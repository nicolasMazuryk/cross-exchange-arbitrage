# 04 — Deployment (Pillar 3: Kamal)

The app layer ships with **Kamal 2** (2.11.x; kamal-proxy ≥ 0.9.2), now spanning **two hosts**: the `trader` app on the **hot box** ([01](./01-topology.md)), and the `query-api` + `spread-computer` apps plus `clickhouse` + `redpanda` accessories on the **core box**. There is **no CI pipeline** — images are built locally (**amd64 only**) and pushed to **GHCR**, then `kamal deploy` rolls them onto the hosts over SSH — authenticating with the same `~/.ssh/nicolas` operator key, connecting as the `ansible`/deploy user ([02](./02-provisioning.md#concrete-resource-table)). Kamal runs the pinned containers on top of the config files Ansible already laid down ([03](./03-configuration.md), gap **G6**). This file carries the image and accessory tables inline.

## Build and deploy (no CI)

Deliberately no GitHub Actions / build farm. The flow is a developer command sequence:

```
docker buildx build --platform linux/amd64 -t ghcr.io/nicolasmazuryk/arbinet-trader:<tag>         -f docker/Dockerfile.trader        --push .
docker buildx build --platform linux/amd64 -t ghcr.io/nicolasmazuryk/arbinet-query-api:<tag>       -f docker/Dockerfile.queryApi      --push .
docker buildx build --platform linux/amd64 -t ghcr.io/nicolasmazuryk/arbinet-spread-computer:<tag> -f docker/Dockerfile.spreadComputer --push .
kamal deploy
```

**Registry = GHCR** (`ghcr.io`) — git is on GitHub, so GHCR is the natural registry; Kamal pulls from it (gap **G7**, [08](./08-gaps-and-decisions.md#g7)). The registry is the personal GitHub account `https://github.com/nicolasMazuryk` (no org). GHCR **image paths are lowercase** (`ghcr.io/nicolasmazuryk/...`) while the **login username keeps its original case** (`nicolasMazuryk`). Registry credentials (a GHCR PAT with `read:packages`/`write:packages`) live in Kamal's secrets, never in the repo.

### Build architecture — amd64 only

**All three hosts are amd64** (hot CCX13, core CPX51, obs CPX41 — CAX/CX ARM lines unavailable on the target account). Developers on Apple Silicon (arm64) **must** pass `--platform linux/amd64` (or pin `builder.arch: amd64` in `deploy.yml`) — building arm64 and deploying to amd64 produces exec-format errors at container boot.

| Target host | Arch | Build requirement |
|---|---|---|
| hot CCX13 (trader) | amd64 | `buildx --platform linux/amd64` from Apple Silicon → GHCR |
| core CPX51 (query-api, spread-computer, CH, Redpanda) | amd64 | `buildx --platform linux/amd64` → GHCR; CH/Redpanda are pinned upstream amd64 images |
| obs CPX41 | amd64 | **Not Kamal-built** — obs runs upstream amd64 images (prom/grafana/loki/tempo/pyroscope/glitchtip) via the Ansible compose stack ([03](./03-configuration.md#obs-box-backend-roles)); no local build. |

No `linux/arm64` builds anywhere. Builds use BuildKit / `docker buildx`, multi-stage Dockerfiles, a non-root container user.

## Kamal apps and accessories

```yaml
# deploy.yml (shape)
service: arbinet
image: ghcr.io/nicolasmazuryk/arbinet-trader
registry:
  server: ghcr.io
  username: nicolasMazuryk
  password: <%= ENV['KAMAL_REGISTRY_PASSWORD'] %>
builder:
  arch: amd64
servers:
  trader:   { hosts: [10.0.1.10], cmd: node dist/trader.js }     # hot box — no proxy/ingress
  queryapi:
    hosts: [10.0.1.20]                                           # core box
    cmd: node dist/queryApi.js
    proxy: { ssl: true, host: api.arbinet.example, app_port: 8080, healthcheck: { path: /up } }
  spreadcomputer: { hosts: [10.0.1.20], cmd: node dist/spreadComputer.js }  # core box
```

`proxy.ssl: true` makes **kamal-proxy on the core box** provision the Let's Encrypt cert and terminate TLS — there is no Hetzner LB.

### Images to build

| Image | Host | Source | Notes |
|---|---|---|---|
| `trader` | hot | `docker/Dockerfile.trader` (multi-stage, non-root) | Node app: WS connectors + orderbookManager + arbitrageEngine + tradeExecutor. Exposes `/up` and `/metrics`. **No ingress** — outbound to exchanges, **produces `ob.ticks` to core Redpanda `10.0.1.20:9092`**, **reads/writes trade-state to core ClickHouse `10.0.1.20:8123` (`@clickhouse/client` HTTP)**, OTLP/Pyroscope to local Alloy. SpreadComputer is **no longer in this image** (snapshotter dissolved; spread-computer split out, G12). |
| `query-api` | core | `docker/Dockerfile.queryApi` (multi-stage, non-root) | Node: Express + ws, reads CH and tails Redpanda. Exposes `/up`, `/healthz`, `/metrics`. The **only** app behind the public edge (via kamal-proxy). |
| `spread-computer` | core | `docker/Dockerfile.spreadComputer` (multi-stage, non-root) | **Split out of trader (G12)** — the lone warm service. Consumes `ob.ticks`, computes spreads, writes `spreads.live` → ClickHouse. Exposes `/metrics`. The raw `orderbooks` path is serviceless (CH Kafka engine consumes `ob.ticks` directly), so it has no image. |

### Kamal accessories (core box)

Middleware runs as Kamal accessories on the **core box**, sized/configured by their Ansible roles ([03](./03-configuration.md#core-box-middleware-roles)) and run by Kamal:

| Accessory | Image | Bind | Volume / mounts |
|---|---|---|---|
| `redpanda` | `redpandadata/redpanda:v26.1` (pinned) | **`10.0.1.20:9092`** (private listener, hot-box producer) + `127.0.0.1:9644` admin/metrics | `/mnt/ch-volume/redpanda:/var/lib/redpanda/data` |
| `clickhouse` | `clickhouse/clickhouse-server:26.3-lts` (pinned) | **`10.0.1.20:8123`** (HTTP private listener, hot-box trade-state client) + `127.0.0.1:9000` | `/mnt/ch-volume/clickhouse:/var/lib/clickhouse` + `config.d`/`users.d` mounts from Ansible |

Redpanda's Kafka listener **and** ClickHouse's HTTP port bind the **private IP** so the hot box can produce `ob.ticks` (`9092`) and persist/restore trade-state (`8123`); the firewall pins the source to `10.0.1.0/24` ([02](./02-provisioning.md#firewalls)). All other core-box ports (incl. CH native `9000`) bind `127.0.0.1`. Alloy (Ansible-installed) scrapes them on loopback.

## Single-instance trader

Hard requirement, not a preference: **exactly one `trader` instance ever, on the hot box.** Two concurrent traders both detect the same arbitrage and both place orders → duplicate trades and financial loss.

- **Kamal zero-downtime overlap disabled** for `trader` — stop-before-start only. kamal-proxy's overlapping-instance cutover is **avoided**. A brief deploy downtime is accepted; overlapping instances are not.
- No app-level lock — the deploy discipline is the guarantee.
- The `trader` app has **no proxy/ingress** at all (it has no proxy block in `deploy.yml`), so there is no health-gated traffic switch to keep two copies alive. `query-api` *may* keep proxy health-gating (it's idempotent, read-only) but still deploys stop-before-start.
- `spread-computer` is also single-instance (consumes from `ob.ticks` once); deploy stop-before-start on the core box. The raw `orderbooks` path has no app instance — the CH Kafka engine consumes `ob.ticks` directly, its consumer count owned by the CH table config (`kafka_num_consumers`), not Kamal.

## Edge and TLS path

Single public ingress, single TLS termination — in **kamal-proxy on the core box** (gap **G5** reversed: the Hetzner LB is dropped because query-api is off the hot path, so terminating TLS on the host is no longer a hot-path concern):

```
Internet ──443/TLS──▶ core box :443 kamal-proxy (Let's Encrypt managed cert; host-side routing + /up health-gate)
                         │ → query-api 127.0.0.1:8080
                         ▼
                      query-api
```

TLS terminates **once, in kamal-proxy on the core box** (`proxy.ssl: true` → Let's Encrypt). There is **no Hetzner LB**. The cert lives on the core box, **off the hot box's dedicated cores** — the whole point of dropping the LB is acceptable precisely because query-api (and now the cert) are off the hot path. The Volume is wired by **Terraform**, not a Kubernetes CCM/CSI — Kamal-on-VMs, no k8s (gap **G4**, [08](./08-gaps-and-decisions.md#g4)).

## Mandatory `/up` healthcheck

A working `/up` is required on `query-api`. Without it, kamal-proxy will not switch traffic and the deploy hangs at "Waiting for the first healthy container" — a known production risk. The `trader` and `spread-computer` expose `/up` for liveness even though they have no ingress.

## Deploy flow

1. Build `trader` (hot) + `query-api`/`spread-computer` (core) for `linux/amd64`; push to GHCR.
2. `kamal deploy` — pulls images; rolls **accessories** (`redpanda`, `clickhouse`, mounting Ansible-laid config) then the **app** containers onto their hosts over SSH: `trader` → `10.0.1.10` (stop-before-start); `query-api`/`spread-computer` → `10.0.1.20`.
3. **`bootstrap.sql`** one-shot against ClickHouse (core box): create the `arbinet` **database**, a `migrations` tracking table, and minimal prep only — **no** app tables, MVs, or `fees` seed. App tables / materialized views / `fees` seed are handled by **separate schema-migration tasks**, not at deploy bootstrap. The schema DDL is **app-owned** (DDL in [`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md) / [`05-rollups-and-mvs.md`](../datapipeline/05-rollups-and-mvs.md)) and applied via those migrations.
4. **Smoke test:** Kamal `/up` healthchecks pass on all apps; the `arbinet` DB + `migrations` table exist. The orderbook-row-count check assumes app tables exist, so it is **gated on after schema migrations have created the tables** — once migrated, confirm the hot box produces `ob.ticks` (CH Kafka-engine consumer lag — `redpanda_kafka_consumer_group_lag{group="ch_orderbooks"}` — low), then `curl 127.0.0.1:8123/?query=SELECT%20count()%20FROM%20arbinet.orderbooks` on the core box returns >0 within ~5 s — orderbooks populate once the trader produces `ob.ticks` and the CH Kafka engine consumes it.
5. Verify the obs box is receiving metrics/logs/traces from **both** Alloy agents ([05-observability.md](./05-observability.md)) — hot + core targets up in Prometheus, GlitchTip reachable.

## Rollback

`kamal rollback` to the previous image tag (or `kamal app stop` + redeploy prior tag). ClickHouse + Redpanda data persist on the core box's `/mnt/ch-volume` across app rollbacks — rollback swaps the app image only, never the data. Procedure: [07-runbooks.md](./07-runbooks.md#rollback).

## Image prune

Accumulating images exhaust disk (known risk). Schedule `kamal prune` (or `docker image prune`) on **both** the hot and core boxes and watch `node_filesystem_avail_bytes` on each root disk ([05](./05-observability.md#alert-rules)). Runbook: [07-runbooks.md](./07-runbooks.md#deploy).

## Secrets

SOPS-encrypted, delivered at runtime — never `.env` + `scp` ([03](./03-configuration.md#secrets-management)). Kamal env carries the app secrets (`QUERY_API_KEY`, `CH_*`, `REDPANDA_BROKERS=10.0.1.20:9092`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, exchange API keys, `KAMAL_REGISTRY_PASSWORD`); Ansible vault carries host/middleware secrets. `CH_URL` is **host-specific**: the **hot-box trader** uses `http://10.0.1.20:8123` (trade-state over the private net), core-box services use `http://127.0.0.1:8123` ([03](./03-configuration.md#clickhouse-role)).

## Local development

A `docker-compose.dev.yml` brings up the full stack on a laptop (development only, not the production runtime). Note the dev compose still runs trader + spread-computer + query-api + CH + Redpanda **in one stack** for convenience, even though prod splits them across two hosts:

- One command: `docker compose -f docker-compose.dev.yml up -d`.
- Same image tags as prod (CH `26.3-lts`, Redpanda `v26.1`); smaller flags (`--smp 1 --memory 1G` for Redpanda).
- Bind-mounts `./.dev-data/clickhouse`, `./.dev-data/redpanda` (gitignored) instead of `/mnt/ch-volume`.
- Bridge networking with explicit port maps (`8123`, `9000`, `9092`, query-api) — no `network_mode: host`. In dev the trader produces `ob.ticks` to the local Redpanda over the bridge.
- No S3 cold disk: dev storage policy points only at `default` (`config.dev.d/storage.xml`, single-disk `tiered → default`).
- `trader` / `query-api` / `spread-computer` bind-mount the repo, run `ts-node + nodemon` for hot reload.
- `bootstrap.sql` runs identically (now just the `arbinet` db + `migrations` table; app tables/MVs come from the separate migration tasks).

```json
"docker:dev:up":   "docker compose -f docker-compose.dev.yml up -d",
"docker:dev:down": "docker compose -f docker-compose.dev.yml down",
"docker:dev:logs": "docker compose -f docker-compose.dev.yml logs -f trader query-api"
```

## Links

- The topology this deploys onto → [01-topology.md](./01-topology.md)
- Firewall / host declarations (no LB) → [02-provisioning.md](./02-provisioning.md)
- Config Kamal mounts (Ansible↔Kamal seam, G6) → [03-configuration.md](./03-configuration.md)
- Verifying the deploy observed correctly → [05-observability.md](./05-observability.md)
- Resource caps & budget → [06-capacity-and-cost.md](./06-capacity-and-cost.md)
- Deploy / rollback runbooks → [07-runbooks.md](./07-runbooks.md)
- Gaps resolved here (G4, G5, G7, G12) → [08-gaps-and-decisions.md](./08-gaps-and-decisions.md)
- App schema/topics executed at deploy → [`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md), [`../datapipeline/11-redis-removal.md`](../datapipeline/11-redis-removal.md)
</content>
