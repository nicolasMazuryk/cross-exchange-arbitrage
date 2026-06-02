# 12 — Phasing, Acceptance, Risks

## Infra prerequisite

All phases below assume the **infrastructure task is already live**: provisioned host + Volume + bucket + LB (Terraform), configured middleware (Ansible `chrony` / `clickhouse` / `redpanda` / observability roles), and the deploy pipeline (Kamal, `bootstrap.sql` execution, self-hosted OTel stack). That task is specified in [`../../intents/infrastructure/README.md`](../../intents/infrastructure/README.md) and is built **first**. The phases here cover **app deliverables** only; infra items (server/CH/Redpanda sizing, storage policy, TLS ingress, dashboards/alerts) are referenced as prerequisites, not re-specified.

## Phase P1 — Warm path foundation (~2 weeks)

Deliverables:

- [ ] `ob.ticks` sampler + `TickScheduler` ([02](./02-snapshotter.md)).
- [ ] Topic `ob.ticks` created on the (infra-provided) Redpanda broker; CH `orderbooks` Kafka engine consumes `ob.ticks` directly (serviceless) ([03](./03-buffer-redpanda.md)).
- [ ] `orderbooks`, `ops_events`, `fees`, `funding_rates` tables ([04](./04-clickhouse-schemas.md)) on the (infra-provided) CH node with `storage_policy='tiered'`.
- [ ] `fees` seed SQL committed (part of `bootstrap.sql`).
- [ ] `orderbooks_spread_3s/15s/1m` rollups + MV chain ([05](./05-rollups-and-mvs.md)).
- [ ] Prometheus `prom-client` wired in trader, `ob.ticks` sampler SLI metrics surfaced ([08](./08-observability.md)).
- _Infra prereq:_ CH + Redpanda installed/sized, `tiered` storage policy, hot/warm/capacity dashboards → [`../../intents/infrastructure/`](../../intents/infrastructure/README.md).

Acceptance:

- `SELECT count() FROM orderbooks WHERE ts > now()-INTERVAL 1 MINUTE` returns ~6k × 60 rows.
- `ob_ticks_drop_total` < 0.1 % over 1-hour run.
- `mv_freshness_seconds{view="orderbooks_spread_15s"}` < 30 s.
- Trader hot-path latency unchanged (compare `trade_executions_total` rate and existing latency histograms vs pre-change baseline).

## Phase P2 — Spreads, trades, query API (~3 weeks)

Deliverables:

- [ ] `SpreadComputer` + `FeesCache` ([06](./06-spreads-engine.md)).
- [ ] `spreads.live` topic, `spreads` table + chained rollups ([04](./04-clickhouse-schemas.md#spreads), [05](./05-rollups-and-mvs.md)).
- [ ] `pair_stats_24h`, `spread_persistance_24h` scheduled `INSERT SELECT` jobs (1-min cadence, trailing 24 h).
- [ ] `funding_rates` hourly ingest cron (HH:02:00).
- [ ] `trades` table + `TradeStateClickhouse` ([11](./11-redis-removal.md)).
- [ ] **Full Redis removal** per file-by-file plan ([11](./11-redis-removal.md)).
- [ ] Query API service + endpoints + WS fanout + coalescer ([07](./07-query-api.md)).
- [ ] Single-user API-key auth in place.
- _Infra prereq:_ Hetzner LB TLS termination for query API; dashboards updated with `qapi_*` + spread metrics → [`../../intents/infrastructure/`](../../intents/infrastructure/README.md).

Acceptance:

- `SELECT count() FROM spreads WHERE ts > now()-INTERVAL 1 MINUTE` ≈ 9k × 60 rows.
- `spreads.ts` exactly matches a corresponding `orderbooks.ts` for the same wall-clock tick (sample 10 rows, assert equality).
- `GET /spreads/history` with 24 h range, 1200 px returns in < 1 s p95, hits `spreads_1m`.
- `GET /trades?status=open` returns same set as `tradeMonitor.inMemory`.
- `grep -ril redis src/` returns empty.
- Trader graceful restart restores open trades from CH (verified in [11](./11-redis-removal.md#verification-checklist)).

## Phase P3 — Cold path & backtest (~1 week + iteration)

Deliverables:

- [ ] Daily Parquet export cron ([10](./10-cold-path.md)).
- [ ] Object layout validated by external `s3()` query from a sample notebook.
- [ ] Backtester prototype doc (separate file `plans/backtest-prototype.md`, out of scope here).
- [ ] Cold-path read latency measured & documented (full-day scan benchmark).
- [ ] Decision: keep both native S3 disk + Parquet, or drop native after watermark ([10](./10-cold-path.md#s3-disk-format-vs-parquet-format)).

Acceptance:

- Day-old data queryable via `s3('.../orderbooks/date=YYYY-MM-DD/*.parquet', 'Parquet')` within 30 s for a single pair filter.
- TTL `TO VOLUME 'cold'` confirmed by `SELECT disk_name FROM system.parts WHERE table='orderbooks' AND active`.
- Object storage cost projection refreshed against actual fill rate.

## Open questions / prototype needs

1. **CH ingest sustained throughput** on the production host with co-resident Node trader. Target ~10 k rows/s `orderbooks` + ~9 k rows/s `spreads`. **Prototype**: synthetic insert harness for 1 hour pre-P1 ship. Risk: if CH hits `parts_to_throw_insert`, async insert tuning needed.
2. **Snapshot read latency from in-memory map** for 1500 symbols. Need < 50 ms to stay safely inside 1 Hz tick. **Prototype**: benchmark `orderbookManager.getAllOrderbooks()` with synthetic 1500-symbol load.
3. **Redpanda heap pressure** at 32 GB total RAM with CH and Node. Cap at 2 GB heap initially; observe `redpanda_memory_*`. May need to drop to 1.5 GB.
4. **WS-per-exchange split**: in P2, do we need IPC change to `orderbookManager`? Likely yes — shared memory ring or Unix-socket gRPC. Defer concrete design until trader CPU hits 8 vCPU sustained.
5. **`spread_persistance_24h` episode detection** via windowed CTE may be CPU-heavy at 1-min cadence over trailing 24 h. If the job > 5 % CPU, fall back to 5-min cadence.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Core-box outage stalls warm path + trade-state persist (SpreadComputer is the lone warm service, off-box; raw `ob.ticks`→`orderbooks` path serviceless; **no shared fate** with trader) | low | medium | Trader keeps trading, drops `ob.ticks`; kamal health-check + restart, hot box reconciles on recovery |
| Single-node CH loss → 7 d hot data gone | low | medium | Cold tier has up to 24 h-old data. Recovery hours, not days |
| Redpanda single-node disk fill | medium | medium | Retention caps + alert at <50 GB free |
| Self-hosted metrics series growth strains host RAM | low | low | ~4-5 k series; label-pruning plan documented in [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md#series-cardinality-budget) |
| Hetzner egress overage from cold reads | medium | low | Backtester rehydrates to local before iterative queries |
| Clock drift breaks 1 Hz alignment | low | medium | chrony monitored, alert at >200 ms p95 |
| `FINAL` cost on `trades` reads | low | low | Wrap with `argMax`-projection view if seen in p95 latency |
| CH version upgrade breaks AggregatingMergeTree state | low | high | Pin CH version, test upgrade in staging before prod |
| Parquet export job slower than 1 day | medium | medium | Chunk by hour; alert on export duration > 30 min |
| Cost overrun > $150/mo | low | low | Volume starts at 400 GB; expand to 600 GB / 1 TB after measured fill; Object Storage growth budgeted |

## Decision log pointers

All design decisions captured in [README.md decisions table](./README.md#decisions-table-captured-from-interview). When a decision changes, update README and the relevant file together.

## Links

- All design files indexed in [README.md](./README.md#file-map).
