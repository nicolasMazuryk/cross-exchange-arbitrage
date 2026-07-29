# Orderbook Market-Data WS Connectivity
### CEX–CEX price-arbitrage system · Node.js / TypeScript

> Scope: live, synchronized L2 books across multiple venues over WebSocket, feeding a cross-venue dislocation detector and a programmatic execution layer. Reliability and latency are first-order. **A silently stale or desynced book is the primary enemy** — worse than a clean disconnect, because it produces phantom signals and bad fills.

**Scope:** Modern, opinionated breakdown for a CEX–CEX / spot-spot / spot-perp / perp-perp crypto price-arbitrage system maintaining live, synchronized L2 orderbooks..

**Profile:** ~15 exchanges × ~2000 markets (~30k subscriptions), single-region single host, low-ms local-processing budget, **correctness > latency** when they conflict.


## 1. Connection establishment

### Library choice

| Concern | Recommendation | Rationale | Tradeoff |
|---|---|---|---|
| WS client | **`ws`** | gives you full control of frames, heartbeats, and compression. | Frame parsing happens in JS, not native. |
| REST (snapshots, signing) | **`undici`** | Native fetch engine with connection pooling + keep-alive. Snapshot fetch is **on the critical resync path**, so this matters. | Lower-level API; you manage pooling/timeouts deliberately. |
| Multi-venue breadth | **`ccxt`** for the *long tail* only | Huge venue coverage, normalized auth and schemas — great for reconciliation and minor venues. | **Do not put it on the latency-critical hot path**: its abstraction layer adds per-message overhead and hides venue quirks you need to control. |
| FSM | `xstate` (or a hand-rolled typed reducer) | statecharts model orthogonal regions, guards, entry/exit actions directly; |

`ws` - Add `bufferutil` and `utf-8-validate` as optional deps so masking/validation run in native code.

### Socket-level setup (table stakes)
- **Disable `permessage-deflate`** (`perMessageDeflate: false`). Compression adds CPU and latency for marginal bandwidth savings; for a latency-sensitive consumer you want raw frames. (Exception: a venue that *only* offers huge full-depth payloads and where you're bandwidth-bound — rare.)
- **`socket.setNoDelay(true)`** — kill Nagle. `ws` does this, but verify; a stray Nagle delay is a classic silent latency tax.
- **DNS caching / pre-resolution** (`cacheable-lookup`). Per-reconnect DNS lookups add latency precisely when you're racing to resync. Cache, but **don't hard-pin IPs** — exchange IPs rotate behind their LBs.
- **TLS session resumption** to shave reconnect handshakes.


### Stream multiplexing strategy
- **Combined stream** (`/stream?streams=a@depth@100ms/b@depth@100ms/...`) multiplexes many symbols on one socket.
- **Decision:** *shard* symbols across a few sockets — neither all-on-one (head-of-line blocking + single point of failure) nor one-per-symbol (FD pressure, connection-rate-limit bans). A few dozen symbols per socket, several sockets per venue, is the sweet spot.

#### How to calculate number of symbols per connection for each exchange: 
MAX_CONNECTION_SAFE_BUFFER = 0.80

Total Exchange Symbols / (Connection-rate-limit per exchange / MAX_CONNECTION_SAFE_BUFFER)
2500 / 100 / 0.80 = 31 symbols per connection


### Venue gotchas — connect/auth

| Venue | Gotcha |
|---|---|
| **Binance** | Server force-closes every **24h** — you must rotate proactively (see §4). Separate hosts for spot (`stream.binance.com`) vs USD-M futures (`fstream`) vs coin-M (`dstream`). Connection-attempt rate limit per IP — uncontrolled reconnect storms get you **banned**. Combined-stream limit per connection. |
| **Bybit (V5)** | Separate public endpoints per category (spot / linear / inverse) and separate private. Subscribe via `{"op":"subscribe","args":[...]}`; watch for the subscribe ack. |
| **OKX** | Idle timeout ~30s — must send a literal text `"ping"` (not a WS ping frame) or you're dropped. `books`/`bbo-tbt` tick-by-tick orderbooks. **Every push carries a CRC32 checksum** you must validate. |
| **Bitget** | `op`/`subscribe` model; text `"ping"` heartbeat (~30s). |
| **Private channels (all)** | HMAC signing with a timestamp/`recvWindow`. **Clock skew → rejected signatures.** Run `chrony`/NTP and monitor skew (see §3, §9). |

### Venue-specific gotchas

**Binance**
- No checksum; correctness rests entirely on update IDs (`U`/`u`, plus `pu` on **futures only**).
- Canonical sync: buffer the depth stream, fetch the REST snapshot, drop events with `u` ≤ snapshot `lastUpdateId`, and the first applied event must straddle `lastUpdateId + 1`.
- **Spot vs USD-M/COIN-M futures differ:** futures adds `pu` (previous final update ID) so each event is gap-checkable against the last; spot can't, so it's more exposed.
- **Biggest gotcha:** Binance force-closes every WS connection at ~24h. Proactively rotate connections before that or eat periodic mass disconnects.
- Respect per-IP connection and message-rate limits, and the ~1024-streams-per-connection cap that drives your sharding math.

**Bybit (v5)**
- Snapshot arrives **over the WS itself** (first message `type: "snapshot"`, then `"delta"`), not via REST.
- Sequence fields (`u`, `seq`) for gap detection; no checksum.
- **Must send a client ping (~every 20s)** or get dropped.
- On any reconnect you get a fresh snapshot — don't try to resume mid-stream.

**OKX**
- `books` channel sends a snapshot then updates, with a **CRC32 checksum** you validate against your top-25 reconstruction.
- **Pick the right channel:** `books5` (5-level snapshots, no checksum, simpler), `bbo-tbt` (tick-by-tick top of book).
- Heartbeat: send the literal string `ping` if idle ~30s or the server closes you.

**Bitget**
- OKX-like model with a **checksum**; same discipline.

**Cross-venue normalization**
- Price/qty precision, tick size, and contract multipliers differ per symbol per venue.
- Normalize to a single internal representation and **never compare raw floats across venues.**

---


---

## 2. Subscription management (table stakes)

- Hold the **desired subscription set as declarative state**. On (re)connect, run an idempotent reconcile loop that re-subscribes to exactly that set — never assume subscriptions survive a reconnect.
- **Verify acks and error responses.** A subscribe that silently failed gives you an open socket with no data — i.e. a stealth-stale book. Treat "subscribed but no first message within X" as a failure.
- Respect **per-connection channel limits**; shard accordingly.
- You cannot put 2000 symbols on one socket everywhere; every venue caps streams/connection and messages/sec. Run **many sockets per venue** behind a subscription scheduler that respects each venue's limits and batches subscribe frames.
---

## 3. Connection health

The hard truth: **an open, ponging socket can stop delivering data.** TCP keepalive and even app-level pong are necessary but **not sufficient**. You need three independent health signals:

1. **Liveness** — venue-specific ping/pong on its required cadence (Binance pong on server ping; OKX/Bybit/Bitget text `"ping"`). *Table stakes.*
2. **Data freshness (staleness watchdog)** — per-stream "time since last message." If no update within `N ×` the expected cadence, the book is **stale** → pull from signals + resync, regardless of pong status. **This is the single most important defense against the failure you named.** *Table stakes.*
3. **Sequence integrity** — the strongest signal. Every venue gives you ordering metadata:
   - **Binance spot:** valid seed is `U <= localUpdateId+1 <= u`; thereafter `U == last_u + 1`.
   - **Binance USD-M futures:** use `pu == last_u` (the previous event's `u`). **Do not copy the spot rule onto futures** — this is the #1 source of subtly-broken futures books.
   - **Bybit V5:** snapshot + delta with `u`/`seq`; a snapshot message re-bases the book.
   - **OKX:** `seqId`/`prevSeqId` continuity **plus** the per-push **CRC32 checksum** over the top levels.

   A gap, a `prevSeqId` mismatch, or a checksum failure means **the book is corrupt → halt and resync.** Non-negotiable.

**Two more cheap, high-value checks (table stakes):**
- **Crossed-book guard:** after every apply, if `best_bid >= best_ask`, the book is corrupt → halt. (Cheap to compute, catches a whole class of bugs.)
- **Clock-skew / latency drift:** track `local_recv_ts − exchange_ts (E/T)` per stream. Growing or jumpy delta = degradation or GC pauses; a sudden jump is an early warning before staleness fires.

---

## 4. Reconnection

### Policy (table stakes)
- **Exponential backoff with full jitter, capped.** Tight first retry (you want speed) but jittered to avoid a thundering herd that trips Binance's connection-rate ban. Per-IP attempt accounting.
- **The book is presumed dead across any reconnect.** Never carry a book over a reconnect. Always: re-buffer → re-snapshot → re-sync.
- **Correct ordering (the classic bug):**
  1. Open socket, **start buffering diffs**.
  2. Fetch REST depth snapshot (`undici`).
  3. Discard buffered events older than the snapshot (`u <= lastUpdateId`).
  4. Verify the seed event brackets the snapshot; if no buffered event does, your buffer window was too short → restart.
  5. Set book = snapshot, apply buffered then live events.
- **Snapshot-fetch failures during resync** (rate limit, 5xx) need their own backoff and a fallback. A resync that can't get a snapshot must keep the book marked stale, not guess.

- On reconnect: **re-subscribe and re-snapshot** (never assume resume); mark books `SYNCING` during rebuild.

---

## 5. Staleness & desync detection

**[TABLE STAKES]**
- **Socket-level watchdog, not per-symbol.** Illiquid symbols legitimately don't tick, so per-book last-update watchdogs false-positive. Watchdog at the **connection** level ("did I receive *anything* recently?") plus the venue heartbeat.
- **Sequence-gap monitor** → immediate resync + degrade flag.
- **Checksum failures** → immediate resync + degrade flag.
- **Per-book freshness/confidence state:** every book is `LIVE | SYNCING | DEGRADED`. The arbitrage engine must refuse signals from anything not `LIVE`. This single gate prevents phantom-arb fills.

STALE — connection alive, sequence intact, but no updates for longer than this symbol's normal cadence. Sequence and checksum both look fine on a frozen book. The catch you flagged earlier — illiquid symbols quiet legitimately — means STALE is mostly a liquid/top-of-book concern; gate it against per-symbol expected update intervals, not a global timeout.
`STALE` (alive but not updating vs expected cadence),
`DEGRADED` (gap/checksum failure), `DISCONNECTED` (socket down).
The arbitrage engine trades only when `health == LIVE`

**[ADVANCED]**
- **Clock-skew & one-way latency monitoring.** Run `chrony` on the host (table stakes), then compare exchange event timestamps to local receive time per venue. A drifting delta warns of a degrading path before sequence gaps appear.


---


## 5. Failure modes & error handling

Enumerate them; design a defined response for each. **Philosophy: fail loud and halt the affected book — never degrade silently.** Per-venue/per-symbol circuit breaker; a halted book is excluded from arb instantly.

| Failure mode | Detection | Response |
|---|---|---|
| Silent staleness | Freshness watchdog (§3.2) | Mark stale, resync |
| Sequence gap / dropped msg | Continuity check (§3.3) | Halt + resync |
| Out-of-order (post-reconnect overlap, combined streams) | Sequence/`pu` check | Drop stale, re-derive |
| Checksum mismatch (OKX) | CRC32 per push | Halt + resync |
| Crossed/locked book | `bid >= ask` guard | Halt + resync |
| Snapshot↔stream race | Seed-bracket check | Restart resync |
| Snapshot fetch fail mid-resync | REST error/timeout | Backoff, stay stale, fallback host |
| Truncated depth misuse | Stream type (`depth20`/`books5`) | Never treat top-N as full book for depth-aware sizing |
| Clock skew / expired signature | Skew monitor (§3) | Re-sign, alert, NTP discipline |
| **Backpressure** | Growing socket `bufferedAmount` / processing lag | You either keep up or **drop + resync** — never apply stale-by-arrears data |
| Poison message (bad JSON/schema) | Parse guard | Isolate to that connection; **must not crash the process** |
| Exchange maintenance / API deprecation | Error codes, status feeds | Circuit-break venue, alert |


Sequence reset without disconnect. Several venues reset seqId daily or after their own internal maintenance while the socket stays open. Your continuity check fires a "gap" and resyncs — usually fine, but a reset to a lower number can fool naive ==last+1 logic or bracket-checks. Handle reset-detection (large backward jump or explicit snapshot re-base) distinctly from forward gaps.

Snapshot permanently can't bracket → infinite resync loop. Distinct from your "snapshot fetch fail" row: the fetch succeeds but the REST snapshot lags the WS stream so the seed event never brackets lastUpdateId. Your step-4 restart loops forever, burning REST weight until you self-ban. Needs a max-attempts breaker + backoff + alert, not silent retry.

Active IP ban detection. You handle ban prevention (jittered backoff). You don't define detecting an active ban — Binance 418/429 with a ban-until timestamp. A banned IP that keeps reconnecting extends the ban. Detection: HTTP status + Retry-After. Response: honor the ban window globally for that IP/venue, don't let backoff hammer through it.

Duplicate / replayed messages. Combined-stream overlap and venue resends deliver the same delta twice. Your out-of-order check handles reordering but not idempotency — applying a delete-then-add twice can corrupt depth. Apply must be idempotent on (seq, price).

Local clock step. Your skew row is exchange-vs-local for signatures. Separate failure: the local clock stepping (NTP step, VM migration, leap second) jumps local_recv_ts and instantly corrupts every staleness/latency computation. Use a monotonic clock (performance.now() / hrtime) for all interval math; reserve wall-clock for cross-venue timestamp comparison only.

Internal IPC backpressure. Your backpressure row is the venue→gateway socket. The gateway→strategy hop (SharedArrayBuffer ring / ZeroMQ) has its own slow-consumer failure: if strategy falls behind, does the ring overwrite (strategy reads a torn/old book) or block (gateway stalls and now the socket backs up)? Define the seqlock-overrun behavior and surface it as a health signal.

Shard / process-crash visibility. With process-per-venue, if a gateway dies, strategy keeps reading its last-published book as LIVE forever. You need a liveness heartbeat on the IPC channel itself; absence → mark all that shard's books DISCONNECTED, not stale-but-tradeable.

Partial subscription failure. You verify acks, but the multiplexed case is stealthier: on one socket, 28 of 31 symbols ack and 3 error. The socket is healthy, data flows, and three books are permanently empty while looking like legitimately-quiet illiquid symbols. Reconcile per-symbol acks against the desired set, not "did the socket get any data."


---

## 7. Data structures & the JSON wall

At 30k subs this is where Node hurts.

- **Price representation** — **[TABLE STAKES]:** scaled integers (`BigInt` or int with known scale) or a decimal library. **Never JS `number`** for price keys/comparison; float drift produces crossed books and phantom spreads.
- **Book structure:** a `Map` keyed by scaled-int price is fine for apply; maintain top-of-book separately so signal generation is O(1) and you don't re-sort on every tick. Avoid per-update object allocation — reuse buffers; GC pauses are latency spikes.

---


## 6. Latency & throughput

### What to measure
End-to-end hop chain, each instrumented: `exchange T → socket recv → parse → normalized book apply → signal`. You can't optimize what you don't timestamp.

### The real bottlenecks in Node (in order)
1. **GC pause tail latency.** A 50ms minor/major GC = 50ms of stale book. Mitigate by **minimizing per-message allocations**: reuse objects/buffers, avoid creating arrays/closures per update, use object pools, store the book in **typed arrays** (`Float64Array`/scaled `Int32Array`) rather than JS object graphs. Tune `--max-semi-space-size` to trade RAM for fewer minor GCs; watch pause histograms.
2. **JSON parsing.** Keep payloads small (**diff streams, not full snapshots**; subscribe to only needed levels). Consider native `simdjson` bindings if parse time dominates. Where a venue offers a binary/SBE feed, evaluate it. Keep prices as **scaled integers or interned strings**; avoid float parsing in the hot loop.
3. **Book data structure.** Per side: `price → size` map for O(1) updates **plus** a maintained sorted index (binary-insert array or tree) for top-of-book and iteration. **Never re-sort the whole side on each update** — a common and brutal perf bug. For pure top-K arb you can maintain only the top-K precisely; keep full depth only if you do depth-aware sizing.
4. **Event-loop blocking.** Per-message work must be O(changed levels) and synchronous; offload anything heavy. Never let one venue's burst block another (→ §7 process isolation).

Node.js: risk is **GC pause tail latency** and **event-loop blocking**. Node's weak spot is tail latency — a GC stall or event-loop hiccup.

### Infra knobs (advanced)
- Pin process to core (`taskset`/`cpuset`), `isolcpus`, `performance` CPU governor, disable HT on trading cores.
- NIC interrupt affinity. Kernel-bypass / busy-polling is **irrelevant over public-internet WAN** to a crypto venue — don't bother.

> **Calibration:** for internet-facing crypto arb the WAN RTT (single-digit to tens of ms) dominates. Microsecond-level local tuning is premature until you've (a) placed compute in-region and (b) killed GC tail spikes.

### **Sharding** — **[TABLE STAKES at this scale]**
- A single V8 event loop saturates on JSON parsing long before bandwidth matters. Shard by `(venue, symbol-range)`.
- Prefer **separate processes** over `worker_threads` for fault isolation: a poison-pill message or memory leak in one venue's parser shouldn't take down all 15.
- Each shard owns a slice of books and publishes normalized updates over fast **local IPC**. Do **not** put a network broker (Kafka/NATS) on the ingest hot path on a single host — it adds latency for no benefit when producer and consumer share the machine.

---

## 7. Architecture

```
[ Per-venue MD gateway processes ]      (one event loop owns a bounded set of sockets)
   Binance-spot  Binance-fut  OKX  Bybit ...
        │            │         │     │
        └──── normalized book updates ────┐
                   (fast local IPC)        │
                                     [ Strategy / signal ]
                                            │
                                     [ Execution service ]
                                            │
                              private WS + REST (signed)
```

- **Process-per-venue (or per-shard) isolation.** Node is single-threaded; a blocked/crashing Binance connector must not stall OKX. Use **separate OS processes** (not just `worker_threads`) for fault isolation *and* to use multiple cores. *Table stakes.*
- **Split ingestion/normalization from strategy/execution.** Gateways publish a **canonical book/update schema**; venue quirks (tick size, contract multiplier, inverse vs linear, fee model) are pushed to the edge so strategy is venue-agnostic.
- **Hot-path IPC — choose deliberately:**

  | Option | Use for | Tradeoff |
  |---|---|---|
  | **SharedArrayBuffer ring buffer + Atomics** (seqlock pattern) | Lowest-latency same-host internal feed | You build the protocol; care with consistency |
  | **ZeroMQ (`zeromq`)** | Pragmatic same/cross-host fan-out | Small serialize + loopback hop |
  | **Unix domain sockets** | Simple same-host | Manual framing |

- **State ownership:** the connector owns the authoritative book; strategy reads a consistent snapshot. Stamp every update with **exchange ts, local recv ts, and a monotonic ingest seq.**
- **Time sync:** `chrony`/NTP everywhere; PTP if same DC. Required for honest cross-venue latency comparison and for signature windows.


---

## 8. Resource optimization (CPU / RAM / FDs / bandwidth)

- **CPU:** core pinning + `performance` governor; no `permessage-deflate`; O(changed-levels) apply; fast parser. (See §6.)
- **RAM / GC:** typed-array book storage; object pooling; pre-size structures; cap retained depth; tune `--max-semi-space-size` / `--max-old-space-size`; watch RSS and GC pause histograms.
- **File descriptors:** raise `ulimit -n`; shard connections to stay under venue per-connection limits.
- **Bandwidth:** diff streams over full snapshots; subscribe only to needed symbols/levels; the truncated `depth20`/`books5` streams are cheaper *if* top-N depth genuinely suffices.

---

## 10. Testing — **[ADVANCED, cheap insurance]**

- **Record/replay:** capture raw frames per venue, replay into the reconciler in CI. Sync-algorithm correctness becomes permanently regression-tested.
- **Chaos:** inject dropped frames, reordered sequences, mid-stream disconnects, corrupted checksums; assert the book ends `DEGRADED`, never silently wrong.

---

## 9. Observability

Low-overhead **metrics + replayable event log** beat heavyweight tracing for trading.

**Metrics (Prometheus + Grafana):**
- **`time_since_last_message` per stream** — the staleness gauge; your most important alert. *Table stakes.*
- **`event_loop_lag`** via `perf_hooks.monitorEventLoopDelay()` — Node-specific and essential; if the loop lags, *every* book is stale. *Table stakes.*
- Connection up/down, reconnect count, resync count + duration.
- Sequence-gap count, checksum-failure count, crossed-book count.
- Per-message parse-time histogram; end-to-end (`exchange T → apply`) latency histogram.
- GC pause-duration histogram; socket `bufferedAmount` (backpressure); clock-skew gauge.

**Logging:** **`pino`** — fast, low-overhead structured JSON (Winston is heavier). Log **state transitions**, not per-message.

**Forensics (high value):** asynchronously capture the **raw feed to disk** off the hot path. Being able to **replay a desync incident** turns "mystery bad fill" into a reproducible bug. *Advanced but pays for itself the first incident.*


**Alerting / SLO:** page on staleness > threshold, repeated resyncs, crossed books, clock skew, event-loop-lag spikes. Define a **book-quality SLO** (% of time each venue/symbol book is FRESH **and** VALID); **arb signals only fire on books meeting it.**

Per `(venue, socket, symbol-class)`: message rate, parse latency p50/p99, sequence-gap count, checksum-failure count, resync count, time-since-last-message, and book-state distribution (`LIVE/SYNCING/DEGRADED/STALE/DISCONNECTED`).

Export to Prometheus + Grafana; alert on gap/checksum/degrade rates. Most valuable single panel: **"% of tradeable symbols currently `LIVE`"** — your real uptime.

---

## 10. Table stakes vs advanced — quick index

**Table stakes (don't trade without these):**
`ws` + `undici`, deflate off + `setNoDelay`, declarative re-subscribe with ack verification, venue heartbeats, **freshness watchdog**, **sequence-gap + checksum + crossed-book halts**, correct buffer→snapshot→resync ordering (spot vs futures rule), jittered capped backoff with per-IP accounting, book presumed dead across reconnect, process-per-venue isolation, canonical schema, in-process book (not Redis), NTP/clock-skew monitoring, staleness + event-loop-lag metrics, `pino` logging.

**Advanced (mature system):**
In-region compute placement (do early — it's cheap and huge), SharedArrayBuffer ring-buffer hot path, typed-array book + object pools + GC tuning, native/SIMD JSON or binary feeds, core pinning + governor, raw-feed capture + replay, book-quality SLO gating.

**Deliberately *not* worth it here:** kernel bypass / busy-polling over WAN, `uWebSockets.js` on the client side, `ccxt` on the hot path, Redis as the source-of-truth book.










---------------------

1. Orderbook synchronization & integrity (table stakes — arguably your #1 dimension). Snapshot-vs-delta reconciliation, sequence/update-ID continuity, gap detection, and checksum verification.

2. Data-freshness / staleness watchdogs (table stakes), distinct from connection health. A connection can be passing heartbeats while a specific symbol hasn't ticked in 30 seconds. 

3. Rate limits, connection caps & subscription sharding (table stakes — forced by your scale). 30k subscriptions cannot live on one socket. The answer must address max streams per connection. The sharding strategy and snapshot-storm avoidance are core architecture, not a footnote.

5. Time synchronization & latency attribution (table stakes for this use case). chrony, and clean separation of exchange-event-time vs local-receive-time vs system-clock. You can't even define "stale" or measure where latency accrues without disciplined clocks, and clock skew silently corrupts staleness logic.

6. Backpressure, conflation & drop policy (table stakes). Bounded queues and a defined behavior when consumers fall behind. The subtlety worth forcing into the answer: you can safely coalesce/conflate successive book states, but you can never silently drop a sequence-relevant delta without triggering a resync — so the drop policy is constrained by dimension #1.

7. Bootstrap / cold start / warmup (advanced-ish, but you'll hit it day one). Startup ordering, time-to-first-valid-book, and suppressing arbitrage signals until each book is confirmed in-sync — including the re-warmup window after every reconnect.

8. Testing, replay & fault injection (advanced). Recorded-session replay, injected gaps/delays/reordering, and book-invariant assertions (bids strictly below asks, monotonic sequence, checksum holds) running continuously. A per-venue conformance harness pays for itself.

9. Lifecycle & deployment (advanced). Graceful drain, hot config reload, and restart strategy that doesn't dump all 30k books simultaneously (again, snapshot-storm/self-ban risk).

---------------------

10. Numeric representation & precision [table stakes] - JS number is IEEE-754 f64; using it for prices, sizes, and large sequence numbers is a correctness bug, not a style choice. Decide: scaled fixed-point integers (BigInt), a decimal library, or per-symbol scaled ints keyed off tick/lot. Cover rounding to venue tick/lot for any derived price.

12. Book sanity invariants / data-quality validation [table stakes] - monotonic level ordering, non-negative sizes, bounded depth, and correct zero-size-means-delete handling.

13. Subscription topology & sharding at scale [table stakes at your scale] — This is latent inside your dimension 1, but 30k subs makes it its own problem: max streams per connection, max connections per IP, weight/rate budgets, and how to shard ~2000 symbols/venue across N sockets while keeping related symbols co-located for cache locality. Include the cold-start stampede: bootstrapping 30k books means 30k REST snapshot fetches — your own thundering herd that can get you banned before steady state.

15. Time synchronization as a first-class concern - for cross-venue arb the relative clock across venues directly corrupts signals. Cover NTP vs PTP, exchange-provided vs local-receive timestamps, one-way-delay estimation, and using timestamps as the primary "live but stale" detector.

18. Lifecycle operations [advanced] — Cold-start warmup sequencing, graceful drain/shutdown, hot-reload of subscriptions, hot reload configs.

---------------------