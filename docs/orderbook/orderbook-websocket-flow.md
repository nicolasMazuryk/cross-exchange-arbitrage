# Orderbook WebSocket Flow

## 1. Overview

ArbiNet ingests real-time orderbooks over WebSocket, normalizes each exchange's
native message into one unified `OrderBookUpdate` shape, maintains a local book per
`(exchange, symbol)`, and emits a `topOfBookUpdate` whenever the best bid/ask price
moves. That event drives the arbitrage engine. Each exchange client owns one or more
WebSocket connections (batched by market type and stream count); a per-exchange
`MessageParser` translates frames; the shared `OrderbookManager` holds state and
detects top-of-book changes.

```
exchange WS
  → exchange client (BinancePublicWebSocketClient / Bybit / Okx / Bitget)
    → MessageParser.parseOrderBookUpdate
      → OrderBookUpdate
        → client.emit('orderbookUpdate')                      (within TraceContext)
          → orchestrator: ws.on('orderbookUpdate')            (orchestrator.ts:715)
            → OrderbookManager.updateOrderbook                (orderbookManager.ts:57)
              → emit('topOfBookUpdate')  [only on best px change]  (orderbookManager.ts:112)
                → ArbitrageEngine.scanOpportunities           (arbitrageEngine.ts:208)
                → TradeMonitor                                (tradeMonitor.ts:517)
```

## 2. Connection lifecycle (`base.ts`)

`BasePublicWebSocketClient` (`base.ts:10`) is an `EventEmitter` holding the shared
batching, reconnect, and symbol-resolution logic. Three abstract seams are
implemented per exchange (`base.ts:263-265`): `createClient()`, `setupEventHandlers(batch)`,
`subscribeToSymbols(batch)`.

**Initialize** (`base.ts:23-72`):
- Builds a type-aware lookup `Map<"${marketType}:${market.id}", unifiedSymbol>`
  (`base.ts:28-32`) so spot and linear markets that share a `market.id` resolve
  correctly. Read back via `getUnifiedSymbol()` (`base.ts:254-260`), which throws if
  a `marketId`+`marketType` pair is unknown.
- Groups markets by `MarketType` (`base.ts:35-43`), applying `filterMarketType()`
  (`base.ts:76-79`) — a single-market-type client (e.g. a Binance spot vs usdm
  client configured with `config.marketType`) drops other types by returning `null`.
- For each type, splits ids into batches of `config.maxStreamsPerConnection`
  (`groupSymbolsIntoBatches`, `base.ts:81-87`) and opens **one connection per batch**
  via `createPublicWebSocketConnection` (`base.ts:46-52`). `batchIndex` is global and
  monotonic across all market types.

**Per-connection setup** (`createPublicWebSocketConnection`, `base.ts:89-146`):
- `createClient()` → a fresh client. On a fresh connect, a `StreamBatch`
  (`{id, client, symbols, marketType, isConnected:false}`, see `types.ts:18-24`) is
  built and pushed (`base.ts:111-123`). On reconnect, the existing batch is found by
  id, its old client is cleaned up, and the new client is swapped in (`base.ts:104-110`).
- `setupEventHandlers(batch)` then `subscribeToSymbols(batch)`.

**Reconnect** (`handleConnectionError`, `base.ts:178-207`):
- Guarded by a `reconnectingBatches: Set<number>` — a second error for an
  already-reconnecting batch returns immediately (`base.ts:179-180`).
- Waits a **fixed** `config.reconnectInterval` (`base.ts:191`) — *not* exponential
  backoff, no jitter.
- Reuses the same batch object (same `id`, `symbols`, `marketType`) and reconnects
  (`base.ts:192`). On success the batch leaves the reconnecting set; on failure it is
  removed and the method **recurses** (`base.ts:204-205`) — an unbounded tight retry
  loop against a persistently failing endpoint.

**Cleanup** (`cleanupClient`, `base.ts:148-176`):
- Nulls `batch.client`, then on the *old* client calls `removeAllListeners()` and
  re-attaches a **no-op `error` handler** before `closeAll()`/`close()`
  (`base.ts:159-166`). This absorbs async errors fired by library-internal reconnect
  timers (notably `okx-api`) after our listeners are gone — without the no-op,
  Node throws `ERR_UNHANDLED_ERROR` and crashes the process.
- `close()` (`base.ts:209-252`) cleans every batch and clears `streamBatches`; errors
  are logged and swallowed so shutdown proceeds.

## 3. Per-exchange subscription & parsing

| Exchange | Library / client | Channel / stream | Depth | `type` marker | Sequence fields parsed | Per-symbol error event |
|----------|------------------|------------------|-------|---------------|------------------------|------------------------|
| Binance | custom `ws` (`BinanceCombinedStreamClient`, `binance.ts:17`) | `<sym>@depth5@100ms` combined stream (`binance.ts:259`) | 5 @ 100ms | hardcoded `'snapshot'` for **both** spot & deriv (`binance.ts:120,141`) | `lastUpdateId` (spot, `:135`); `U`/`u`/`pu` → `firstUpdateId`/`finalUpdateId`/`prevFinalUpdateId` (deriv, `:156-158`) | n/a |
| Bybit | `bybit-api` `WebsocketClient` (`bybit.ts:51`) | `orderbook.50.<sym>` (`bybit.ts:166`) | 50 | from `data.type` — exchange's own snapshot/delta (`bybit.ts:20`) | `u` → `finalUpdateId`, `seq` → `sequence` (`bybit.ts:35-36`) | `exception`, `ret_msg` contains `handler not found` (`bybit.ts:110-122`) |
| OKX | `okx-api` `WebsocketClient` (`okx.ts:53`) | `books` channel (`okx.ts:177`) | 400 | `action==='update' ? 'delta' : 'snapshot'` (`okx.ts:19`) | `seqId` → both `finalUpdateId` and `sequence` (`okx.ts:37-38`) | `error`, code `60018` (`okx.ts:122-133`) |
| Bitget | `bitget-api` `WebsocketClientV2` (`bitget.ts:53`) | `books5` (`bitget.ts:169-178`) | 5 | hardcoded `'snapshot'` (`bitget.ts:23`) | `seq` → `finalUpdateId` (`bitget.ts:38`) | `exception`, code `30001` (`bitget.ts:114-127`) |

Notes:
- **Binance always tags `'snapshot'`** even for `depthUpdate` deltas (`binance.ts:141`).
  Because the subscription is `@depth5@100ms`, each frame is a full top-5 image, so the
  manager's snapshot path (full replace) is correct in practice. `firstUpdateId` /
  `prevFinalUpdateId` are parsed but never consumed downstream.
- **OKX** subscribes the `books` channel (400-level true deltas), not `books5`. So OKX
  is the one exchange that drives the manager's real delta path with `action==='update'`.
- **Level normalization (all exchanges):** each `[price, quantity]` pair →
  `{ price, quantity, amount: price*quantity }` via `parseFloat`
  (e.g. `binance.ts:125-134`, `bybit.ts:25-34`, `okx.ts:27-36`, `bitget.ts:28-37`).
- **Per-symbol error filtering** (Bybit/OKX/Bitget) logs a warning and *returns* for a
  single bad-topic/instId subscription instead of tearing down the whole batch
  (`bybit.ts:113-122`, `okx.ts:124-133`, `bitget.ts:118-127`). Any other error falls
  through to `handleConnectionError` (full reconnect).
- **Message → emit** (all): the `'update'`/`'message'` handler runs inside
  `TraceContext.runWithTrace(...)`, gates on `isOrderBookMessage`, parses, stamps
  `update.traceId = traceId`, then `emit('orderbookUpdate', update)`
  (`binance.ts:221-248`, `bybit.ts:134-158`, `okx.ts:145-169`, `bitget.ts:139-163`).

### Reconnect-handler differences

Only **Binance** carries an `errorHandled` flag (`binance.ts:179,192-194,206-208`) to
stop a single failure from triggering `handleConnectionError` twice (once on `close`,
once on `error`). Bybit/OKX/Bitget wire `close` and the error event independently with
no such local guard and rely on the library's own reconnect/dedup plus the base
`reconnectingBatches` set.

### Heartbeat

Only **Binance** runs an application-level heartbeat: a 10s ping with a 2s
pong-timeout that calls `ws.terminate()` on a missed pong
(`binance.ts:10-11,57-67`). Bybit/OKX/Bitget rely on their library's internal liveness.

## 4. The `OrderBookUpdate` contract

The unified payload emitted as `orderbookUpdate` (`orderbookManager.ts:14-27`):

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'snapshot' \| 'delta'` | routes manager handling |
| `exchange` | `string` | lowercase exchange key |
| `symbol` | `string` | unified symbol |
| `marketType` | `MarketType` | spot / linear / inverse |
| `bids`, `asks` | `OrderBookLevel[]` | `{price, quantity, amount}` |
| `timestamp` | `number` | exchange `ts`/`E` where available; Binance spot uses `Date.now()` (`binance.ts:124`) |
| `finalUpdateId` | `number` | required; per-exchange seq id |
| `firstUpdateId?` | `number` | Binance deriv only (`U`) |
| `sequence?` | `number` | Bybit `seq`, OKX `seqId` |
| `prevFinalUpdateId?` | `number` | Binance deriv only (`pu`) |
| `traceId` | `string` | set in the message handler, `''` at parse time |

## 5. OrderbookManager (`orderbookManager.ts`)

**State** (`orderbookManager.ts:48-49`): two parallel maps,
`orderbooks: Map<exchange, Map<symbol, OrderBook>>` and
`topOfBooks: Map<exchange, Map<symbol, TopOfBook>>`. `trackedPairs` is read from config
(`:54`) but `updateOrderbook` does not filter on it.

**`updateOrderbook(update)`** (`:57-128`):
1. Drops updates with both `bids` and `asks` empty (`:62-64`).
2. Lazily initializes the per-exchange maps (`:67-70`).
3. `type === 'snapshot'` → **full replace** of the stored book (`:76-77`).
   `type === 'delta'` → `handleDeltaUpdate` (`:79`).
4. Reads `bids[0]`/`asks[0]`; if the book is missing (delta-before-snapshot) it returns
   silently (`:83-87`).
5. Computes `spreadPercent = (bestAsk.price - bestBid.price)/bestBid.price * 100`
   (`:94`), stores the new `TopOfBook` unconditionally (`:106`), and **emits
   `topOfBookUpdate` only when** a prior TOB existed **and** the best bid *or* best ask
   price changed (`:108-113`). Consequences: **no first-emit** (the very first TOB for a
   symbol is stored but not emitted), **no throttle**, change-detection only on price
   (not size).
6. Errors are logged and swallowed (`:115-127`) — a parse/update failure never
   propagates to the socket handler.

**`handleDeltaUpdate(update)`** (`:130-183`):
- Missing book → warn and return (`:135-145`).
- `finalUpdateId === stored.finalUpdateId` → treated as a "snapshot re-broadcast":
  warn and **full replace** (`:148-159`).
- Otherwise `processDeltaLevels` for bids and asks, then store with the new
  `finalUpdateId`/`timestamp` (`:162-173`).

**`processDeltaLevels(current, delta, isBid)`** (`:185-213`):
- Copies current levels; for each delta level matched by exact `price`:
  `quantity === 0` → splice out; existing price → replace; new price → push
  (`:192-207`).
- Re-sorts every call: bids descending, asks ascending (`:209-212`). Matching is exact
  float price equality (`:193`).

## 6. Timing sequence (one update)

1. Exchange pushes a frame on the socket; the library/custom client emits
   `'update'`/`'message'`.
2. Handler opens a trace: `TraceContext.runWithTrace('ws-orderbook-update-<exchange>', …)`
   → fresh `traceId` (e.g. `binance.ts:222`).
3. `isOrderBookMessage` gate → `parseOrderBookUpdate` builds the `OrderBookUpdate`
   (`traceId` still `''`).
4. Handler stamps `update.traceId = traceId`, then `emit('orderbookUpdate', update)`.
5. Orchestrator's listener re-enters the *same* trace via
   `TraceContext.runWithExistingTrace(update.traceId, 'orderbook-update', …)` and calls
   `OrderbookManager.updateOrderbook(update)` (`orchestrator.ts:715-718`).
6. Manager mutates the book and, on a best-price change, emits `topOfBookUpdate`
   carrying the same `traceId` (`orderbookManager.ts:104,112`).
7. `ArbitrageEngine` re-enters the trace again with
   `runWithExistingTrace(topOfBook.traceId, 'arbitrage-scan', …)` →
   `scanOpportunities(topOfBook)` (`arbitrageEngine.ts:208-212`). `TradeMonitor` also
   subscribes (`tradeMonitor.ts:517`).

The single `traceId` threads socket-frame → parse → orderbook-update → arbitrage-scan,
enabling end-to-end latency correlation. All steps run **synchronously on the event
loop** — there is no queue or batching between socket frame and arbitrage scan.

## 7. Correctness & Timing Caveats

Factual current behavior affecting local-book quality:

- **No sequence-gap detection / resync.** `finalUpdateId` / `prevFinalUpdateId` /
  `sequence` are parsed but never validated for continuity in the manager. The only
  use of `finalUpdateId` is the equality check for snapshot re-broadcast
  (`orderbookManager.ts:148`). A dropped delta silently corrupts the book until the
  next snapshot/re-broadcast. Binance and Bitget sidestep this (every frame is a full
  top-5 replace); **OKX `books` deltas carry real risk**, as do Bybit `delta` frames.
- **No staleness eviction / TTL.** Books persist indefinitely; age is only checked
  *downstream* in `ArbitrageEngine`'s freshness score vs `config.arbitrage.maxOrderbookAge`
  (`arbitrageEngine.ts:289-290`). A dead-but-connected stream keeps serving a stale TOB.
- **No crossed-book validation.** `bestBid >= bestAsk` is accepted; `spreadPercent`
  goes `≤ 0` with no warning (`orderbookManager.ts:94`).
- **Heartbeat only on Binance** (`binance.ts:57-67`); other exchanges rely on library
  liveness — silent half-open risk.
- **Fixed reconnect interval, recursive retry** — no backoff or jitter
  (`base.ts:191,205`); a flapping endpoint can be hit in a tight reconnect loop.
- **Delta-before-snapshot is dropped** (warn + return, `orderbookManager.ts:135-145`);
  no snapshot is requested, so the book stays empty until the exchange sends a
  `snapshot`-typed frame.
- **No throttle / batching in the manager** — every frame is processed synchronously,
  and `topOfBookUpdate` fires on every best-price change with no rate limit.

## 8. Out of scope

Private/account WebSocket streams, arbitrage detection internals, and any fix for the
caveats above (documented as current behavior only).
