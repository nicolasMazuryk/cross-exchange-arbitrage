# ARBINET Orderbook Pipeline — Design Index

## Purpose

Design the **warm path** and **cold path** that hang off the existing hot trading loop:

- **Hot path** (sealed, unchanged): WS connectors → `orderbookManager` → `arbitrageEngine` → `tradeExecutor`.
- **Warm path** (this design): hot-box 1 Hz `ob.ticks` sampler → core-box Redpanda → {CH Kafka engine → `orderbooks` (serviceless raw path); core-box SpreadComputer → `spreads.live` → CH} → ClickHouse (raw + rollups) → Node query API → trader UI + Grafana.
- **Cold path**: ClickHouse TTL → Hetzner Object Storage Parquet → backtest read via `s3()` table function.

Plus: full **Redis → ClickHouse migration** (Redis removed from repo).

## Audience

Engineers implementing P1/P2/P3. Read top-to-bottom for end-to-end picture; each file is self-contained for focused work.

## How to read

1. Start with [01-topology.md](./01-topology.md) for service map.
2. Then `ob.ticks` sampler → buffer → schemas → rollups → spreads engine for warm path build order.
3. [11-redis-removal.md](./11-redis-removal.md) is the only file with src/ touch points; everything else is greenfield.
4. [12-phasing-and-risks.md](./12-phasing-and-risks.md) is the milestone tracker.

## Decisions table (captured from interview)

App-level decisions only. **Infrastructure decisions** (host SKU, observability stack, budget, local-dev runtime) live in [`../../intents/infrastructure/README.md`](../../intents/infrastructure/README.md#infra-decisions-table) and [`capacity-and-cost.md`](../../intents/infrastructure/capacity-and-cost.md).

| Topic | Decision |
|---|---|
| Raw record path | Hot-box thin 1 Hz sampler publishes `ob.ticks` to core-box Redpanda (≤5 ms drop); CH Kafka engine consumes `ob.ticks` → `orderbooks` directly (serviceless); SpreadComputer is the only core-box warm service, consuming `ob.ticks` → `spreads.live` |
| WS connectors | In-process for P1; design fan-out boundary for per-exchange process split in P2 |
| Snapshot depth | Top-10 levels |
| Spread cadence | 1 Hz, wall-clock aligned (`Date.now() % 1000`); `spreads.ts == orderbooks.ts` |
| Spread emission filter | All cross-listed pairs always; `stale` flag when leg `ts_exchange` > 2000 ms old; negative `spread_bps` preserved |
| `spread_costs_bps` | `ob_spread_bps(buy_leg) + ob_spread_bps(sell_leg)` for spot-perp & perp-perp; `0` for spot-spot |
| `spreads.latency` | Per-leg `latency_buy_ms`, `latency_sell_ms` (Int32) |
| Sequence gap | `sequence_gap Bool` column on `orderbooks` |
| Drop policy | Hot-box `ob.ticks` producer blocks ≤5 ms on Redpanda produce, then drops tick. Producer buffer cap ~64 MB. Drop counter exported. Core-box producers (loopback) relaxed |
| Backfill | None. Accept gaps. Mark discontinuity in CH on restart |
| Cold tier layout | `s3://bucket/orderbooks/date=YYYY-MM-DD/*.parquet` (full-day scans) |
| `funding_rates` ingest | CCXT `fetchFundingRateHistory()` per exchange, hourly at HH:02:00 |
| `fees` table | Static reference (exchange × market_type × order_type) |
| `trades` | Migrate Redis → ClickHouse fully. Remove Redis from repo |
| Query API | Node/TS, separate process, `X-API-Key` header auth |
| Cold UI latency | Seconds-to-tens acceptable |
| Retention | 3-day raw in CH; rollups same; `funding_rates` cold-tiered at 90 d; cold tier indefinite |
| Partition keys | Cross-exchange tables/MVs/topics carry `buy_market_type` + `sell_market_type` (one symbol may stream from spot and perp simultaneously) |
| Pair stats / persistance | Trailing 24 h rolling window refreshed every 1 minute (gate to 5 min on CPU pressure); `spread_persistance_24h` replaces `half_life_1h` with `entry_persistance` + `exit_decay` quantiles |

## Infrastructure prerequisite

This pipeline runs **on top of** the infrastructure task (provision → configure → deploy → observe) specified in [`../../intents/infrastructure/README.md`](../../intents/infrastructure/README.md), which is built **first**. Host/CH/Redpanda sizing, storage policy, TLS ingress, secrets, deployment, and the observability stack live there; this design names them as prerequisites via pointers.

## Phase pointer map

- **P1**: `ob.ticks` sampler, Redpanda, CH `orderbooks` (Kafka engine, serviceless) + 1s/15s/1m rollups, `ops_events`, `fees` seed, SLI metrics → see [02](./02-snapshotter.md), [03](./03-buffer-redpanda.md), [04](./04-clickhouse-schemas.md), [05](./05-rollups-and-mvs.md), [08](./08-observability.md).
- **P2**: spreads engine + table + rollups + MVs, `funding_rates` ingest, `trades` table + Redis removal, query API + WS fanout → see [06](./06-spreads-engine.md), [07](./07-query-api.md), [11](./11-redis-removal.md).
- **P3**: cold-path Parquet finalized, backtest read patterns, prototype backtester (separate doc) → see [10](./10-cold-path.md), [12](./12-phasing-and-risks.md).

## Glossary

| Term | Meaning |
|---|---|
| Hot path | Synchronous trade decision loop. Latency-critical. Outside the trader process: exchange WS/REST, plus one async, bounded ≤5 ms `ob.ticks` publish to core-box Redpanda, and trade-state persist/restore to core-box ClickHouse |
| Warm path | Async snapshot/spread pipeline feeding analytics & UI. Must not back-pressure hot path |
| Cold path | Archival Parquet on Hetzner Object Storage, queried on demand for backtesting |
| Top-N | Snapshot of top N bid/ask price levels per side; here N=10 |
| BBO | Best Bid / Best Offer — top-of-book (level 1) |
| Rollup tier | Time-bucketed aggregation table; 1s/3s/5s/15s/1m for ARBINET |
| AggregatingMergeTree | ClickHouse engine storing intermediate aggregate states (`-State`) for fast roll-forward |
| Sequence gap | Per-exchange WS-adapter continuity flag (set on `finalUpdateId` discontinuity in the adapter), carried on `ob.ticks` as a 1 s-window discontinuity flag — indicates lost WS updates. No gap math on the 1 Hz sample |
| Stale leg | A spread leg whose `ts_exchange` is > 2000 ms behind wall-clock at emit time |
| MV chain | Materialized-view sequence where each tier consumes its parent (raw → 3s → 15s → 1m) |

## File map

- [01-topology.md](./01-topology.md) — service map, hot/warm/cold boundaries, failure isolation
- [02-snapshotter.md](./02-snapshotter.md) — `ob.ticks` sampler design, ts dual-stamp, drop policy
- [03-buffer-redpanda.md](./03-buffer-redpanda.md) — single-broker KRaft, topics, retention, ingest pattern
- [04-clickhouse-schemas.md](./04-clickhouse-schemas.md) — all table DDLs (references infra-defined `tiered` storage policy)
- [05-rollups-and-mvs.md](./05-rollups-and-mvs.md) — 1s/3s/5s/15s/1m rollups, MV chain, resolver
- [06-spreads-engine.md](./06-spreads-engine.md) — `SpreadComputer`, formulas, stale handling
- [07-query-api.md](./07-query-api.md) — endpoints, WS fanout, auth, caching
- [08-observability.md](./08-observability.md) — app instrumentation contract (metric names + app SLI targets)
- [10-cold-path.md](./10-cold-path.md) — S3 disk, TTL TO VOLUME, Parquet layout, daily export, backtest read
- [11-redis-removal.md](./11-redis-removal.md) — file-by-file Redis purge
- [12-phasing-and-risks.md](./12-phasing-and-risks.md) — milestones, acceptance, risks, open questions

Infrastructure (provision/configure/deploy/observe) → [`../../intents/infrastructure/`](../../intents/infrastructure/README.md).
