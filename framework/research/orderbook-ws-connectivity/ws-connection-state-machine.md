# Orderbook Market-Data WebSocket Connectivity — Best-in-Class Stack & Practices

---

## First, the framing that determines everything else

Two principles drive every decision below:

**A book is either provably fresh or it is dead.** There is no "probably fine." Every book carries an explicit state, and only books in `SYNCED + FRESH` are eligible to feed the arb signal. The moment you can't *prove* freshness — sequence gap, checksum mismatch, transport drop, stale timestamp, watchdog timeout — the book is excluded from signal generation immediately and downstream sees the staleness flag. This is the entire defense against phantom arbitrage. Never patch a suspect book; tear it down and rebuild.

---

## The two-level state machine

Model this as two nested FSMs. The **connection** FSM governs transport; each **book** on that connection has its own FSM governing sync state. They're coupled but distinct — a connection can be `LIVE` while one book on it is `RESYNCING`.

**Connection states:**

```
DISCONNECTED → CONNECTING → OPEN → SUBSCRIBING → LIVE → (DEGRADED) → CLOSING → DISCONNECTED
```

plus a terminal `FAILED` that trips a circuit breaker.

**Book states:**

```
AWAITING_SNAPSHOT → BUFFERING → SYNCED → STALE   (STALE reachable from anywhere)
```

`STALE` is reachable from anywhere and is the safe default whenever anything is uncertain.

Now the lifecycle events mapped onto this.

### connect / connecting

Set `TCP_NODELAY` (kill Nagle), enlarge `SO_RCVBUF`, set a hard connection timeout. Some venues publish multiple data-center endpoints and you want the lowest-RTT one from your single region.

### open

On `onOpen`, **do not reset your backoff counter yet.** Reset it only after the connection survives a stability window (e.g., 10–30s of healthy data). Resetting immediately is how you get a hot reconnect loop against a flapping endpoint, which then gets you banned. Start heartbeat timers and transition to `SUBSCRIBING`.

### subscribe / unsubscribe

Treat subscriptions as **declarative desired-state, reconciled** — not imperative commands. You hold a target set of (venue, symbol) tuples; the connector continuously reconciles actual against desired. This single design choice makes reconnect, dynamic add/remove, and partial failures all fall out naturally instead of being special cases.

Concretely:

- Batch subscribes but respect per-message arg limits and subscribe-rate limits (you'll get throttled or disconnected otherwise).
- Track every pending subscription with a timeout — no ack within N seconds → retry or alarm.
- **Correlate acks by request id**; venues echo a confirmation you must match.
- Handle *partial* failures: some symbols come back rejected (delisted, invalid, not on that market type) — don't let one rejection abort the batch; record the rejection, alarm, and continue.
- Unsubscribe matters at this scale too: when you rebalance shards across connections you'll unsubscribe-then-resubscribe elsewhere, and you must not double-count or leave orphaned book state.

### message / update / response — the crux

Classify every inbound frame into control (subscribe ack, error, pong), heartbeat, or data (snapshot vs diff). The orderbook sync algorithm is where correctness is won or lost, and it's venue-specific:

- **Binance-family (sequence with snapshot reconciliation):** Fetch the REST depth snapshot to get `lastUpdateId`. Buffer WS diff events meanwhile. Drop any buffered event with `u < lastUpdateId+1`. The first event you *apply* must satisfy `U <= lastUpdateId+1 <= u`. From then on, every event's `pu` must equal the previous event's `u` (the explicit prev-update-id chain) — any break is a gap. Gap → book to `STALE`, resnapshot. Never interpolate across a gap.
- **OKX / Bitget (checksum-validated):** They send a CRC32 checksum of the top levels (OKX: top 25) on each push. You maintain the book and recompute the checksum every update (or every N if you're tight on budget, but every update is cheap and catches corruption instantly). Mismatch → `STALE` → resubscribe + resnapshot. This is the strongest correctness signal available and you should treat venues that offer it as first-class.
- **Bybit (snapshot + delta with sequence):** Snapshot then deltas carrying sequence/update ids; gap → resubscribe.

The invariant across all of them: **maintain an expected-next-sequence per book; any deviation transitions to `STALE`.** Plus venue-independent sanity gates on every update — crossed book (`best_bid >= best_ask`), negative/zero qty where illegal, price bounds — because these catch both venue bugs and your own parser bugs, and they're nearly free.

### heartbeat / ping-pong / liveness — the silent-death problem

The dangerous failure is not a clean disconnect; it's a TCP connection that stays *open* while data silently stops. Protocol-level WS ping/pong is necessary but **not sufficient** — venue infra will happily keep the socket alive while the data plane is dead.

So you run **two independent liveness mechanisms**:

1. **Venue heartbeat protocol** (Binance sends ping frames you must pong within their timeout; OKX expects a `ping` string and replies `pong`; Bybit has its own ping format). Comply exactly or you get cut.
2. **A data-staleness watchdog** that lives *outside* the WS library's ping handling, tracking last-message time per connection *and per book*, with intervals adaptive to symbol liquidity. A liquid BTC book going 2 seconds silent is an emergency; an illiquid altcoin going 2 seconds silent is normal. No data within the expected window → connection `DEGRADED`, suspect books → `STALE`, trigger resync. This watchdog is the thing that actually saves you from serving a frozen book into the arb engine.

### exception / error

Categorize, because the response differs sharply:

- **Transport** (TCP reset, TLS error, 1006 abnormal close): reconnect with backoff.
- **Protocol** (malformed frame): log raw bytes for forensics, drop the frame, never crash the connection on one bad message — isolate failures per book.
- **Application** (rate-limit/429, IP ban, invalid subscription): respect `Retry-After`, back off *hard*, and alarm. A ban response means stop hammering immediately.
- **Logical** (sequence gap, checksum fail, crossed book): book → `STALE` → resync. Connection stays up.

A **circuit breaker per venue**: repeated `FAILED` transitions → exponential backoff with a hard cap and a loud alarm, so a venue outage doesn't turn into a self-inflicted ban.

### disconnect / close

Distinguish a clean close (close frame + code: 1000 normal, 1008 policy, venue-specific 4xxx) from an abrupt drop (1006, TCP reset, watchdog timeout), and log the code with a reason. The non-negotiable action: **on any disconnect, immediately mark every book on that connection `STALE`.** Downstream stops getting fresh prices from those symbols the instant the transport dies — no grace period.

Plan for the **scheduled cut**: Binance force-disconnects connections at 24h. Don't wait for it. Do a **make-before-break** — open a new connection, subscribe, fully resync its books, *then* cut the old one — so coverage never has a hole. Failure-driven reconnects are immediate; scheduled ones are make-before-break.

### reconnect → resubscribe → resync → reconnected

These are three distinct steps and conflating them causes bugs:

1. **Reconnect** re-establishes transport (exponential backoff with **full jitter**, capped, per-venue policy).
2. **Resubscribe** reconciles desired-state (your declarative registry makes this automatic).
3. **Resync** rebuilds each book's state (the snapshot+buffer dance again, per venue).

A book is only "reconnected" — i.e., back to `SYNCED + FRESH` and eligible for signals — after resync completes *and* validates (checksum passes or sequence chain re-establishes). Until then it stays `STALE` and excluded.

---

## Cross-cutting concerns

**Freshness, surfaced explicitly.** Four independent staleness signals: sequence continuity, checksum, exchange-timestamp-vs-local-receive-time, and the inter-message watchdog. Beyond connection state, enforce a **max book age even for `SYNCED` books** — if the venue's own timestamp on the latest update is older than X ms, treat as suspect. And the cross-venue rule that closes the phantom-arb hole: an arb signal compares two books; **if either is not `SYNCED + FRESH`, no signal**, full stop.

**Clock discipline.** chrony at minimum. Use exchange-provided timestamps only for relative ordering/freshness; use `CLOCK_MONOTONIC` (or NIC hardware timestamps) for your own latency measurement. Never use wall-clock for latency.

**Threading / book access.** Per-connection single reader task that does recv + parse + apply, keeping each book **single-writer**. Expose to the arb engine via a lock-free read — a seqlock or RCU-style atomic pointer swap (build new top-of-book, swap the pointer) — so the consumer never contends with the writer and never reads a torn book. 

**Backpressure.** Bounded queues everywhere on the publish path. If a consumer falls behind, coalesce to latest top-of-book — never block the reader. If the *connector itself* can't decode as fast as ingress (queue to the book builder growing), that's a `STALE` condition you must detect and resync after, and ultimately a signal to scale out shards.

**Memory & parsing.** Pre-allocate book structures, object-pool everything per-message, zero per-update heap allocation in steady state. SIMD JSON (simd-json) since nearly all crypto venues are JSON — but prefer a binary feed (SBE/protobuf) wherever a venue offers one. Keep at least the depth the venue checksums, so you can validate; keep more only if arb needs it.

**Observability — non-negotiable for HFT.** Per connection *and* per book: message rate, gap count, resync count, checksum-failure count, reconnect count, exchange-timestamp-vs-local-receive-time, time-since-last-message, decode latency, and cumulative staleness duration. Structured log of *every* state transition with a reason code. Alarm on resync storms, ban responses, and any staleness exceeding threshold. When a book misbehaves at 3am you must be able to reconstruct exactly why it went stale.

**Testing / chaos.** Record raw WS frames with receive timestamps for deterministic replay. Build a fault injector that drops, reorders, duplicates, delays, gaps, and corrupts checksums, and assert your book builder always lands in `STALE`-then-recovered rather than silently wrong. Per-venue conformance tests for each sync protocol.

---

## The opinionated stack

| Concern | Choice |
|---|---|
| IPC to arb engine | shared-memory lock-free ring buffer (SPSC/MPSC) — same host, never touch the network stack |
| Time | chrony (PTP if available), `CLOCK_MONOTONIC` for latency |

---
