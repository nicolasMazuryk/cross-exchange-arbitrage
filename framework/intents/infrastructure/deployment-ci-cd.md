# Hetzner Cloud Deployment Architecture

## Infrastructure Provisioning

- Label every Hetzner resource. Labels are the discovery mechanism for the Cloud Controller Manager (CCM), the CSI driver, and any custom automation. Untagged resources are effectively invisible to these systems.

## Container Images

- Build with BuildKit / `docker buildx`.
- Use multi-stage Dockerfiles.
- Define a non-root user in the Dockerfile and run containers as that user.
- Account for CPU architecture when building (see [Build Architecture](#build-architecture)).

### Build Architecture

The build host architecture must match the target Hetzner server architecture, or the image must be built for both.

| Target server line | Architecture | Build requirement |
| --- | --- | --- |
| CX / CPX | amd64 | Pin `builder.arch: amd64`, or build with `--platform linux/amd64` |
| CAX (ARM) | arm64 | Build `linux/amd64,linux/arm64` (multi-arch) |

- ARM on Hetzner (CAX) is meaningfully cheaper and most stacks build fine on it.
- Building on Apple Silicon (arm64) and deploying to amd64 without specifying the platform produces exec-format errors at container boot.

## Application Deployment

- Deploy with Kamal 2 (`kamal deploy`), which builds the image, pushes it, and rolls the containers onto the remote server.
- Kamal 2 deploys Dockerized apps over SSH and provisions TLS via Let's Encrypt.

## Deployment Strategy — Single-Instance Constraint

This is a hard requirement, not a preference.

- **Exactly one instance of the application may run at any time.** Two concurrent instances are not acceptable.
- **Rationale:** The system listens to order-book updates over many exchange websockets (thousands of events per second) and detects arbitrage opportunities. If two instances are live simultaneously, both detect the same opportunity and both place orders — resulting in unintended duplicate trades, false decisions, and potential financial loss.
- **Consequence for deploys:** kamal-proxy's zero-downtime deployment behavior — which keeps two application instances running concurrently while holding requests during the restart/cutover — must be avoided. A brief deployment downtime is acceptable; overlapping instances are not.

## Networking, Edge, and TLS

| Component | Preference | Notes |
| --- | --- | --- |
| Hetzner Cloud Networks (private VPC) | Use for all server-to-server traffic | Databases always on the private network; firewall the public interfaces. |
| Hetzner Cloud Firewalls | First line of defense, at the resource level | Do not rely on host (OS) firewalls alone. |
| Hetzner Load Balancers | Default choice; cheap and CCM-integrated | Sufficient for most workloads. |
| Self-managed Caddy | Only when exotic routing is needed | Otherwise prefer the Hetzner Load Balancer. |

## Kamal 2 Configuration

- **Zero-downtime deployments: disabled.** See the [Single-Instance Constraint](#deployment-strategy--single-instance-constraint) above — running two instances during cutover is not permitted.
- **Healthchecks are mandatory.** A working `/up` endpoint is required; without it, kamal-proxy will not switch traffic during a deploy and the deploy will appear to hang.
- **Bind accessory ports to `127.0.0.1`.** A mapping such as `127.0.0.1:5432:5432` keeps the database off the public internet. Combined with the private network, the database is reachable only by app containers on the same host.
- **Multi-arch builds.** Pin `builder.arch: amd64` for the amd64 (CX/CPX) line, or build `linux/amd64,linux/arm64` for the CAX ARM line.

## Security Checklist (perimeter, outside in)

| Layer | Control |
| --- | --- |
| Cloud firewall | Hetzner Cloud Firewall allowing only ports 22, 80, and 443 |
| Network isolation | Private network for all server-to-server traffic; no accessory on a public IP |
| Host firewall | UFW inside the OS as defense in depth |
| SSH brute-force | Fail2ban |
| SSH access | Key-only; no root password |
| OS patching | Unattended security upgrades enabled |
| Container runtime | Non-root container user defined in the Dockerfile |

## Known Production Risks

| Risk | Trigger | Symptom / Mitigation |
| --- | --- | --- |
| Hung deploy | Missing `/up` healthcheck | Deploy stalls at "Waiting for the first healthy container"; ensure the endpoint exists and responds. |
| Boot failure | Building on Apple Silicon and deploying to Intel without `--platform linux/amd64` | exec-format errors at boot; build for the correct platform. |
| Disk exhaustion | Accumulating container images | Schedule image prunes and monitor disk usage. |

## Arbinet Service Layout & Deployment Flow

Concrete deployment of the Arbinet trader + orderbook pipeline. The runtime is **Kamal apps + accessories**, superseding the earlier Docker-Compose + `scp .env` model that the pipeline drafts assumed.

### Images to build

| Image | Source | Notes |
|---|---|---|
| `trader` | `docker/Dockerfile.trader` (multi-stage, non-root user) | Node app: WS connectors + orderbookManager + arbitrageEngine + tradeExecutor + snapshotter + spread computer. Exposes `/up` (healthcheck) and `/metrics`. |
| `query-api` | `docker/Dockerfile.queryApi` (multi-stage, non-root user) | Separate Node process: Express + ws, reads CH and tails Redpanda. Exposes `/up`, `/healthz`, `/metrics`. |

Build per [Build Architecture](#build-architecture): pin `builder.arch: amd64` for the CPX62 (amd64) line, or build `linux/amd64,linux/arm64` if a CAX ARM host is ever used. Build with BuildKit / `docker buildx`.

### Kamal accessories

The middleware that earlier drafts ran as Docker-Compose services become **Kamal accessories**, installed/sized by their Ansible roles ([ansible-configuration.md](./ansible-configuration.md)) and run by Kamal:

| Accessory | Image | Bind | Volume |
|---|---|---|---|
| `redpanda` | `redpandadata/redpanda` (pinned) | `127.0.0.1:9092` | `/mnt/ch-volume/redpanda:/var/lib/redpanda/data` |
| `clickhouse` | `clickhouse/clickhouse-server` (v26-LTS, pinned) | `127.0.0.1:8123`, `127.0.0.1:9000` | `/mnt/ch-volume/clickhouse:/var/lib/clickhouse` + config.d/users.d mounts |

Accessory ports bind to `127.0.0.1` (off the public internet; the Hetzner firewall opens only 22/80/443). The observability agents ([ansible-configuration.md](./ansible-configuration.md#observability_agents)) run alongside.

### Single-instance constraint

Per the [Single-Instance Constraint](#deployment-strategy--single-instance-constraint): the `trader` runs **exactly one instance**, Kamal zero-downtime overlap **disabled**. A brief deploy downtime is accepted; two concurrent traders would place duplicate orders.

### Secrets (reframed from `.env` + `scp`)

No `.env` files pushed by `scp`. Secrets are **SOPS-encrypted** in the repo/inventory and delivered at runtime — Ansible vault (`community.sops`) for host/middleware config (CH user/password, `S3_ACCESS_KEY`/`S3_SECRET_KEY`), Kamal env for the app containers (`QUERY_API_KEY`, `CH_*`, `REDPANDA_BROKERS`, exchange API keys). `no_log: true` on any task touching secrets.

### Deployment flow

1. Build `trader` + `query-api` images (correct platform).
2. `kamal deploy` — pushes images, rolls accessories (redpanda, clickhouse) then the app containers onto the host over SSH.
3. **Run `bootstrap.sql`** against ClickHouse: create database, all tables, materialized views, and seed the `fees` table. The SQL is **owned by the app** (DDL lives in [`../../specs/datapipeline/04-clickhouse-schemas.md`](../../specs/datapipeline/04-clickhouse-schemas.md) / [`05-rollups-and-mvs.md`](../../specs/datapipeline/05-rollups-and-mvs.md)); infra executes it as a one-shot deploy step.
4. **Smoke test:** Kamal `/up` healthchecks must pass; then `curl 127.0.0.1:8123/?query=SELECT%20count()%20FROM%20arbinet.orderbooks` returns >0 within ~5 s of trader start.
5. Verify the self-hosted observability stack is receiving metrics/logs/traces ([observability-stack.md](./observability-stack.md)).

**Rollback:** `kamal rollback` to the previous image tag (or `kamal app stop` + redeploy prior tag). ClickHouse + Redpanda data persist on the Volume across app rollbacks.

### Local development

A `docker-compose.dev.yml` brings up the full stack on a laptop for development only (not the production runtime):

- One command: `docker compose -f docker-compose.dev.yml up -d`.
- Same image tags as prod (CH v26-LTS, Redpanda pinned) so schemas exercise the same versions; smaller flags (`--smp 1 --memory 1G` for Redpanda).
- Bind-mounts to `./.dev-data/clickhouse` and `./.dev-data/redpanda` (gitignored) instead of `/mnt/ch-volume`.
- Bridge networking with explicit port maps (`8123`, `9000`, `9092`, plus query-api) — no `network_mode: host`.
- No S3 cold disk: dev storage policy points only at `default` (`config.dev.d/storage.xml`, single-disk `tiered → default`).
- `trader` / `query-api` bind-mount the repo and run a `ts-node + nodemon` dev command for hot reload.
- `bootstrap.sql` runs identically; dev uses a smaller `fees` seed.

```json
"docker:dev:up":   "docker compose -f docker-compose.dev.yml up -d",
"docker:dev:down": "docker compose -f docker-compose.dev.yml down",
"docker:dev:logs": "docker compose -f docker-compose.dev.yml logs -f trader query-api"
```

## Links

- Resource declarations (server, LB, firewall) → [infrastructure-provisioning.md](./infrastructure-provisioning.md)
- Middleware install/config/sizing → [ansible-configuration.md](./ansible-configuration.md)
- Resource caps & budget → [capacity-and-cost.md](./capacity-and-cost.md)
- App schema/topics executed at deploy → [`../../specs/datapipeline/04-clickhouse-schemas.md`](../../specs/datapipeline/04-clickhouse-schemas.md), [`../../specs/datapipeline/11-redis-removal.md`](../../specs/datapipeline/11-redis-removal.md)