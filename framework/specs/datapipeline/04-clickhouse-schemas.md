# 04 — ClickHouse Schemas

Full DDL for all tables plus storage policy. Single-node CH, MergeTree family, 3-day raw retention with TTL to cold tier.

## Storage policy

The `tiered` storage policy (3 disks: `nvme` hot → `volume` warm → `s3` cold, `move_factor 0.2`) is **infra-owned** and defined in the Ansible `clickhouse` role config → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#clickhouse). The table DDLs below merely *reference* it via `storage_policy = 'tiered'` and `TTL … TO VOLUME 'cold'`.

## `orderbooks`

```sql
CREATE TABLE orderbooks
(
  ts                DateTime64(3, 'UTC')                                          CODEC(DoubleDelta, ZSTD(3)),
  ts_exchange       DateTime64(3, 'UTC')                                          CODEC(DoubleDelta, ZSTD(3)),
  market_type       LowCardinality(String),
  exchange          LowCardinality(String),
  symbol            LowCardinality(String),
  best_bid          Float64                                                       CODEC(Gorilla, ZSTD(3)),
  best_ask          Float64                                                       CODEC(Gorilla, ZSTD(3)),
  best_bid_qty      Float64                                                       CODEC(Gorilla, ZSTD(3)),
  best_ask_qty      Float64                                                       CODEC(Gorilla, ZSTD(3)),
  bids              Array(Tuple(Float64, Float64))                                CODEC(ZSTD(3)),
  asks              Array(Tuple(Float64, Float64))                                CODEC(ZSTD(3)),
  spread_bps        Float32 MATERIALIZED if(best_bid > 0, (best_ask - best_bid) / best_bid * 10000, 0)
                                                                                  CODEC(Gorilla, ZSTD(3)),
  sequence_gap      Bool                                                          CODEC(ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (symbol, exchange, market_type, ts)
TTL ts + INTERVAL 3 DAY TO VOLUME 'cold'
SETTINGS storage_policy = 'tiered',
         index_granularity = 8192,
         min_bytes_for_wide_part = 1048576;
```

Notes:

- `ORDER BY (symbol, exchange, market_type, ts)` chosen for typical UI/backtest filters (one pair, one exchange, time range).
- `spread_bps` materialized in same row to avoid recompute in rollups.
- `sequence_gap` kept as `Bool` per decision table — set upstream in the WS adapter, carried verbatim through `ob.ticks` (see [02](./02-snapshotter.md#sequence-gap-detection)).
- `bids` / `asks` arrays sized at 10 per side (enforced by producer; CH does not constrain).
- TTL `TO VOLUME 'cold'` after 3 days; no hard delete (cold retains indefinitely via S3 disk path; see [10](./10-cold-path.md)).

## `ops_events`

```sql
CREATE TABLE ops_events
(
  ts     DateTime64(3, 'UTC')                                                     CODEC(DoubleDelta, ZSTD(3)),
  event  LowCardinality(String)                                                   -- e.g. 'trader_restart'
)
ENGINE = MergeTree
ORDER BY ts;
```

Tiny operational-marker table. The trader emits one `trader_restart` row at its own startup (see [02](./02-snapshotter.md#backfill-on-restart)). Analytics/backtest queries `JOIN` against it to mask `orderbooks` / `spreads` rows around a restart.

## `spreads`

```sql
CREATE TABLE spreads
(
  ts                DateTime64(3, 'UTC')                                          CODEC(DoubleDelta, ZSTD(3)),
  latency_buy_ms    Int32                                                         CODEC(ZSTD(3)),
  latency_sell_ms   Int32                                                         CODEC(ZSTD(3)),
  symbol            LowCardinality(String),
  buy_market_type   LowCardinality(String),
  sell_market_type  LowCardinality(String),
  buy_exchange      LowCardinality(String),
  sell_exchange     LowCardinality(String),
  buy_ask           Float64                                                       CODEC(Gorilla, ZSTD(3)),
  sell_bid          Float64                                                       CODEC(Gorilla, ZSTD(3)),
  spread_bps        Float32                                                       CODEC(Gorilla, ZSTD(3)),
  exec_size         Float64                                                       CODEC(Gorilla, ZSTD(3)),
  spread_costs_bps  Float32                                                       CODEC(Gorilla, ZSTD(3)),
  trading_fees_bps  Float32                                                       CODEC(Gorilla, ZSTD(3)),
  profit_bps        Float32 MATERIALIZED spread_bps - spread_costs_bps - trading_fees_bps
                                                                                  CODEC(Gorilla, ZSTD(3))
  stale             Boolean
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (symbol, buy_exchange, sell_exchange, ts)
TTL ts + INTERVAL 3 DAY TO VOLUME 'cold'
SETTINGS storage_policy = 'tiered';
```

Notes:

- `latency_*` per-leg as per decision (replaces single-leg `latency`).
- `profit_bps` materialized; rollups read it directly.
- `exec_size` = min sizing available given × buy_ask price. exec_size = min(best_buy_ask_qty, best_sell_bid_qty) x best_buy_ask_price

## `trades`

Schema mirrors `TrackedTrade` in `src/core/trading/tradeMonitor.ts:41-109` field-for-field. Nested objects flattened to columns; `entry_trade` / `exit_trade` `TradeResult` kept as Tuples; per-bucket PnL breakdown flattened.

```sql
CREATE TABLE trades
(
  id                              String,
  _version                        UInt64                                          CODEC(Delta(8), ZSTD(3)),
  status                          LowCardinality(String),                          -- 'open'|'closed'|'error'
  strategy                        LowCardinality(String),                          -- 'funding'|'spread'
  strategy_variant                LowCardinality(Nullable(String)),
  exit_reason                     LowCardinality(Nullable(String)),
  entry_date                      DateTime64(3, 'UTC')                             CODEC(DoubleDelta, ZSTD(3)),
  exit_date                       Nullable(DateTime64(3, 'UTC'))                   CODEC(DoubleDelta, ZSTD(3)),
  entry_timestamp                 UInt64                                           CODEC(Delta(8), ZSTD(3)),
  exit_timestamp                  Nullable(UInt64)                                 CODEC(Delta(8), ZSTD(3)),
  last_update_timestamp           UInt64                                           CODEC(Delta(8), ZSTD(3)),
  spread_at_exit_percent          Nullable(Float32)                                CODEC(Gorilla, ZSTD(3)),

  -- ArbitrageOpportunity (flattened)
  opportunity_id                  String,
  normalized_pair                 LowCardinality(String),
  buy_exchange_symbol             String,
  sell_exchange_symbol            String,
  buy_exchange                    LowCardinality(String),
  sell_exchange                   LowCardinality(String),
  buy_market_type                 LowCardinality(String),
  sell_market_type                LowCardinality(String),
  both_legs_are_perp              Bool,
  is_spot_spot                    Bool,
  avg_buy_normalized_exec_price   Float64                                          CODEC(Gorilla, ZSTD(3)),
  avg_sell_normalized_exec_price  Float64                                          CODEC(Gorilla, ZSTD(3)),
  normalized_volume               Float64                                          CODEC(Gorilla, ZSTD(3)),
  buy_exchange_volume             Float64                                          CODEC(Gorilla, ZSTD(3)),
  sell_exchange_volume            Float64                                          CODEC(Gorilla, ZSTD(3)),
  order_amount_usd                Float64                                          CODEC(Gorilla, ZSTD(3)),
  confidence_score                Float32                                          CODEC(Gorilla, ZSTD(3)),
  trace_id                        String,
  orderbook_update_timestamp      UInt64                                           CODEC(Delta(8), ZSTD(3)),
  target_funding_timestamp        Nullable(UInt64),
  buy_exchange_next_funding_ts    Nullable(UInt64),
  sell_exchange_next_funding_ts   Nullable(UInt64),
  costs_usd                       Float64                                          CODEC(Gorilla, ZSTD(3)),
  costs_percent                   Float32                                          CODEC(Gorilla, ZSTD(3)),
  trading_fees_usd                Float64                                          CODEC(Gorilla, ZSTD(3)),
  trading_fees_percent            Float32                                          CODEC(Gorilla, ZSTD(3)),
  spread_profit_usd               Float64                                          CODEC(Gorilla, ZSTD(3)),
  spread_profit_percent           Float32                                          CODEC(Gorilla, ZSTD(3)),
  funding_profit_usd_estimated    Float64                                          CODEC(Gorilla, ZSTD(3)),
  funding_profit_percent_estimated Float32                                         CODEC(Gorilla, ZSTD(3)),
  estimated_profit_usd            Float64                                          CODEC(Gorilla, ZSTD(3)),
  estimated_profit_percent        Float32                                          CODEC(Gorilla, ZSTD(3)),

  -- Entry / exit TradeResult (Tuple per leg)
  entry_trade Tuple(
    id               String,
    success          Bool,
    latency_ms       UInt32,
    buy_order        Tuple(
      id                String, client_order_id  String,
      exchange          LowCardinality(String), symbol String,
      order_side        LowCardinality(String), position_side LowCardinality(String),
      order_type        LowCardinality(String), price Float64, average_price Float64,
      quantity          Float64, status LowCardinality(String), timestamp UInt64,
      expected_price    Nullable(Float64), leverage Nullable(Float32),
      latency_ms        Nullable(UInt32), fees_usd Nullable(Float64),
      slippage_percent  Nullable(Float32),
      market_type       LowCardinality(Nullable(String))
    ),
    sell_order       Tuple(
      id                String, client_order_id  String,
      exchange          LowCardinality(String), symbol String,
      order_side        LowCardinality(String), position_side LowCardinality(String),
      order_type        LowCardinality(String), price Float64, average_price Float64,
      quantity          Float64, status LowCardinality(String), timestamp UInt64,
      expected_price    Nullable(Float64), leverage Nullable(Float32),
      latency_ms        Nullable(UInt32), fees_usd Nullable(Float64),
      slippage_percent  Nullable(Float32),
      market_type       LowCardinality(Nullable(String))
    ),
    fees_usd         Float64,
    fees_percent     Float32,
    slippage_usd     Float64,
    slippage_percent Float32
  ),
  exit_trade Nullable(Tuple(
    id               String,
    success          Bool,
    latency_ms       UInt32,
    buy_order        Tuple(
      id String, client_order_id String, exchange LowCardinality(String), symbol String,
      order_side LowCardinality(String), position_side LowCardinality(String),
      order_type LowCardinality(String), price Float64, average_price Float64,
      quantity Float64, status LowCardinality(String), timestamp UInt64,
      expected_price Nullable(Float64), leverage Nullable(Float32),
      latency_ms Nullable(UInt32), fees_usd Nullable(Float64),
      slippage_percent Nullable(Float32),
      market_type LowCardinality(Nullable(String))
    ),
    sell_order       Tuple(
      id String, client_order_id String, exchange LowCardinality(String), symbol String,
      order_side LowCardinality(String), position_side LowCardinality(String),
      order_type LowCardinality(String), price Float64, average_price Float64,
      quantity Float64, status LowCardinality(String), timestamp UInt64,
      expected_price Nullable(Float64), leverage Nullable(Float32),
      latency_ms Nullable(UInt32), fees_usd Nullable(Float64),
      slippage_percent Nullable(Float32),
      market_type LowCardinality(Nullable(String))
    ),
    fees_usd         Float64,
    fees_percent     Float32,
    slippage_usd     Float64,
    slippage_percent Float32
  )),

  -- Funding events array (FundingFeeCollectedEvent)
  funding_events Array(Tuple(
    net_funding_rate_percent          Float32,
    buy_exchange_funding_rate_percent Float32,
    sell_exchange_funding_rate_percent Float32,
    net_funding_fee_usd               Float64,
    buy_exchange_funding_fee_usd      Float64,
    sell_exchange_funding_fee_usd     Float64,
    buy_exchange_actual_funding_date  DateTime64(3, 'UTC'),
    sell_exchange_actual_funding_date DateTime64(3, 'UTC'),
    funding_timestamp                 UInt64,
    funding_date                      DateTime64(3, 'UTC')
  )),

  -- PnL breakdown (Tuple-per-bucket flattened)
  fees_usd_entry                  Float64                                          CODEC(Gorilla, ZSTD(3)),
  fees_usd_exit                   Float64                                          CODEC(Gorilla, ZSTD(3)),
  fees_usd_total                  Float64                                          CODEC(Gorilla, ZSTD(3)),
  slippage_usd_entry              Float64                                          CODEC(Gorilla, ZSTD(3)),
  slippage_usd_exit               Float64                                          CODEC(Gorilla, ZSTD(3)),
  slippage_usd_total              Float64                                          CODEC(Gorilla, ZSTD(3)),
  funding_usd_buy                 Nullable(Float64)                                CODEC(Gorilla, ZSTD(3)),
  funding_usd_sell                Nullable(Float64)                                CODEC(Gorilla, ZSTD(3)),
  funding_usd_net                 Nullable(Float64)                                CODEC(Gorilla, ZSTD(3)),
  delta_usd_buy                   Float64                                          CODEC(Gorilla, ZSTD(3)),
  delta_usd_sell                  Float64                                          CODEC(Gorilla, ZSTD(3)),
  delta_usd_net                   Float64                                          CODEC(Gorilla, ZSTD(3)),
  fees_percent_entry              Float32                                          CODEC(Gorilla, ZSTD(3)),
  fees_percent_exit               Float32                                          CODEC(Gorilla, ZSTD(3)),
  fees_percent_total              Float32                                          CODEC(Gorilla, ZSTD(3)),
  slippage_percent_entry          Float32                                          CODEC(Gorilla, ZSTD(3)),
  slippage_percent_exit           Float32                                          CODEC(Gorilla, ZSTD(3)),
  slippage_percent_total          Float32                                          CODEC(Gorilla, ZSTD(3)),
  funding_percent_buy             Nullable(Float32)                                CODEC(Gorilla, ZSTD(3)),
  funding_percent_sell            Nullable(Float32)                                CODEC(Gorilla, ZSTD(3)),
  funding_percent_net             Nullable(Float32)                                CODEC(Gorilla, ZSTD(3)),
  delta_percent_buy               Float32                                          CODEC(Gorilla, ZSTD(3)),
  delta_percent_sell              Float32                                          CODEC(Gorilla, ZSTD(3)),
  delta_percent_net               Float32                                          CODEC(Gorilla, ZSTD(3)),
  delta_profit_usd                Float64                                          CODEC(Gorilla, ZSTD(3)),
  funding_profit_usd              Float64                                          CODEC(Gorilla, ZSTD(3)),
  pnl_usd                         Float64                                          CODEC(Gorilla, ZSTD(3)),
  delta_profit_percent            Float32                                          CODEC(Gorilla, ZSTD(3)),
  funding_profit_percent          Float32                                          CODEC(Gorilla, ZSTD(3)),
  pnl_percent                     Float32                                          CODEC(Gorilla, ZSTD(3))
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(entry_timestamp)
ORDER BY (id)
SETTINGS storage_policy = 'tiered';
-- No TTL: trades are an asset.
```

Read pattern: `SELECT … FROM trades FINAL WHERE …` for guaranteed latest version. For high-frequency UI list endpoints, use `argMax(_version, …)` in a wrapping view to avoid `FINAL` cost.

Mirror this schema in `tradeStateClickhouse` insert payload and the `TrackedTrade` interface — see [11-redis-removal.md](./11-redis-removal.md).

## `fees`

```sql
CREATE TABLE fees
(
  exchange     LowCardinality(String),
  market_type  LowCardinality(String),
  order_type   LowCardinality(String),  -- 'maker' | 'taker'
  fee_bps      Float32,
  updated_at   DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (exchange, market_type, order_type);
```

Seed via `scripts/seed_fees.sql` (in repo) at deploy. Example rows:

```sql
INSERT INTO fees (exchange, market_type, order_type, fee_bps) VALUES
('binance', 'SPOT',    'maker', 1.0), ('binance', 'SPOT',    'taker', 1.0),
('binance', 'LINEAR',  'maker', 1.8), ('binance', 'LINEAR',  'taker', 4.5),
('bybit',   'LINEAR',  'maker', 1.0), ('bybit',   'LINEAR',  'taker', 6.0),
('okx',     'LINEAR',  'maker', 2.0), ('okx',     'LINEAR',  'taker', 5.0),
('bitget',  'LINEAR',  'maker', 2.0), ('bitget',  'LINEAR',  'taker', 6.0);
-- … fill from current exchange fee schedules
```

In-process cache loaded at startup, refreshed hourly (see [06](./06-spreads-engine.md#fees-cache)).

## `funding_rates`

```sql
CREATE TABLE funding_rates
(
  ts               DateTime64(3, 'UTC')                                           CODEC(DoubleDelta, ZSTD(3)),
  exchange         LowCardinality(String),
  symbol           LowCardinality(String),
  market_type      LowCardinality(String),
  interval         LowCardinality(String),                                        -- '1h','4h','8h' (from CCXT fundingIntervalHours)
  funding_rate     Float64                                                        CODEC(Gorilla, ZSTD(3)),
  next_funding_ts  DateTime64(3, 'UTC')                                           CODEC(DoubleDelta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (symbol, exchange, market_type, ts)
TTL ts + INTERVAL 90 DAY TO VOLUME 'cold'
SETTINGS storage_policy = 'tiered';
```

Hourly cron at `HH:01:00` calls CCXT `fetchFundingRateHistory()` per exchange and `INSERT`s rows. Record `interval` from CCXT response field `fundingIntervalHours` (e.g. `8` → `'8h'`).

## Bootstrap execution

These DDLs (database + all tables + `fees` seed) plus the materialized views in [05](./05-rollups-and-mvs.md) form `bootstrap.sql`, owned here in the app specs. Infra **executes** it as a one-shot step during deploy — see [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md#deployment-flow).

## Validation checklist

- All `LowCardinality(String)` columns used for any field with cardinality < ~10k.
- Codecs: `DoubleDelta` for monotonic timestamps & sequence ids; `Gorilla` for floats; `ZSTD(3)` as wrapper.
- Partition keys daily (`toYYYYMMDD`) for high-volume tables, monthly (`toYYYYMM`) for low-volume.
- Order keys match expected filter prefix (`symbol`, then `exchange`).
- TTL `TO VOLUME 'cold'` on `orderbooks`, `spreads`, `funding_rates`; trades retained indefinitely on tiered policy (no TTL).

## Links

- Rollups consume these → [05-rollups-and-mvs.md](./05-rollups-and-mvs.md)
- Spread engine producer → [06-spreads-engine.md](./06-spreads-engine.md)
- Cold tier policy → [10-cold-path.md](./10-cold-path.md)
- Redis trade-state replacement → [11-redis-removal.md](./11-redis-removal.md)
