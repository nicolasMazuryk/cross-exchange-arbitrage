# 03 — Redpanda Buffer

Single-broker Redpanda (KRaft) on the **core box**, co-located with its core-box producer (SpreadComputer) and its consumers (ClickHouse on `ob.ticks` + `spreads.live`, SpreadComputer on `ob.ticks`). The **hot box** produces `ob.ticks` to it across the private net. Decouples bursty producers from ClickHouse ingest cadence; lets us add consumers (WS fanout, future processors) without re-wiring producers.

## Why Redpanda over direct CH insert

- **Burst absorption**: the hot-box sampler and SpreadComputer fire 1 Hz bursts; CH `INSERT` parallelism is throttled by `parts_to_throw_insert`. Buffer flattens this.
- **Multi-consumer**: query API WS fanout reads the same topics CH ingests from. No double-write from producers.
- **Restart isolation**: trader restart leaves buffered ticks for CH to drain.
- **Operational simplicity**: single Kafka-compatible binary, no ZooKeeper, ~200 MB binary, runs in one container.

## Deployment

Install/sizing/run is infra-owned: the broker runs as a **Kamal accessory** sized by the Ansible `redpanda` role (`--smp 2 --memory 3G`, data dir on the Volume, an `INTERNAL://127.0.0.1:9092` loopback listener **plus a private-net listener `10.0.1.20:9092`** so the hot-box `ob.ticks` producer can reach it across the private net, size-retention caps). The added private listener is infra-owned; this file just records the dependency. See [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#redpanda) and [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md#kamal-accessories). This file owns the **topic definitions, partition-key design, retention policy intent, producer config, and CH ingest pattern** below.

## Topics

| Topic | Partitions | Replication | Retention | Cleanup | Notes |
|---|---|---|---|---|---|
| `ob.ticks` | 16 | 1 | 24 h or 50 GB | delete | Partition key = `${exchange}:${market_type}:${symbol}`; ~6k msg/s (1 Hz top-N); raw system-of-record ingest source for CH (Kafka engine) + SpreadComputer |
| `spreads.live` | 8 | 1 | 24 h or 20 GB | delete | Partition key = `${buy_exchange}:${buy_market_type}:${sell_exchange}:${sell_market_type}:${symbol}`; ~9k msg/s |
| `funding_rates.ingest` | 1 | 1 | 7 days | delete | Hourly cron writes; CH MV drains |
| `trades.events` | 4 | 1 | 30 days | delete | Trade lifecycle events (open/update/close); driven by `tradeMonitor` post Redis removal |

Why 16 partitions for `ob.ticks`: 4 exchanges × ~1500 symbols partitioned by `(exchange, market_type, symbol)` — 16 gives parallel CH consumers without overloading a single-node broker.

**Why `market_type` is in the key**: `(exchange, symbol)` is not unique — the same symbol streams concurrently from spot and perp markets (e.g., `BTC/USDT` SPOT and `BTC/USDT` LINEAR on the same exchange). Including `market_type` keeps each market on a stable partition so per-stream ordering holds and consumers can fan out cleanly. No partition count change; hashing distribution stays even given high cardinality.

## Retention

- Time-based 24 h primary; size-based fail-safe (50 GB / 20 GB).
- `delete.retention.ms = 86_400_000`, `retention.bytes = 53_687_091_200`.
- Cold tier handled in CH; Redpanda is short-term buffer only.

## On-disk sizing

Per-topic rate × message-size × retention math (Redpanda data dir < 80 GB at caps) is part of the Volume sizing budget → [`../../intents/infrastructure/capacity-and-cost.md`](../../intents/infrastructure/capacity-and-cost.md#volume-sizing-math-3-day-hot). The per-topic byte caps (`ob.ticks` 50 GB, `spreads.live` 20 GB) are enforced by the redpanda role; the policy intent is in the [Topics](#topics) and [Retention](#retention) tables above.

## Producer config (KafkaJS)

```ts
// Hot-box ob.ticks producer — crosses the private net to the core-box broker.
const kafka = new Kafka({
  clientId: 'arbinet-trader',
  brokers: ['10.0.1.20:9092'],    // core-box private-net listener
  retry: { retries: 0 },          // we drop, not retry
})
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  maxInFlightRequests: 5,
  // KafkaJS does not expose linger.ms / buffer-bytes directly;
  // batching achieved by sending arrays from caller.
})
// acks=1 specified per send() call; 5 ms Promise.race drop (see 02)

// The core-box producer (SpreadComputer) and the CH consumers stay loopback:
//   brokers: ['127.0.0.1:9092']  — co-located with the broker, relaxed timeout.
```

## ClickHouse ingest pattern

Standard Kafka-engine → MV → MergeTree:

```sql
CREATE TABLE kafka_ob_ticks
(
  ts UInt64, ts_exchange UInt64, market_type LowCardinality(String),
  exchange LowCardinality(String), symbol LowCardinality(String),
  best_bid Float64, best_ask Float64, best_bid_qty Float64, best_ask_qty Float64,
  bids Array(Tuple(Float64, Float64)), asks Array(Tuple(Float64, Float64)),
  sequence_gap UInt8
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = '127.0.0.1:9092',
  kafka_topic_list = 'ob.ticks',
  kafka_group_name = 'ch_orderbooks',
  kafka_format = 'MsgPack',
  kafka_num_consumers = 4,
  kafka_max_block_size = 65536,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW mv_orderbooks TO orderbooks AS
SELECT
  toDateTime64(ts / 1000, 3, 'UTC')           AS ts,
  toDateTime64(ts_exchange / 1000, 3, 'UTC')  AS ts_exchange,
  market_type, exchange, symbol,
  best_bid, best_ask, best_bid_qty, best_ask_qty,
  bids, asks,
  toBool(sequence_gap)                        AS sequence_gap
FROM kafka_ob_ticks;
```

Same pattern for `spreads.live` → `mv_spreads` → `spreads`.

## Consumer-group strategy

- `ob.ticks` consumers: CH Kafka engine group `ch_orderbooks` (ingests `ob.ticks` → `orderbooks` directly, serviceless) and SpreadComputer group `spread_ticks`, each reading from `latest` (gap-accept, no replay). The two groups consume the same topic independently so both carry the same canonical `ts`.
- CH groups: `ch_orderbooks` (consumes `ob.ticks`), `ch_spreads`, `ch_funding`, `ch_trades` — consume `spreads.live` / etc.
- Query API WS fanout uses **separate** consumer groups (`qapi_ws_*`) reading `seek-to-end` so it never drags Redpanda retention by being slow.
- SpreadComputer restart accepts gap; no replay logic (see decisions table).

## Failure modes

| Event | Behavior |
|---|---|
| Hot-box producer cannot reach core-box broker | 5 ms timeout → drop tick (cross private net). `ob_ticks_drop_total` increments |
| Broker disk full | Retention deletes oldest segments; new writes succeed |
| CH consumer lag | `ch_kafka_consumer_lag` Prometheus alert at >5 s |
| SpreadComputer restart | New offsets from `latest`; `spreads.live` gap accepted, no replay |

## Links

- ob.ticks sampler detail → [02-snapshotter.md](./02-snapshotter.md)
- Spread computer producer → [06-spreads-engine.md](./06-spreads-engine.md)
- Schemas → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md)
- Metric names emitted → [08-observability.md](./08-observability.md); scrape/alert config → [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md)
- Broker install/sizing → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#redpanda)
