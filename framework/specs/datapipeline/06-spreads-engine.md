# 06 — Spreads Engine

The **lone warm core-box service**: it consumes `ob.ticks`, computes cross-exchange spreads, and emits to `spreads.live`. No in-process orderbook access — it reads the `ob.ticks` stream (the same raw stream CH ingests directly into `orderbooks`), co-located with the broker (loopback).

## Goals

- One row per (symbol, buy_exchange, sell_exchange, buy_market_type, sell_market_type) per tick for every cross-listed pair.
- `spreads.ts == orderbooks.ts` exactly — the `ts` is **taken from the consumed `ob.ticks` row** (equality via data, no shared scheduler); `orderbooks.ts` comes from CH consuming the same `ob.ticks` directly.
- Per-leg latency, stale flag, negative spreads preserved.
- Costs and fees joined in-process from cached `fees` table (CH over core-box loopback).

## Class sketch

```ts
// src/services/spreadComputer/spreadComputer.ts
import { Kafka, Producer, Consumer, CompressionTypes } from 'kafkajs'
import msgpack from 'msgpack-lite'
import { FeesCache } from './feesCache'
import { Logger } from '../../utils/logger'
import { Counter } from 'prom-client'

const dropTotal = new Counter({
  name: 'spread_engine_drop_total',
  help: 'Spread rows dropped on producer backpressure',
  labelNames: ['reason'],
})

type BBO = {
  bid: number; bidQty: number; ask: number; askQty: number
  ts_exchange: number
  ob_spread_bps: number
  market_type: 'SPOT' | 'LINEAR' | 'INVERSE'
}

interface SpreadRow {
  ts: number
  latency_buy_ms: number
  latency_sell_ms: number
  symbol: string
  buy_market_type: string
  sell_market_type: string
  buy_exchange: string
  sell_exchange: string
  buy_ask: number
  sell_bid: number
  spread: number
  spread_bps: number
  exec_size: number
  spread_costs_bps: number
  trading_fees_bps: number
  stale: boolean
}

export class SpreadComputer {
  private producer: Producer
  private consumer: Consumer
  private logger = new Logger('spread-computer')
  private staleThresholdMs = 2000
  private produceTimeoutMs = 1000   // core-box loopback; relaxed, normal backpressure
  private graceMs = 250             // watermark slack: tolerate 16 interleaved partitions arriving out of order

  // Accumulate consumed ticks per canonical ts; flush a ts once the watermark passes it.
  // ob.ticks has 16 partitions, so rows for one ts arrive interleaved across partitions —
  // a flush-on-ts-change would fire prematurely/partially. Hold per-ts buckets, flush on watermark.
  private maxSeenTs = 0
  private byTs = new Map<number, Map<string, Map<string, BBO>>>()  // ts -> symbol -> exchange -> BBO

  constructor(
    kafka: Kafka,            // brokers: ['127.0.0.1:9092'] (core-box loopback)
    private fees: FeesCache,
  ) {
    this.producer = kafka.producer({ allowAutoTopicCreation: false, maxInFlightRequests: 5 })
    this.consumer = kafka.consumer({ groupId: 'spread_ticks' })
  }

  async start(): Promise<void> {
    await this.producer.connect()
    await this.consumer.connect()
    await this.consumer.subscribe({ topic: 'ob.ticks', fromBeginning: false })
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const tick = msgpack.decode(message.value!)
        // ob.ticks carries the canonical ts stamped once on the hot box; we copy it
        // verbatim so spreads.ts == orderbooks.ts holds by construction.
        this.accumulate(tick)
        if (tick.ts > this.maxSeenTs) this.maxSeenTs = tick.ts
        await this.flushReady()   // emit every ts the watermark has passed
      },
    })
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect()
    await this.producer.disconnect()
  }

  private accumulate(tick: any): void {
    if (!tick.bids?.[0] || !tick.asks?.[0]) return
    const bbo: BBO = {
      bid: tick.bids[0][0], bidQty: tick.bids[0][1],
      ask: tick.asks[0][0], askQty: tick.asks[0][1],
      ts_exchange: tick.ts_exchange ?? 0,
      ob_spread_bps: tick.bids[0][0] > 0 ? (tick.asks[0][0] - tick.bids[0][0]) / tick.bids[0][0] * 10000 : 0,
      market_type: tick.market_type,
    }
    let byPair = this.byTs.get(tick.ts)
    if (!byPair) { byPair = new Map(); this.byTs.set(tick.ts, byPair) }
    let inner = byPair.get(tick.symbol)
    if (!inner) { inner = new Map(); byPair.set(tick.symbol, inner) }
    inner.set(tick.exchange, bbo)
  }

  // Flush every buffered ts at or below the watermark (maxSeenTs - grace), oldest first.
  private async flushReady(): Promise<void> {
    const watermark = this.maxSeenTs - this.graceMs
    const ready = [...this.byTs.keys()].filter(ts => ts <= watermark).sort((a, b) => a - b)
    for (const ts of ready) {
      const byPair = this.byTs.get(ts)!
      this.byTs.delete(ts)
      await this.flush(ts, byPair)
    }
  }

  // Emit all cross-exchange spreads for the completed tick, carrying its ts.
  private async flush(tickTs: number, byPair: Map<string, Map<string, BBO>>): Promise<void> {
    const rows: SpreadRow[] = []
    for (const [symbol, byExchange] of byPair) {
      const entries = [...byExchange.entries()]
      if (entries.length < 2) continue
      for (let i = 0; i < entries.length; i++) {
        for (let j = 0; j < entries.length; j++) {
          if (i === j) continue
          const [buyExchange, buyBBO]  = entries[i]
          const [sellExchange, sellBBO] = entries[j]
          rows.push(this.computeRow(tickTs, symbol, buyExchange, buyBBO, sellExchange, sellBBO))
        }
      }
    }
    await this.emit(rows)
  }

  private computeRow(
    tickTs: number,
    symbol: string,
    buyExchange: string, buy: BBO,
    sellExchange: string, sell: BBO,
  ): SpreadRow {
    const spread = sell.bid - buy.ask
    const spread_bps = buy.ask > 0 ? (spread / buy.ask) * 10000 : 0
    const strategy = deriveStrategy(buy.market_type, sell.market_type)
    const spread_costs_bps = strategy === 'spot-spot' ? 0 : buy.ob_spread_bps + sell.ob_spread_bps
    const feeMul = strategy === 'spot-spot' ? 1 : 2   // perp legs paid on enter + exit
    const trading_fees_bps =
      (this.fees.get(buyExchange,  buy.market_type,  'taker') +
       this.fees.get(sellExchange, sell.market_type, 'taker')) * feeMul
    const stale =
      (tickTs - buy.ts_exchange  > this.staleThresholdMs) ||
      (tickTs - sell.ts_exchange > this.staleThresholdMs)
    const exec_size = Math.min(buy.askQty, sell.bidQty)
    return {
      ts: tickTs,
      latency_buy_ms:  buy.ts_exchange  ? tickTs - buy.ts_exchange  : 0,
      latency_sell_ms: sell.ts_exchange ? tickTs - sell.ts_exchange : 0,
      symbol,
      buy_market_type:  buy.market_type,
      sell_market_type: sell.market_type,
      buy_exchange, sell_exchange,
      buy_ask: buy.ask, sell_bid: sell.bid,
      spread_bps,
      exec_size,
      spread_costs_bps,
      trading_fees_bps,
      stale,
    }
  }

  private async emit(rows: SpreadRow[]): Promise<void> {
    const messages = rows.map(r => ({
      key: `${r.buy_exchange}:${r.buy_market_type}:${r.sell_exchange}:${r.sell_market_type}:${r.symbol}`,
      value: msgpack.encode(r),
      timestamp: r.ts.toString(),
    }))
    try {
      await Promise.race([
        this.producer.send({
          topic: 'spreads.live',
          compression: CompressionTypes.LZ4,
          acks: 1,
          messages,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('produce-timeout')), this.produceTimeoutMs),
        ),
      ])
    } catch (err: any) {
      const reason = err?.message === 'produce-timeout' ? 'timeout' : 'error'
      dropTotal.inc({ reason }, rows.length)
    }
  }
}

function deriveStrategy(buy: string, sell: string): 'spot-spot' | 'spot-perp' | 'perp-perp' {
  const isPerp = (m: string) => m === 'LINEAR' || m === 'INVERSE'
  if (!isPerp(buy) && !isPerp(sell)) return 'spot-spot'
  if (isPerp(buy)  &&  isPerp(sell)) return 'perp-perp'
  return 'spot-perp'
}
```

## Fees cache

Runs on the **core box** alongside the SpreadComputer, querying CH over loopback (`127.0.0.1:8123`).

```ts
// src/services/spreadComputer/feesCache.ts
import { ClickHouseClient } from '@clickhouse/client'

export class FeesCache {
  private cache = new Map<string, number>()  // key = `${exchange}:${marketType}:${orderType}`
  private timer?: NodeJS.Timeout

  constructor(private ch: ClickHouseClient) {}

  async start(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => { this.refresh().catch(() => {}) }, 60 * 60 * 1000)
  }

  stop(): void { if (this.timer) clearInterval(this.timer) }

  get(exchange: string, marketType: string, orderType: 'maker' | 'taker'): number {
    return this.cache.get(`${exchange}:${marketType}:${orderType}`)
  }

  private async refresh(): Promise<void> {
    const rs = await this.ch.query({ query: 'SELECT exchange, market_type, order_type, fee_bps FROM fees', format: 'JSONEachRow' })
    const rows = await rs.json<{ exchange: string; market_type: string; order_type: string; fee_bps: number }>()
    const next = new Map<string, number>()
    for (const r of rows) next.set(`${r.exchange}:${r.market_type}:${r.order_type}`, r.fee_bps)
    this.cache = next
  }
}
```

## Formulas (locked)

```
spread_bps        = ((sell_bid - buy_ask) / buy_ask) * 10000
spread_costs_bps  = strategy == 'spot-spot' ? 0
                                            : ob_spread_bps(buy_leg) + ob_spread_bps(sell_leg)
trading_fees_bps  = (fee(buy_exchange,  buy_market_type,  'taker') +
                     fee(sell_exchange, sell_market_type, 'taker'))
                  × (strategy == 'spot-spot' ? 1 : 2)
profit_bps        = spread_bps - spread_costs_bps - trading_fees_bps   -- MATERIALIZED in CH
strategy          = mapping(buy_market_type, sell_market_type)
stale             = (now - ts_exchange_buy  > 2000) || (now - ts_exchange_sell > 2000)
```

`profit_bps` is `MATERIALIZED` on the CH side ([04](./04-clickhouse-schemas.md#spreads)) so the engine doesn't write it.

## Stale handling

Stale rows still emit (decision: emit all cross-listed pairs always). UI filters via `stale = false`. Rollups can stratify with `countIf(stale)` if needed.

## Sizing

- Cross-listed pairs: ~1500 symbols × C(4,2) ordered = ~1500 × 12 = 18 000 max; in practice far fewer pairs cross-list across all 4. Conservative target ~9 k rows/s.
- Producer batch: one `send()` per tick, ~9 k messages. KafkaJS batches via internal partitioner.

## Tick alignment without a shared scheduler

SpreadComputer is the **lone warm core-box service** — there is no shared in-process scheduler. The single `TickScheduler` lives on the **hot box** and drives only the `ob.ticks` sampler ([02](./02-snapshotter.md)), where the canonical `ts` is stamped once:

```ts
// src/core/snapshot/tickScheduler.ts — HOT BOX ONLY, drives the ob.ticks sampler
type Subscriber = (tickTs: number) => Promise<void> | void
export class TickScheduler {
  private subs: Subscriber[] = []
  private timer?: NodeJS.Timeout
  subscribe(s: Subscriber): void { this.subs.push(s) }
  start(): void { this.schedule() }
  stop(): void { if (this.timer) clearTimeout(this.timer) }
  private schedule(): void {
    const delay = 1000 - (Date.now() % 1000)
    this.timer = setTimeout(() => {
      const t = Date.now()
      for (const s of this.subs) Promise.resolve(s(t)).catch(() => {})
      this.schedule()
    }, delay)
  }
}
```

`spreads.ts == orderbooks.ts` holds **by construction**: each `ob.ticks` row carries the `ts` stamped by the hot-box sampler; CH copies it into `orderbooks` (Kafka engine, serviceless) and the SpreadComputer copies it verbatim into `spreads.live`. No cross-process clock coordination is needed. The orchestrator does not register the SpreadComputer — it owns only the hot-box `TickScheduler` + `ob.ticks` publisher (see [11](./11-redis-removal.md)).

## Links

- Tick & gap → [02-snapshotter.md](./02-snapshotter.md)
- Topics → [03-buffer-redpanda.md](./03-buffer-redpanda.md#topics)
- `spreads` DDL → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md#spreads)
- Rollup MVs → [05-rollups-and-mvs.md](./05-rollups-and-mvs.md)
- API consumer → [07-query-api.md](./07-query-api.md)
