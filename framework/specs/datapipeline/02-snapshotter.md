# 02 — ob.ticks Sampler

One component: the **hot-box thin sampler** (`ob.ticks` publisher), running in the trader process. It reads `orderbookManager.getAllOrderbooks()` in-process on a 1 Hz wall-clock tick — including the per-book `sequence_gap` flag set upstream by the WS adapter — stamps the canonical `ts` (the tick) + `ts_exchange`, builds top-10 rows, and publishes them to `ob.ticks` on the core-box Redpanda over the private net. Async, bounded, **≤5 ms drop-on-timeout** — hot-path latency untouched. **No book reconstruction leaves the hot box**; the raw sampling stays here.

`ob.ticks` is the raw system-of-record stream: ClickHouse consumes it directly via a Kafka engine (serviceless raw path, see [03](./03-buffer-redpanda.md#clickhouse-ingest-pattern)), and the core-box SpreadComputer consumes it for cross-exchange spreads ([06](./06-spreads-engine.md)).

## Goals

- 1 Hz aligned cadence per pair (`Date.now() % 1000 == 0 ± a few ms`), stamped **once** on the hot box and carried through `ob.ticks`.
- Dual timestamps: wall-clock `ts` and exchange `ts_exchange`.
- Carry the per-(exchange, symbol) `sequence_gap` flag set upstream in the WS adapter — a 1 s-window discontinuity flag, no gap math in the sampler.
- Top-10 levels both sides.
- Non-blocking hot-box emit; drop on backpressure ≤ 5 ms timeout.

## Class sketch

### Hot-box `ob.ticks` publisher (thin 1 Hz sampler)

Runs in the trader process. The only Redpanda I/O on the hot path: an async, bounded, ≤5 ms drop-on-timeout produce to the core-box broker. No gap detection here — `sequence_gap` is set upstream in the WS adapter and read off each book verbatim.

```ts
// src/core/snapshot/obTicksPublisher.ts
import { Kafka, Producer, CompressionTypes } from 'kafkajs'
import msgpack from 'msgpack-lite'
import { OrderbookManager } from '../orderbook/orderbookManager'
import { Logger } from '../../utils/logger'
import { Counter, Gauge, Histogram } from 'prom-client'

const dropTotal = new Counter({
  name: 'ob_ticks_drop_total',
  help: 'ob.ticks rows dropped on hot-box producer backpressure',
  labelNames: ['reason'],
})
const produceSeconds = new Histogram({
  name: 'ob_ticks_produce_seconds',
  help: 'Hot-box ob.ticks produce duration',
})
const tickLag = new Gauge({
  name: 'snapshotter_tick_lag_seconds',
  help: 'now - last successful tick wall-clock',
})

interface TickRow {
  ts: number            // ms epoch, wall-clock when tick fired (canonical, stamped here once)
  ts_exchange: number   // ms epoch, OrderBook.timestamp from connector
  market_type: 'SPOT' | 'LINEAR' | 'INVERSE'
  exchange: string
  symbol: string
  best_bid: number
  best_ask: number
  best_bid_qty: number
  best_ask_qty: number
  bids: [number, number][]   // top-10
  asks: [number, number][]   // top-10
  sequence_gap: boolean      // ≥1 discontinuity in this 1 s window; set upstream in the WS adapter
}

export class ObTicksPublisher {
  private timer?: NodeJS.Timeout
  private producer: Producer
  private logger = new Logger('ob-ticks-publisher')
  private depthN = 10
  private produceTimeoutMs = 5     // hot-path protective drop

  constructor(
    private orderbookManager: OrderbookManager,
    kafka: Kafka,                  // brokers: ['10.0.1.20:9092'] (core-box, private net)
  ) {
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: false,
    })
  }

  async start(): Promise<void> {
    await this.producer.connect()
    this.scheduleAlignedTick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    await this.producer.disconnect()
  }

  private scheduleAlignedTick(): void {
    const delay = 1000 - (Date.now() % 1000)
    this.timer = setTimeout(() => {
      const tickTs = Date.now()
      // Fire-and-forget; never await before next scheduling
      this.tick(tickTs).catch(err => this.logger.error({ msg: 'tick error', error: err }))
      this.scheduleAlignedTick()
    }, delay)
  }

  private async tick(tickTs: number): Promise<void> {
    tickLag.set(0)
    const books = this.orderbookManager.getAllOrderbooks()  // synchronous in-memory read (hot box)
    const rows: TickRow[] = books.map(ob => ({
      ts: tickTs,
      ts_exchange: ob.timestamp ?? tickTs,
      market_type: ob.marketType,
      exchange: ob.exchange,
      symbol: ob.symbol,
      best_bid: ob.bids[0]?.[0] ?? 0,
      best_ask: ob.asks[0]?.[0] ?? 0,
      best_bid_qty: ob.bids[0]?.[1] ?? 0,
      best_ask_qty: ob.asks[0]?.[1] ?? 0,
      bids: ob.bids.slice(0, this.depthN),
      asks: ob.asks.slice(0, this.depthN),
      sequence_gap: ob.sequenceGap ?? false,   // set upstream in the WS adapter; carried verbatim
    }))
    await this.emit(rows)
  }

  private async emit(rows: TickRow[]): Promise<void> {
    const messages = rows.map(r => ({
      key: `${r.exchange}:${r.market_type}:${r.symbol}`,
      value: msgpack.encode(r),
      timestamp: r.ts.toString(),
    }))
    const end = produceSeconds.startTimer()
    try {
      await Promise.race([
        this.producer.send({ topic: 'ob.ticks', compression: CompressionTypes.LZ4, acks: 1, messages }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('produce-timeout')), this.produceTimeoutMs),
        ),
      ])
    } catch (err: any) {
      const reason = err?.message === 'produce-timeout' ? 'timeout' : 'error'
      dropTotal.inc({ reason }, rows.length)
      this.logger.warn({ msg: 'ob.ticks drop', function: 'ObTicksPublisher.emit', reason, count: rows.length })
    } finally {
      end()
    }
  }
}
```

## Wall-clock alignment

- Tick fires at `Date.now() % 1000 == 0` (±jitter from event loop) on the **hot box**, where `ts` is stamped **once**.
- The SpreadComputer is a **separate core-box app** — no shared in-process scheduler. It **copies the canonical `ts`** from the `ob.ticks` row it consumes, so `spreads.ts == orderbooks.ts` holds **by construction (via data, not a shared clock)** — `orderbooks.ts` comes from CH consuming `ob.ticks` directly.
- chrony keeps host clocks within 50 ms of UTC on both boxes; the chrony role is infra-owned → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#chrony).

## Sequence-gap detection

The per-(exchange, symbol) continuity check lives **upstream in each WS adapter** (out of scope here). It sets `sequence_gap = true` on the in-memory book when it detects a discontinuity (lost WS updates). The 1 Hz sampler reads that flag off the book and carries it verbatim on `ob.ticks` as a "≥1 discontinuity in this 1 s window" flag. Counter `sequence_gap_total{exchange,type}` is incremented by the WS continuity check, not the pipeline. Downstream rollups can mask gap rows from BBO calcs if needed.

## Drop policy

The hot-box `ob.ticks` producer is the only producer on the raw path (CH consumes `ob.ticks` serviceless):

- **Hot-box `ob.ticks` producer**: `acks=1`, LZ4, buffer cap ~64 MB. Per-tick produce wrapped in `Promise.race` with a **5 ms** timeout. On timeout or error: increment `ob_ticks_drop_total{reason}` by row count, log warn, **never** retry within this tick. Hot path untouched — the produce is fire-and-forget from the trade loop's perspective.

See [01](./01-topology.md#hot--warm--cold-boundary) for the cross-box backpressure boundary.

## Backfill on restart

No backfill (decision). On hot-box WS reconnect, the WS adapter raises `sequence_gap = true`, which propagates through `ob.ticks` and into `orderbooks`; the first row per pair after the discontinuity is flagged. CH ingests forward only — gaps are accepted and marked, never replayed.

The discontinuity marker in CH for analytics is **emitted by the trader at its own startup** (one row), decoupled from per-key gaps:

```sql
-- Done by the trader once, at startup
INSERT INTO ops_events (ts, event) VALUES (now(), 'trader_restart');
```

`ops_events` is a tiny MergeTree table ([04](./04-clickhouse-schemas.md#ops_events)); analytics/backtest queries can `JOIN` against it to mask rows around a restart.

## Emit format

- Topic: **`ob.ticks`** (produced by the hot-box sampler).
- Partition key: `${exchange}:${market_type}:${symbol}` (hashed into partitions; uniqueness requires `market_type` since the same symbol can stream from spot and perp)
- Value: msgpack-encoded `TickRow`
- Headers: `schema_version=1`

## Capacity sketch

- 4 exchanges × ~1500 symbols × 1 Hz = ~6000 rows/s peak (use ~10k design margin).
- Row size after msgpack + LZ4: ~250 B → ~1.5 MB/s pre-batch, ~0.6 MB/s after compression.
- Comfortably under 64 MB producer buffer at any realistic stall.

## Open

- The `orderbookManager.getAllOrderbooks()` read **stays on the hot box** (the thin sampler reads the in-memory map there). If that read on a 1500-symbol map exceeds 50 ms, switch to a copy-on-write ring buffer. Benchmark in P1 prototype (see [12-phasing-and-risks.md](./12-phasing-and-risks.md#open-questions--prototype-needs)).
- For P2 WS-per-exchange split: the hot-box sampler consumes from in-memory IPC instead of the direct map; `ob.ticks` format unchanged.

## Links

- Hot/warm boundary → [01-topology.md](./01-topology.md#hot--warm--cold-boundary)
- Topic config → [03-buffer-redpanda.md](./03-buffer-redpanda.md)
- `orderbooks` + `ops_events` schema → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md#orderbooks)
- SLIs → [08-observability.md](./08-observability.md)
