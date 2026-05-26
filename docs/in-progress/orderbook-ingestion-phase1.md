ARBINET — Orderbook Ingestion Design

# PHASE 1

1. Where the warm path sits
Three logical paths in our system. Don't conflate them:

- Hot path — WebSocket connectors maintain in-memory L2 orderbooks, arbitrageEngine detects spreads and fires execution. Microsecond budget. Owned by the trading engine.
- Warm path (this task) — 1 Hz snapshots → ClickHouse → analytics → charts. Seconds budget. Must not back-pressure the hot path.
- Cold path — long-term archive (Parquet on S3) for strategies backtesting.

The single most important architectural rule: the snapshotter reads from the hot path's in-memory orderbook (orderbookManager), never the WebSocket stream directly, and writes through a buffer (Redpanda) so a slow ClickHouse ingest can't stall trading.


WS Connectors ─► In-mem L2 books ─► Spread Detector ─► Execution  (HOT)
                       │
                       ▼ (1 Hz sampler, non-blocking)
                  Snapshotter ─► Redpanda topic: ob.snapshots
                                        │
                            ┌───────────┼───────────┐
                            ▼           ▼           ▼
                   ClickHouse          WS Fanout
                   (Redpanda engine)   to UI
                            │           │
                            ▼           ▼
                    Raw + Rollups   
                            │
                            ▼
                   Query API ──► React/TradingView Charts  (trader UI)
                            └──► Grafana                    (ops UI)


2. Snapshot strategy — what you actually persist at 1 Hz

You do not want to persist the full book. You want top-N levels (I'd start with N=10). That's enough for spread analytics and depth-weighted execution sizing.

Two non-obvious things:
- Align snapshots to the wall clock, not to the time the snapshotter happens to wake up. Otherwise cross-exchange comparisons at the same t are off by 100–800 ms and your spread numbers lie. The sampler ticks at ceil(now, 1s) and reads each book at that instant.
- Capture two timestamps: ts_exchange (from the venue's last update) and ts_snapshot (your wall clock). The delta between them is itself a quality signal — if Binance is 2 s behind, every Binance-vs-X spread at that tick is suspect.


3. ClickHouse schema
Raw snapshots — one row per (exchange, symbol, second):

[define the performant, optimized `orderbooks` table schema here, for example:]

CREATE TABLE orderbooks (
    ts            DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(3)),
    ts_exchange   DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(3)),
    market_type   LowCardinality(String),
    exchange      LowCardinality(String),
    symbol        LowCardinality(String),
    best_bid      Float64 CODEC(Gorilla, ZSTD(3)),
    best_ask      Float64 CODEC(Gorilla, ZSTD(3)),
    best_bid_qty  Float64 CODEC(Gorilla, ZSTD(3)),
    best_ask_qty  Float64 CODEC(Gorilla, ZSTD(3)),
    bids          Array(Tuple(Float64, Float64)),  -- top-N
    asks          Array(Tuple(Float64, Float64)),
    spread_bps    Float64 MATERIALIZED ((best_ask - best_bid) / best_bid) * 10000
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (symbol, exchange, ts)
TTL ts + INTERVAL 14 DAY TO VOLUME 'cold'  -- then Parquet/S3
SETTINGS index_granularity = 8192;


Notes that matter:

ORDER BY (symbol, exchange, ts) — the dominant query pattern is "give me one symbol across all exchanges over a time window," so symbol leads. Reverse it if your hottest query is "everything on one exchange."
Gorilla codec on price/size columns — Facebook's time-series codec, often 10× on slowly-varying floats. DoubleDelta + ZSTD on timestamps.
LowCardinality(String) on exchange/symbol — saves memory and speeds GROUP BYs by 5–10×.

Sizing sanity check: 10 × 1000 × 1 Hz = 10k rows/s = ~864 M rows/day. Top-10 book is ~250 B/row uncompressed, ~25–35 GB/day after ClickHouse compression.


6. Making the charts fast — the multi-resolution trick
This is how TradingView is fast and how yours should be too. Don't query 1 Hz data for a 30-day chart.
Pre-aggregate via ClickHouse materialized views into rollup tables:

spreads        (1 s, raw, 30 day TTL)
spreads_3s    (3 s buckets, AggregatingMergeTree, 30 day)
spreads_5s     (5 s buckets, 30 day)
spreads_15s     (15 s buckets, 30 day)
spreads_1m     (5 m buckets, 30 day)

Each rollup keeps OHLC-style aggregates on spread_bps: open/high/low/close, sum of exec opportunities. Now the chart picks the right table based on time_range / pixel_width — exactly the TradingView model.

Use AggregatingMergeTree with AggregateFunction columns so the rollups self-merge correctly:

CREATE MATERIALIZED VIEW spreads_1m_mv
TO spreads_1m
AS SELECT
    toStartOfMinute(ts)                AS ts,
    symbol, buy_exchange, sell_exchange,
    argMinState(spread_bps, ts)        AS open_bps,
    maxState(spread_bps)               AS high_bps,
    minState(spread_bps)               AS low_bps,
    argMaxState(spread_bps, ts)        AS close_bps,
    avgState(spread_bps)               AS avg_bps,
FROM spreads
GROUP BY ts, symbol, buy_exchange, sell_exchange;


7. Visualization 

TradingView Lightweight Charts + custom React shell - Trader-facing spread analyzer — the thing your users will actually use to make decisions

Perspective (FINOS) - Streaming tabular + chart hybrid; great for "leaderboard of top 50 live spreads" panel

Custom React app (Next.js) with TradingView Lightweight Charts for the trader view. Three panels: top 50 live spreads (Perspective table or virtualized HTML table), per-pair historical spread chart (Lightweight Charts). Live data comes via WebSocket fanout (push only deltas, not full state); historical comes via a thin query API in front of ClickHouse with aggressive caching on the rollup tables.


8. Things to nail down before implementation:

1. Clock discipline — every snapshotter host on chrony/PTP. Cross-exchange spread analytics are worthless without ±10 ms sync.
2. Retention tiers — 30 days of 1 s data in ClickHouse, raw shipped to S3 Parquet for cold queries via s3() table function.
3. Backfill story — when (not if) the snapshotter crashes, do you reconstruct from Redpanda retention, or accept gaps? I'd give Redpanda 24 h retention and replay on restart.













# PHASE 2 Cross-exchange spreads and profitability — compute and store

4. (PHASE 2) Cross-exchange spreads and profitability — compute and store
For C(10,2) = 45 venue pairs × ~1000 symbols = 45k spread streams. You have two choices:

Compute on read — flexible, no extra storage, but every chart query joins the snapshots table against itself. Slow at scale.
Compute on write — the snapshotter (or a small stream processor right after) emits cross-exchange spread rows and profitability calculation. Charts read them directly.

Take option B. The hot path already knows current best bid/ask for every (exchange, symbol); fanning those into a small in-process service that maintains a Map<symbol, Map<exchange, BBO>> and emits 45 spread rows per symbol per second is trivial and gives you 10× faster chart queries.

We may need to create a separate table with the fee structure for each exchange/marketType/orderType. For example, binance/spot/limit, etc.


CREATE TABLE spreads (
    ts             DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(3)),
    latency        DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(3)), -- (ts - min(ts_exchangeA, ts_exchangeB))
    symbol         LowCardinality(String),
    buyMarketType  LowCardinality(String), 
    sellMarketType LowCardinality(String), 
    buy_exchange   LowCardinality(String),  -- where you BUY (low ask)
    sell_exchange  LowCardinality(String),  -- where you SELL (high bid)
    buy_ask        Float64,
    sell_bid       Float64,
    spread         Float64,                 
    spread_bps     Float64,                 -- ((sell_bid - buy_ask) / buy_ask) * 10000
    exec_size      Float64,                 -- min(buy_ask_qty, sell_bid_qty)
    spread_costs   Float64,                 -- spot-perp, perp-perp strategies enter the trade, hold the position and exit the trade. Meaning, each leg side buys at ask and sells at bid. Meaning, we need to include the cost of the spread inside the orderbook. "spread_costs" must be a sum of both legs orderbooks.spread_bps. For spot-spot it is not applicable as spot-spot don't hold the possitions. Should be 0 here for spot-spot.
    profit_bps     Float64,                 -- spread_bps - spread_costs - trading_fees
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (symbol, buy_exchange, sell_exchange, ts)
TTL ts + INTERVAL 30 DAY;




5. (PHASE 2) Observability

Grafana for the SRE/ops view: ingest lag, snapshot drop rate, ClickHouse write rate, exchange clock skew, alerting. ClickHouse plugin is mature.



# PHASE 3 BACKTESTING

###############
Clickhouse data will be used later for backtesting as well.
###############