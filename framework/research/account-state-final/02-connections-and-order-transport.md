# 02 — Connections & Order Transport

**Scope:** the private/user-data WebSocket lifecycle (establishment, auth, health, reconnection, the snapshot↔stream sync, gap detection, and the full connection FSM specification), plus order-entry transport: WS order placement with REST fallback, hot/warm connection topology, signing, hot-path construction (summarized), socket/runtime tuning (summarized), and rate limits. Cross-references: topology/adapter → `01`, order FSM/Resolver → `03`, reconciliation → `05`, failure catalog/breakers → `07`, venue quirks appendix → `08 §5`.

---

## 1. Order-entry transport: WS primary, REST fallback

**Use the venue's WebSocket order-entry API wherever it exists; REST is the recovery, reconciliation, and query path** (and primary on the few venues without WS trading). Empirical comparisons consistently show WS order placement is both faster and more stable than HTTP, with HTTP exhibiting latency spikes tied to connection recycling. The deeper reason WS wins isn't just transport: **authentication is amortized** — session-scoped auth removes per-request signing from the hot path entirely (§10).

Two design theses: (1) arb *edge* comes from the place→ack hot path being branchless and allocation-free; arb *survival* comes from every other path being a boring, exhaustively-enumerated state transition — **build the second one first**. (2) **The recovery path is the product; the happy path is easy.**

### 1.1 Socket topology

Run order entry on a **dedicated socket**, separate from market data and separate from the private execution-report stream. Three sockets per venue minimum: (1) order-entry request/response, (2) private user-data / execution-report stream, (3) market data (out of scope). Never multiplex order entry onto a market-data socket — a depth burst must not head-of-line-block a cancel.

### 1.2 Transport abstraction

The gateway interface is `sendIntent(OrderIntent): Token` with WS, REST, and FIX implementations behind it (in TypeScript: a per-venue class implementing a common `OrderGateway` interface). Don't let "WebSocket" leak into strategy code — the strategy speaks intents; transports are per-venue plumbing. This symmetry makes REST-primary venues and mid-failure transport switching free at the architecture level.

### 1.3 When REST wins outright

REST is not a "slower equal" — it's a differently-shaped tool: stateless, independently rate-limited on most venues, and immune to your WS session's auth-expiry problems. It is the right primary path for:

1. **In-doubt resolution** — querying an order by `clientOrderId` after a timeout is the canonical way to disambiguate without risking a duplicate (→ `03 §5`).
2. **Kill-switch / cancel-all** — must not depend on the health of the WS session you're trying to escape from (→ `07 §7`).
3. **Endpoints not exposed over WS** — some conditional/algo order types, account ops, transfers, margin ops.
4. **A degraded WS session** — when the circuit breaker has tripped the WS channel.

---

## 2. Per-venue WS order-entry landscape

> **Verify per venue at integration time — this churns.** (All endpoint names, dates, and feature claims below are point-in-time and must be re-verified against live venue documentation before integration.)

| Venue | WS order entry | Notes that matter |
|---|---|---|
| Binance spot | Yes (`ws-api.binance.com`: `order.place` / `order.cancel` / `order.cancelReplace` / amend; JSON or SBE-encoded requests) | Separate service from market-data streams (orders and market data require two separate connections); functionally equivalent to REST — same features, parameters, status and error codes. Ed25519 `session.logon` → no per-request signature; SBE responses available; unfilled-order-count limits. Also offers FIX order entry. |
| Binance USDⓈ-M / COIN-M futures | Yes (`ws-fapi` / `ws-dapi`, same request/response model) | Session-logon support landed later than spot — **verify per product**. Legacy WS URLs were decommissioned 2026-04-23 — **pin current endpoints in config, not code**. |
| Bybit (v5 unified) | Yes (`wss://stream.bybit.com/v5/trade`: `order.create` / `order.amend` / `order.cancel` + batch) | Covers USDT contract, USDC contract, spot — i.e., everything including unified-margin accounts. One auth per connection (HMAC over `GET/realtime{expires}`); shares rate limits with REST. **The ack only means the request was accepted — order status must come from the private order stream** (→ `03 §3`). |
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

## 3. Private-stream establishment

Maintain **one private WS connection per `(venue, subaccount)`**, multiplexed by a connection manager (running inside the venue worker, → `01 §2`).

### 3.1 Authentication models (they differ per venue — abstract them behind the `VenueAdapter`, → `01 §8`)

| Auth style | Venues (representative) | Keepalive concern |
|---|---|---|
| **listenKey** issued via REST, attached to the WS URL | Binance (spot & futures) | listenKey expires (~60 min); must `PUT`-keepalive (~every 30 min) and re-issue on `401`/expiry |
| **Signed login frame** sent on the open socket (HMAC over expires/timestamp) | Bybit, OKX, Bitget | login expires; some require periodic re-auth; signature is over server-aligned time |
| **Per-request signing** with rolling timestamp window | most REST snapshots | clock skew → signature rejection |

### 3.2 Clock discipline for signing

Maintain a per-venue **server-time offset** (sampled via the venue's time endpoint, smoothed, re-sampled periodically). Sign every REST request and login frame against `now + offset`. Signature rejections due to skew are a *recoverable* auth failure (re-sample offset, retry) — distinct from invalid-key failures (unrecoverable → `HALTED`). Skew monitoring as a breaker → `07 §9`; recvWindow policy → §10.3.

---

## 4. The snapshot↔stream sync (the single most important sequencing detail)

A naive "take a REST snapshot, then subscribe" loses every event that fires in the gap — the view is born stale. The order-book sync discipline applies verbatim to account state:

1. Open WS, authenticate, **subscribe** to all private channels.
2. The moment events *can* arrive (entry to `SUBSCRIBING`), **buffer every inbound event in memory** — do **not** apply yet. Tag each with arrival order + dedup key + `eventSeq`/`eventTs`.
3. After subscriptions are confirmed, issue REST snapshots and record a **fence** per domain: ideally a venue sequence/transaction id (update id, `lastUpdateId`-equivalent); if the venue only gives timestamps, use the snapshot's server time **minus a safety margin** as the fence and rely on idempotency to absorb the overlap.
4. Apply the snapshot as the base state.
5. **Drain the buffer:** apply each buffered event only if it is *after* its domain fence; events at/before the fence are no-ops (already reflected). With per-event ids, compare ids; with timestamps, tolerate overlap and let idempotency dedup.
6. Transition to `LIVE`, applying events directly.

**Subtlety that bites everyone:** venue REST snapshots are **not atomic across endpoints** — balances, positions, and open-orders are separate calls captured at different instants, and the venue's own REST view is eventually consistent with its stream (an order you saw `NEW` on WS may not yet appear in `GET /openOrders`). Consequences baked into the design:

- The fence is **per-domain**, not global.
- Application must be **idempotent** so overlapping data converges.
- A buffered `NEW` for an order absent from the REST snapshot is **adopted**, not discarded (match by `clientOrderId`); a snapshot order absent from the stream is adopted too.
- A **follow-up full reconcile** shortly after going LIVE catches residual divergence.

**Treat bootstrap as the same operation as recovery after any stream gap** — one code path, exercised constantly, not a special-case startup script. The same buffer→snapshot→drain discipline also applies to live reconciles, so a stale snapshot never clobbers concurrent stream events (→ `05 §5`).

> Venue reality: sequencing semantics differ per exchange (some give monotonic per-stream sequence numbers, some per-event update IDs, some only timestamps, some reset counters on reconnect). Encode each venue's guarantees in `VenueCapabilities` (→ `01 §8`).

---

## 5. Connection health

The dangerous failure is not a clean disconnect — it is a **silent half-open** socket: TCP says alive, no data flows, you keep trusting a frozen view. Health monitoring detects *the absence of expected liveness*, not just errors. Idle ≠ alive.

### 5.1 Independent liveness signals (track all, per stream)

1. **Protocol ping/pong.** Honor the venue's scheme (some send ping and expect your pong; some expect *you* to ping). Track RTT. A missed pong within `pongTimeout` → connection presumed dead → `RECONNECTING`.
2. **Application data watchdog.** A monotonic timer reset on *every* inbound frame (data or pong). If `now − lastFrameTs > stalenessThreshold`, the stream is silent → `DEGRADED`, then escalate. Private streams are quiet by nature (no trades = no events), so the watchdog must be paired with a **deliberate liveness probe**: a cheap periodic authenticated REST call (server time or a light balance read) whose success proves the *venue path* is alive even when the *stream* is legitimately idle. "No events for T seconds while REST shows changes" is a stream-death detection.
3. **Auth/token expiry timer** — listenKey / login-token TTL, tracked explicitly (§7.4).

### 5.2 Freshness as a first-class field

Every account carries `lastReconcileAt` and `lastEventAppliedAt`. The allocator's freshness gate compares these to the clock. Health is therefore not boolean — it is *"how recently can I prove this view matches the venue."* Latency spikes (RTT breach), reconcile staleness, and partial subscription all degrade health *before* anything visibly breaks.

### 5.3 Concrete thresholds (tune per venue, start here)

| Signal | Soft (→ DEGRADED) | Hard (→ RECONNECTING/RESYNCING) |
|---|---|---|
| Pong RTT | > 1 s sustained | missed pong past `pongTimeout` (e.g., 10 s) |
| Inbound frame silence | > 30 s with no liveness-probe success | probe fails twice |
| Reconcile staleness | > 2× reconcile cadence | > 5× cadence |
| Sequence gap | 1 missed (auto-resync) | repeated/unrecoverable gaps |

### 5.4 Connection scoring, not binary up/down (order-entry sockets)

Track per connection: last-inbound-byte age, app-level ping RTT EWMA, ack-latency EWMA and rolling p99, consecutive timeouts/errors. Route each new order to the best-scoring authenticated socket. A connection degrades before it dies; a connection that's "up" but whose ack p99 has tripled is **down for trading purposes**.

Per-venue health is a **vector**, not a flag — place-ack latency, cancel-ack latency, exec-stream liveness, book-vs-trades drift — and the strategy consumes it: a venue with degraded cancel latency gets sized down or quoted wider automatically. A venue can keep WS up but stop matching, or accept places while cancels degrade — the health vector plus per-operation breakers (→ `07 §4`), not a single up/down flag, is what catches this **maintenance asymmetry**.

---

## 6. Reconnection

### 6.1 Core rule: never resume mid-stream. Re-snapshot on every reconnect.

User-data streams on these venues are **not resumable with a cursor** — there is no "give me everything since seq N." A reconnect = potential unbounded gap = you *must* re-establish via the §4 snapshot↔stream sync. Treat any reconnect as: *trust nothing the stream told me during the outage; the snapshot is truth.*

### 6.2 Backoff, jitter, circuit breaker

- **Exponential backoff with full jitter**, capped (e.g., base 100–250 ms → cap a few seconds to 30 s). Full jitter (`random(0, min(cap, base·2^attempt))`) avoids a thundering herd across 15 venues reconnecting together. With a warm standby (§7.1), the primary's death costs ~0 and backoff only governs rebuilding the standby — **backoff never gates trading**.
- **Circuit breaker per venue.** After N consecutive failures within a window, open the circuit: stop hammering, hold the account in `HALTED`/`RECONNECTING-backoff`, alert. Half-open probes test recovery.
- **Re-resolve credentials on every reconnect attempt** (listenKey may have expired, login material rotated, server-time offset drifted): `RECONNECTING → RESOLVING_CREDS → CONNECTING`.
- Attempt reconnects in *parallel* across the venue's multiple endpoints/IPs — first to complete auth wins.

### 6.3 Trading is gated for the entire reconnect + resync window

From the instant health degrades through the moment the post-reconnect reconcile passes, the account is **not LIVE**, so `deployable = 0`. No exception. The cost is a few hundred ms of missed opportunity; the alternative is sizing against a frozen view and double-committing capital. On any reconnect / order-entry socket transition, before that connection becomes order-eligible: re-auth → re-subscribe private streams → **reconcile open orders via REST** (snapshot diffed against the local order table). Never skip the reconcile. **Cancels may flow immediately on the new socket; new places wait for the reconcile.**

### 6.4 Distinguish reconnect classes

| Class | Trigger | Path |
|---|---|---|
| **Transport reconnect** | TCP/pong death, server close | `RECONNECTING → RESOLVING_CREDS → CONNECTING → … → SNAPSHOTTING → LIVE` |
| **Re-auth (socket retained)** | listenKey refresh OK, login still valid | `REAUTHING → RESYNCING → LIVE` (resync because a refresh can create a micro-gap) |
| **Re-auth (socket rebuild)** | login expired, listenKey revoked | `REAUTHING → RECONNECTING → …` |

---

## 7. Order-entry connection management (hot + warm)

### 7.1 Hot + warm topology

- **N hot + 1 warm standby per venue** (N ≥ 2 authenticated trade-WS connections at all times). Hot connections carry orders; the warm spare is fully connected, TLS-established, authenticated, heartbeating — and carries zero traffic. On primary failure, cut over in microseconds (promotion target < 1 ms) instead of paying DNS + TCP + TLS + login (50–300 ms — an eternity with orders resting in a moved market).
- Failover = flip a pointer; **resend nothing automatically** (§13 and `03 §5` define what is safe to resend).
- Terminate primary and standby on **different venue gateway IPs**: resolve all A records and pin connections to distinct IPs.
- Send a trivial authenticated no-op or app-level ping on the standby periodically so middleboxes and venue idle-timeouts never reap it.
- Mind per-venue connection/login limits; the majors tolerate 2–3 trade sockets.
- One API key per connection where venue limits allow — isolates rate-limit and ban blast radius (§10.4).

### 7.2 Proactive recycling and planned death

Many venues hard-disconnect on a schedule (Binance: 24 h max connection lifetime) or on auth expiry. Never let the venue choose the moment: every connection has a **planned-death schedule** — recycle on your own terms (e.g., every 12 h, or ~23 h for Binance's 24 h limit), jittered, one at a time, during quiet periods, never during a burst, warm-spare first. Binance sends a `serverShutdown` event **10 minutes before disconnection** — treat it as a first-class signal: promote the standby and drain the doomed connection gracefully instead of getting RST'd mid-burst.

### 7.3 Heartbeats — both ways, per-venue dialect

- Respond to server pings **immediately and from the gateway/IO thread** — never queued behind work (a pong stuck behind a slow task = disconnect at the worst time). The order-gateway event loop must never be blocked by anything else (§12).
- Send your own app-level pings (or cheap authenticated no-ops) every 5–15 s and treat ping silence as failure *fast*: a venue TCP connection can be black-holed for 30+ s before the kernel notices; your ping timeout (2–3 missed) is the real failure detector.
- Run a continuous latency probe (cheap authenticated no-op / time request) to track per-venue RTT drift.
- Per-venue dialects: **Bybit** `{"op":"ping"}` every ~20 s; **OKX** the literal string `ping` (disconnects after 30 s idle); **Binance** protocol-level ping/pong. (Re-verify per venue.)
- Arm `TCP_USER_TIMEOUT` (~5–10 s) so writes into a dead peer's window fail fast instead of silently buffering (§12).

### 7.4 Auth-session expiry

Sessions die silently more often than loudly: Bybit auth can lapse, OKX logins expire, listenKey-style mechanisms time out. Detect via the periodic cheap authenticated probe on each connection — **never discover auth death by having a real order rejected.** Re-auth on the standby, swap, then fix the primary.

**Login/session state is part of connection state.** "TCP up but not authenticated" must be unroutable. Model it explicitly:

```
Connecting → TlsReady → Authenticated → Subscribed → Eligible → Degraded → Draining → Dead
```

---

## 8. Event-stream reliability

Private streams drop messages, deliver out of order, and silently miss events. Your defenses are **detection** (so you *know* you diverged) and **recovery** (snapshot — because replay is almost never available).

### 8.1 Gaps / dropped events

- **If the venue exposes a per-stream monotonic sequence:** maintain `expectedSeq`. On `event.seq > expectedSeq` → gap detected → `RESYNCING` (mark stream `SUSPECT`; do **not** apply the delta or anything past the gap; capital decisions pause for that account until reconciled). On `event.seq < expectedSeq` → stale/duplicate → drop. Apply the venue's documented rule (some use `prevSeqId != lastSeq`; some give global update ids, some per-symbol).
- **If it does not** (common for private streams): you **cannot** detect a single dropped fill from the stream alone. Periodic REST reconciliation (→ `05`) and the reservation ledger (→ `04`) are the safety net for undetectable drops — periodic snapshots are your gap detector, not a luxury; tighten the cadence accordingly. Cross-checks catch drops: a balance delta that doesn't correspond to any seen fill, or `cumExecQty` jumping by more than the sum of received fills, signals a missed event → targeted resync. The adapter declares the venue's ordering capability; core adapts cadence accordingly.
- An **illegal FSM transition** (e.g., cancel before accept) is itself a gap detector.

### 8.2 Out-of-order delivery

Order events legitimately arrive out of order (`NEW` after `PARTIALLY_FILLED`, a stale `NEW` after `FILLED`; a fill before its ack). The **order FSM** (→ `03 §2`) is the guard: transitions only move forward; monotonic fields never regress; a late event that would regress state is **absorbed for its data, ignored for its transition**. Use a reorder buffer keyed by seq where sequences exist; apply only monotonically — last-writer-wins by **sequence, not arrival time**. Prefer venue-provided sequence/transaction-time over local arrival time everywhere ordering matters.

### 8.3 Deduplication

Two dedup namespaces, both persisted with TTL (bounded LRU/TTL `seenSet` in memory, backed by the durable event log for restart survival):

- **Fills:** key `(venue, exchangeOrderId, execId|tradeId)`. A fill is applied at most once — critical, because a double-applied fill double-counts realized PnL and balance (→ `03 §7`).
- **Order-state events:** key `(venue, exchangeOrderId, status, cumExecQty, updateTime)`.

### 8.4 Recovery hierarchy: targeted ≫ domain ≫ full ≫ replay

| Recovery | When | Cost |
|---|---|---|
| **Targeted re-fetch** (single order by `clientOrderId`, single position, single asset balance) | a specific entity is suspect (stuck in-flight, gap touching one order, balance delta mismatch) | cheap; preferred |
| **Domain snapshot** (all open orders, or all positions, or all balances) | gap with unknown blast radius in one domain | moderate |
| **Full account snapshot** (all domains + recent trades) | reconnect, repeated gaps, invariant breach | expensive; the §4 sync |
| **Replay from stream** | venue offers a resumable cursor (rare for private) | usually unavailable — **do not design around it** |

**Replay is not a real option** on these venues for private data. Recovery = snapshot. Build for that.

---

## 9. Private/user-data WebSocket connection FSM — full specification

The connection lifecycle in full: every state, every legal transition with trigger + guard + action, entry/exit actions, and the recovery path per failure. Venue-agnostic via the `VenueAdapter` (→ `01 §8`). Three orthogonal FSMs govern liveness per account — this **Connection FSM**, the **Reconciliation FSM**, and the **per-account Health FSM** (the trading gate); their AND-composition is what the allocator reads: `enabled = Connection==LIVE ∧ Health==HEALTHY ∧ Reconcile==FRESH ∧ allInvariantsHold` (→ `05 §7`).

### 9.1 States

| State | Purpose | Trading gate | Notes |
|---|---|---|---|
| `INIT` | constructed, nothing started | closed | loads persisted state on entry |
| `RESOLVING_CREDS` | acquire/refresh API key, signing material, listenKey, server-time offset | closed | also the re-entry point from reconnect & supervised resume |
| `CONNECTING` | TCP+TLS+WS handshake | closed | handshake timeout armed |
| `AUTHENTICATING` | send login/sign frame, or attach listenKey; await auth ack | closed | **no event buffering yet, no subscriptions** |
| `SUBSCRIBING` | subscribe to private channels; await sub-acks | closed | **buffering of inbound events BEGINS on entry** |
| `SNAPSHOTTING` | buffer live events, pull REST snapshots, apply, drain buffer past fence | closed | the §4 sync; runs the reconcile FSM's first pass |
| `LIVE` | steady state; apply incremental events; heartbeats healthy; reconcile fresh | **OPEN** (iff Health/Reconcile also green) | the only tradeable state |
| `DEGRADED` | connected but soft fault; in-band recovery; trading gated | closed | late heartbeat / minor gap / stale reconcile / partial sub / latency |
| `RESYNCING` | re-snapshot to repair detected gap/drift, socket retained | closed | targeted or full; returns to LIVE on success |
| `REAUTHING` | auth/listenKey expired; refresh creds (socket retained or rebuilt) | closed | §6.4 classes |
| `RECONNECTING` | transport lost; backoff timer running; will rebuild | closed | circuit breaker lives here |
| `HALTED` | unrecoverable or safety-tripped; hard trading block | closed (hard) | requires supervised resume |
| `CLOSING` | graceful shutdown in progress | closed | flush WAL, cancel timers, unsubscribe |
| `CLOSED` | terminal; resources released | closed | |

### 9.2 Entry / exit actions per state

| State | On entry | On exit |
|---|---|---|
| `INIT` | construct adapter; load durable state; replay WAL into in-memory model | — |
| `RESOLVING_CREDS` | fetch/refresh keys + listenKey; sample server-time offset; arm creds-timeout | clear creds-timeout |
| `CONNECTING` | open WS; arm handshake-timeout | clear handshake-timeout |
| `AUTHENTICATING` | send auth frame (or note listenKey-in-URL); arm auth-timeout | clear auth-timeout |
| `SUBSCRIBING` | send subscribe frames; **start event buffer**; arm sub-timeout | clear sub-timeout (keep buffer) |
| `SNAPSHOTTING` | capture per-domain fence; issue REST snapshots; arm snapshot-timeout | apply snapshot + drain buffer + assert invariants; clear snapshot-timeout; stop buffering |
| `LIVE` | start heartbeat + data-watchdog + liveness-probe timers; start reconcile cadence timer; set Health=HEALTHY, Reconcile=FRESH; open gate | stop heartbeat/watchdog/probe/cadence timers; close gate |
| `DEGRADED` | mark Health=DEGRADED (gate closes); start fault-recovery timer; begin in-band probe/resync attempt | clear fault-recovery timer |
| `RESYNCING` | mark Health=RECOVERING; start resync; arm resync-timeout | apply repair; clear resync-timeout |
| `REAUTHING` | call adapter keepalive/refresh; arm reauth-timeout | clear reauth-timeout |
| `RECONNECTING` | close socket cleanly; compute backoff w/ jitter; tick circuit breaker; arm backoff-timer | clear backoff-timer |
| `HALTED` | hard-close socket; set Health=HALTED; emit alert; persist halt reason | require operator/supervisor token to leave |
| `CLOSING` | unsubscribe; flush WAL/checkpoint store; cancel all timers | — |
| `CLOSED` | release socket + handles | — |

### 9.3 Transition table (trigger / guard / action)

| # | From → To | Trigger | Guard | Action |
|---|---|---|---|---|
| T1 | `INIT → RESOLVING_CREDS` | `start()` | persisted state loaded & WAL replayed | begin credential resolution |
| T2 | `RESOLVING_CREDS → CONNECTING` | creds resolved | keys valid, offset sampled | proceed to connect |
| T3 | `RESOLVING_CREDS → HALTED` | creds error | error is *invalid key/permission* (not skew) | alert: bad credentials |
| T4 | `RESOLVING_CREDS → RECONNECTING` | transient creds error / timeout | recoverable (network, skew) | backoff & retry |
| T5 | `CONNECTING → AUTHENTICATING` | WS open | handshake ok | send auth frame / attach listenKey |
| T6 | `CONNECTING → RECONNECTING` | handshake fail/timeout | — | backoff |
| T7 | `AUTHENTICATING → SUBSCRIBING` | auth ack ok | login accepted | send subscriptions; start buffer |
| T8 | `AUTHENTICATING → REAUTHING` | auth reject (expired listenKey/login, skew) | recoverable | refresh creds |
| T9 | `AUTHENTICATING → HALTED` | auth reject (invalid key/permission) | unrecoverable | alert |
| T10 | `AUTHENTICATING → RECONNECTING` | transport drop / auth-timeout | — | backoff |
| T11 | `SUBSCRIBING → SNAPSHOTTING` | all sub-acks received | every required channel confirmed | capture fence; pull snapshots |
| T12 | `SUBSCRIBING → DEGRADED` | partial sub-ack | some required channel missing past sub-timeout | retry failed channels in-band |
| T13 | `SUBSCRIBING → RECONNECTING` | transport drop / sub-timeout (total) | no channels acked | backoff |
| T14 | `SNAPSHOTTING → LIVE` | snapshot applied & buffer drained | invariants hold; fence monotonic | open gate; start LIVE timers |
| T15 | `SNAPSHOTTING → RESYNCING` | snapshot inconsistent / REST retryable error | retryable | re-snapshot w/ fresh fence |
| T16 | `SNAPSHOTTING → RECONNECTING` | transport drop / snapshot-timeout | — | backoff |
| T17 | `SNAPSHOTTING → HALTED` | invariant breach implying unknown exposure | auto-repair unsafe | alert; supervised resume |
| T18 | `LIVE → DEGRADED` | late pong / data-silence / reconcile-stale / latency breach | soft thresholds (§5.3) | close gate; begin in-band recovery |
| T19 | `LIVE → RESYNCING` | seq gap / confirmed drift | recoverable via snapshot | targeted/full re-snapshot |
| T20 | `LIVE → REAUTHING` | listenKey/login near expiry; keepalive failed | recoverable | refresh creds |
| T21 | `LIVE → RECONNECTING` | pong timeout / transport drop / half-open detected | — | force-close; backoff |
| T22 | `LIVE → HALTED` | hard invariant breach (unknown exposure / persistent / PnL irreconcilable) | unrecoverable safely | alert |
| T23 | `LIVE → CLOSING` | `shutdown()` | — | graceful teardown |
| T24 | `DEGRADED → LIVE` | fault cleared | heartbeat resumed ∧ reconcile fresh ∧ gap benign ∧ subs complete | reopen gate |
| T25 | `DEGRADED → RESYNCING` | recovery needs snapshot | drift/gap confirmed | re-snapshot |
| T26 | `DEGRADED → RECONNECTING` | escalation / decide to recycle socket | fault-recovery timer expired or transport lost | backoff |
| T27 | `DEGRADED → HALTED` | persistent fault past budget / invariant breach | unrecoverable | alert |
| T28 | `RESYNCING → LIVE` | resync applied | drift repaired ∧ invariants hold | reopen gate |
| T29 | `RESYNCING → RECONNECTING` | transport drop during resync | — | backoff |
| T30 | `RESYNCING → HALTED` | unrepairable drift / repeated resync failures / invariant breach | unrecoverable safely | alert |
| T31 | `REAUTHING → RESYNCING` | creds refreshed, socket retained | login valid again | resync (close micro-gap) |
| T32 | `REAUTHING → RECONNECTING` | refresh requires new socket | listenKey revoked / login unrecoverable on this socket | rebuild |
| T33 | `REAUTHING → HALTED` | refresh fails (key revoked) | unrecoverable | alert |
| T34 | `RECONNECTING → RESOLVING_CREDS` | backoff elapsed | circuit not open | re-resolve creds, then reconnect |
| T35 | `RECONNECTING → HALTED` | max retries / circuit open past budget | breaker tripped | alert; supervised resume |
| T36 | `RECONNECTING → CLOSING` | `shutdown()` during backoff | — | cancel backoff; teardown |
| T37 | `HALTED → RESOLVING_CREDS` | supervised resume | operator token ∧ root cause cleared | full re-establish + mandatory reconcile |
| T38 | `HALTED → CLOSING` | `shutdown()` | — | teardown |
| T39 | `CLOSING → CLOSED` | teardown complete | WAL flushed, timers cleared | release handles |
| T40 | `* → CLOSING` | `shutdown()` (any state) | — | graceful teardown (highest-priority transition) |
| T41 | `* → HALTED` | unclassified error near money | error not provably benign | conservative default: halt + alert |

### 9.4 Recovery-path summary (per failure, by originating state)

- **Handshake/transport failure** (`CONNECTING/AUTH/SUBSCRIBING/SNAPSHOTTING/LIVE/RESYNCING`) → `RECONNECTING` → backoff+jitter → `RESOLVING_CREDS` → … → full re-sync. Circuit breaker guards runaway loops (→ `HALTED`).
- **Auth/listenKey expiry** → `REAUTHING` → refresh → `RESYNCING` (socket kept) or `RECONNECTING` (socket rebuilt). Invalid key → `HALTED`.
- **Half-open socket** → data-watchdog + failed liveness probe → `LIVE→RECONNECTING` (force-close first).
- **Seq gap / drift** → `RESYNCING` (targeted, else full). Unrepairable → `HALTED`.
- **Partial subscription** → `DEGRADED` → retry channels → `LIVE`, else recycle → `RECONNECTING`.
- **Invariant breach implying unknown exposure** → `HALTED` from any state; never auto-repaired (→ `05 §6`).
- **Rate limit / maintenance** → `DEGRADED`/`HALTED` for that venue; reconcile cadence throttled; resume via half-open probe + mandatory full reconcile.
- **Shutdown** → `CLOSING → CLOSED` from anywhere (T40 wins).
- **Supervised resume** is the *only* exit from `HALTED` other than shutdown (T37), and it forces a full re-establish + reconcile before the gate can reopen.

---

## 10. Auth and signing

Signing is pure self-inflicted latency. Attack it venue by venue.

### 10.1 The three signing regimes

1. **Session-auth venues — zero per-request signing.** The single biggest signing win available, and the core reason WS APIs dominate. Binance spot: `session.logon` with an **Ed25519 key** authenticates the connection once; subsequent `order.place` / `order.cancel` requests need no signature. Bybit / OKX / Bitget: HMAC-SHA256 at login (connection-scoped auth), per-order requests unsigned after login. Use session auth everywhere a venue offers it — microseconds saved and one less thing to get wrong per order.
2. **Per-request Ed25519:** ~15–50 µs per signature — fine at these burst rates, no caching games needed, but prefer session auth so it's zero. Binance explicitly recommends Ed25519 as the best-performing key type (and `session.logon` requires it); timestamps may be specified in microseconds.
3. **Per-request HMAC-SHA256** (REST fallback, some venues): ~1–2 µs with a precomputed key context. In Node.js, create the key once as a `KeyObject` via `crypto.createSecretKey()` at startup and reuse it for every `crypto.createHmac()` call — never re-derive the key from the secret per request; write the output into a preallocated `Buffer` rather than allocating strings on the hot path.

**Do not pre-sign future timestamps to "cache signatures"** — the correctness risk (stale `recvWindow`, venue clock skew) isn't worth saving ~2 µs.

**Binance 2026 signing change (re-verify):** payloads must be **percent-encoded before computing signatures**; requests that don't follow this order are rejected with `-1022 INVALID_SIGNATURE`. Encode-then-sign, never sign-then-encode. A storm of `-1022` after this change is a code bug, not weather — raise an ops alarm (→ `07 §2`).

### 10.2 Precompute everything signable

Keys are parsed once at startup and held in protected memory — use `sodium-native` secure buffers (`sodium_malloc` + `sodium_mlock`) so key material is locked and excluded from swap/core dumps. The signing input is built into a preallocated `Buffer`; only timestamp/qty/price/clientOrderId bytes get patched per order (§11).

### 10.3 recvWindow and clock discipline

- Set `recvWindow` / expiry windows tight enough to bound "zombie order placed late" risk — **2–5 s** as the default — but not so tight that normal clock error rejects you.
  > **Alternative view:** one source recommends a tighter 1000–3000 ms. Use the tighter band only once clock discipline is proven in production (continuous offset monitoring green for weeks); correctness here means *not* getting valid orders rejected.
- Run chrony/NTP against the venue region's servers (PTP if available), **plus continuous measurement of your offset vs each venue's `serverTime`**, alarming when skew drifts past ~200 ms. Clock skew is a monitored production metric with its own breaker; trading must not enable while the clock alarm is red (→ `07 §9`).
- Timestamp regimes are tightening: Binance now rejects requests whose timestamp exceeds `serverTime + 1 s`, rejects at the matching engine on drift, and the rejection **increments your rate/IP limits** — clock slop literally consumes your order budget and can rate-limit-ban you while rejecting 100% of your orders.

### 10.4 Key hygiene

Trade-only keys (no withdrawal scope), IP-allowlisted to your host, one key per connection where venue limits allow (isolates rate-limit and ban blast radius), and a rotation runbook that uses the warm-spare mechanism so rotation is a zero-downtime flip. Keys are never logged; signing happens inside the IO worker (→ `01 §3.6`).

---

## 11. Hot-path message construction (summary)

The order hot path is: ring pop → patch template → sign (if needed) → mask → TLS encrypt → write. Budget single-digit microseconds before the syscall. Techniques, in brief:

- **Pre-rendered templates.** For each (venue, symbol, side, order-type/shape) tuple actually traded, pre-render the JSON byte buffer at startup into a fixed `Buffer` with fixed-width reserved slots; at fire time, copy digits into the slots (`buffer.write` / manual byte stores) — no allocator, no JSON library, no float formatting, no `JSON.stringify`. Takes "build + serialize" from tens of microseconds to <1 µs.
- **Numbers as pre-quantized fixed-point → ASCII.** Tick/lot sizes are known per instrument, so integer-to-ASCII digit patching replaces any float-formatting path entirely. Prices and quantities are fixed-point integers internally (`bigint` or range-checked integer `number` with branded types), converted to strings only at the template patch. **Never let a float touch a price** — no `toFixed`, no FP arithmetic on prices/quantities (→ `01 §9`). Validate against cached `exchangeInfo` before send; refresh specs off the hot path.
- **Lazy parsing of acks/fills.** No full deserialization: lazy/partial parsing (`simdjson` Node bindings in lazy mode, or hand-rolled `Buffer` field scanners) keyed on the few fields that drive the state machine: `id`, `status`, `code`, `orderId`, `clientOrderId`, `execType`. Binance SBE responses skip JSON entirely — use them there.
- **IDs.** Generate request `id` and `clientOrderId` from an atomic counter + epoch prefix (sortable, collision-free across restarts), pre-encoded as ASCII; pre-generate `clientOrderId`s in batches (a ring of pre-rendered IDs) so fire-time ID acquisition is a pointer bump. No UUID generation/formatting on the hot path. Encode lane/venue/intent in the ID structure so a bare `clientOrderId` in a venue message is self-describing during reconciliation (→ `03 §1`).
- **Batching.** Where the venue supports true batch ops (OKX `batch-orders`/`batch-cancel-orders`, Kraken batch, Binance futures `batchOrders`, Bybit batch variants): a two-leg place or place+cancel in one frame saves per-message overhead and can land atomically-ish in venue ingest order — one frame, one syscall, 20 cancels — trading a few hundred µs of batching delay for large rate-limit efficiency. **Use it for multi-leg hedge baskets and cancel storms, not the latency-critical taker leg.** Correctness rule: **never treat a batch ack as atomic** — OKX-style batch ops allow partial success; check per-order `sCode`/`sMsg`.

---

## 12. Socket, TLS, and runtime tuning (summary)

Kernel bypass (DPDK/Onload-class) is overkill for one host hitting 15 internet-distant venues — the bottleneck is RTT, not your stack. Within the host:

- **TCP/WS:** `TCP_NODELAY` on everything, always (`socket.setNoDelay(true)`) — Nagle plus delayed ACK is a 40 ms tax and the most common self-inflicted wound. `TCP_USER_TIMEOUT` ~5–10 s so half-open connections fail fast (Node doesn't expose it directly — set via a small native addon / `setsockopt` on the fd; worth the addon). `SO_PRIORITY`/DSCP if the network honors it. **Disable permessage-deflate on the order channel** (`ws`: `perMessageDeflate: false`) — compressing a 300-byte order frame burns CPU for nothing; compression only pays on market-data fan-in.
- **TLS:** TLS 1.3 with session-resumption tickets cached per venue so reconnects are 1-RTT. Kernel TLS isn't practically reachable from Node's TLS stack; recapture the equivalent win by keeping the write path copy-free up to `tls.TLSSocket.write` — write the final masked frame from one preallocated `Buffer`, no intermediate string/object allocation.
- **WS client:** prefer a hand-rolled WS framer over a raw `tls.TLSSocket` for the order channel (write the masked client frame yourself into the preformatted buffer; client frames must be masked — cheap RNG, apply mask during the copy). If using a library, `ws` with `perMessageDeflate: false`, fed preassembled `Buffer` payloads — never objects stringified per send. **One writer per socket** — no cross-component contention on the write path. Run the order gateway as its own Node process (or dedicated `worker_thread`) per latency lane; connect strategy↔gateway with an SPSC ring over `SharedArrayBuffer` + `Atomics`, not structured-clone messaging (→ `01 §2.3`).
- **Runtime/OS:** the gateway event loop must never block — no synchronous I/O, no JSON of large payloads, no crypto bigger than one HMAC on it; cold work (spec refresh, reconciliation, journal compaction) goes to `worker_threads`/separate processes. **GC pauses are this stack's latency tax:** minimize hot-path allocation (templates/rings do most of it), pool every buffer, tune heap flags (e.g., `--max-semi-space-size`) so minor GCs are rare and short, and monitor GC pause times as a first-class latency metric alongside ack p99. Node's epoll loop can't busy-poll natively; `SO_BUSY_POLL` (same native addon) plus isolated cores recovers most of the wakeup-latency win available at internet RTTs.

---

## 13. REST fallback path, done properly

REST is the fallback for order entry on WS failure, the reconciliation/query path, and primary for venues without WS trading. Make it **not cold**:

- **Warm at all times:** a small pool of persistent HTTPS connections per venue — `undici` (`Pool`/`Agent` with keep-alive) rather than a high-level convenience client — kept alive and *verified* with periodic cheap authenticated requests end-to-end. **A fallback you haven't exercised in an hour is Schrödinger's fallback.** Never pay DNS + TCP + TLS (~1.5 RTT even with TLS 1.3) at fire time. Pre-resolved, health-ranked IPs; TLS sessions resumed.
- **HTTP/1.1 keepalive pool by default; HTTP/2 only if the venue's h2 termination is measured faster — several are not.**
  > **Alternative view:** one source suggests HTTP/2 wherever supported (one connection, multiplexed queries). h2 is fine for the cold query path; for the fallback *order* path, measurement decides.
- Reuse the **same template-patching serializer** (§11) for request bodies/query strings.
- **Same state machine, same `clientOrderId`s, same journal.** REST is a transport, not a different system. A place sent on WS can be canceled over REST and vice versa — required during partial failures. Failover WS→REST reuses the same `clientOrderId`; venues that reject duplicate client IDs turn the race into a safe, observable outcome.
- **Fallback triggers with hysteresis:** WS connection score below threshold, ack p99 over budget, or N consecutive ack timeouts → route new intents via REST while WS recovers; flip back only after the WS path proves itself (M consecutive healthy pings + a canary order/cancel on testable venues). Avoid flap.
- **No hedged/duplicated places across transports.** Hedging requests is for idempotent reads; a place is not idempotent across IDs. Hedging the *same* `clientOrderId` across WS+REST simultaneously relies on every venue's dedup under load — don't. **Cancels: hedge freely across both transports** (→ `03 §5.4`).
- REST owns: order-status queries, open-orders snapshots, position snapshots, instrument metadata, transfer/margin ops — all off the hot path.

**Budget reality:** a *warm* REST place is typically only ~0.5–2 ms worse than WS on the same path. The fallback is not a disaster; *cold* REST is.

---

## 14. Rate limits as a first-class subsystem

### 14.1 Know each venue's currency of limitation (re-verify per venue)

- **Binance:** two independent dimensions — IP-based request *weight*, and per-account *unfilled order count* (orders per 10 s and per 24 h). Cancels don't relieve the unfilled-order counter the way fills do, so a requote-heavy strategy burns it fast — this, not weight, is often the binding constraint for arb. Timestamp-rule rejections increment IP limits but **not** unfilled order count. Binance spot WS additionally caps incoming messages per second per connection at a small number — this directly limits per-socket burst rate and argues for parallel authenticated trade sockets on burst-heavy venues.
- **Bybit:** per-UID, per-endpoint limits with current usage echoed in response headers (`X-Bapi-Limit-Status`) — parse them and feed your buckets ground truth rather than open-loop accounting. Tier upgrades are negotiable with volume. WS trade shares rate limits with REST.
- **OKX:** limits keyed per (sub-)account and per instrument family; batch ops spend one request for up to 20 operations, which changes the arithmetic for cancel storms.

### 14.2 Client-side enforcement

- Per venue, a local **hierarchical token-bucket mirror of every applicable limit** — IP bucket → account/UID bucket → endpoint bucket, plus order-count windows, per-symbol limits, and the WS message-per-second limit itself. Decrement locally *before* send; sync from response headers (`X-MBX-ORDER-COUNT-*`, `X-Bapi-Limit-Status`, etc.) as ground truth; cap at ~80% of nominal.
- **One shared limiter per venue spans all subaccounts and all REST callers** — snapshots, reconciles, order ops, recovery. Recovery and reconciliation must not starve order placement, and vice versa: prioritize *within* the limiter (order-critical path > critical reconcile calls (open orders, balances, positions) > nice-to-haves). A resync storm during an outage that ignores the limiter gets you banned, deepening the outage. Prefer WS for live data so REST budget stays reserved for reconciliation. Losing REST means losing the ability to verify truth → the venue must DEGRADE (can't verify = not tradeable).
- **The single most important rule: separate budget pools for place vs cancel, and cancel's pool can never be starved by place.** When rate-constrained, the system must always be able to flatten itself. Shed places, never cancels; reserve a hard floor (~20% of every bucket) that only cancel/close operations may spend.
- **Back off *before* the venue 429s you** — rejected requests can still increment unfilled-order counts and IP limits. Binance escalates to **HTTP 418 auto-bans** for continuing to send after 429s, so a 429 must hard-gate the bucket, not just delay one request. A 418 IP ban takes the whole host out — on a single-host design, a full outage; this is the strongest argument for per-key isolation and a second egress IP on a standby host.
- When multiple accounts on one venue all need re-snapshot (reconnect storm), **coalesce: batch and pace them** through the shared bucket with jittered backoff.
