#!/usr/bin/env bash
# obs-smoke.sh — end-to-end smoke test of the local observability stack.
#
# Follows the CLAUDE.md Runtime Verification Protocol: generates real load, then
# asserts each signal by curl and prints "ran X, observed Y" — no assumptions.
# Proves: metric in Prometheus, log w/ trace_id in Loki, that trace resolvable
# in Tempo, a profile in Pyroscope, and all Grafana datasources healthy.
#
# Usage: bash scripts/obs-smoke.sh   (or: npm run docker:dev:obs:verify)
# Requires the dev stack up: npm run docker:dev:up
set -uo pipefail

PROM=http://localhost:9090
LOKI=http://localhost:3100
TEMPO=http://localhost:3200
PYRO=http://localhost:4040
GRAF=http://localhost:3000
QAPI=http://localhost:8080

PASS=0; FAIL=0
ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "── $1 ──"; }

# Wait until an HTTP endpoint returns 200 (readiness gate for the shell-less
# backends that carry no docker healthcheck).
wait_http() {
  local name=$1 url=$2 tries=${3:-60}
  for ((i=1; i<=tries; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
    [ "$code" = "200" ] && { echo "  $name ready (HTTP 200) after ${i}s"; return 0; }
    sleep 1
  done
  echo "  $name NOT ready after ${tries}s (last HTTP ${code:-none})"; return 1
}

echo "=== ArbiNet observability smoke test ==="

hdr "0. Readiness"
wait_http prometheus "$PROM/-/ready"        || true
wait_http loki       "$LOKI/ready"          || true
wait_http tempo      "$TEMPO/ready"         || true
wait_http pyroscope  "$PYRO/ready"          || true
wait_http grafana    "$GRAF/api/health"     || true
wait_http query-api  "$QAPI/up"             || true

hdr "1. Generate load (query-api HTTP → OTel spans + logs)"
N=40
for ((i=1; i<=N; i++)); do
  curl -s -o /dev/null "$QAPI/healthz"
  curl -s -o /dev/null "$QAPI/up"
done
echo "  ran ${N}× GET /healthz + /up against query-api"
echo "  (waiting 12s for scrape + batch span export + log tail to settle)"
sleep 12

hdr "2. Prometheus — app target up"
# up{job="query-api"} must be 1 (Alloy scraped it and remote-wrote here).
RESP=$(curl -s "$PROM/api/v1/query" --data-urlencode 'query=up{job="query-api"}')
VAL=$(echo "$RESP" | grep -oE '"value":\[[0-9.]+,"[0-9]+"\]' | grep -oE '"[01]"\]$' | tr -d '"]')
echo "  query: up{job=\"query-api\"} → ${RESP:0:160}"
if [ "$VAL" = "1" ]; then ok "up{job=query-api}=1"; else bad "up{job=query-api} not 1 (got '${VAL:-none}')"; fi
# Also confirm the stub's own counter series exists.
RESP2=$(curl -s "$PROM/api/v1/query" --data-urlencode 'query=stub_obticks_produced_total')
if echo "$RESP2" | grep -q '"metric"'; then ok "stub_obticks_produced_total present"; else bad "stub_obticks_produced_total missing"; fi

hdr "3. Loki — query-api log line carrying trace_id"
END=$(date +%s)000000000
START=$(( $(date +%s) - 600 ))000000000
LRESP=$(curl -s -G "$LOKI/loki/api/v1/query_range" \
  --data-urlencode 'query={container="arbinet-query-api-dev"} |= "trace_id"' \
  --data-urlencode "start=$START" --data-urlencode "end=$END" --data-urlencode 'limit=20')
# Extract a 32-hex trace id. Loki returns each log line as a JSON string, so the
# embedded quotes are backslash-escaped (\"trace_id\":\"<hex>\") — match through
# any quote/colon/backslash separators, then pull the hex.
TRACE_ID=$(echo "$LRESP" | grep -oE 'trace_id[\\":]+[0-9a-f]{32}' | head -1 | grep -oE '[0-9a-f]{32}')
echo "  query: {container=\"arbinet-query-api-dev\"} |= \"trace_id\""
if [ -n "$TRACE_ID" ]; then ok "Loki log carries trace_id=$TRACE_ID"; else
  bad "no trace_id in Loki logs"; echo "  resp: ${LRESP:0:300}"; fi

hdr "4. Tempo — resolve that trace_id"
if [ -n "$TRACE_ID" ]; then
  # Tempo lags Loki slightly (block flush); retry a few times.
  TFOUND=""
  for ((i=1; i<=15; i++)); do
    TRESP=$(curl -s -o /dev/null -w '%{http_code}' "$TEMPO/api/traces/$TRACE_ID")
    [ "$TRESP" = "200" ] && { TFOUND=1; break; }
    sleep 2
  done
  if [ -n "$TFOUND" ]; then
    BODY=$(curl -s "$TEMPO/api/traces/$TRACE_ID")
    echo "  GET /api/traces/$TRACE_ID → 200, ${#BODY} bytes"
    ok "trace $TRACE_ID resolvable in Tempo (log→trace correlation proven)"
  else
    bad "trace $TRACE_ID not found in Tempo after retries (HTTP $TRESP)"
  fi
else
  bad "skipped Tempo check — no trace_id from Loki"
fi

hdr "5. Pyroscope — a profile exists for a stub app"
# Confirm the stubs registered as profiled services (service_name label values).
PRESP=$(curl -s "$PYRO/querier.v1.QuerierService/LabelValues" \
  -H 'content-type: application/json' -d '{"name":"service_name"}' 2>/dev/null)
echo "  service_name values: ${PRESP:0:200}"
if echo "$PRESP" | grep -qE 'trader|query-api|spread-computer'; then
  ok "Pyroscope has stub app profiles (service_name registered)"
else
  bad "no stub service_name in Pyroscope"
fi

hdr "6. Grafana — datasource health"
DS=$(curl -s "$GRAF/api/datasources")
COUNT=$(echo "$DS" | grep -oE '"uid":"(prometheus|tempo|loki|pyroscope)"' | sort -u | wc -l | tr -d ' ')
echo "  provisioned datasources with expected uids: $COUNT/4"
[ "$COUNT" = "4" ] && ok "all 4 datasources provisioned" || bad "expected 4 datasources, found $COUNT"
# Per-datasource health probe via Grafana's datasource proxy.
for uid in prometheus tempo loki pyroscope; do
  H=$(curl -s -o /dev/null -w '%{http_code}' "$GRAF/api/datasources/uid/$uid/health")
  if [ "$H" = "200" ]; then ok "datasource $uid health 200"; else bad "datasource $uid health $H"; fi
done

echo
echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
