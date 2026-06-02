# Capacity & Cost — Arbinet Single-Host Sizing

Resource boundaries, sizing math, retention footprints, and budget for the single Hetzner host that runs the Arbinet trader + orderbook data pipeline. Serves as the capacity contract for the workloads specified in `../../specs/datapipeline/` (snapshotter, spreads engine, ClickHouse, Redpanda, query API).

All figures assume the host and middleware sizing declared in [infrastructure-provisioning.md](./infrastructure-provisioning.md) and [ansible-configuration.md](./ansible-configuration.md).

## Process resource boundaries

Single host: **Hetzner CPX62 — 16 vCPU / 32 GB RAM / 360 GB NVMe** + 1× attached Volume. Each long-lived process is capped so the set fits within RAM with burst headroom.

| Service | Process | Memory cap | CPU budget | Enforced via |
|---|---|---|---|---|
| Trader (WS + orderbookManager + arbitrageEngine + tradeExecutor + snapshotter + spread computer) | 1 Node process (Kamal app) | ~12 GB | 6–8 vCPU | container limits |
| Redpanda | 1 process (KRaft) | 3 GB heap + ~2 GB page cache | 2 vCPU | `--smp 2 --memory 3G --reserve-memory 0M` (Kamal accessory) |
| ClickHouse | 1 process | ~12 GB | 4–6 vCPU | `limits.xml` (`max_memory_usage`, `max_threads=6`) — see ansible clickhouse role |
| Query API | 1 Node process (Kamal app) | 1 GB | 1 vCPU | container limits |
| Observability agents (OTel collector / Alloy + node_exporter + clickhouse-exporter) | sidecars | ~200 MB total | <0.5 vCPU | container limits |

Headroom on 16 vCPU / 32 GB: ~2 GB RAM and 1–2 vCPU left for bursts.

## Volume sizing math (3-day hot)

The attached Volume (mounted `/mnt/ch-volume`) holds ClickHouse data + Redpanda data dir. 3-day raw retention before TTL move to cold tier.

| Item | Calc | Hot footprint |
|---|---|---|
| `orderbooks` raw | 4 ex × ~1500 sym × 1 Hz × ~100 B compressed × 86400 s × 3 d | ~155 GB compressed |
| `spreads` raw | ~9 k rows/s × ~70 B compressed × 86400 × 3 | ~155 GB compressed |
| Rollup chain (spreads + orderbooks) | ~5 % of raw | ~18 GB |
| `trades` | <100 trades/day × ~2 KB | <1 GB |
| `funding_rates` | hourly × 4 ex × ~1500 sym × 90 d × ~50 B | ~50 MB |
| `fees` | static | <1 MB |
| CH metadata + WAL | misc | ~10 GB |
| Redpanda data dir | 24 h × ~10 MB/s effective | ~80 GB |
| **Total on Volume** | | **~370 GB** |

Volume ships at **400 GB** → ~30 GB headroom. Per-day growth tracked via the `disk_low` alert (see [observability-stack.md](./observability-stack.md)). At 80 % fill: expand Volume to 600 GB before extending retention; scale to 1 TB after measured growth. Volume resize is a Terraform change ([infrastructure-provisioning.md](./infrastructure-provisioning.md)).

## Cold tier per year

Raw `orderbooks` + `spreads` age to the Hetzner Object Storage bucket `arbinet-cold` (CH S3 disk + daily Parquet export — export *script* owned by the app, see `../../specs/datapipeline/10-cold-path.md`).

| Item | Per day | Per year |
|---|---|---|
| `orderbooks` Parquet | ~95 GB raw → ~25 GB Parquet | ~9 TB/yr |
| `spreads` Parquet | ~50 GB raw → ~15 GB Parquet | ~5 TB/yr |
| Rollups (not aged out) | trivial | trivial |
| **Total cold y1** | | **~14 TB** |

(Lower than a naive 35 TB estimate because Parquet + ZSTD on top-N orderbooks is highly compressible.)

Cost model — Hetzner Object Storage ~€6/TB-mo:

- Year 1 ramp: ~14 TB → avg ~€42/mo → year-1 total ~€500.
- Year 2 steady: +~14 TB/yr → ~28 TB end of year 2 → ~€170/mo.

If cold cost exceeds budget by year 2:

- Drop top-10 ladder post-day-30, store only BBO (`best_*` columns) → ~5× compression.
- Lower spread retention to top decile only.
- Parquet-with-ZSTD level 9 (cheaper storage, slower read).

## Budget

Target: **≤ $150/mo infra total.**

| Item | EUR/mo | Note |
|---|---|---|
| Hetzner CPX62 | 54.49 | server-pricing.com confirmed |
| Hetzner Volume 400 GB | 17.60 | €0.044/GB-mo |
| Hetzner Object Storage (y1 avg ~7 TB) | ~42.00 | ~€6/TB-mo |
| Hetzner Load Balancer (Query-API ingress) | ~5.39 | LB11 |
| Self-hosted observability | 0.00 | runs on the same host (no Grafana Cloud / SaaS metrics bill) |
| Misc (egress, snapshots) | ~5.00 | |
| **Total** | **~€125** | **≈ $135/mo** |

> Ships with Volume 400 GB; expand to 600 GB at 80 % fill, then 1 TB after measured growth. Self-hosting the OTel stack trades a SaaS metrics bill for host RAM/CPU (budgeted in process boundaries above) — no per-series cost ceiling.

## Capacity headroom & scaling triggers

| Trigger | Action |
|---|---|
| Trader CPU ≥ 8 vCPU sustained | Split WS connectors per-exchange (P2 boundary; IPC change to `orderbookManager`) |
| CH ingest backs up (`parts_to_throw_insert`) | Raise `async_insert_threads=4`, raise `kafka_num_consumers` (clickhouse role var) |
| Redpanda heap pressure | Cut heap 3 GB → 1.5 GB; throughput unaffected at our rates (redpanda role var) |
| Volume ≥ 80 % | Expand Volume 400→600 GB (Terraform), then 1 TB after measured fill |
| Cold cost > budget (y2) | BBO-only post-day-30, lower spread retention, ZSTD-9 (see cold tier above) |
| Series cardinality nears budget | Prune high-cardinality labels (e.g. `sequence_gap_total{symbol}` → `{exchange}`) — see [observability-stack.md](./observability-stack.md) |

## Links

- Host + Volume + bucket declarations → [infrastructure-provisioning.md](./infrastructure-provisioning.md)
- Middleware sizing (CH `limits.xml`, Redpanda flags) → [ansible-configuration.md](./ansible-configuration.md)
- Alert thresholds for the triggers above → [observability-stack.md](./observability-stack.md)
- Workloads being sized → `../../specs/datapipeline/` ([01-topology](../../specs/datapipeline/01-topology.md), [03-buffer-redpanda](../../specs/datapipeline/03-buffer-redpanda.md), [04-clickhouse-schemas](../../specs/datapipeline/04-clickhouse-schemas.md), [10-cold-path](../../specs/datapipeline/10-cold-path.md))
