# Reliable, Lowest-Latency WebSocket Order Execution for CEX Arbitrage

**Scope:** Consolidated best practices (as of mid-2026) for WebSocket order placement and cancellation with REST as fallback, for a CEX–CEX price-arbitrage system (spot–spot, spot–perp, perp–perp; spot, linear/inverse perp, unified margin). Up to 15 venues, many simultaneous orders, bursty place+cancel traffic, single region, single host. **Correctness > latency on conflict; every controllable millisecond elsewhere is minimized.** Implementation ecosystem: **Node.js / TypeScript.**

**Two design theses run through everything below:**

1. **Arb edge** comes from the place→ack hot path being branchless and allocation-free. **Arb survival** comes from every other path being a boring, exhaustively-enumerated state transition. Build the second one first.
2. **The recovery path is the product; the happy path is easy.**

---

## 1. Order-entry transport: WS primary, REST fallback

**Use the venue's WebSocket order-entry API wherever it exists; REST is the recovery, reconciliation, and query path** (and primary on the few venues without WS trading). Empirical comparisons consistently show WS order placement is both faster and more stable than HTTP, with HTTP exhibiting latency spikes tied to connection recycling. The deeper reason WS wins isn't just transport: **authentication is amortized** — session-scoped auth removes per-request signing from the hot path entirely (§4).

### 1.1 Socket topology

Run order entry on a **dedicated socket**, separate from market data and separate from the private execution-report stream. Three sockets per venue minimum:

1. Order-entry request/response
2. Private user-data / execution-report stream
3. Market data (out of scope here)

Never multiplex order entry onto a market-data socket — a depth burst must not head-of-line-block a cancel.

### 1.2 Transport abstraction

The gateway interface is `sendIntent(OrderIntent): Token` with WS, REST, and FIX implementations behind it (in TypeScript: a per-venue class implementing a common `OrderGateway` interface). Don't let "WebSocket" leak into strategy code — the strategy speaks intents; transports are per-venue plumbing. This symmetry is also what makes REST-primary venues and mid-failure transport switching free at the architecture level.

### 1.3 When REST wins outright

REST is not a "slower equal" — it's a differently-shaped tool: stateless, independently rate-limited on most venues, and immune to your WS session's auth-expiry problems. It is the right primary path for:

1. **In-doubt resolution** — querying an order by `clientOrderId` after a timeout is the canonical way to disambiguate without risking a duplicate.
2. **Kill-switch / cancel-all** — must not depend on the health of the WS session you're trying to escape from.
3. **Endpoints not exposed over WS** — some conditional/algo order types, account ops, transfers, margin ops.
4. **A degraded WS session** — when the circuit breaker has tripped the WS channel.

---

## 2. Per-venue WS order-entry landscape

Verify per venue at integration time — this churns.

| Venue | WS order entry | Notes that matter |
|---|---|---|
| Binance spot | Yes (`ws-api.binance.com`: `order.place` / `order.cancel` / `order.cancelReplace` / amend; JSON or SBE-encoded requests) | Separate service from market-data streams (orders and market data require two separate connections); functionally equivalent to REST — same features, parameters, status and error codes. Ed25519 `session.logon` → no per-request signature; SBE responses available; unfilled-order-count limits. Also offers FIX order entry. |
| Binance USDⓈ-M / COIN-M futures | Yes (`ws-fapi` / `ws-dapi`, same request/response model) | Session-logon support landed later than spot — **verify per product**. Legacy WS URLs were decommissioned 2026-04-23 — **pin current endpoints in config, not code**. |
| Bybit (v5 unified) | Yes (`wss://stream.bybit.com/v5/trade`: `order.create` / `order.amend` / `order.cancel` + batch) | Covers USDT contract, USDC contract, spot, options, inverse — i.e., everything including unified-margin accounts. One auth per connection (HMAC over `GET/realtime{expires}`); shares rate limits with REST. **The ack only means the request was accepted — order status must come from the private order stream** (§8). |
| OKX (v5 unified) | Yes (`order`, `cancel-order`, `amend-order`, `batch-orders`, `batch-cancel-orders` on private WS after one `login`) | Batch ops are real ops, not loops: up to 20 orders per request, can mix instrument types, **not all-or-nothing** — check per-order `sCode`/`sMsg`. Good cancel-on-disconnect support. |
| Bitget | Yes (v2 WS trade channel) | Newer; test reject semantics carefully. |
| Gate.io | Yes (v4, spot & futures WS order placement) | |
| Kraken (spot v2) | Yes (`add_order` / `cancel_order` / batch) | |
| Deribit | Yes (JSON-RPC over WS, mature) | Best-in-class cancel-on-disconnect. |
| Coinbase Exchange | No WS order entry — **FIX 4.2/5 or REST** | If Coinbase matters, you are writing a FIX initiator; budget for it. |
| KuCoin, MEXC, HTX, smaller venues | Mostly REST-first; some have partial/announced WS trade | Treat REST as primary there; the transport abstraction (§1.2) makes this symmetric. |

**Tier-2 venue rule:** implement WS order entry only after measuring that the venue's WS path actually beats its REST path — on some venues the WS order gateway is a thin proxy to the same REST backend and saves nothing while adding a failure mode. Measure place→ack distributions on both before committing.

**Binance-specific accelerations:** Binance additionally offers FIX order entry and SBE encoding on spot. If Binance is your colocated taker venue, FIX OE / SBE-over-WS is measurably leaner than JSON and worth adopting for that one venue. Don't build FIX adapters for venues 40 ms away — the RTT dwarfs the encoding win.

---

## 3. Connection lifecycle management

This is where most "fast" systems die.

### 3.1 Hot + warm topology

- **N hot + 1 warm standby per venue** (i.e., N ≥ 2 authenticated trade-WS connections at all times). Hot connections carry orders; the warm spare is fully connected, TLS-established, authenticated, heartbeating — and carries zero traffic. On primary failure, cut over in microseconds (promotion target < 1 ms) instead of paying DNS + TCP + TLS + login (50–300 ms — an eternity with orders resting in a moved market).
- Failover = flip a pointer; **resend nothing automatically** (§8 defines what is safe to resend).
- Terminate primary and standby on **different venue gateway IPs**: resolve all A records and pin connections to distinct IPs.
- Send a trivial authenticated no-op or app-level ping on the standby periodically so middleboxes and venue idle-timeouts never reap it.
- Mind per-venue connection/login limits; the majors tolerate 2–3 trade sockets.
- One API key per connection where venue limits allow — isolates rate-limit and ban blast radius (§4.4).

### 3.2 Connection scoring, not binary up/down

Track per connection: last-inbound-byte age / time-since-last-message, app-level ping (heartbeat) RTT EWMA, ack-latency EWMA and rolling p99, consecutive timeouts/errors. Route each new order to the best-scoring authenticated socket. A connection degrades before it dies; a connection that's "up" but whose ack p99 has tripled is **down for trading purposes**.

Per-venue health is a **vector**, not a flag — place-ack latency, cancel-ack latency, exec-stream liveness, WS-book-vs-trades drift — and the strategy consumes it: a venue with degraded cancel latency gets sized down or quoted wider automatically.

### 3.3 Proactive recycling and planned death

Many venues hard-disconnect on a schedule (Binance: 24 h max connection lifetime) or on auth expiry. Never let the venue choose the moment: every connection has a **planned-death schedule** — recycle on your own terms (e.g., every 12 h, or ~23 h for Binance's 24 h limit), jittered, one at a time, during quiet periods, never during a burst, warm-spare first.

Binance now sends a `serverShutdown` event **10 minutes before disconnection** — treat it as a first-class signal: on receipt, promote the standby and drain the doomed connection gracefully instead of getting RST'd mid-burst.

### 3.4 Heartbeats — both ways, per-venue dialect

- Respond to server pings **immediately and from the gateway/IO thread** — never queued behind work (a pong stuck behind a slow task = disconnect at the worst time). In Node.js this means the order-gateway process's event loop must never be blocked by anything else (§6.4).
- Send your own app-level pings (or cheap authenticated no-ops) every 5–15 s and treat ping silence as failure *fast*: a venue TCP connection can be black-holed for 30+ s before the kernel notices; your ping timeout (2–3 missed) is the real failure detector.
- Run a continuous latency probe (cheap authenticated no-op / time request) to track per-venue RTT drift.
- Per-venue heartbeat dialects: **Bybit** `{"op":"ping"}` every ~20 s; **OKX** the literal string `ping` (disconnects after 30 s idle); **Binance** protocol-level ping/pong.
- Arm `TCP_USER_TIMEOUT` (~5–10 s) so writes into a dead peer's window fail fast instead of silently buffering.

### 3.5 Auth-session expiry

Sessions die silently more often than loudly: Bybit auth can lapse, OKX logins expire, listen-key-style mechanisms time out. Detect via the periodic cheap authenticated probe on each connection — **never discover auth death by having a real order rejected.** Re-auth on the standby, swap, then fix the primary.

**Login/session state is part of connection state.** "TCP up but not authenticated" must be unroutable. Model it explicitly:

```
Connecting → TlsReady → Authenticated → Subscribed → Eligible → Degraded → Draining → Dead
```

### 3.6 Reconnect discipline

- Jittered exponential backoff per endpoint (start 100–250 ms, cap a few seconds) — but with a warm standby, the primary's death costs ~0 and backoff only governs rebuilding the standby. **Backoff never gates trading.**
- Attempt reconnects in *parallel* across the venue's multiple endpoints/IPs — first to complete auth wins.
- On any reconnect / order-entry socket transition, before that connection becomes order-eligible: re-auth → re-subscribe private streams → **reconcile open orders via REST** (snapshot diffed against the local order table, §8.6) so you re-enter with truthful state. Never skip the reconcile. Cancels may flow immediately on the new socket; new places wait for the reconcile.

### 3.7 Venue maintenance asymmetry

A venue can keep WS up but stop matching, or accept places while cancels degrade. The health vector (§3.2) plus per-operation breakers (§10.2) — not a single up/down flag — is what catches this.

---

## 4. Auth and signing

Signing is pure self-inflicted latency. Attack it venue by venue.

### 4.1 The three signing regimes

1. **Session-auth venues — zero per-request signing.** The single biggest signing win available anywhere, and the core reason WS APIs dominate. Binance spot: `session.logon` with an **Ed25519 key** authenticates the connection once; subsequent `order.place` / `order.cancel` requests need no signature. Bybit / OKX / Bitget: HMAC-SHA256 at login (connection-scoped auth), per-order requests unsigned after login. Use session auth everywhere a venue offers it — it's both microseconds saved and one less thing to get wrong per order.
2. **Per-request Ed25519:** ~15–50 µs per signature — fine at these burst rates, no caching games needed, but prefer session auth so it's zero. Binance explicitly recommends Ed25519 as the best-performing key type (and `session.logon` requires it); timestamps may be specified in microseconds.
3. **Per-request HMAC-SHA256** (REST fallback, some venues): ~1–2 µs with a precomputed key context. In Node.js, create the key once as a `KeyObject` via `crypto.createSecretKey()` at startup and reuse it for every `crypto.createHmac()` call — never re-derive the key from the secret per request. Write the hex/base64 output into a preallocated `Buffer` rather than allocating strings on the hot path.

**Do not pre-sign future timestamps to "cache signatures"** — the correctness risk (stale `recvWindow`, venue clock skew) isn't worth saving ~2 µs.

**Binance 2026 signing change:** payloads must be **percent-encoded before computing signatures**; requests that don't follow this order are rejected with `-1022 INVALID_SIGNATURE`. Encode-then-sign, never sign-then-encode. A storm of `-1022` after this change is a code bug, not weather — raise an ops alarm (§11.1).

### 4.2 Precompute everything signable

Keys are parsed once at startup and held in protected memory — in Node.js use `sodium-native` secure buffers (`sodium_malloc` + `sodium_mlock`) so key material is locked and excluded from swap/core dumps. The signing input is built into a preallocated `Buffer`; only timestamp/qty/price/clientOrderId bytes get patched per order (§5).

### 4.3 recvWindow and clock discipline

- Set `recvWindow` / expiry windows tight enough to bound "zombie order placed late" risk — **2–5 s** as the default — but not so tight that normal clock error rejects you.
  > **Alternative view:** one source recommends a tighter 1000–3000 ms. Use the tighter band only once your clock discipline is proven in production (continuous offset monitoring green for weeks); correctness here means *not* getting valid orders rejected.
- Run chrony/NTP against the venue region's servers (PTP if available), **plus continuous measurement of your offset vs each venue's `serverTime`**, alarming when skew drifts past ~200 ms. Clock skew is a monitored production metric with its own breaker; trading must not enable while the clock alarm is red.
- Timestamp regimes are tightening: Binance now rejects requests whose timestamp exceeds `serverTime + 1 s`, rejects at the matching engine on drift, and the rejection **increments your rate/IP limits** — clock slop literally consumes your order budget and can rate-limit-ban you while rejecting 100% of your orders.

### 4.4 Key hygiene

Trade-only keys (no withdrawal scope), IP-allowlisted to your host, one key per connection where venue limits allow (isolates rate-limit and ban blast radius), and a rotation runbook that uses the warm-spare mechanism so rotation is a zero-downtime flip.

---

## 5. Hot-path message construction and serialization

The order hot path is: ring pop → patch template → sign (if needed) → mask → TLS encrypt → write. Budget single-digit microseconds for everything before the syscall.

### 5.1 Pre-rendered templates

- For each (venue, symbol, side, order-type/shape) tuple actually traded, **pre-render the JSON byte buffer at strategy-arm/startup time** into a fixed `Buffer` with fixed-width reserved slots, e.g. `{"id":"________","method":"order.place","params":{"symbol":"BTCUSDT","side":"BUY","type":"LIMIT","timeInForce":"IOC","quantity":"______","price":"________",...}}`.
- At fire time, copy digits into the slots (`buffer.write` / manual byte stores) — no allocator, no JSON library, no float formatting, no `JSON.stringify`. This takes "build + serialize" from tens of microseconds to <1 µs.
- Format numbers as **pre-quantized fixed-point → ASCII**: since tick/lot sizes are known per instrument, integer-to-ASCII digit patching (a small hand-written routine writing bytes into the `Buffer`) replaces any float-formatting path entirely.

### 5.2 Decimal correctness is a correctness requirement

Prices and quantities are fixed-point integers internally (integer ticks/lots per instrument — in TypeScript use `bigint` or range-checked `number` integers with branded types), converted to strings only at the template patch. **Never let a float touch a price** — no `toFixed`, no floating-point arithmetic on prices/quantities. Venue rejects for tick/lot/minNotional violations are *your* bugs: validate against cached `exchangeInfo`/instrument specs before send, and refresh specs off the hot path (a `worker_thread` or cold timer).

### 5.3 Parsing acks and fills

You don't need full deserialization. Use lazy/partial parsing — the `simdjson` Node.js bindings in lazy mode, or hand-rolled `Buffer` field scanners — keyed on the few fields that drive the state machine: `id`, `status`, `code`, `orderId`, `clientOrderId`, `execType`. Binance SBE responses skip JSON entirely — use them there.

### 5.4 IDs

- Generate the request `id` and `clientOrderId` from an atomic counter + epoch prefix (sortable, collision-free across restarts), pre-encoded as ASCII. **No UUID generation/formatting on the hot path.**
- Pre-generate `clientOrderId`s in batches (a ring of pre-rendered IDs) so fire-time ID acquisition is a pointer bump.
- Encode lane/venue/intent in the ID structure so a bare `clientOrderId` appearing in a venue message is self-describing during reconciliation.

### 5.5 Batching

Where the venue supports true batch ops (OKX `batch-orders`/`batch-cancel-orders`, Kraken batch, Binance futures `batchOrders`, Bybit batch variants): a two-leg place or place+cancel in one frame saves full per-message overhead and can land atomically-ish in venue ingest order. Batch is genuinely useful for requote bursts — one frame, one syscall, 20 cancels — and trades a few hundred µs of batching delay for large rate-limit efficiency. **Use it for multi-leg hedge baskets and cancel storms, not the latency-critical taker leg.** Never treat a batch ack as atomic (§11.5).

---

## 6. Socket, TLS, and runtime tuning

### 6.1 TCP and WS options

- `TCP_NODELAY` on everything, always (in Node.js: `socket.setNoDelay(true)`) — Nagle plus delayed ACK is a 40 ms tax and the most common self-inflicted wound.
- `TCP_USER_TIMEOUT` set to a few seconds (~5–10 s) so half-open connections fail fast instead of silently eating writes into a dead peer's window. Node doesn't expose this directly — set it via a small native addon or `setsockopt` on the socket fd; it's worth the addon.
- `SO_PRIORITY` / DSCP marking if your NIC/network honors it.
- **Disable permessage-deflate on the order channel** (negotiate it off in the WS handshake; with the `ws` library: `perMessageDeflate: false`). Compressing a 300-byte order frame burns CPU and adds latency for nothing; compression only pays on market-data fan-in.

### 6.2 TLS

- TLS 1.3 with session resumption tickets cached per venue so reconnects are 1-RTT.
- Kernel TLS (kTLS) is not practically reachable from Node's TLS stack; recapture the equivalent win by keeping the write path copy-free up to `tls.TLSSocket.write` — write the final masked frame from one preallocated `Buffer`, no intermediate string/object allocation.

### 6.3 WS client implementation

Kernel bypass (DPDK/Onload) is overkill for one host hitting 15 internet-distant venues — the bottleneck is RTT, not your stack. But within the host:

- Prefer a **hand-rolled WS framer over a raw `tls.TLSSocket`** for the order channel rather than a general-purpose WS stack: write the masked client frame yourself into the preformatted buffer (client-to-server frames must be masked; use a cheap RNG and apply the mask during the copy). If using a library, use `ws` with `perMessageDeflate: false` and feed it preassembled `Buffer` payloads — never objects to be stringified per send.
- **One writer per socket — no cross-component contention on the write path.** Run the order gateway as its own Node process (or dedicated `worker_thread`) per latency lane; if strategy and gateway are separate threads, connect them with an SPSC ring buffer over `SharedArrayBuffer` (+ `Atomics`), not message-passing with structured clone.
- Keep the TX path allocation-free: preallocated buffer rings, no per-order object churn.

### 6.4 Node.js runtime and OS discipline

- The gateway event loop must never block: no synchronous I/O, no JSON of large payloads, no crypto bigger than one HMAC on it. Cold work (spec refresh, reconciliation, journal compaction) goes to `worker_threads` or separate processes.
- **GC pauses are this stack's latency tax.** Minimize allocation on the hot path (the template/ring design above does most of it), pool every buffer, tune heap flags (e.g., `--max-semi-space-size`) so minor GCs are rare and short, and monitor GC pause times as a first-class latency metric alongside ack p99.
- Busy-polling: Node's event loop is epoll-based and can't busy-poll natively; `SO_BUSY_POLL` on the socket (via the same native addon as `TCP_USER_TIMEOUT`) plus isolated cores recovers most of the wakeup-latency win available at internet RTTs.

---

## 7. The per-order state machine

The architecture that ties connections, failures, and reconciliation together is a per-order state machine owned by the gateway:

```
CREATED → SENT → ACKED_UNCONFIRMED → LIVE → { FILLED | CANCELLED | REJECTED }
                       ↑
        IN_DOUBT  (reachable from SENT / ACKED_UNCONFIRMED)
```

Every transition is driven by an explicit message (ack, stream event, query result, timer) and persisted to a local write-ahead log. **Ack ≠ accepted ≠ live:** Bybit's trade-WS ack only means the request was accepted; OKX likewise. Venues *will* ack synchronously and reject asynchronously (post-risk-check, post-matching-engine). The distinct `ACKED_UNCONFIRMED` state between `SENT` and `LIVE` carries a timeout that escalates to query; the private order stream is the source of truth, and the ack only releases your in-flight token.

### 7.1 Invariants

- **`clientOrderId` assigned before any bytes leave the process, and journaled before send** (in-memory ring + async-flushed append log). After a crash you must be able to enumerate every order you might have placed. This is the idempotency spine: any retry reuses the same `clientOrderId`, so a duplicate send becomes a venue-side "duplicate client order id" reject instead of a double position. **The `clientOrderId` is your idempotency key and your only truth across transports.**
- **Never auto-retry a `place` whose outcome is unknown with a *new* ID.** Retry-with-same-ID or query-then-decide. A missed arb is a small loss; a double-filled taker leg is a position.
- **Single writer per order:** the venue gateway lane owns all state transitions for its orders. Strategy reads state via the return ring; it never mutates.
- **In-flight registry with deadlines:** every `SENT`/`ACKED_UNCONFIRMED`/`CancelPending` entry carries a timeout (e.g., per-venue adaptive p99.9 ack latency × 3). Expiry ⇒ `IN_DOUBT` ⇒ reconciler.

### 7.2 Two sources of truth, reconciled

Acks come back on the request/response channel; fills and terminal states also arrive on the **private execution-report stream**. Treat the exec stream as authoritative for *economic* events (fills) and order status, the ack channel as authoritative for *admission* (accepted/rejected), and build the state machine to accept events from either **in any order** — fills frequently arrive before the place-ack on fast venues. De-duplicate by (venue orderId | clientOrderId, execId, seq).

### 7.3 The double-send problem (in-doubt resolution)

The dangerous window: you wrote an order frame, then the connection died (or the ack timed out). The order is *in-doubt* — TCP write success means nothing about venue receipt.

1. **Never blind-resend.** Query by `clientOrderId` over REST (the independent warm path). Three outcomes: found-live (manage it), found-filled/cancelled (reconcile), not-found.
2. **"Not-found" immediately after send is not proof of non-arrival** — venues are eventually consistent between trade gateway and query endpoints. Treat not-found as still-in-doubt for a venue-tuned grace window (typically 500 ms–2 s), re-query, and only then resend — *with the same `clientOrderId`* where the venue enforces uniqueness, so a late-arriving original causes a duplicate-ID reject (your confirmation) rather than a double position.
3. Not-found *and* venue confirms "unknown order" *and* the connection has been continuously healthy since send → safe to mark dead. Not-found amid connection trouble → **assume it may yet exist**; re-query until venue time passes the order's `recvWindow`/expiry, then mark dead. Require **two consistent sources** (stream + REST snapshot) before declaring an in-doubt order dead.
4. **Cancels invert the calculus:** cancelling an already-cancelled/filled order returns "unknown order," which is information, not failure. On in-doubt, aggressively resend cancels — across both transports. **Double-cancel is free; double-place is a position.**

### 7.4 Reconciliation loop

A cold-thread (`worker_thread` / separate process) service that owns `IN_DOUBT`:

1. Query by `clientOrderId` via REST (`order.status` equivalents exist everywhere).
2. Found → install truth, resume the state machine. Not-found → apply §7.3 rules.
3. On any reconnect: snapshot open orders (REST open-orders per symbol) + positions, diff against the local book, alert on any divergence, auto-cancel anything the venue has that you don't recognize (config-gated).
4. **Periodic background reconcile (every 30–60 s) even when healthy.** Drift you discover in calm markets is drift that won't kill you in a fast one. REST queries can lag the stream and the stream can lag fills visible via REST — reconcile against the stream as primary, REST snapshots as periodic ground-truthing.

---

## 8. REST fallback path, done properly

REST is the fallback for order entry on WS failure, the reconciliation/query path, and primary for venues without WS trading. Make it not-cold:

- **Warm at all times:** a small pool of persistent HTTPS connections per venue — in Node.js use `undici` (`Pool`/`Agent` with keep-alive) rather than a high-level convenience client — kept alive and *verified* with periodic cheap authenticated requests end-to-end (a fallback you haven't exercised in an hour is Schrödinger's fallback). Never pay DNS + TCP + TLS (~1.5 RTT even with TLS 1.3) at fire time.
- Pre-resolved, health-ranked IPs; TLS sessions resumed.
- **HTTP/1.1 keepalive pool by default; HTTP/2 only if the venue's h2 termination is measured faster — several are not.**
  > **Alternative view:** one source suggests HTTP/2 wherever supported (one connection, multiplexed queries). h2 is fine for the cold query path; for the fallback *order* path, measurement decides.
- Reuse the **same template-patching serializer** as the WS path (§5.1) for request bodies/query strings.
- **Same state machine, same `clientOrderId`s, same journal.** REST is a transport, not a different system. A place sent on WS can be canceled over REST and vice versa — required during partial failures. Failover WS→REST reuses the same `clientOrderId`; venues that reject duplicate client IDs turn the race into a safe, observable outcome.
- **Fallback triggers with hysteresis:** WS connection score below threshold, ack p99 over budget, or N consecutive ack timeouts → route new intents via REST while WS recovers; flip back only after the WS path proves itself (M consecutive healthy pings + a canary order/cancel on testable venues). Avoid flap.
- **No hedged/duplicated places across transports.** Hedging requests is for idempotent reads; a place is not idempotent across IDs. Hedging the *same* `clientOrderId` across WS+REST simultaneously is venue-behavior-dependent — most reject the duplicate, but you'd be relying on every venue's dedup under load. Don't. **Cancels: hedge freely across both transports.**
- REST owns: order-status queries, open-orders snapshots, position snapshots, instrument metadata, transfer/margin ops — all off the hot path.

**Budget reality:** a *warm* REST place is typically only ~0.5–2 ms worse than WS on the same path. The fallback is not a disaster; *cold* REST is.

---

## 9. Rate limits as a first-class subsystem

### 9.1 Know each venue's currency of limitation

- **Binance:** two independent dimensions — IP-based request *weight*, and per-account *unfilled order count* (orders per 10 s and per 24 h). Cancels don't relieve the unfilled-order counter the way fills do, so a requote-heavy strategy burns it fast — this, not weight, is often the binding constraint for arb. Timestamp-rule rejections increment IP limits but **not** unfilled order count. Binance spot WS additionally caps incoming messages per second per connection at a small number — this directly limits per-socket burst rate and argues for parallel authenticated trade sockets on burst-heavy venues.
- **Bybit:** per-UID, per-endpoint limits with current usage echoed in response headers (`X-Bapi-Limit-Status`) — parse them and feed your buckets ground truth rather than open-loop accounting. Tier upgrades are negotiable with volume. WS trade shares rate limits with REST.
- **OKX:** limits keyed per (sub-)account and per instrument family; batch ops spend one request for up to 20 operations, which changes the arithmetic for cancel storms.

### 9.2 Client-side enforcement

- Per venue, a local **hierarchical token-bucket mirror of every applicable limit** — IP bucket → account/UID bucket → endpoint bucket, plus order-count windows, per-symbol limits, and the WS message-per-second limit itself. Decrement locally *before* send; sync from response headers (`X-MBX-ORDER-COUNT-*`, `X-Bapi-Limit-Status`, etc.) as ground truth; cap at ~80% of nominal.
- **The single most important rule: separate budget pools for place vs cancel, and cancel's pool can never be starved by place.** When rate-constrained, the system must always be able to flatten itself. Shed places, never cancels; reserve a hard floor (~20% of every bucket) that only cancel/close operations may spend.
- **Back off *before* the venue 429s you** — rejected requests can still increment unfilled-order counts and IP limits. Binance escalates to **HTTP 418 auto-bans** for continuing to send after 429s, so a 429 must hard-gate the bucket, not just delay one request. A 418 IP ban takes the whole host out — on a single-host design, a full outage; this (plus item 7 in §13) is the strongest argument for a second egress IP on a standby host.

---

## 10. Circuit breakers and kill switch

### 10.1 Circuit breakers — three independent trips per venue, each with hysteresis

1. **Reject-storm:** N rejects in a window → stop placing on that venue, keep cancelling. Distinguish reject *types*: a storm of `-1021` timestamps means fix your clock; a storm of insufficient-balance means your position model has diverged — halt and reconcile.
2. **Error/disconnect rate:** connection flapping or a rising 5xx/timeout share → quarantine the venue from new entries.
3. **Latency spike:** rolling ack p99 above threshold → trip early. In arb, slow execution is worse than no execution, because the hedge leg lands stale.

A tripped venue degrades to **cancel-and-reduce-only**, never to fully-off, until breakers reset.

### 10.2 Kill switch — design it as if your main process is the adversary

- A **separate watchdog process** (separate code path, REST-only, pre-authed) that on trigger fires cancel-all on every venue and optionally flattens with reduce-only IOCs. It must not share the event loop, memory, or fate of the trading process — in Node.js terms: a separate OS process, not a `worker_thread`.
- Arm **venue-side dead-man switches** so even host-level failure is covered: OKX `cancel-all-after`, Bybit Disconnect-Cancel-Protection (DCP) on the trade WS, Binance futures `countdownCancelAll`. Re-arm them on a heartbeat from the trading process — if the process dies, the venue cancels for you. For unhedged taker-arb legs this is the difference between an incident and a story.
- **Triggers:** manual (big red button), position-limit breach, breaker cascade (≥K venues tripped), reconciliation divergence, watchdog heartbeat loss.

---

## 11. Error taxonomy

Classify every venue error code into exactly one of four buckets **at integration time**, in a per-venue table that is code-reviewed, not inferred at runtime.

### 11.1 Terminal (never retry)

Bad symbol; filter violations — tick/lot/notional, noting that Binance's filters now use a *reference price* when available, so a price that passed your static check can still fail; insufficient balance/margin; reduce-only conflicts; invalid signature/auth (also raise an ops alarm — `-1022` after the percent-encoding change is a code bug, not weather); risk-control blocks. **Terminal errors invalidate the *intent*: re-decide, don't re-send.**

### 11.2 Retryable (bounded, jittered)

- 429 / rate-limit — back off per venue guidance and hard-gate the bucket (§9.2; 418 escalation risk).
- Transient "system busy" / matching-engine-busy codes.
- Order-not-found on a **cancel** immediately after placement (eventual consistency) — retry the cancel for a short window before concluding the order never existed.

### 11.3 In-doubt (the dangerous bucket)

Timeouts; disconnects after write; and — critically — **server-side 5xx**: Binance is explicit that 5xx must NOT be treated as a failed operation; execution status is UNKNOWN and could have been a success. In-doubt always resolves through the query-by-`clientOrderId` protocol (§7.3), never through optimistic assumption in either direction.

### 11.4 Good-news errors

"Order does not exist / already filled" in response to a cancel of a taker leg; duplicate-`clientOrderId` rejects during failover. Map these to **success** paths in the state machine.

### 11.5 Venue quirks to encode explicitly

- **Ack ≠ accepted ≠ live** (§7) — Bybit and OKX acks only mean request accepted; expect synchronous ack, asynchronous reject.
- **Batch partiality:** OKX batch ops allow partial success — check `sCode`/`sMsg` per order; never treat a batch ack as atomic.
- **Trade-WS vs REST eventual consistency cuts both ways** (§7.4): an order can be "missing" via REST that the stream already confirmed, and vice versa.
- **Unified-margin coupling:** on Bybit UTA and OKX unified accounts, a spot leg's reject can be caused by the *perp* leg's margin consumption — error attribution must consider the whole account, not the instrument.
- **Timestamp regimes are tightening** (Binance's `serverTime + 1 s` rule is the trend) — clock skew gets its own monitor and breaker (§4.3).

---

## 12. Testing, simulation, chaos

**Testnets are for protocol conformance only** — they validate schemas, not latency, rate limits, matching behavior, or edge cases.

- **A venue simulator per integrated exchange dialect**, speaking its WS trade protocol with configurable latency distributions, reject rates, out-of-order fills-before-acks, mid-burst disconnects, duplicate exec reports, and silent black-holing. Deterministically simulate at minimum: ack lost but order live; fill-before-ack; cancel/fill race; exec-stream gap mid-burst; socket death with 10 in-flight; duplicate exec reports; success-shaped errors; clock skew; rate-limit rejection mid-basket.
- **Property-test the state machine against the simulator.** Invariant: no sequence of simulator cruelty produces a position the journal can't explain. Replay-driven integration tests of the state machine should be the most-developed suite in the codebase.
- **Chaos drills on a schedule, in production, tiny live size:** kill a hot connection mid-burst; firewall a venue for 10 s; freeze the process (SIGSTOP) and verify the venue-side dead-man cancels fire; skew the clock 3 s; exhaust a rate bucket; randomly kill sockets and the process itself — then verify recovery reconciles to exchange truth with **zero manual intervention**. If the first time cancel-on-disconnect fires is the day your NIC dies, you don't have a safety net, you have a hypothesis.
- **Validate latency and burst behavior in prod** with minimum-size canary orders on liquid symbols (place deep-out-of-book post-only, cancel, measure) on a cadence.
- **Replay:** every incident must be reproducible from the journal + pcap into the simulator.

---

## 13. Failure-mode checklist (the ones that actually hit people)

1. Fill arrives before place-ack → state machine accepts out-of-order truth (§7.2).
2. Cancel races place → "unknown order" reject handled as retryable-then-good-news, re-armed (§11.2, §11.4).
3. Ack timeout during burst → `IN_DOUBT`, reconcile, no blind re-place with a new ID (§7.1, §7.3).
4. Venue disconnects all sockets at top of hour → proactive recycling + warm spares + cancel-on-disconnect (§3.3, §10.2).
5. Clock drifts 6 s after host reboot → recvWindow rejects + rate-limit accrual → chrony/offset alarm blocks trading before it starts (§4.3).
6. Your own burst exhausts the order budget and cancels start failing → reserved cancel budget floor (§9.2).
7. Rate-limit ban on a shared IP kills all venues' REST → per-key isolation, instant stop on 429, and a second egress IP on the standby host (§9.2, §4.4).
8. Process crash with 14 resting orders → journal replay + reconcile-on-start + dead-man switches already flattened the dangerous ones (§7, §10.2).
9. Venue "successfully" accepts an order it never reports again → periodic open-orders diff catches the orphan (§7.4).
10. The fallback path rotted (expired key, changed endpoint) → continuously exercised warm REST path (§8).

---