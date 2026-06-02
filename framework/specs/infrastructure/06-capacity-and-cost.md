# 06 — Capacity & Cost (Three-Host Sizing)

Resource boundaries, sizing math, retention footprints, and budget for the **three** Hetzner hosts ([01](./01-topology.md)): the **hot box (CCX13)** running the trader on dedicated cores, the **core box (CPX51)** running ClickHouse + Redpanda + query-api + spread-computer + Alloy + kamal-proxy, and the **obs box (CPX41, amd64)** running the observability backends. This is the capacity contract for the workloads in [`../datapipeline/`](../datapipeline/README.md). All figures assume the hosts and middleware sizing in [02](./02-provisioning.md) and [03](./03-configuration.md), and the **spread-computer split out of the trader** (gap **G12**; — without that split the hot box would need CCX23+.

## Hot-box process boundaries

**Hetzner CCX13 — 2 dedicated vCPU / 8 GB RAM / 80 GB NVMe**, no Volume. Kept lean so the dedicated cores serve the trade loop.

| Service | Process | Memory cap | CPU budget | Note |
|---|---|---|---|---|
| Trader (WS + orderbookManager + arbitrageEngine + tradeExecutor) | 1 Node process (Kamal app) | ~6.5 GB | 1–2 dedicated cores | RAM driven by in-mem L2 books; **spread-computer removed** (G12) |
| Grafana Alloy (lean) + node_exporter | agent + sidecar | ~250 MB | <0.3 vCPU | scrape trader `/metrics` + host, receive OTLP/Pyroscope, forward to obs |
| Headroom | — | ~1 GB | — | **TIGHT — flag (G13)** |

**8 GB is tight (gap G13).** Measure trader RSS at runtime (verification below); if it exceeds **~6.5 GB sustained**, fall back to **CCX23** (4 vCPU / 16 GB, ~+€12/mo). The `hot_mem_high` alert (`node_memory_MemAvailable_bytes{host="hot"} < 1 GB` for 10 min, [05](./05-observability.md#alert-rules)) is the defined upgrade trigger. The dedicated cores carry **no steal** — `hot_cpu_steal` should sit ~0; any sustained steal is an isolation regression, not a sizing issue.

## Core-box process boundaries

**Hetzner CPX51 — 16 shared vCPU / 32 GB RAM / 360 GB NVMe** + 200 GB Volume. Each long-lived process is capped so the set fits with headroom. Shared vCPU is fine here — the warm/analytical tier is not the financial hot path.

| Service | Process | Memory cap | CPU budget | Enforced via |
|---|---|---|---|---|
| ClickHouse | 1 process | ~12 GB | 4–6 vCPU | `limits.xml` (`max_memory_usage`, `max_threads=6`) — clickhouse role |
| Redpanda | 1 process (KRaft) | ~5 GB (heap + page cache) | 2 vCPU | `--smp 2 --memory 5G` (Kamal accessory) |
| spread-computer svc | 1 Node process (Kamal app) | ~1.5 GB | 1–2 vCPU | container limits |
| query-api | 1 Node process (Kamal app) | ~1 GB | 1 vCPU | container limits |
| Grafana Alloy + node_exporter + clickhouse-exporter + kamal-proxy | agent + sidecars + proxy | ~0.5 GB | <1 vCPU | systemd / container limits |
| **Total / headroom** | | **~20.5 GB / ~11.5 GB** | fits 16 vCPU | |

~11.5 GB RAM headroom on 32 GB. The split-out spread-computer (~1.5 GB) sits comfortably alongside CH + Redpanda. Redpanda gets more heap (5 GB vs the old 3 GB) now that it no longer shares a host with the Node trader.

## Obs-box process boundaries

**Hetzner CPX41 — 8 shared vCPU / 16 GB RAM / 240 GB NVMe (amd64)** + 40 GB Volume. The backend stack ([05](./05-observability.md#obs-box-backend-stack)). amd64 — upstream obs images (prom/grafana/loki/tempo/pyroscope/glitchtip) all publish amd64.

| Backend | Memory cap | CPU budget | Enforced via |
|---|---|---|---|
| Prometheus (TSDB + rules; ~5.5 k series) | ~2 GB | 1 vCPU | container limits |
| Loki | ~1.5 GB | 1 vCPU | container limits |
| Tempo | ~1 GB | 1 vCPU | container limits |
| Pyroscope | ~1.5 GB | 1 vCPU | container limits |
| Grafana | ~0.5 GB | 0.5 vCPU | container limits |
| Alertmanager | ~0.1 GB | <0.5 vCPU | container limits |
| GlitchTip (web + worker + Postgres + Redis) | ~2.5 GB | 1–2 vCPU | container limits |
| node_exporter (self-monitor) + OS | ~1 GB | 0.5 vCPU | — |
| **Total** | **~10–11 GB** | **~7 vCPU** | |

Headroom on 8 vCPU / 16 GB: ~5 GB RAM. GlitchTip (Django + Postgres + Redis + worker) is the heaviest tenant; if RAM tightens, it is the first candidate to cap or drop. The obs box is **not** latency-critical — backend pauses cost visibility, not trades.

## Core Volume sizing (starts small, grows later)

The Volume (`/mnt/ch-volume`) on the core box holds ClickHouse data + Redpanda data dir. It **ships at 200 GB** and grows via Terraform `size` as fill dictates — it does **not** start at the full 3-day-hot end-state footprint. End-state 3-day raw retention before TTL move to cold:

| Item | Calc | Hot footprint (end-state) |
|---|---|---|
| `orderbooks` raw | 4 ex × ~1500 sym × 1 Hz × ~100 B compressed × 86400 s × 3 d | ~155 GB compressed |
| `spreads` raw | ~9 k rows/s × ~70 B compressed × 86400 × 3 | ~155 GB compressed |
| Rollup chain (spreads + orderbooks) | ~5 % of raw | ~18 GB |
| `trades` | <100 trades/day × ~2 KB | <1 GB |
| `funding_rates` | hourly × 4 ex × ~1500 sym × 90 d × ~50 B | ~50 MB |
| `fees` | static | <1 MB |
| CH metadata + WAL | misc | ~10 GB |
| Redpanda data dir (`ob.ticks` + `spreads.live`, 24 h) | app-rate-dependent estimate (exact recompute owned by datapipeline) | ~30 GB |
| **End-state total on Volume** | | **~320 GB** (estimate; tracks the Redpanda data-dir figure) |

**Ships at 200 GB** (covers the initial bring-up: fewer symbols / shorter live retention while the pipeline ramps). As real fill approaches 80 % (`disk_low` at <40 GB free, [05](./05-observability.md#alert-rules)), expand **200 → 400 → 600 GB** via a Terraform `size` change before extending retention to the full 3-day end-state ([02](./02-provisioning.md#volume-lifecycle); runbook [07](./07-runbooks.md#volume-expand)). Starting small defers the volume cost until the data justifies it.

## Obs-box storage and retention

The Volume (`/mnt/obs-data`) on the obs box holds every backend store. **Ships at 40 GB.** Retention windows ([05](./05-observability.md#obs-box-backend-stack)) sized to keep the working set under 40 GB at current cardinality:

| Store | Retention | Footprint |
|---|---|---|
| Prometheus TSDB (~5.5 k series) | 15 d | ~8 GB |
| Loki chunks (sampled logs) | 7 d | ~12 GB |
| Tempo blocks (sampled traces) | 72 h | ~8 GB |
| Pyroscope profiles | 7 d | ~6 GB |
| GlitchTip Postgres (30 d events) + Redis | 30 d | ~4 GB |
| Grafana + Alertmanager state | — | <1 GB |
| **Total on obs Volume** | | **~39 GB** |

Near-full at 40 GB by design (start-small). The first retention widening or cardinality bump expands `obs-data` (Terraform `size`, 40 → 90 GB). No backups (gap **G10**) — obs data loss on host-rebuild is acceptable (it is telemetry, not trade state).

## Cold tier per year

Raw `orderbooks` + `spreads` age to `arbinet-cold` (CH S3 disk + daily Parquet export; export script app-owned, [`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)). The S3 endpoint is **NBG1** (`nbg1.your-objectstorage.com`).

| Item | Per day | Per year |
|---|---|---|
| `orderbooks` Parquet | ~95 GB raw → ~25 GB Parquet | ~9 TB/yr |
| `spreads` Parquet | ~50 GB raw → ~15 GB Parquet | ~5 TB/yr |
| Rollups (not aged out) | trivial | trivial |
| **Total cold y1** | | **~14 TB** |

(Lower than a naive 35 TB estimate — Parquet + ZSTD on top-N orderbooks compresses well.) Cost — Hetzner Object Storage ~€6/TB-mo:

- Year 1 ramp: ~14 TB → avg ~€42/mo → year-1 total ~€500.
- Year 2 steady: +~14 TB/yr → ~28 TB end of year 2 → ~€170/mo.

If cold cost exceeds budget by year 2: drop top-10 ladder post-day-30, store only BBO → ~5× compression; lower spread retention to top decile; Parquet ZSTD-9.

This bucket is the **only durable data copy** (no backups, gap **G10**): a **core-box** loss keeps only what already aged to `arbinet-cold` (the core box is now the data box — a hot-box loss loses no stored data).

## Budget

Target: **≤ $200/mo infra total** — the ceiling was **raised this session** from $150 to ~$200, justified by the dedicated hot cores (gap **G1** resolved).

| Item | EUR/mo | Note |
|---|---|---|
| Hetzner CCX13 (hot) | ~13.10 | 2 **dedicated** vCPU / 8 GB — hot-path isolation |
| Hetzner CPX51 (core) | ~55.49 | 16 shared vCPU / 32 GB — warm/analytical tier |
| Hetzner CPX41 (obs) | ~25.20 | 8 shared vCPU / 16 GB amd64 (CAX/CX unavailable) |
| Hetzner Volume 200 GB (core) | 8.80 | €0.044/GB-mo; starts small, grows later |
| Hetzner Volume 40 GB (obs) | 1.76 | €0.044/GB-mo; starts small, grows later |
| Hetzner Object Storage (y1 avg ~7 TB) | ~42.00 | ~€6/TB-mo, NBG1 |
| Hetzner Load Balancer | **0.00** | **dropped** — TLS in kamal-proxy on the core box (G5 reversed) |
| Self-hosted observability software | 0.00 | runs on the obs box (no Grafana Cloud / SaaS metrics bill) |
| Misc (egress, snapshots) | ~5.00 | |
| **Total** | **≈ €151.4** | **≈ $164/mo** (at ~1.08 USD/EUR) — **under the $200 ceiling** |

### G1 — budget resolved under the raised ceiling

Three-host total **≈ €151 ≈ $164/mo** vs the raised **≤ $200** ceiling → **~$36/mo of headroom**. The dedicated CCX13 + the obs CPX41 (amd64, since CAX/CX are unavailable) are absorbed; the smaller starting volumes (200/40 GB) and the dropped LB offset most of the CPX41-vs-ARM cost bump. The total grows only as the volumes expand later. Gap **G1** is resolved (see [08](./08-gaps-and-decisions.md#g1)).

## Scaling triggers

| Trigger | Action |
|---|---|
| **Hot-box trader RSS > ~6.5 GB sustained / `hot_mem_high`** | **Upgrade hot box CCX13 → CCX23** (4 vCPU / 16 GB, ~+€12/mo) (gap **G13**) |
| Hot-box CPU steal > 0 sustained (`hot_cpu_steal`) | Dedicated-core isolation regression — open Hetzner ticket; not a sizing change |
| Trader CPU saturates both dedicated cores | Split WS connectors per-exchange (P2 boundary; IPC change to `orderbookManager`) |
| `ob.ticks` produce p99 nears 5 ms / `ob_ticks_drops` | Investigate private-net throughput; tune Redpanda producer batching; the drop-on-timeout protects the trade loop regardless |
| CH ingest backs up (`parts_to_throw_insert`) | Raise `async_insert_threads=4`, raise `kafka_num_consumers` (clickhouse role var) |
| Redpanda heap pressure (core box) | Cut heap 5 GB → 3 GB (redpanda role var); throughput unaffected at our rates |
| Core Volume ≥ 80 % (`disk_low`) | Expand Volume 200 → 400 GB (Terraform), then 600 GB after measured fill |
| Obs Volume ≥ 80 % | Shorten a retention window or expand `obs-data` 40 → 90 GB (Terraform) |
| Obs-box RAM pressure | Cap/drop GlitchTip first; then shorten Tempo/Pyroscope retention |
| Cold cost > budget (y2) | BBO-only post-day-30, lower spread retention, ZSTD-9 |
| Series cardinality nears budget | Prune high-cardinality labels (`sequence_gap_total{symbol}` → `{exchange}`) — [05](./05-observability.md#series-cardinality-budget) |

## Links

- Host / Volume / bucket declarations being sized → [02-provisioning.md](./02-provisioning.md#concrete-resource-table)
- Middleware sizing (CH `limits.xml`, Redpanda flags, chrony) → [03-configuration.md](./03-configuration.md#core-box-middleware-roles)
- Obs backend retention these stores assume → [05-observability.md](./05-observability.md#obs-box-backend-stack)
- Alert thresholds for the triggers above → [05-observability.md](./05-observability.md#alert-rules)
- Volume-expand runbook → [07-runbooks.md](./07-runbooks.md#volume-expand)
- Budget (G1), no-backups (G10), app-split prereq (G12), hot RAM risk (G13) → [08-gaps-and-decisions.md](./08-gaps-and-decisions.md)
- Workloads being sized → [`../datapipeline/01-topology.md`](../datapipeline/01-topology.md), [`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)
</content>
