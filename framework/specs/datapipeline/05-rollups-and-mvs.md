# 05 — Rollups & Materialized Views

Five rollup tiers per spread/orderbook stream. AggregatingMergeTree with chained MVs (each tier reads its parent, not raw) to keep MV cost flat.

Every cross-exchange rollup and MV carries `buy_market_type` and `sell_market_type` in columns, `GROUP BY`, and `ORDER BY` — `(symbol, buy_exchange, sell_exchange)` is not unique once spot/perp share a symbol. `orderbooks_spread_*` already carries `market_type`; unchanged there.

## Tier map

| Tier | Bucket | Source | Use |
|---|---|---|---|
| raw | 1 s | producers | Live UI top-50, last-minute view |
| `_3s` | 3 s | raw | Short scrubbing zooms |
| `_15s` | 15 s | `_3s` | Last 15-30 minute charts |
| `_1m` | 1 m | `_15s` | Multi-hour charts |
| `_5m` | 5 m | `_1m` | Multi-day charts (use cold tier beyond 3 d) |

Chained build keeps each MV reading ~5-20× less data than raw, avoiding MV stack overhead on the trader host.

## Canonical statistic set (spread/profit rollups)

Every `spreads_*` tier table has the same column set. Quantiles populated in one pass via `quantilesState(0.01, 0.05, 0.10, 0.25, 0.5, 0.75, 0.90, 0.95, 0.99)(...)` — single t-digest state per column, cheaper than nine separate `quantileState` calls.

```
spread_bps_min, spread_bps_max, spread_bps_median,
spread_bps_p01, spread_bps_p05, spread_bps_p10, spread_bps_p25,
spread_bps_p50, spread_bps_p75, spread_bps_p90, spread_bps_p95, spread_bps_p99,
profit_bps_min, profit_bps_max, profit_bps_median,
profit_bps_p01, profit_bps_p05, profit_bps_p10, profit_bps_p25,
profit_bps_p50, profit_bps_p75, profit_bps_p90, profit_bps_p95, profit_bps_p99,
ticks
```

`orderbooks_spread_*` uses the same set on `spread_bps` only (no `profit_bps`).

## DDL — `spreads_3s`

```sql
CREATE TABLE spreads_3s
(
  bucket            DateTime('UTC'),
  symbol            LowCardinality(String),
  buy_exchange      LowCardinality(String),
  buy_market_type   LowCardinality(String),
  sell_exchange     LowCardinality(String),
  sell_market_type  LowCardinality(String),
  spread_bps_min    AggregateFunction(min,    Float32),
  spread_bps_max    AggregateFunction(max,    Float32),
  spread_bps_median    AggregateFunction(median, Float32),
  spread_bps_q      AggregateFunction(quantiles(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99), Float32),
  profit_bps_min    AggregateFunction(min,    Float32),
  profit_bps_max    AggregateFunction(max,    Float32),
  profit_bps_median    AggregateFunction(median, Float32),
  profit_bps_q      AggregateFunction(quantiles(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99), Float32),
  ticks             AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(bucket)
ORDER BY (symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, bucket)
TTL bucket + INTERVAL 3 DAY TO VOLUME 'cold';

CREATE MATERIALIZED VIEW mv_spreads_3s TO spreads_3s AS
SELECT
  toStartOfInterval(ts, INTERVAL 3 SECOND, 'UTC')   AS bucket,
  symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, strategy,
  minState(spread_bps)             AS spread_bps_min,
  maxState(spread_bps)             AS spread_bps_max,
  medianState(spread_bps)             AS spread_bps_median,
  quantilesState(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(spread_bps) AS spread_bps_q,
  minState(profit_bps)             AS profit_bps_min,
  maxState(profit_bps)             AS profit_bps_max,
  medianState(profit_bps)             AS profit_bps_median,
  quantilesState(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(profit_bps) AS profit_bps_q,
  countState()                     AS ticks
FROM spreads
GROUP BY bucket, symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, strategy;
```

Individual percentile columns (`spread_bps_p01`, … `_p99`, `profit_bps_p01`, … `_p99`) are exposed at read time by `arrayElement(quantilesMerge(...)(spread_bps_q), N)`; storing them as named columns instead of one `quantiles` state remains an option if read SQL grows unwieldy.

## DDL — `spreads_15s` (chained from 3s)

```sql
CREATE TABLE spreads_15s AS spreads_3s
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(bucket)
ORDER BY (symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, bucket)
TTL bucket + INTERVAL 3 DAY TO VOLUME 'cold';

CREATE MATERIALIZED VIEW mv_spreads_15s TO spreads_15s AS
SELECT
  toStartOfInterval(bucket, INTERVAL 15 SECOND, 'UTC') AS bucket,
  symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, strategy,
  minMergeState(spread_bps_min)                                  AS spread_bps_min,
  maxMergeState(spread_bps_max)                                  AS spread_bps_max,
  medianMergeState(spread_bps_median)                                  AS spread_bps_median,
  quantilesMergeState(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(spread_bps_q) AS spread_bps_q,
  minMergeState(profit_bps_min)                                  AS profit_bps_min,
  maxMergeState(profit_bps_max)                                  AS profit_bps_max,
  medianMergeState(profit_bps_median)                                  AS profit_bps_median,
  quantilesMergeState(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(profit_bps_q) AS profit_bps_q,
  countMergeState(ticks)                                         AS ticks
FROM spreads_3s
GROUP BY bucket, symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type, strategy;
```

Same pattern for `spreads_1m` (from `spreads_15s`) and `spreads_5m` (from `spreads_1m`). All carry `TTL bucket + INTERVAL 3 DAY TO VOLUME 'cold'`.

## Orderbook rollups

Same shape against `orderbooks.spread_bps` for top-of-book bid-ask spread per pair/exchange (separate from cross-exchange `spreads`):

```sql
CREATE TABLE orderbooks_spread_3s
(
  bucket           DateTime('UTC'),
  exchange         LowCardinality(String),
  symbol           LowCardinality(String),
  market_type      LowCardinality(String),
  spread_bps_min   AggregateFunction(min, Float32),
  spread_bps_max   AggregateFunction(max, Float32),
  spread_bps_median   AggregateFunction(median, Float32),
  spread_bps_q     AggregateFunction(quantiles(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99), Float32),
  best_bid_argmin  AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
  best_bid_argmax  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
  best_ask_argmin  AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
  best_ask_argmax  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
  ticks            AggregateFunction(count)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(bucket)
ORDER BY (symbol, exchange, market_type, bucket)
TTL bucket + INTERVAL 3 DAY TO VOLUME 'cold';

CREATE MATERIALIZED VIEW mv_orderbooks_spread_3s TO orderbooks_spread_3s AS
SELECT
  toStartOfInterval(ts, INTERVAL 3 SECOND, 'UTC') AS bucket,
  exchange, symbol, market_type,
  minState(spread_bps)                                          AS spread_bps_min,
  maxState(spread_bps)                                          AS spread_bps_max,
  medianState(spread_bps)                                          AS spread_bps_median,
  quantilesState(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(spread_bps) AS spread_bps_q,
  argMinState(best_bid, ts)                                     AS best_bid_argmin,
  argMaxState(best_bid, ts)                                     AS best_bid_argmax,
  argMinState(best_ask, ts)                                     AS best_ask_argmin,
  argMaxState(best_ask, ts)                                     AS best_ask_argmax,
  countState()                                                  AS ticks
FROM orderbooks
GROUP BY bucket, exchange, symbol, market_type;
```

## Pair-stats (trailing 24 h, 1-minute refresh)

Replaces fixed-hour `pair_stats_1h`. Trailing-24h rolling window, refreshed every 1 minute via scheduled `INSERT … SELECT`. Cost-gate: fall back to 5-minute cadence if dashboard shows MV/job cost > 5 % CPU.

```sql
CREATE TABLE pair_stats_24h
(
  computed_at       DateTime('UTC'),                 -- when job ran (also acts as version)
  symbol            LowCardinality(String),
  buy_exchange      LowCardinality(String),
  buy_market_type   LowCardinality(String),
  sell_exchange     LowCardinality(String),
  sell_market_type  LowCardinality(String),
  spread_bps_min    Float32,
  spread_bps_max    Float32,
  spread_bps_median    Float32,
  spread_bps_p01    Float32, spread_bps_p05 Float32, spread_bps_p10 Float32,
  spread_bps_p25    Float32, spread_bps_p50 Float32, spread_bps_p75 Float32,
  spread_bps_p90    Float32, spread_bps_p95 Float32, spread_bps_p99 Float32,
  profit_bps_min    Float32,
  profit_bps_max    Float32,
  profit_bps_median    Float32,
  profit_bps_p01    Float32, profit_bps_p05 Float32, profit_bps_p10 Float32,
  profit_bps_p25    Float32, profit_bps_p50 Float32, profit_bps_p75 Float32,
  profit_bps_p90    Float32, profit_bps_p95 Float32, profit_bps_p99 Float32,
  ticks             UInt64
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(computed_at)
ORDER BY (symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type);
```

Cron `*/1 * * * *` runs:

```sql
INSERT INTO pair_stats_24h
SELECT
  now()                 AS computed_at,
  symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type,
  min(spread_bps), max(spread_bps), median(spread_bps),
  quantile(0.01)(spread_bps), quantile(0.05)(spread_bps), quantile(0.10)(spread_bps),
  quantile(0.25)(spread_bps), quantile(0.50)(spread_bps), quantile(0.75)(spread_bps),
  quantile(0.90)(spread_bps), quantile(0.95)(spread_bps), quantile(0.99)(spread_bps),
  min(profit_bps), max(profit_bps), median(profit_bps),
  quantile(0.01)(profit_bps), quantile(0.05)(profit_bps), quantile(0.10)(profit_bps),
  quantile(0.25)(profit_bps), quantile(0.50)(profit_bps), quantile(0.75)(profit_bps),
  quantile(0.90)(profit_bps), quantile(0.95)(profit_bps), quantile(0.99)(profit_bps),
  count()
FROM spreads
WHERE ts > now() - INTERVAL 24 HOUR
GROUP BY symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type;
```

Reads use `FINAL` (or `argMax(_version, …)` view) for the latest snapshot.

## Spread persistance (replaces half-life)

`spread_persistance_24h` — entry-persistance and exit-decay distributions per cross-exchange pair. Same 1-minute trailing-24h refresh cadence as `pair_stats_24h`.

```sql
CREATE TABLE spread_persistance_24h
(
  computed_at               DateTime('UTC'),
  symbol                    LowCardinality(String),
  buy_exchange              LowCardinality(String),
  buy_market_type           LowCardinality(String),
  sell_exchange             LowCardinality(String),
  sell_market_type          LowCardinality(String),
  entry_persistance_p10_ms  UInt32,
  entry_persistance_p25_ms  UInt32,
  entry_persistance_p50_ms  UInt32,
  exit_decay_p50_ms         UInt32,
  exit_decay_p75_ms         UInt32,
  exit_decay_p90_ms         UInt32,
  events                    UInt32
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(computed_at)
ORDER BY (symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type);
```

### Definitions

- **Entry persistance**: time (ms) the opportunity stays above `spread_bps_p90` from first cross-above (`time_start`) until first cross-back-below (`time_end`); `entry_persistance = time_end - time_start`. Reported as `p10`, `p25`, `p50` over the trailing 24 h window. Gauges how feasible it is to enter the trade.
- **Exit decay**: time (ms) from first cross-above `spread_bps_p90` (`time_start`) until first cross-below `spread_bps_p50` (`time_end`); `exit_decay = time_end - time_start`. Reported as `p50`, `p75`, `p90`. Gauges how long the position would need to be held until mean-reversion.

### Compute

Windowed CTE over `spreads`, joined to `pair_stats_24h` for per-pair `spread_bps_p90` / `spread_bps_p50` thresholds. Run by scheduled cron (trader or query-api container), 1 min cadence, fall back to 5 min on CPU pressure.

```sql
INSERT INTO spread_persistance_24h
WITH thresholds AS (
  SELECT symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type,
         spread_bps_p50 AS p50, spread_bps_p90 AS p90
  FROM pair_stats_24h FINAL
),
ticks AS (
  SELECT s.ts, s.symbol, s.buy_exchange, s.buy_market_type, s.sell_exchange, s.sell_market_type,
         s.spread_bps, t.p50, t.p90,
         s.spread_bps > t.p90 AS above_p90,
         s.spread_bps < t.p50 AS below_p50
  FROM spreads s
  JOIN thresholds t USING (symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type)
  WHERE s.ts > now() - INTERVAL 24 HOUR
),
flagged AS (
  SELECT *,
         lagInFrame(above_p90) OVER w AS prev_above
  FROM ticks
  WINDOW w AS (
    PARTITION BY symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type
    ORDER BY ts
  )
),
episodes AS (
  -- Each "episode" starts on a cross-above (above_p90 AND NOT prev_above).
  -- entry_dur_ms = time until next cross-below p90 within the partition.
  -- exit_dur_ms  = time until next cross-below p50 within the partition.
  -- Implementation: arrayJoin episode boundaries computed per partition via
  -- groupArray(ts) + arrayMap; see implementation task during build-out.
  SELECT symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type,
         entry_dur_ms, exit_dur_ms
  FROM ( /* episode-detection subquery — TODO during implementation */ )
)
SELECT
  now() AS computed_at,
  symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type,
  toUInt32(quantile(0.10)(entry_dur_ms)),
  toUInt32(quantile(0.25)(entry_dur_ms)),
  toUInt32(quantile(0.50)(entry_dur_ms)),
  toUInt32(quantile(0.50)(exit_dur_ms)),
  toUInt32(quantile(0.75)(exit_dur_ms)),
  toUInt32(quantile(0.90)(exit_dur_ms)),
  toUInt32(count())
FROM episodes
GROUP BY symbol, buy_exchange, buy_market_type, sell_exchange, sell_market_type;
```

The episode-detection subquery is implementation-time work — pseudo above describes the contract.

## Resolution-selection function

Server-side picker for `GET /spreads/history`:

```ts
// src/services/queryApi/rollup.ts
const TIERS = [
  { name: 'spreads',     bucketSec: 1   },
  { name: 'spreads_3s',  bucketSec: 3   },
  { name: 'spreads_15s', bucketSec: 15  },
  { name: 'spreads_1m',  bucketSec: 60  },
  { name: 'spreads_5m',  bucketSec: 300 },
]

export function selectRollup(timeRangeSec: number, pixelWidth: number): typeof TIERS[number] {
  // Aim for ≤ pixelWidth buckets, but never < 50 buckets so chart isn't sparse
  const targetBuckets = Math.min(pixelWidth, 1000)
  const idealSec = Math.max(1, Math.floor(timeRangeSec / targetBuckets))
  return TIERS.reduce((best, t) =>
    Math.abs(t.bucketSec - idealSec) < Math.abs(best.bucketSec - idealSec) ? t : best
  )
}
```

Example: 24 h range, 1200 px wide → idealSec ≈ 72 s → picks `spreads_1m`.

## Read pattern (median-primary)

Median is the headline statistic. No `avg` column is stored — median replaces it.

```sql
SELECT
  bucket,
  minMerge(spread_bps_min)                                                              AS spread_min,
  maxMerge(spread_bps_max)                                                              AS spread_max,
  medianMerge(spread_bps_median)                                                        AS spread_median,
  arrayElement(quantilesMerge(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(spread_bps_q), 8) AS spread_p95
FROM spreads_3s
WHERE symbol = 'BTC/USDT'
  AND buy_exchange  = 'binance' AND buy_market_type  = 'SPOT'
  AND sell_exchange = 'okx'     AND sell_market_type = 'LINEAR'
  AND bucket BETWEEN {from:DateTime} AND {to:DateTime}
GROUP BY bucket
ORDER BY bucket;
```

(`arrayElement(..., 5)` selects p50 — the 5th element of the 9-quantile array; element 8 is p95.)

## Cost note

MV chain cost per 1 s tick across all spreads (~9 k rows/s):

- `mv_spreads_3s`: reads 9 k rows/s, writes 3 k rows/s → ~3 GB/d state
- `mv_spreads_15s`: reads 3 k/s, writes 600/s → ~700 MB/d
- `mv_spreads_1m`: 600/s → 150/s → ~150 MB/d
- `mv_spreads_5m`: 150/s → 30/s → ~30 MB/d

Total rollup overhead < 5 GB/d, dwarfed by raw. `pair_stats_24h` + `spread_persistance_24h` refreshed jobs each scan ≤ 800 M rows once per minute → CPU-bound; gate to 5 min if observed > 5 % CPU.

## Links

- Underlying tables → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md)
- Producer cadence → [06-spreads-engine.md](./06-spreads-engine.md)
- API resolver consumer → [07-query-api.md](./07-query-api.md)
- Cold reads of rollups → [10-cold-path.md](./10-cold-path.md)
- These MVs are part of `bootstrap.sql`, executed at deploy by infra → [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md#deployment-flow)

> The `*/1` cron that refreshes `pair_stats_24h` / `spread_persistance_24h` is app logic; the cron **trigger** is provided by infra at deploy.
