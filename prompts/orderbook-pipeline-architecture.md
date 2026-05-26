# ARBINET — Orderbook Ingestion Pipeline: Architect Brief

## Your role
You are the best technical architect. You are designing the system end-to-end, not implementing it: 1 Hz orderbook snapshots → durable buffer → ClickHouse (raw + rollups) → query API → fanout to the trader UI and Grafana.

## System context
ARBINET is an automated crypto price-arbitrage trading system. WebSocket connectors maintain in-memory L2 orderbooks for **>15 exchanges × ~1,500 symbols**, with 50–100 ms update cadence per book. The **hot path** (spread detection, order routing, execution) is owned by the trading engine and is **out of scope**. Your warm path must never back-pressure it, under any load or failure mode. A **cold path** (S3/Parquet for backtesting) sits downstream of you.

## Inputs
1. **`orderbook-ingestion.md`** — seed design, phased P1 (snapshots) → P2 (cross-exchange spreads, profitability, observability) → P3 (backtesting). Includes a proposed Redpanda + ClickHouse topology, draft schemas, rollup strategy, and several open questions. **Treat this as a hypothesis, not a finished spec.** It has known gaps — for example, `spread_costs` semantics across strategies (spot-spot vs. spot-perp vs. perp-perp) are muddled, retention/backfill policy is hand-wavy, and the sizing numbers need re-validation at the agreed scale. Validate, challenge, and complete it.
2. **`trader-ui-spec.md`** — **reference only, out of scope.** Read it to understand the read-side query patterns your storage and query layer must serve: Top-50 live spreads table, per-pair historical spread chart with TradingView-style multi-resolution scroll-back (50 series, 1 s tick, 24 h jank-free), regime/distribution stats, depth ladders, persistence and half-life analytics. The UI will be built later; your job is to make it feasible without expensive aggregates on raw snapshots at query time.

## Deliverable
A design document, phased to match P1/P2/P3 in the seed, covering at minimum:

1. **Topology** — components, data flow, hot/warm boundary, failure isolation. Diagram welcome (ASCII or Mermaid).
2. **Snapshotter** — non-blocking read from `orderbookManager`; wall-clock alignment across hosts; dual timestamps (`ts_exchange`, `ts_snapshot`) and how the delta surfaces as a data-quality signal; top-N choice (N=10 is the starting hypothesis — justify any deviation); drop policy under load; Redpanda emit format; partitioning/keying.
3. **Buffer (Redpanda)** — topics, partitions, retention (seed proposes 24 h — confirm or revise), replay semantics on snapshotter restart, exactly-once vs. at-least-once trade-off into ClickHouse.
4. **ClickHouse — raw + rollups** — finalize the `orderbooks` table and the rollup tiers (1s/3s/5s/15s/1m/…). For every choice that matters (ORDER BY key, partitioning, codecs, TTL, AggregatingMergeTree state functions, MV chains), justify or revise the seed. Specify how query resolution is selected from `time_range / pixel_width`.
5. **Spreads & profitability (P2)** — validate compute-on-write for the ~45k spread streams/s implied by C(15,2) × ~1,500 symbols (re-derive the number; the seed uses an older count). Specify where it runs (in-process service alongside the snapshotter vs. dedicated stream processor), how multi-leg BBOs are joined, and the `spreads` schema. **Clearly define `spread_costs` per strategy** (spot-spot, spot-perp, perp-perp), including which legs hold positions and which don't. Specify the fee/cost reference table (exchange × marketType × orderType).
6. **Query API** — thin layer over ClickHouse. Endpoints, resolution-selection logic, caching strategy on rollup tables, and the WebSocket fanout that pushes live deltas (not full state) to the UI.
7. **Observability (P2)** — Grafana SLIs and alert thresholds: ingest lag, snapshot drop rate, CH write rate, per-host clock skew, per-exchange WS health, sequence gaps, rollup MV freshness.
8. **Operational plan** — concrete (not hand-waved) plans for: clock discipline (chrony/PTP) across all snapshotter hosts; backfill and gap policy on snapshotter crash; capacity sizing (validate the seed's "~25–35 GB/day after compression" at the agreed scale, project 30 days raw + all rollups); cold-path handoff to S3/Parquet for P3 backtesting.
9. **Risks, open questions, and deferred decisions** — be explicit about what you don't yet know and what needs a prototype.

## Style
- Challenge the seed where it's wrong. The author expects pushback, not stenography.
- Concrete numbers over adjectives. Show the math behind any performance claim.
- When you pick option A, name option B and say why you rejected it. Trade-offs over verdicts.
- Phase your output to P1/P2/P3 so engineering can sequence work.