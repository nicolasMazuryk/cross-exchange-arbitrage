# 08 — Observability (App Instrumentation Contract)

This file is the **app side** of observability: the metric names each pipeline service must expose and the SLI targets the app is accountable for. Collection, scraping, alert rules, dashboards, the metric catalog for middleware/host exporters, and the series-cardinality budget are **infra-owned** and self-hosted (Prometheus / Alertmanager / Loki / Tempo / Grafana) → [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md).

All app services expose `/metrics` via `prom-client` and emit structured JSON logs to stdout (Pino) carrying `trace_id` / `span_id` for cross-signal correlation. The on-host OTel collector scrapes and ships them ([`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#observability_agents)).

## Metric names the app must emit

### Trader (hot box) + SpreadComputer (core box)

The trader runs on the **hot box**; the SpreadComputer is a separate **core-box** app. `ob_ticks_*` and `snapshotter_tick_lag_seconds` below are emitted by the **hot-box** `ob.ticks` sampler (the new cross-box warm seam); the `spread_engine_*` by the core-box SpreadComputer. Broker-side consumer lag for `ob.ticks` is infra-owned (pointer only).

| Metric | Type | Purpose |
|---|---|---|
| `ob_ticks_produce_seconds` | Histogram | Hot-box `ob.ticks` produce duration (new hot-path protective seam) |
| `ob_ticks_drop_total{reason}` | Counter | Hot-box `ob.ticks` drops (≤5 ms drop-on-timeout) |
| `snapshotter_tick_lag_seconds` | Gauge | now − last tick (hot-box sampler) |
| `sequence_gap_total{exchange,type}` | Counter | WS continuity (see note below) |
| `spread_engine_drop_total{reason}` | Counter | Spread drops |
| `spread_engine_rows_emitted_total` | Counter | Throughput |
| `exchange_clock_skew_seconds{exchange}` | Histogram | `ts − ts_exchange` p50/p95 |
| `ws_health{exchange}` | Gauge | 1 = up, 0 = down |
| `arb_opportunities_detected_total{strategy}` | Counter | Engine output |
| `trade_executions_total{result}` | Counter | Hot path — `result` ∈ {`filled`,`partial`,`rejected`,`timeout`,`rollback`} |

> **`sequence_gap_total` is emitted by the WS continuity check** (per-exchange, in the WS adapter — impl later), **not by the pipeline**. It carries no `symbol` label: per-symbol drill-down moves to a trace exemplar, not a label (cardinality — infra [`05`](../infrastructure/05-observability.md#series-cardinality-budget)).

### Trader hot path — tick-to-trade & latency

Anchors (where each is emitted): WS emit `src/adapters/websocket/binance.ts:227`; book apply `src/core/orderbook/orderbookManager.ts:57-128`; detect `src/core/arbitrage/arbitrageEngine.ts:860-1014`; submit/ack/fill `src/core/trading/tradeExecutor.ts:88-488` + `src/core/trading/utils.ts:13-98` (existing `latencyMs` is the histogram source).

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `tick_to_trade_seconds{stage}` | Histogram | s | In-process hot-path decomposition; `stage` ∈ {`ws_recv`,`book_apply`,`opp_detect`,`decision`} |
| `exchange_order_latency_seconds{exchange,phase}` | Histogram | s | Exchange-side RTT/fill; `phase` ∈ {`submit_to_ack`,`ack_to_fill`} |

### Trader hot path — WS health & freshness

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `ws_messages_received_total{exchange,type}` | Counter | — | Message-rate floor; 0 = silent stall |
| `ws_staleness_seconds{exchange}` | Gauge | s | Silent failure: book stale while `ws_health==1` |
| `ws_reconnects_total{exchange}` | Counter | — | Feed flapping |

### Trader hot path — orderbook quality

Anchors: `orderbookManager.ts:57-128` (apply), `:89-105` (top-of-book / crossed-locked), `:130-183` (delta desync → resync), age calc `arbitrageEngine.ts:289`.

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `orderbook_age_seconds{exchange}` | Histogram | s | Book freshness feeding decisions |
| `orderbook_apply_seconds` | Histogram | s | Update-apply latency on hot path |
| `orderbook_crossed_total{exchange}` | Counter | — | Crossed/locked book = bad data |
| `orderbook_resync_total{exchange,reason}` | Counter | — | Delta-before-snapshot desync drops |

### Trader — Node runtime

Via `prom-client` `collectDefaultMetrics()` + `perf_hooks.monitorEventLoopDelay`. Single-threaded trader: loop stalls/GC are the silent tick-killers.

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `nodejs_eventloop_lag_seconds` | Histogram | s | Blocked loop = missed ticks |
| `nodejs_gc_duration_seconds{kind}` | Histogram | s | GC pause stalls the trade loop |
| `nodejs_heap_used_bytes` | Gauge | bytes | App-level leak (OS RSS via node_exporter) |

### Trader — opportunity funnel

Anchors: reject points in `arbitrageEngine.checkDirection` — anomaly `:1048`, depth/volume `:1052-1130`, min-amount `:1154`, quote mismatch `:1137`, persistence `:708-799`, strategy window `:584-676`, confidence `:279-302`.

| Metric | Type | Purpose |
|---|---|---|
| `arb_funnel_total{reason}` | Counter | *Why* opportunities die; `reason` ∈ {`spread_too_small`,`anomaly_spread`,`insufficient_depth`,`min_amount`,`quote_mismatch`,`stale_book`,`persistence_failed`,`outside_window`,`low_confidence`} |
| `arb_opportunities_missed_total{reason}` | Counter | Detected but not acted; `reason` ∈ {`too_slow`,`risk_blocked`,`insufficient_balance`} |

### Trader — execution quality

Anchors: `tradeExecutor.ts:363-488` (placement), `utils.ts:104-134` (slippage), `tradeExecutor.ts:493-598` (rollback), `arbitrageEngine.ts:304-418` (expected edge).

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `order_fills_total{exchange,status}` | Counter | — | Fill/partial/reject rate; `status` ∈ {`filled`,`partial`,`rejected`,`canceled`,`timeout`} |
| `order_reject_total{exchange,reason}` | Counter | — | Reject reasons |
| `trade_slippage_bps{side}` | Histogram | bps | Realized vs expected price |
| `trade_edge_expected_bps{strategy}` | Histogram | bps | Theoretical edge at decision |
| `trade_edge_realized_bps{strategy}` | Histogram | bps | Edge actually captured |
| `trade_rollback_total{reason}` | Counter | — | **P0**: partial-fill unwind / stuck-position risk |

### Trader — risk / inventory

Anchors: `accountStateManager.ts` (positions/balances + `getLastUpdateTime`), `tradeMonitor.ts:41-110` (PnL), `fundingFeeCollector.ts:335-340` (PnL), `maxPositionAmountUsd` (config) drives `exposure_limit_utilization_ratio`, pre-trade gates `tradeExecutor.ts:147-325`. `kill_switch_active`/`circuit_breaker_trips_total` instrument the target risk-halt design.

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `open_positions{exchange}` | Gauge | — | Live inventory count |
| `position_notional_usd{exchange}` | Gauge | USD | Gross exposure |
| `net_exposure_usd` | Gauge | USD | Net delta across venues |
| `exposure_limit_utilization_ratio` | Gauge | ratio | vs `maxPositionAmountUsd` |
| `portfolio_pnl_usd{type}` | Gauge | USD | `type` ∈ {`realized`,`unrealized`} |
| `portfolio_drawdown_usd` | Gauge | USD | Drawdown for stop trigger |
| `venue_balance_usd{exchange}` | Gauge | USD | Balance per venue |
| `account_state_age_seconds{exchange,type}` | Gauge | s | **P0 silent failure**: trading on stale state |
| `kill_switch_active` | Gauge | — | 1/0 — halted? |
| `circuit_breaker_trips_total{reason}` | Counter | — | Why we halted |
| `risk_check_rejections_total{check}` | Counter | — | Pre-trade gate hits; `check` ∈ {`balance`,`active_orders`,`opposite_position`,`max_position`} |

### Trader — strategy health

| Metric | Type | Unit | Purpose |
|---|---|---|---|
| `open_trades{strategy,variant}` | Gauge | — | Live trade count |
| `trade_hold_duration_seconds{exit_reason}` | Histogram | s | Hold time by exit path; `exit_reason` ∈ {`take-profit`,`convergence`,`spread-widening`,`timeout`,`manual`,`error`} |
| `funding_collected_usd_total` | Counter | USD | Funding-arb realized income |

### Query API

`qapi_http_duration_seconds{route}` (histogram), `qapi_ws_clients`, `qapi_ws_messages_pushed_total{channel}`, `qapi_ch_errors_total{route}`, `qapi_cache_hits_total{route}`.

> Middleware/host series (`redpanda_*`, `clickhouse_*`, `node_*`, `chrony_*`) come from native endpoints / exporters wired by infra, **not** emitted by app code — see the [infra metric catalog](../../intents/infrastructure/observability-stack.md#metric-catalog).

## SLI targets the app is accountable for

| SLI | Target |
|---|---|
| `ob.ticks` warm-hop | Hot-box produce p99 < 5 ms; core-box consume lag bounded (< 1 s) |
| Sampler tick lag | < 1 s p99 |
| `ob.ticks` hot-box drop rate | < 0.1 % over 5 min |
| Spread emit drop rate | < 0.1 % over 5 min |
| Exchange clock skew | < 200 ms p95 |
| Query API latency | < 500 ms p95 HTTP, < 100 ms WS push age |
| WS health | > 99 % per exchange |
| Internal tick-to-trade (`ws_recv`→`decision`) | < 5 ms p99 |
| Opportunities acted within budget | > 95 % acted < 250 ms |
| WS staleness | < 2 s p99 per exchange |
| Event-loop lag | < 50 ms p99 |
| Order fill rate | > 90 % `filled`/submitted |
| Slippage | p95 < 10 bps |
| Account-state freshness | < 30 s |

These targets are turned into recording rules + burn-rate alerts by infra; the full SLO/alert set (incl. CH consumer lag, MV freshness, disk) is in [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md#slis--slos).

## Links

- Metrics produced by → [02](./02-snapshotter.md), [06](./06-spreads-engine.md), [07](./07-query-api.md)
- Collection / alerts / dashboards / cardinality → [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md)
- Collection agents → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#observability_agents)
