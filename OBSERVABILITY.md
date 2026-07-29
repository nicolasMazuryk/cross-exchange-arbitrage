# Local Observability Stack (dev)

A prod-parity observability stack runs alongside the dev datapipeline in
`docker-compose.dev.yml`: **Prometheus / Loki / Tempo / Pyroscope / Grafana**,
fed by a single **Grafana Alloy** collector — the same images, collector
pipeline, datasource wiring, and dashboards as the Hetzner `obs` box, scaled to
one laptop.

Goal: (1) dev looks/behaves like prod, and (2) **agents query metrics/logs/
traces/profiles via CLI/curl** (NOT MCP) to debug code they just ran.

## Architecture

```
  trader ─┐                                          ┌─ Prometheus (metrics, remote-write target)
  query-api ─ /metrics ──┐         scrape            ├─ Loki       (logs, docker-tail)
  spread-computer ─┘     ├──────►  ALLOY  ──────────►├─ Tempo      (traces, OTLP)
  node-exporter ─────────┤    (single collector)     └─ Pyroscope  (profiles)
  clickhouse:9363 ───────┤                                  ▲
  redpanda:9644 ─────────┘                                  │ all four queried by
                                                            └─ Grafana (datasources + 10 dashboards)
  stubs ── OTLP traces ──►  alloy:4317  ─► Tempo
  stubs ── pprof push ───►  alloy:4040  ─► Pyroscope
```

Alloy is the **only** thing that scrapes app/infra targets — Prometheus does not
(it only self-scrapes), exactly like prod. The three app stubs are instrumented
by `src/stubs/telemetry.ts` (`--require`d before the entrypoint): OTel
auto-instrumentation emits real HTTP/Kafka/ClickHouse spans, and
`@pyroscope/nodejs` pushes continuous CPU/heap profiles.

## Ports / endpoints (host-published)

| Service | URL | Use |
|---|---|---|
| Grafana | http://localhost:3000 | UI (anonymous Admin in dev), `/api/datasources` |
| Prometheus | http://localhost:9090 | PromQL `/api/v1/query` |
| Loki | http://localhost:3100 | LogQL `/loki/api/v1/query_range` |
| Tempo | http://localhost:3200 | TraceQL `/api/search`, `/api/traces/<id>` |
| Pyroscope | http://localhost:4040 | `/pyroscope/render`, apps API |
| Alloy | http://localhost:12345 | debug UI; OTLP grpc 4317 / http 4318 |
| query-api stub | http://localhost:8080 | `/up`, `/healthz`, `/metrics` (load gen) |

No host-port collisions: dev already uses 8080, 8123, 9000, 9229–9231, 9644, 19092.

## Quickstart

```bash
npm run docker:dev:up            # builds the stub image (OTel deps) + brings up all services
npm run docker:dev:obs:verify    # scripts/obs-smoke.sh — end-to-end signal assertions
open http://localhost:3000       # Grafana → ArbiNet folder (10 dashboards)
```

## Query cookbook (CLI / curl — for agents)

**Prometheus (PromQL)** — is an app target up? what series exist?
```bash
curl -s localhost:9090/api/v1/query --data-urlencode 'query=up{job="query-api"}' | jq .
curl -s localhost:9090/api/v1/query --data-urlencode 'query=stub_obticks_produced_total' | jq .
curl -s 'localhost:9090/api/v1/label/__name__/values' | jq '.data | length'   # cardinality
```
Jobs (prod-parity names): `node clickhouse redpanda query-api spread-computer trader prometheus`.

**Loki (LogQL)** — find a stub's logs; logs carry `trace_id` when a span is active.
```bash
NOW=$(date +%s)000000000; AGO=$(( $(date +%s)-600 ))000000000
curl -s -G localhost:3100/loki/api/v1/query_range \
  --data-urlencode '{container="arbinet-query-api-dev"} |= "trace_id"' \
  --data-urlencode "start=$AGO" --data-urlencode "end=$NOW" | jq -r '.data.result[].values[][1]'
# Or with logcli (containerized, no install):
docker run --rm --network arbinet grafana/logcli:3.7.2 --addr=http://loki:3100 \
  query '{container="arbinet-trader-dev"}' --limit=20
```
Container labels: `arbinet-{trader,query-api,spread-computer,clickhouse,redpanda,...}-dev`.

**Tempo (TraceQL / by id)** — fetch a trace, or search recent.
```bash
curl -s localhost:3200/api/traces/<TRACE_ID> | jq '.batches | length'
curl -s -G localhost:3200/api/search --data-urlencode 'q={ resource.service.name="query-api" }' | jq .
```

**Pyroscope (profiles)** — which apps pushed, render a CPU profile.
```bash
curl -s localhost:4040/pyroscope/api/apps | jq .
curl -s -G localhost:4040/pyroscope/render \
  --data-urlencode 'query=process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name="trader"}' \
  --data-urlencode 'from=now-5m' | jq '.flamebearer.numTicks'
```

**Grafana (datasource health)**
```bash
curl -s localhost:3000/api/datasources | jq '.[].name'
curl -s localhost:3000/api/datasources/uid/prometheus/health | jq .
```

## Walkthrough: a request's `trace_id` → its logs and trace

1. Hit the stub: `curl localhost:8080/healthz`. OTel records an HTTP server span;
   the pino `mixin` (`src/stubs/stubLogger.ts`) stamps `trace_id`/`span_id` onto
   that request's log lines.
2. Pull the id from Loki (LogQL above) — log lines are JSON in obs mode, so
   `"trace_id":"<hex>"` is literal.
3. Fetch the trace: `curl localhost:3200/api/traces/<hex>`.
4. In Grafana the same hop is one click: a Loki log's **trace_id** derived field
   → Tempo trace → **Logs**/**Profiles** tabs (tracesToLogs / tracesToProfiles).

This is exactly the prod correlation chain — the datasource provisioning is
copied verbatim from `infra/ansible/roles/grafana/.../datasources.yml.j2`.

## Parity vs prod — intentional divergences

| Aspect | Prod | Dev | Why |
|---|---|---|---|
| Alloy | apt/systemd binary, per-box (hot+core) | one `grafana/alloy` **container** | single laptop |
| Network | split obs/core/hot | one `arbinet` bridge | single laptop |
| `host` label | `hot` / `core` / `obs` | `dev` | one host |
| Retention | Prom 15d, Loki 7d, Tempo 72h, Pyro 7d | **24h** all | laptop disk |
| Grafana auth | vault admin pw, anon off | **anon Admin**, pw `admin` | agent curl convenience |
| Alerting | Alertmanager + GlitchTip | **none** | out of scope |
| Stub logs | (prod runs stubs w/o OTel preload) | JSON in obs mode + trace_id mixin | log↔trace correlation |
| Obs storage | role-managed dirs | **named volumes** | non-root images + Docker Desktop macOS bind-mount perms |
| Docker-log label | (verbatim prod body) | `discovery.relabel` adds `container` | make LogQL deterministic in dev |
| node-exporter | host metrics | Docker Desktop **Linux VM** metrics, not macOS | platform limitation |

Same as prod: all image tags, the Alloy scrape/log/trace/profile pipeline, job
names, datasource URLs + cross-signal links, and all 10 dashboards (business
panels may be empty in dev — by design; the stubs emit no business metrics).

## What's required beyond `docker compose`

- **npm deps** `@opentelemetry/*`, `@pyroscope/nodejs` → `docker:dev:up` rebuilds
  the stub image (`--build`).
- **`/var/run/docker.sock`** mounted read-only into Alloy for log tailing.
- **OTel preload ordering** — `--require ./src/stubs/telemetry.ts` AFTER
  `ts-node/register`, BEFORE the entrypoint (else auto-instrumentation misses
  already-loaded modules). Wired in compose `command:`.
- **CH `:9363`** via `infra/clickhouse/config.dev.d/prometheus.xml`.
- **No privileged / eBPF / kernel knobs** — Pyroscope uses the Node SDK push
  model, not eBPF. ~7 extra containers; modest footprint.

## Real-app (`npm start`) instrumentation — deferred hook

The compose stack runs the **stubs**, not `src/main.ts`. The real app is
instrumented-ready but off by default: `src/utils/logger.ts` carries the same
OTel `trace_id`/`span_id` mixin (no-op without an active span / OTLP endpoint).
To enable, run main under the same preload and set `OTEL_EXPORTER_OTLP_ENDPOINT`
— prod is untouched because its Kamal command doesn't `--require` the bootstrap.

## Verification checklist

1. `npm run docker:dev:up` → `docker compose -f docker-compose.dev.yml ps` all up.
2. `npm run docker:dev:obs:verify` → green (metric, log w/ trace_id, trace,
   profile, datasource health).
3. Manual: pull a `trace_id` from a Loki log → fetch it from Tempo → same id.
4. Grafana → datasources health OK; ArbiNet dashboards render.
