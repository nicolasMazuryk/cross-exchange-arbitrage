# 11 — Redis Removal

Migrate trade & funding-event state from Redis to ClickHouse. Delete Redis from repo. File-by-file plan.

## Current Redis usage (audit)

Confirmed by `grep -ril redis|ioredis|redlock src/`:

- `src/utils/config.ts` — Redis config block.
- `src/core/state/stateService.ts` — Redis persistence layer (delete entirely).
- `src/core/trading/tradeMonitor.ts` — Redis read/write of TrackedTrade lifecycle.
- `src/core/funding/fundingFeeCollector.ts` — Redis storage of funding fee events.
- `src/core/orchestration/orchestrator.ts` — wires Redis init stage.

`src/core/funding/fundingService.ts` is already in-memory; no Redis use — no change needed.

## Target architecture

| Concern | Today | After |
|---|---|---|
| Open-trade state | Redis hash `trades:open:*` | `trades` table (ReplacingMergeTree) `WHERE status='open'` |
| Trade history | Redis lists | `trades` table full history |
| Funding events on open trades | Redis hash | `trades.funding_events` array (append via ReplacingMergeTree _version bump) |
| Locks (redlock) | Redis SETNX | In-process Mutex; single trader-process invariant holds (one trader on the hot box) |
| Restore on restart | Read from Redis | `SELECT * FROM trades FINAL WHERE status='open'` |

## New module: `src/core/state/tradeStateClickhouse.ts`

```ts
// src/core/state/tradeStateClickhouse.ts
import { ClickHouseClient, createClient } from '@clickhouse/client'
import { Logger } from '../../utils/logger'

/**
 * Source of truth: `TrackedTrade` in `src/core/trading/tradeMonitor.ts:41-109`.
 * The CH `trades` table mirrors this field-for-field; see
 * [04-clickhouse-schemas.md#trades](./04-clickhouse-schemas.md#trades).
 *
 * Persistence interface re-exports the same `TrackedTrade` interface from
 * `tradeMonitor`. Two CH-only fields added at the boundary:
 *   _version: bigint   — monotonic per id, fed to ReplacingMergeTree(_version)
 *   status:  'open' | 'closed' | 'error'
 *
 * The full schema (ArbitrageOpportunity flattened, entry_trade / exit_trade
 * Tuples, funding_events array, full PnL breakdown) is in the CH DDL.
 * Keep this interface and the DDL in lock-step — any TrackedTrade field
 * change must update both.
 */
export type { TrackedTrade } from '../trading/tradeMonitor'

export class TradeStateClickhouse {
  private ch: ClickHouseClient
  private logger = new Logger('trade-state-ch')

  constructor(url: string, user: string, password: string) {
    this.ch = createClient({ url, username: user, password })
  }

  async saveTrade(t: TrackedTrade): Promise<void> {
    const row = { ...t, _version: nextVersion(t._version) }
    await this.ch.insert({
      table: 'trades',
      format: 'JSONEachRow',
      values: [serializeForCh(row)],
    })
  }

  async updateTrade(id: string, patch: Partial<TrackedTrade>): Promise<void> {
    const cur = await this.getTrade(id)
    if (!cur) throw new Error(`trade ${id} not found`)
    await this.saveTrade({ ...cur, ...patch })
  }

  async getTrade(id: string): Promise<TrackedTrade | null> {
    const rs = await this.ch.query({
      query: 'SELECT * FROM trades FINAL WHERE id = {id:String} LIMIT 1',
      query_params: { id },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<TrackedTrade>()
    return rows[0] ?? null
  }

  async getOpenTrades(): Promise<TrackedTrade[]> {
    const rs = await this.ch.query({
      query: "SELECT * FROM trades FINAL WHERE status = 'open'",
      format: 'JSONEachRow',
    })
    return rs.json<TrackedTrade>()
  }

  async getAllTrades(from?: Date, to?: Date): Promise<TrackedTrade[]> {
    const rs = await this.ch.query({
      query: `
        SELECT * FROM trades FINAL
        WHERE entry_date BETWEEN {from:DateTime} AND {to:DateTime}
        ORDER BY entry_date DESC
      `,
      query_params: { from: from ?? new Date(0), to: to ?? new Date() },
      format: 'JSONEachRow',
    })
    return rs.json<TrackedTrade>()
  }

  async appendFundingEvent(id: string, event: FundingEvent): Promise<void> {
    const cur = await this.getTrade(id)
    if (!cur) return
    cur.funding_events.push(event)
    cur.funding_net += event.amount
    await this.saveTrade(cur)
  }
}

function nextVersion(v?: bigint): bigint { return (v ?? 0n) + 1n }
```

`_version` is monotonic per `id`. ReplacingMergeTree keeps the highest. Reads use `FINAL`; for hot lookups in `tradeMonitor`, in-process cache (`Map<id, TrackedTrade>`) reflects current state — CH is authoritative for restart only.

## File-by-file changes

### 1. **New** `src/core/state/tradeStateClickhouse.ts`

Created above.

### 2. **Rewrite** `src/core/trading/tradeMonitor.ts`

Lines referenced from audit: 1319, 1592, 1631, 1775. Swap all Redis interactions for `TradeStateClickhouse`. Patterns:

```ts
// before
await this.redis.hset(`trades:open:${id}`, serialize(trade))
// after
await this.tradeState.saveTrade(trade)

// before
const open = await this.redis.hgetall('trades:open:*')
// after
const open = await this.tradeState.getOpenTrades()

// before
await this.redis.del(`trades:open:${id}`)
await this.redis.lpush('trades:history', serialize(trade))
// after
await this.tradeState.saveTrade({ ...trade, status: 'closed' })
```

`restoreState()` becomes:

```ts
async restoreState(): Promise<void> {
  const open = await this.tradeState.getOpenTrades()
  for (const t of open) this.inMemory.set(t.id, t)
  this.logger.info({ msg: 'restored open trades', function: 'TradeMonitor.restoreState', count: open.length })
}
```

### 3. **Rewrite** `src/core/funding/fundingFeeCollector.ts`

Lines 162, 301, 412. Funding events are no longer stored under a Redis key; they're appended to `trades.funding_events` for the matching open trade:

```ts
// before
await this.redis.lpush(`funding:${tradeId}`, JSON.stringify(event))
// after
await this.tradeState.appendFundingEvent(tradeId, event)
```

Cron behavior unchanged (HH:02:00 — see [04](./04-clickhouse-schemas.md#funding_rates)).

### 4. **Delete** `src/core/state/stateService.ts`

Entire file removed. Any imports updated to `TradeStateClickhouse`.

### 5. **Edit** `src/core/orchestration/orchestrator.ts`

- Delete the Redis init stage (was stage 4 per CLAUDE.md).
- Replace `private stateService: StateService` with `private tradeState: TradeStateClickhouse`.
- New init sequence:
  1. REST clients
  2. Funding service
  3. Core services (orderbook, arb engine)
  4. **ClickHouse client + TradeStateClickhouse** (was Redis)
  5. Account sync
  6. Trading services (consumes `tradeState`)
  7. WebSocket clients
  8. Funding fee collector (consumes `tradeState`)
  9. Shutdown handlers
  10. State restoration (`tradeState.getOpenTrades()`)
  11. **New**: hot-box `TickScheduler` + `ob.ticks` publisher (P1/P2), and a one-shot `INSERT INTO ops_events (ts, event) VALUES (now(), 'trader_restart')` emitted at startup (see [02](./02-snapshotter.md#backfill-on-restart)). The SpreadComputer is **not** wired into the orchestrator — it is a separate core-box app consuming `ob.ticks`; CH ingests `ob.ticks` → `orderbooks` serviceless (see [02](./02-snapshotter.md), [06](./06-spreads-engine.md)).

### 6. **Edit** `src/utils/config.ts`

- Remove `RedisConfig` block + parser.
- Add `ClickhouseConfig`:

```ts
export interface ClickhouseConfig {
  url: string                // http://10.0.1.20:8123 — core box, cross-box (accepted third hot-box egress)
  user: string
  password: string
  database: string           // 'arbinet'
}
export interface RedpandaConfig {
  brokers: string[]          // ['10.0.1.20:9092'] — core-box private-net listener
  clientId: string
  topics: {
    // Trader (hot box) produces only these two:
    ticks:  string           // 'ob.ticks' — thin 1 Hz sampler
    trades: string           // 'trades.events'
    // 'spreads.live' is produced by the core-box SpreadComputer, not the trader —
    // its topic config belongs to that service, not RedpandaConfig here.
  }
}
```

**Accepted third hot-box egress.** With ClickHouse on the core box, the trader's `TradeStateClickhouse` (writes trade state and reads it back on restart via `getOpenTrades()` `SELECT FINAL`) connects to CH **across the private net** (`10.0.1.20:8123`). This is a deliberate third hot-box egress (alongside exchange APIs and the `ob.ticks` publish), documented here as intended — not anomalous.

### 7. Runtime services (infra-owned)

The production runtime (ClickHouse, Redpanda, query-api, observability agents) is **infra-owned** — Kamal apps + accessories, not an app-managed Compose file. See [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md#kamal-accessories). The app's only obligation here: **stop depending on Redis** (drop the `redis` dep from `package.json`, item 8) and depend on ClickHouse/Redpanda via config (`ClickhouseConfig`, `RedpandaConfig`, item 6). The local-dev Compose stack is likewise described in [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md#local-development).

### 8. **Edit** `package.json`

- Remove: `ioredis`, `redlock`.
- Add: `@clickhouse/client`, `kafkajs`, `msgpack-lite`, `lru-cache` (query API), `prom-client`.

### 9. **Edit** `.env.example`

```
# remove
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=

# add
CH_URL=http://10.0.1.20:8123       # core box (cross-box; accepted third hot-box egress)
CH_USER=arbinet
CH_PASSWORD=
CH_DATABASE=arbinet
REDPANDA_BROKERS=10.0.1.20:9092    # core-box private-net listener
QUERY_API_KEY=
S3_ACCESS_KEY=
S3_SECRET_KEY=
```

### 10. **Verify** `src/core/funding/fundingService.ts`

Confirm no Redis import. Already in-memory per audit. No change.

### 11. **Edit** `npm` scripts

`docker:up` no longer starts Redis. Replace with:

```json
"docker:up":   "docker compose up -d clickhouse redpanda",
"docker:down": "docker compose down"
```

## Locks

`redlock` removed; previously protected concurrent trade transitions. Replaced by in-process `async-mutex` keyed by trade id:

```ts
import { Mutex } from 'async-mutex'
private locks = new Map<string, Mutex>()
private getLock(id: string): Mutex {
  let m = this.locks.get(id)
  if (!m) { m = new Mutex(); this.locks.set(id, m) }
  return m
}
// usage
await this.getLock(trade.id).runExclusive(async () => { ... })
```

Single trader process makes this sufficient. If P2 splits trader into multiple processes, revisit (CH `INSERT … ALTER` row locking insufficient; need external coordination).

## Cutover

Two options, choose simpler:

**Option A — dual-write then cut (safe, ~3 days)**
1. Ship CH `trades` table, fees seed.
2. Add dual-write in `tradeMonitor` and `fundingFeeCollector`: write Redis + CH.
3. After 24 h, cut reads to CH (open-trade restore from CH).
4. After another 24 h, delete Redis writes.
5. Delete Redis from compose + repo.

**Option B — maintenance-window cutover (simple, ~1 hour)**
1. Ship CH `trades` table.
2. Schedule maintenance window with no open positions (close all manually).
3. Deploy CH-only branch; Redis service deleted.
4. Accept: any open trade at cutover is lost from state and must be reconciled by hand.

User decision needed — recommend **Option B** since open trades are rare and the system has graceful-shutdown closing logic.

## Verification checklist

- [ ] No references to `ioredis`, `redlock`, or `RedisClient` in `src/` (`grep -ril redis src/` returns empty).
- [ ] `npm install` removes ioredis from `node_modules`.
- [ ] `docker compose config` shows no redis service.
- [ ] Orchestrator boot logs show CH init replacing Redis.
- [ ] On graceful restart with one open trade, trade restored from CH (`tradeMonitor.restoreState()` log shows `count: 1`).
- [ ] Funding fee collector appends events to `trades.funding_events` (`SELECT length(funding_events) FROM trades FINAL WHERE id=...`).

## Links

- `trades` table → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md#trades)
- Runtime services & secrets → [`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md)
- Phasing → [12-phasing-and-risks.md](./12-phasing-and-risks.md)
