# 07 — Query API

Separate Node/TypeScript process under `src/services/queryApi/`. Serves trader UI + ad-hoc queries. Reads ClickHouse and tails Redpanda for WS fanout.

## Process layout

```
src/services/queryApi/
├── server.ts             # Express + ws; entrypoint
├── auth.ts               # API-key middleware
├── rollup.ts             # selectRollup() resolver
├── handlers/
│   ├── pairs.ts
│   ├── spreadsTop.ts
│   ├── spreadsHistory.ts
│   ├── orderbooksDepth.ts
│   ├── statsPair.ts
│   ├── trades.ts
│   └── funding.ts
├── stream/
│   ├── fanout.ts         # Redpanda consumer → ws clients
│   └── coalescer.ts      # 1 push / sec / channel
├── cache.ts              # LRU keyed by query+args
└── ch.ts                 # @clickhouse/client singleton
```

Runs in its own container **on the core box**, talks to CH and Redpanda over loopback.

## Auth

```ts
// src/services/queryApi/auth.ts
import { Request, Response, NextFunction } from 'express'

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('X-API-Key')
  if (!key || key !== process.env.QUERY_API_KEY) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  next()
}
```

WS upgrade also checks `X-API-Key` via the upgrade request header.

No TLS in-app — TLS is terminated by **kamal-proxy (TLS via Let's Encrypt) on the core box** (infra-owned; Hetzner LB dropped), with the Hetzner Cloud firewall fronting it. See [`../../intents/infrastructure/infrastructure-provisioning.md`](../../intents/infrastructure/infrastructure-provisioning.md#query-api-ingress-reframed). The query-api container binds to `127.0.0.1` on the core box and is reached only via kamal-proxy.

## HTTP endpoints

| Method | Path | Purpose | Backed by |
|---|---|---|---|
| GET | `/pairs` | List cross-listed pairs | `SELECT DISTINCT symbol, buy_exchange, sell_exchange, buy_market_type, sell_market_type FROM spreads_3s WHERE bucket > now()-INTERVAL 10 MINUTES` (cached 5 min) |
| GET | `/spreads/top?strategy=&limit=50&min_profit_bps=` | Top live opportunities (rows include `buy_market_type`, `sell_market_type`) | latest 1 s from `spreads` + in-mem top-50 from WS tail |
| GET | `/spreads/history?pair=&buy=&sell=&buy_type=&sell_type=&from=&to=&pixels=` | Time-series | `selectRollup()` → `spreads_*` |
| GET | `/orderbooks/depth?exchange=&symbol=&market_type=` | Top-N book | latest row from `orderbooks` |
| GET | `/stats/pair?pair=&buy=&sell=&buy_type=&sell_type=&lookback=24h` | Histogram + quantiles + entry persistance + exit decay | `pair_stats_24h`, `spread_persistance_24h` |
| GET | `/trades?status=&from=&to=` | Trade history | `trades FINAL` |
| GET | `/funding?exchange=&symbol=&from=&to=` | Funding history | `funding_rates` |
| GET | `/healthz` | Liveness | — |
| GET | `/metrics` | Prometheus scrape | `prom-client` |

### `/spreads/history` request handler sketch

```ts
import { selectRollup } from '../rollup'
import { ch } from '../ch'
import { lruGet, lruSet } from '../cache'

export async function spreadsHistory(req, res) {
  const { pair, buy, sell, buy_type, sell_type, from, to, pixels } = req.query
  const fromTs = new Date(String(from))
  const toTs   = new Date(String(to))
  const rangeSec = (toTs.getTime() - fromTs.getTime()) / 1000
  const tier = selectRollup(rangeSec, Number(pixels) || 1200)

  const cacheKey = `${tier.name}:${pair}:${buy}:${buy_type}:${sell}:${sell_type}:${from}:${to}:${pixels}`
  const cached = lruGet(cacheKey)
  if (cached) return res.json(cached)

  const rows = await ch.query({
    query: `
      SELECT
        bucket,
        minMerge(spread_bps_min) AS min,
        maxMerge(spread_bps_max) AS max,
        medianMerge(spread_bps_median) AS median,
        arrayElement(quantilesMerge(0.01,0.05,0.10,0.25,0.5,0.75,0.90,0.95,0.99)(spread_bps_q), 8) AS p95
      FROM ${tier.name}
      WHERE symbol = {pair:String}
        AND buy_exchange  = {buy:String}  AND buy_market_type  = {buy_type:String}
        AND sell_exchange = {sell:String} AND sell_market_type = {sell_type:String}
        AND bucket BETWEEN {from:DateTime} AND {to:DateTime}
      GROUP BY bucket
      ORDER BY bucket
    `,
    query_params: { pair, buy, sell, buy_type, sell_type, from: fromTs, to: toTs },
    format: 'JSONEachRow',
  }).then(r => r.json())

  lruSet(cacheKey, rows, tier.bucketSec * 1000)
  res.json(rows)
}
```

## WS `/stream`

Single endpoint, channel multiplexing on subscribe messages:

```jsonc
// client -> server
{ "op": "subscribe", "channel": "spreads.top",          "args": { "limit": 50 } }
{ "op": "subscribe", "channel": "spreads.pair",         "args": { "pair": "BTC/USDT", "buy": "binance", "buy_type": "SPOT", "sell": "okx", "sell_type": "INVERSE" } }
{ "op": "subscribe", "channel": "orderbooks.depth",     "args": { "exchange": "binance", "symbol": "BTC/USDT", "type": "LINEAR" } }

// server -> client (deltas only)
{ "ch": "spreads.pair", "ts": 1716691200000, "spread_bps": 4.2, "profit_bps": 1.1 }
```

### Fanout & coalescing

- One Redpanda consumer group `qapi_ws_fanout` reading `spreads.live` from `latest`.
- In-memory state: last value per `(channel, key)`.
- Coalescer flushes once per 1 s to every subscribed socket so 9 k/s spreads don't drown clients.

```ts
// src/services/queryApi/stream/coalescer.ts
type Key = string
const pending = new Map<Key, unknown>()
setInterval(() => {
  for (const [k, msg] of pending) {
    deliver(k, msg)
  }
  pending.clear()
}, 1000)

export function publish(k: Key, msg: unknown): void {
  pending.set(k, msg)  // last write wins
}
```

- Deltas-only: don't push if value hasn't changed since last push.
- Fanout key for `spreads.pair`: `${channel}:${pair}:${buy}:${buy_type}:${sell}:${sell_type}` — matches the Redpanda `spreads.live` partition key and disambiguates spot/perp on the same pair.

## Caching

- `lru-cache` with TTL = rollup bucket size for `/spreads/history`.
- `/stats/pair` cached 5 min.
- `/pairs` cached 5 min.
- No cache for `/spreads/top` (driven by WS in-memory state) or `/orderbooks/depth` (always latest).

## Single-session enforcement

- Track active WS upgrade count in process; reject second upgrade with HTTP 409 (decision: single trader UI session).
- Note: this is single-process; if Query API scales horizontally later, need shared lock.

## Failure & degrade

| Event | Behavior |
|---|---|
| CH unavailable | HTTP 503; metric `qapi_ch_errors_total++` |
| Redpanda unavailable | WS stops receiving; HTTP endpoints still work |
| Slow client | Bounded send queue per socket; drop oldest delta with metric |
| Wrong API key | 401 + rate-limit IP |

## Sizing

- One UI client, ~3-5 subscribed channels typical.
- HTTP RPS: <1 (interactive only).
- WS push: ~5 msg/s after coalescing.
- CH query cost dominated by `/spreads/history` (LRU absorbs reloads).

## Links

- Rollup tables → [05-rollups-and-mvs.md](./05-rollups-and-mvs.md)
- Live topics tailed → [03-buffer-redpanda.md](./03-buffer-redpanda.md)
- `qapi_*` metric names emitted → [08-observability.md](./08-observability.md); SLOs/alerts → [`../../intents/infrastructure/observability-stack.md`](../../intents/infrastructure/observability-stack.md)
- TLS ingress (kamal-proxy on the core box) → [`../../intents/infrastructure/infrastructure-provisioning.md`](../../intents/infrastructure/infrastructure-provisioning.md#query-api-ingress-reframed)
