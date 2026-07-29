# Reliable, Reconciled Local Account State for a CEX-CEX Arbitrage System

**Scope:** Balances, open orders, positions, funding, and fees across ~15 venues and many subaccounts, in Node.js/TypeScript, single host, surviving restarts. Correctness strictly dominates latency.

This is an opinionated breakdown of how to build and operate the account-state layer so that the arbitrage engine can size and gate trades against a local view that is *provably* consistent with the venue, or that *knows* it is not and refuses to act.

---

## 0. The one idea everything else hangs off

There is exactly one source of truth: **the venue.** Your local state is a *cache with a confidence level*, never an authority. Every design decision below exists to answer two questions at all times:

1. Is my local view currently trustworthy enough to trade on?
2. If not, how fast can I either re-establish trust or stop trading?

Three corollaries that should be treated as laws, not preferences:

- **Events are hints, not truth.** Every WebSocket user-data stream drops messages, reorders, duplicates, and silently dies. You design *as if* every event can be lost, because it can. The stream makes you fast; reconciliation makes you correct.
- **Silently-wrong state is worse than no state.** A view you *know* is stale triggers a safe halt. A view that is wrong but looks fine sends a second leg against capital that is already committed. The entire system is biased toward *detecting* divergence loudly rather than minimizing its probability quietly.
- **Reconciliation is not a cleanup job, it is the backbone.** The stream is an optimization layer bolted on top of a system that would still be correct (just slower) on REST polling alone. If you can't describe your design with the stream deleted, you don't have a reliable design.

---

## 1. Topology: single-writer state machines per (venue, subaccount)

### 1.1 The actor boundary

Model each `(venue, subaccount)` as an independent **single-writer actor** that owns its slice of account state. All mutations to that slice — from REST snapshots, stream events, reconciliation diffs, and local intent (reservations) — flow through one serialized command queue. Nothing else writes to that state.

Why single-writer:

- It makes ordering *explicit and yours*. You decide the merge order of a REST snapshot vs. a buffered stream event; the runtime doesn't decide it for you via interleaving.
- It eliminates an entire class of TOCTOU races on balance/position fields without locks.
- It makes the state a **deterministic reducer**: `state(n) = reduce(state(n-1), event(n))`. Determinism is what makes replay, testing, and crash recovery tractable.

In Node this maps cleanly onto the event loop: one async command-processing loop per actor, `await`-serialized, with an explicit in-memory FIFO and backpressure. Do **not** rely on incidental event-loop ordering — own an explicit queue with sequence stamps so you can reason about and replay it.

### 1.2 Layered planes

```
                 ┌─────────────────────────────────────────┐
   intent  ───►  │  Reservation ledger (local, optimistic)  │
                 ├─────────────────────────────────────────┤
   stream  ───►  │  Live reducer  (fast path, event-sourced)│  ──► local truth
                 ├─────────────────────────────────────────┤
   REST    ───►  │  Snapshot / reconcile (slow path, truth) │
                 └─────────────────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────────────────────┐
                 │  Persistence: WAL + periodic snapshots   │
                 └─────────────────────────────────────────┘
```

- **Snapshot/reconcile plane (REST):** authoritative, slow, rate-limited. Establishes ground truth on boot and periodically thereafter.
- **Live plane (stream):** fast, lossy. Folds incremental events into the reducer between snapshots.
- **Reservation ledger (local):** *your* intent that the venue doesn't know about yet. The bridge between "the engine decided to commit capital" and "the venue confirmed the lock." This is where double-spend prevention lives.

---

## 2. Bootstrap: the snapshot-then-stream race (and how to not lose events)

The single most common subtle bug in account state is the gap between "I took a REST snapshot" and "I started listening." Events that fire *during* that window are lost, and your view is born stale.

The correct sequence (the same discipline as order-book sync, applied to account state):

1. **Open and subscribe the user-data stream first.** Begin **buffering** every event in memory. Do not apply anything yet.
2. **Take the authoritative REST snapshot** of balances / open orders / positions. Record the venue's sequence/version marker that came with it (update id, transaction time, `lastUpdateId`-equivalent, or—if the venue gives you nothing—the snapshot wall-clock plus a server-time read).
3. **Replay the buffer**, discarding any event at or before the snapshot's marker and applying everything after it. For venues with no usable per-event sequence, fall back to event timestamps with a guard band and accept that the first reconcile will correct any overlap error.
4. **Go live**, applying events directly.

Treat the bootstrap as *the same operation* as recovery after any stream gap (Section 4). One code path, exercised constantly, not a special-case startup script.

> Venue reality: sequencing semantics differ per exchange (some give monotonic per-stream sequence numbers, some give per-event update IDs, some give only timestamps, some reset counters on reconnect). Encode each venue's guarantees behind an adapter interface.

---

## 3. The venue adapter interface

Fifteen venues means fifteen dialects. Quarantine the differences behind one normalized interface so the reducer, reconciler, and arbitrage engine never branch on venue.

```ts
interface VenueAccountAdapter {
  // --- Truth (slow path) ---
  fetchBalances(sub: SubAccountId): Promise<BalanceSnapshot>;
  fetchOpenOrders(sub: SubAccountId): Promise<OrderSnapshot[]>;
  fetchPositions(sub: SubAccountId): Promise<PositionSnapshot>;
  fetchOrderById(sub: SubAccountId, id: OrderRef): Promise<OrderSnapshot | null>;
  fetchUserTrades(sub: SubAccountId, since: Cursor): Promise<FillSnapshot[]>;

  // --- Stream (fast path) ---
  openUserStream(sub: SubAccountId): UserStream;          // emits normalized events
  // keepalive / listen-key / token refresh handled internally by the adapter

  // --- Intent (writes) ---
  placeOrder(req: NewOrderRequest): Promise<Ack>;          // idempotent on clientOrderId
  cancelOrder(ref: OrderRef): Promise<Ack>;
  amendOrder(ref: OrderRef, change: Amend): Promise<Ack>;

  // --- Metadata ---
  serverTime(): Promise<Millis>;
  capabilities(): VenueCapabilities;                        // sequencing guarantees, amend support, etc.
}
```

`VenueCapabilities` is load-bearing: it declares, per venue, whether streams carry sequence numbers, whether native amend exists (vs. cancel/replace), whether balances are pushed or poll-only, how subaccounts are addressed, and the funding schedule. The reconciler and order manager read capabilities to decide their behavior rather than hard-coding venue names.

Normalize **everything** at the adapter boundary: symbols, sides, order types, time-in-force, asset codes, and especially **numbers** (Section 11). The core engine speaks one vocabulary.

---

## 4. Stream lifecycle, gap detection, and self-healing

A user-data stream is a fragile, expiring, droppable resource. Operate it defensively.

**Liveness.** Track three independent timers per stream: last message received, last heartbeat/pong, and (where applicable) the listen-key / auth-token expiry. Any timer breach → treat the stream as dead → reconnect and **re-bootstrap** (Section 2). Don't trust a stream that has gone quiet just because the socket is technically open; idle ≠ alive.

**Gap detection.** For venues with sequence numbers, every event must advance the counter by exactly one (or match the venue's documented rule). A skip = a gap = you have lost at least one event = your view is now untrusted for that account → trigger a reconcile before trading resumes. For venues without sequence numbers, you cannot detect gaps from the stream alone, so the periodic reconcile (Section 8) is your *only* gap detector — tighten its cadence accordingly.

**Reconnect storms & rate limits.** Reconnects hit weight-limited REST endpoints (re-snapshot). Use jittered exponential backoff, a shared per-venue token-bucket limiter in front of *all* REST traffic, and coalesce: if three accounts on one venue all need re-snapshot, batch and pace them.

**The confidence flag.** Every account slice carries a state-machine status the engine must check before acting:

| Status        | Meaning                                          | Engine may trade? |
|---------------|--------------------------------------------------|-------------------|
| `LIVE`        | Stream healthy, last reconcile clean             | Yes               |
| `DEGRADED`    | Stream healthy but reconcile overdue/soft-drift  | Read-only / no new commits |
| `RECONCILING` | Re-snapshot in flight                             | No                |
| `STALE`       | Gap detected / stream dead, not yet healed        | No                |
| `HALTED`      | Unresolved hard divergence, manual gate           | No                |

The arbitrage gate reads this flag for *both* legs before committing. A leg whose account is not `LIVE` is not tradeable, full stop. This is cheaper than any clever recovery and it is the difference between a missed opportunity and an unhedged position.

---

## 5. Order lifecycle: idempotency, the state machine, and the cancel/fill race

This is where money is actually lost, so it gets the most care.

### 5.1 Client-order-ID discipline (the foundation of idempotency)

Every order you send carries a **deterministic, client-generated order ID** (`clientOrderId`). Rules:

- Generate it *before* the first send attempt and reuse it across every retry. A network timeout on `placeOrder` is **ambiguous** — the order may have landed. Retrying with the *same* `clientOrderId` makes the venue dedupe (most do; for those that don't, you must `fetchOrderById` by client id before retrying). Never retry a placement with a fresh id — that is how you get accidental doubles.
- Make it carry routing identity: encode `(strategy, leg, intent-uuid)` so that a fill arriving on a stream can be attributed to the exact arbitrage decision that created it, even after a restart.
- Persist the `clientOrderId` to the WAL **before** sending (Section 10). The invariant is: *no order exists on a venue that we have no local record of having attempted.* Write-ahead, then send.

### 5.2 The order state machine

Model orders as an explicit FSM with terminal states. Reject transitions that aren't in the table; an illegal transition is a signal of an out-of-order event or a bug, not something to silently absorb.

```
                    ┌──────────► REJECTED (terminal)
                    │
  NEW ─► PENDING ─► OPEN ─► PARTIALLY_FILLED ─► FILLED (terminal)
   │       (sent)    │            │
   │                 ├────────────┴──────► CANCELED (terminal)
   │                 └───────────────────► EXPIRED  (terminal)
   └─► PENDING_CANCEL / PENDING_AMEND (in-flight intent overlays)
```

Key properties:

- **Monotonic fill accounting.** Track cumulative filled quantity, not deltas, keyed by the venue's last-execution identifier. Streams deliver duplicate and out-of-order execution reports; you fold them by taking `max(cumulativeFilled)` and ignoring any report whose cumulative figure is ≤ what you already have. This makes fill handling idempotent and reorder-safe.
- **Per-fill ledger.** Each distinct `tradeId`/`execId` updates: filled qty, average fill price, fee paid (in the fee asset), and realized PnL contribution. Dedup on `execId`. The sum of fills must reconcile against the order's cumulative figure and against `fetchUserTrades`.
- **Terminal is terminal.** Once `FILLED`/`CANCELED`/`REJECTED`/`EXPIRED`, no further state events mutate it; late events are logged and dropped. But terminal state still participates in reconciliation until it ages out.

### 5.3 The cancel-to-fill race

The canonical HFT hazard: you send `cancel`, and a fill lands in the same instant. Four real outcomes:

1. Cancel wins, no fill. Order → `CANCELED`.
2. Fill wins fully. Order → `FILLED`; the cancel is rejected/no-op.
3. Partial fill, then cancel of the remainder. Order → `CANCELED` with non-zero filled qty — **you now hold/owe inventory** and the hedge leg must react.
4. Ambiguous: cancel ack and fill report arrive out of order across two transports.

Rules to survive it:

- **The cancel ack is not proof of zero fill.** Never release reserved capital or assume no inventory on a cancel ack alone. Only the *terminal order state with its final cumulative filled qty* settles inventory — and that figure can change between "cancel sent" and "cancel confirmed."
- **Reconcile the order, not just the request.** After any cancel/amend, the order's truth is its post-operation snapshot (`fetchOrderById`), not the ack of the operation. Treat outcome 3 as the default you must always handle: a "canceled" order can carry a fill.
- **Amend = cancel/replace semantics unless the venue guarantees atomic amend.** Where amend isn't atomic, model it as the two-step it actually is, with its own race window, and never assume the old order is gone until confirmed.
- **Fence with timestamps/sequence.** When a cancel-derived state and a fill-derived state disagree, the one with the later venue transaction-time/sequence wins; if you can't order them, force a `fetchOrderById` and let the venue arbitrate.

---

## 6. Balances and the reserved-capital ledger (double-spend prevention)

### 6.1 Model the venue's view faithfully

Per `(subaccount, asset, marketType)` track at minimum: `total`, `available`, `locked` (venue-reserved against resting orders), and per-market-type segregation (spot wallet vs. linear/USDⓈ-M vs. inverse/coin-M vs. unified margin, depending on venue account mode). Unified/portfolio-margin accounts collapse some of these — the adapter declares the account mode and the model follows it. Never sum across market types that the venue keeps separate, or you'll conjure "available" capital that can't actually be deployed on the leg you intend.

### 6.2 The reservation overlay (this is the double-spend fix)

The venue's `available` lags your decisions by a full round-trip: between "engine decides to use $X" and "venue locks $X on order placement," the venue still reports that $X as free. If two simultaneous arbitrage opportunities both read venue-`available`, they both commit the same capital. Hence a **local reservation ledger** sitting *above* venue truth:

```
deployable(asset) = venue.available(asset)
                  − Σ local_reservations(asset)        // intent not yet locked at venue
                  − safety_buffer(asset)               // fees, slippage, funding headroom
```

- Reserving is an **atomic, serialized** operation through the single-writer actor: the engine requests a reservation; the actor checks `deployable ≥ amount` and either grants a reservation token or denies. Because it's serialized per account, two opportunities cannot both win the same dollars.
- A reservation has a **lifecycle and a TTL.** It's created on intent, *converted* when the venue confirms the lock (order `OPEN` with `locked` reflecting it), and *released* on terminal order state, on explicit cancel-with-no-fill, or on TTL expiry (to recover from a placement whose fate we never learned — though TTL expiry must trigger a `fetchOrderById`, never a blind release).
- **Reconcile reservations too.** Periodically assert `Σ converted-reservations ≈ venue.locked`. Drift here means an order locked capital we didn't track, or vice versa — a red flag.

Cross-leg capital sharing means this ledger is *global per asset across the legs that draw on it*, not per-strategy. The arbitrage engine's two-leg commit (Section 9) reserves on both legs' assets up front and only fires when both reservations are granted.

---

## 7. Position state (perps)

Per `(subaccount, symbol)` for derivatives, maintain: signed `size`, `avgEntryPrice`, `realizedPnl`, `unrealizedPnl`, `leverage`, `marginMode` (cross/isolated), `liquidationPrice`, and `positionSide` for hedge-mode venues (long/short legs tracked separately).

Best practices:

- **Recompute, don't trust pushed PnL blindly.** Unrealized PnL is a function of `size`, `avgEntry`, and *current bid/ask orderbook price*. Recompute it locally from your own orderbook top-of-book bid/ask feed so it updates continuously between events, but reconcile your `size`/`avgEntry`/`realizedPnl` against the venue, since those are the figures that must match truth. Pushed uPnL is a sanity check, not an input.
- **Average entry is fill-derived and venue-confirmed.** Update `avgEntry` from fills locally for immediacy, but treat the venue's reported `avgEntry` as authoritative on reconcile — venues differ on fee-inclusion and rounding, and small errors compound across many fills.
- **Liquidation distance is a first-class safety signal**, not a display field. Recompute locally from margin and orderbook top-of-book bid/ask feed; surface it to the risk gate. Cross-margin means a position's liq distance depends on the *whole* account's equity, so it cannot be computed per-symbol in isolation under cross margin.
- **Position and balance must be reconciled jointly** on derivatives venues: margin moves between them. A position-only or balance-only snapshot can be internally inconsistent at the instant you read it; prefer atomic/near-simultaneous snapshots and tolerate small read-skew with bands, not exact equality.

---

## 8. The reconciliation engine

This is the component that earns the word "reliable."

### 8.1 Cadence

Run reconciliation on three triggers:

1. **Periodic**, per account, at a cadence set by venue weight limits and stream trust — tighter for sequence-less venues, looser for venues with reliable sequenced streams. Stagger across accounts so you don't burst REST weight.
2. **Event-driven**, immediately after any gap, reconnect, ambiguous ack, or illegal FSM transition.

### 8.2 What to diff, and tolerance

Diff local vs. fresh REST snapshot across all five domains: open-order set (by `clientOrderId`), fills/trades, per-asset balances, positions, and the reservation/locked relationship. Classify every difference:

- **Exact-match domains** (order existence, order terminal state, position side): zero tolerance. A mismatch is a hard event.
- **Banded domains** (balances, PnL, avg entry): allow a small tolerance band for read-skew, fee-rounding, and in-flight settlement. Outside the band → drift.

### 8.3 Drift response ladder

| Severity | Example | Action |
|----------|---------|--------|
| Soft     | Balance off by < band; explained by an in-flight fill | Auto-correct local to venue truth; log; stay `LIVE` |
| Medium   | Unknown resting order on venue we don't track; missing fill | Adopt venue truth, set `DEGRADED`, force full re-snapshot + user-trades backfill, alert |
| Hard     | Position size disagrees; order we think is `FILLED` is `OPEN`; locked ≫ reservations | `HALTED`, cancel-all on that account, exit this individual position(if safe), page a human |

**Adopt-venue-truth is the default heal.** The venue wins every disagreement; local state is overwritten to match. The only question is whether the *cause* of the divergence is benign enough to keep trading. When in doubt, halt — an idle account costs opportunity; a wrong account costs principal.

### 8.4 Don't reconcile yourself into a race

A naive reconcile reads a REST snapshot and overwrites local — but stream events that arrived *during* the REST round-trip would be clobbered. Use the same buffer-and-merge discipline as bootstrap (Section 2): buffer stream events during the reconcile fetch, apply the snapshot, then replay the buffered events that postdate the snapshot marker.

---

## 9. Capital allocation across legs (the arbitrage gate)

The state layer's whole purpose is to let the engine answer "can I safely commit both legs of this spread right now?" The gate:

1. Both legs' accounts must be `LIVE`.
2. **Atomically reserve** required capital on both legs' assets via the single-writer reservation path. Reserve on *both* before sending *either*. If either reservation is denied, abort and release.
3. Send both placements with deterministic `clientOrderId`s, write-ahead-logged first.
4. On acks, convert reservations to venue-locked; on fills, fold inventory; on any leg failing to place/fill, enter the **unwind path** — the most dangerous state in arbitrage is one leg on, one leg off.

The unhedged-leg problem deserves explicit machinery, not ad-hoc handling: a leg that fills while its partner is rejected/unfilled creates directional exposure. The state layer must surface "leg imbalance" as a top-priority signal the moment a fill lands without its counterpart, so the hedger can chase or flatten. This is why fill attribution via `clientOrderId` (Section 5.1) matters: you must instantly know *which spread* a fill belongs to.

---

## 10. Persistence and restart recovery

Local state must survive process death without lying after it.

### 10.1 Storage model: snapshot + write-ahead log

Use an append-only **WAL of commands/events** plus periodic **state snapshots**. On Node/single-host, the pragmatic stack is an embedded store (SQLite via `better-sqlite3` for synchronous, transactional, crash-safe writes is the strong default; LMDB is an alternative for very high write rates). Reserve a full client/server DB only if you outgrow single-host. The non-negotiables:

- **Write-ahead, then act.** Persist intent (a placement's `clientOrderId`, a reservation) *before* the side-effecting network call. After a crash, you can always ask the venue "did this happen?" because you recorded that you were about to try.
- **Atomic, fsync'd writes** for anything on the order/reservation path. `better-sqlite3` in WAL journal mode with appropriate synchronous settings gives you transactional, durable writes synchronously, sidestepping a class of async-ordering bugs.
- **Snapshots are a compaction optimization**, not the source of recovery truth (the venue is).

### 10.2 The recovery sequence (the part people get wrong)

On restart, **never trust local persisted state as current.** It tells you what you *intended* and last *knew*, which is exactly what you need to ask the venue the right questions — but it is by definition stale. So:

1. Load the last snapshot + replay WAL to reconstruct *intended* state, including in-flight orders and live reservations.
2. For every in-flight/ambiguous order in that reconstructed state, `fetchOrderById` to learn its real fate. Resolve placements whose acks we never saw.
3. Run a **full reconcile** (Section 8) against fresh REST snapshots for every account — open orders, balances, positions — and adopt venue truth.
4. Backfill `fetchUserTrades` since the last persisted cursor to catch fills that occurred while the process was down.
5. Only then mark accounts `LIVE`. Until that completes, the engine stays gated.

The invariant: **a restart always re-derives truth from the venue; persistence only ensures we ask the right questions and never lose track of an order we attempted.**

---

## 11. Node.js / TypeScript specifics

- **Never represent money as a JS `number`.** IEEE-754 floats will silently corrupt balances and fill math. Use integer minor units where possible, or a decimal library (`decimal.js` / `big.js`), applied uniformly at the adapter boundary. Carry the venue's tick/lot/precision (`symbolRules`) and round *deliberately* (and in the venue's direction) before sending — never let float drift produce a rejected order or an off-by-a-satoshi reconcile alarm.
- **Protect the event loop.** State is owned by single-writer async loops; any CPU-heavy work (large reconcile diffs across many accounts, crypto signing under load, JSON parse of huge snapshots) that risks blocking goes to **worker threads**. A blocked loop = delayed event processing = a stream that looks alive but is falling behind = silent staleness. Monitor event-loop lag as a first-class health metric.
- **Backpressure on streams.** During reconnect storms or fill bursts, the inbound event rate can exceed processing. Bound your per-actor queue; if it saturates, that's a `DEGRADED`/`STALE` signal, not something to buffer unboundedly into a memory blowup.
- **One shared rate limiter per venue**, spanning all subaccounts and all REST callers (snapshots, reconciles, order ops, recovery). Weight-aware token bucket. Recovery and reconciliation must not starve order placement, and vice versa — prioritize within the limiter.
- **Time discipline.** Use venue server time for signing/`recvWindow` and for ordering events; track local-vs-server clock skew and alert on drift. Don't order venue events by local arrival time when a venue transaction-time or sequence exists.
- **Typed, exhaustive state machines.** Use discriminated unions for order/account status and `never`-checked exhaustive switches so an unhandled transition is a compile error, not a runtime surprise. The FSM tables in Sections 4–5 should be code the type system enforces.

---

## 6. Venue-specific gotchas (representative — *re-verify against live docs*)

These illustrate the *categories* of divergence your adapter layer must absorb. The detail churns; the categories don't.

### Binance
- **Separate streams per product.** Spot, USD-M futures, COIN-M futures each have their own user data stream and lifecycle. Don't assume one connection covers an account.
- **Event shapes differ by product.** Spot: `executionReport` (orders), `outboundAccountPosition`/`balanceUpdate` (balances). Futures: `ORDER_TRADE_UPDATE` (orders), `ACCOUNT_UPDATE` (balances+positions, push-on-change). Your canonical schema must unify these.
- **Ordering:** futures events carry `T` (matching-engine transaction time) and `E` (event-generation time); same-type events on one connection are ordered by both, and Binance recommends using **`E` for cross-stream ordering**. There is no single global monotonic sequence across the user stream — reconcile, don't assume.

### Bybit (v5)
- **Unified Trading Account (UTA)** merges spot + derivatives margin into a shared pool — **a major balance-model implication:** "available balance" is margin-aware and shared across instruments, so your reservation ledger (§4) must be margin-aware, not per-asset-cash. Account types (UTA vs classic, and UTA margin modes) change the math.
- Private WS requires a **signed auth** frame; topics: `order`, `execution`, `position`, `wallet`. **Keepalive: send a ping (~every 20 s)** or the connection drops.
- Watch `execution`/`order` ordering and the creation/update timestamps for sequencing.

### OKX
- Private WS requires a **login** message; channels include `account`, `positions`, `orders`, and notably **`balance_and_position`** — a *combined* channel that pushes balance and position changes atomically, which is exactly what you want for cross-consistency (use it).
- **Keepalive: send a `ping` (text frame) within the idle window (~30 s)** or you're disconnected.
- **Account modes** (Simple / Single-currency margin / Multi-currency margin / Portfolio margin) **drastically change** balance and margin semantics — your reconciliation must know the account's mode.

### Bitget / others
- V2 APIs, WS **login** + keepalive ping, channels analogous to the above. Each venue has its own subaccount model, fee currency conventions, and amend semantics. The point: **encode each venue's auth/keepalive/sequencing/mode rules in its adapter, validated by schema, and never let those leak into core logic.**

### Cross-cutting venue hazards
- **Many private streams give no usable sequence number** → you *cannot* detect gaps from the stream alone → **periodic REST snapshots are your gap detector**, not a luxury.
- **Snapshot endpoints can lag the stream** (eventual consistency) → reconcile with timestamp tie-breaking and tolerance.
- **Rate limits** (often weight-based) constrain how aggressively you can snapshot → budget per venue, back off, prioritize critical scopes.
- **Clock skew** between venue and host → use venue timestamps for cross-event ordering; use local monotonic clock (`process.hrtime.bigint()`) only for latency measurement.
- **Duplicate delivery on reconnect** → idempotency required (§2.3).

---


## 7. Funding and fees (don't let these silently corrupt PnL/capital)

- **Funding intervals vary** (commonly 8h, but per-symbol 4h or 1h exist, and conventions differ by venue). **Predicted funding** is available via WS/REST and feeds capital-at-risk and arb-edge decisions; **settled funding** changes realized balance at the funding timestamp. Model accrual locally for *decisions*, but **settle against the venue** — never book funding you only predicted.
- **Fees:** maker vs taker, tiered by volume, and the **fee currency varies** (quote, base, or a discount token like BNB). Reconcile **actual fees from fill/execution reports** — estimate-and-forget understates capital consumption and quietly inflates deployable balance over time.
- **Both funding and fees feed the reservation safety buffer (§4)** — under-accounting for them is a slow-leak path to over-commitment.

---


## 12. Observability, invariants, and the kill switch

Reliability you can't see isn't reliability.

**Runtime invariants** (assert continuously; violation → alert + `HALTED`):

- `available + locked == total` per asset (within band).
- `Σ converted-reservations ≈ venue.locked` per asset.
- `Σ per-fill qty == order.cumulativeFilled` per order.
- No order in a non-terminal state past its max age without a reconcile touch.
- No account in `LIVE` with an overdue reconcile.
- Σ position margin + free ≈ account equity (derivatives).

**Metrics to dashboard:** time-since-last-reconcile per account, reconcile drift magnitude per domain, stream gap count, event-loop lag, REST weight headroom per venue, reservation-vs-locked delta, open leg-imbalance count, age of oldest in-flight order.

**Alerting tiers** map to the drift ladder: soft auto-heals are logged; medium drift pages low; hard divergence pages high and auto-halts the affected account.

**The kill-switch ladder** — graduated, not binary:

1. Per-account `DEGRADED` → no new commits, finish/unwind existing.
2. Per-account `HALTED` → cancel-all on that account (when the account state is trustworthy enough to cancel safely), no trading.
3. Global halt → stop all new commits across all venues, attempt orderly flatten, page.

Make halting *cheap and frequent*. A system that halts ten times a day on conservative triggers and never trades on a wrong view beats one that halts rarely and occasionally over-commits real capital.

---

## 13. Testing and chaos

Determinism (Section 1.1) exists so you can test this hard:

- **Replay harness.** Record real stream + REST traffic per venue; replay it through the reducer and assert the resulting state matches an independently computed expected state. Reducers being pure makes this exact.
- **Fault injection.** Drop events, reorder them, duplicate them, kill streams mid-burst, delay acks past timeout, return stale REST snapshots, inject clock skew. Assert the system detects divergence and heals or halts — never proceeds wrongly.
- **The cancel/fill race as a fixture.** Generate all four outcomes from Section 5.3 deterministically and assert inventory/reservation correctness on each.
- **Crash/restart tests.** Kill the process at every interesting point (after WAL write but before send; after send but before ack; mid-reconcile) and assert recovery converges to venue truth.
- **Property tests on invariants.** The Section 12 invariants become properties checked across randomized event sequences.
- **Reconciliation as a continuous integration check**, and a shadow/read-only mode against production where the state layer runs live, reconciles, and alerts on drift *without* trading — run this before ever letting the engine commit capital.

## 8. Testing the part that actually breaks — *strongly recommended*

Reconciliation bugs hide until a bad market moment, so test the failure modes directly:

- **Deterministic replay** of recorded real venue streams (record raw payloads in prod; replay through the adapter+reconciler).
- **Chaos injection:** drop messages, delay/lose acks, duplicate events, reorder within a stream, inject snapshot-lags-stream, kill the process mid-send. Assert state converges to venue truth and invariants never break.
- **Property-based testing** (`fast-check`): for any interleaving of valid events, invariants hold (available ≥ 0, locked == Σ open-order locks, reserved releases on terminal states, no double-spend).
- **The cancel/fill race** deserves dedicated tests — it's the most likely source of an unhedged leg.

---

## 9. Assumptions, and where they'd change the advice

**One input that would sharpen this further:** the **margin-mode mix across your 15 venues** (how many are cross-margin / UTA / portfolio-margin vs. simple per-asset spot). That materially changes the reservation ledger from "per-asset cash" to "margin-aware shared pool," which is a meaningfully different (and harder) design.

---

## 14. Anti-patterns to refuse

- Trusting the stream as the source of truth and reconciling "occasionally." (Reconciliation is the spine.)
- Releasing reserved capital or assuming flat inventory on a *cancel ack*. (Only terminal order state with final fill qty settles inventory.)
- Floats for money. Anywhere. Ever.
- Retrying ambiguous placements with a fresh order id. (Deterministic `clientOrderId` + dedupe/`fetchOrderById`.)
- Summing balances across market types the venue segregates.
- Treating restart-loaded local state as current without venue re-derivation.
- Per-strategy capital views when capital is shared across legs. (Global per-asset reservation ledger.)
- A single global rate limiter ignored by the recovery path, so a reconnect storm gets you REST-banned exactly when you most need truth.
- Reconciling without buffering concurrent stream events (clobbering the fast path with a stale snapshot).
- Computing cross-margin liquidation per-symbol in isolation.

---

## 15. Recommended build sequence

1. **Numbers + symbol rules + venue adapter interface** with normalized types. Get money math right before anything touches it.
2. **Single-writer actor + deterministic reducer + WAL/snapshot persistence.** Prove replay and crash recovery on synthetic data.
3. **Bootstrap (snapshot-then-stream) + stream lifecycle + gap detection** for one venue end to end.
4. **Order FSM + clientOrderId idempotency + cancel/fill race handling.**
5. **Reservation ledger + balance/position model + double-spend gate.**
6. **Reconciliation engine + drift ladder + invariants + kill switch.**
7. **Shadow mode** (live state, no trading) against production for every venue; tune bands and cadence on real drift before enabling commits.
8. Roll out venues behind the capability flags; the core never learns their names.

---

### Closing principle

The arbitrage edge is real but thin; a single over-committed or unhedged leg can erase a week of it. The account-state layer is not plumbing under the strategy — it *is* the risk system. Build it so that its strong bias, under any uncertainty, is to **stop and re-derive truth from the venue**, loudly, rather than to keep trading on a view it cannot vouch for.