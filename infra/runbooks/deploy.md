# Deploy (spans two hosts)

Ship new app images to `hot` (trader) and `core` (query-api, spread-computer +
CH/Redpanda accessories). No CI — built locally, pushed to GHCR, rolled by Kamal.
Source: [spec 07 §Deploy](../../framework/specs/infrastructure/07-runbooks.md),
[spec 04](../../framework/specs/infrastructure/04-deployment.md). Tunnel up first.

> **Single-instance trader is sacred.** Two concurrent traders both place the
> same orders → duplicate trades, real loss. The pre-deploy hook + `kamal.sh`
> guard `docker rm -f` the trader before boot (brief downtime accepted). Never
> let two run. Verify after (step 6).

## Pre-flight

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
git status                    # COMMIT first — kamal.sh tags the image by git HEAD
                              # short-SHA but builds from the worktree (infra/CLAUDE.md)
```

## 1. Build amd64 images → GHCR

**amd64 only** — arm64 on the hosts = exec-format error at boot. From repo root:

```bash
TAG=$(git rev-parse --short HEAD)
for svc in trader queryApi spreadComputer; do
  img=$(echo "$svc" | sed -E 's/queryApi/query-api/;s/spreadComputer/spread-computer/')
  docker buildx build --platform linux/amd64 \
    -t ghcr.io/nicolasmazuryk/arbinet-$img:$TAG \
    -f docker/Dockerfile.$svc --push .
done
```

(Or just `infra/kamal/kamal.sh deploy`, which builds+pushes+rolls in one go.)

## 2. Roll with Kamal

```bash
infra/kamal/kamal.sh deploy
```

- **Accessories boot first if cold:** `kamal accessory boot all` — `kamal deploy`
  does NOT boot accessories; apps crashloop without CH/Redpanda (infra/CLAUDE.md).
- Rolls `trader` → hot `10.0.1.10` (stop-before-start); `query-api` /
  `spread-computer` → core `10.0.1.20`.
- Target only the hot box: `infra/kamal/kamal.sh deploy --roles=trader`.

## 3. Bootstrap ClickHouse (one-shot, idempotent)

Creates the `arbinet` db + `migrations` table only — app tables/MVs are
datapipeline-owned migrations, not this. Multi-statement → needs
`clickhouse-client --multiquery`, NOT the HTTP `/` endpoint (infra/CLAUDE.md):

```bash
ssh -i ~/.ssh/nicolas ansible@10.0.1.20 \
  'docker exec -i $(docker ps -qf name=clickhouse) clickhouse-client --multiquery' \
  < infra/clickhouse/bootstrap.sql
```

## 4. Smoke test

```bash
# /up on each app (trader has no proxy → curl the container IP, port 8081):
TIP=$(ssh ... 'docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" arbinet-trader-<v>')
ssh hot "curl -sf http://$TIP:8081/up"            # OK
curl -sf https://api.arbinet.xyz/up               # query-api via kamal-proxy
# db + migrations table exist:
ssh ... core 'docker exec ... clickhouse-client --multiquery -q "SHOW TABLES FROM arbinet"'
```

The **orderbook-row-count** check is gated on the schema migrations having run
(they create `arbinet.orderbooks`). Once migrated: confirm
`redpanda_kafka_consumer_group_lag{group="ch_orderbooks"}` low and
`SELECT count() FROM arbinet.orderbooks` > 0 within ~5 s.

## 5. Confirm observability

Hot + core targets `up` in Prometheus, GlitchTip reachable:

```bash
curl -sG 10.0.1.30:9090/api/v1/query --data-urlencode \
  'query=up{job=~"trader|query-api|spread-computer|node|clickhouse|redpanda"}'
# (hot/core are remote-written → NOT in /api/v1/targets; query `up` instead)
```

## 6. Prove single-instance trader

```bash
ssh hot 'nohup sh -c "for i in $(seq 1 400); do printf \"%s %s\n\" \
  \"$(date +%s.%N)\" \"$(docker ps -q --filter label=role=trader --filter status=running | wc -l)\"; \
  sleep 0.2; done" >/tmp/s.log 2>&1 &'
# after deploy: assert max==1, sequence 1→0→1, NEVER 2
ssh hot "awk '{print \$2}' /tmp/s.log | sort | uniq -c"
```

## 7. Image prune (BOTH hot + core)

Accumulating images exhaust the root disk:

```bash
infra/kamal/kamal.sh prune || ssh <host> 'docker image prune -f'
# watch node_filesystem_avail_bytes{mountpoint="/"} per host
```

Rollback if the smoke test fails → [rollback.md](./rollback.md).
</content>
