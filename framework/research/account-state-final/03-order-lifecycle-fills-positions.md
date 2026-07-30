# 03 — Order Lifecycle, Fills & Positions

**Scope:** `clientOrderId` discipline, the canonical order FSM (states, transition tables, races, amend), the `UNKNOWN`/in-doubt Resolver, idempotency and exactly-once application, the fill/trade lifecycle, and position/PnL/liquidation tracking. Cross-references: canonical events/aggregates → `01 §7`, transports/ack semantics → `02`, capital reservations → `04`, reconciliation/invariants → `05`, persistence write-order → `06`, master failure catalog → `07 §3`.

This is where money is actually lost, so it gets the most care.

---

## 1. `clientOrderId` discipline (the foundation of idempotency)

Every order carries a **deterministic, client-generated order ID** (`clientOrderId`, "coid"). Rules:

- **Deterministic, unique, never reused, decodable.** Recommended scheme:
  ```
  clientOrderId = `${envTag}${strategyId}-${accountShard}-${monotonicSeq}`   # ≤ venue maxLen
  ```
  The **monotonic seq** comes from a persisted counter (survives restart; never resets backward). Pre-allocate ranges so a crash mid-batch can't reissue an id; on boot, if the counter is not strictly increasing, **refuse to start trading** and rebuild it from `log max + gap`. On collision, abort the send — never reuse a coid.
- **Generated before the first send attempt and reused across every retry.** A network timeout on `placeOrder` is **ambiguous** — the order may have landed. Retrying with the *same* `clientOrderId` makes the venue dedupe (most do; for those that don't, you must query by client id before retrying). **Never retry a placement with a fresh id — that is how you get accidental doubles.**
- **Persisted to the WAL before sending** (the `INTENT` rule, → `06 §3`). The invariant: *no order exists on a venue that we have no local record of having attempted.* Write-ahead, then send. The coid is the join key that lets you, after a crash, ask the venue *"did order `coid` land?"* via `fetchOrderByClientId`. Without it, an order whose ack you lost is **unidentifiable** → unhedged-leg risk → forced halt. This single discipline is the difference between graceful recovery and a manual money-hunt.
- **Carries routing identity:** encode `(strategy, leg, intent)` so a fill arriving on any stream can be attributed to the exact arbitrage decision that created it, even after a restart — a bare coid in a venue message is self-describing during reconciliation. (Leg attribution is what makes the unhedged-leg signal instant, → `04 §3.3`.)
- **Length/charset clamped per venue** (adapters validate). Some venues mutate or reject ids — the adapter normalizes and stores both ours and the venue's (`venueOrderId ↔ clientOrderId` binding, which may arrive late).
- Hot-path generation: atomic counter + epoch prefix, pre-encoded ASCII, pre-generated rings — no UUIDs at fire time (→ `02 §11`).

**The `clientOrderId` is your idempotency key and your only truth across transports.**

---

## 2. The canonical order FSM

The FSM is **venue-agnostic**; adapters map venue event vocabularies onto these canonical states/triggers. Each state is classified by **kind**: `pre-flight`, `in-flight` (a request is outstanding, capital committed, outcome unknown), `resting` (venue holds it; can still fill/cancel), `terminal` (no further transitions for this coid), or `quarantine` (state unproven; nothing derived from it may be trusted until resolved).

### 2.1 State catalogue

| # | State | Kind | Meaning | Key invariants | On-entry action | On-exit action |
|---|---|---|---|---|---|---|
| 1 | `INTENT` | pre-flight | Strategy decided; coid minted; capital reservation granted; **persisted before any network I/O** | reservation exists; `venueOrderId=null`; `cumFilled=0` | append `OrderIntent`; reserve capital | — |
| 2 | `PENDING_NEW` | in-flight | Placement request dispatched, no ack | reservation held; `sentAt` set; idempotency key = coid | append `OrderSubmitted`; **arm submit-timeout** | clear submit-timeout |
| 3 | `ACKED_UNCONFIRMED` | in-flight | Transport ack received, but venue ack ≠ live (Bybit/OKX-class venues ack the *request*, then may reject asynchronously post-risk-check) | timeout armed; escalates to query | arm confirm-timeout | clear confirm-timeout |
| 4 | `LIVE` | resting | Venue confirmed resting on book, `cumFilled=0` | `venueOrderId` known; `leftover=qty` | append `OrderAcked`; register in open-orders index | deregister from open-orders index |
| 5 | `PARTIALLY_FILLED` | resting | Live, `0 < cumFilled < qty` | `leftover>0`; each fill applied once | append `OrderPartiallyFilled`; update position/fees | — |
| 6 | `PENDING_AMEND` | in-flight | Amend/replace dispatched, no ack | pre-amend snapshot retained for rollback; reservation delta held | append `OrderAmendSubmitted`; **arm amend-timeout** | clear amend-timeout |
| 7 | `PENDING_CANCEL` | in-flight | Cancel dispatched, no ack | cancel may *lose a race* to a fill | append `OrderCancelSubmitted`; **arm cancel-timeout** | clear cancel-timeout |
| 8 | `FILLED` | terminal | `cumFilled == qty` | reservation fully consumed→released; position updated | append `OrderFilled`; finalize reservation | — |
| 9 | `CANCELED` | terminal | Venue confirmed cancel; leftover released | leftover reservation released; partial fills already applied | append `OrderCanceled`; release leftover reservation | — |
| 10 | `REJECTED` | terminal | Venue refused placement/amend | no fills; reservation released; reason captured | append `OrderRejected`; release reservation; raise typed error | — |
| 11 | `EXPIRED` | terminal | TIF expiry / IOC-FOK unfilled remainder / session expiry | leftover released; any fills applied | append `OrderExpired`; release leftover reservation | — |
| 12 | `UNKNOWN` | quarantine | Ack lost / timeout / conflicting evidence; true state unproven | **no derived state may be trusted**; capital stays reserved (pessimistic) | append `OrderUnknown{cause}`; enqueue to **Resolver**; raise alert | append `OrderResolved{to,evidence}` |

**Source-terminology mapping** (the merged FSM unifies several vocabularies): `INTENT` ≈ `INTENT`+`RESERVED`/`CREATED`; `PENDING_NEW` ≈ `SENT`/`SENDING`/`PENDING`; `LIVE` ≈ `OPEN`/`NEW`; `UNKNOWN` ≈ `IN_DOUBT`/quarantine. `ACKED_UNCONFIRMED` is **only** instantiated for venues whose ack semantics require it (declared in `VenueCapabilities`); on venues where the ack is authoritative admission, `PENDING_NEW → LIVE` is direct.

**Design choices worth defending:**

- `INTENT` is a real, *persisted* state, not an in-memory nicety. Persisting the coid **before** the network call is what makes lost-ack recovery possible.
- `UNKNOWN` exists deliberately. Most naive implementations collapse "timeout" into "failed" — **the single most dangerous bug in order management**, because a "failed" placement may actually be resting and filling. `UNKNOWN` is pessimistic: capital stays locked and the order is non-tradable-around until resolved.
- **Ack ≠ accepted ≠ live.** Acks arrive on the request/response channel; fills and terminal states arrive on the private execution-report stream. Treat the exec stream as authoritative for *economic* events (fills) and order status, the ack channel as authoritative for *admission* (accepted/rejected) — and build the FSM to accept events from either **in any order** (fills frequently arrive before the place-ack on fast venues). The ack only releases your in-flight token; the distinct `ACKED_UNCONFIRMED` state carries a timeout that escalates to query.
- Amend is modeled as cancel-replace semantics with explicit successor linkage, because most venues do not give true in-place amend with stable identity.
- **Terminal is terminal.** Once terminal, no further state events mutate the order; late events are logged and dropped (absorbed for data, ignored for transition — e.g., a stale `NEW` after `FILLED` does not reopen the order, but its `updateTime` is reconciled). Terminal orders still participate in reconciliation until they age out. Monotonic guards: `cumExecQty` non-decreasing, `leavesQty` non-increasing; never resurrect a terminal order.
- **In-flight registry with deadlines:** every `PENDING_*`/`ACKED_UNCONFIRMED` entry carries a timeout (per-venue adaptive — e.g., p99.9 ack latency × 3). Expiry ⇒ `UNKNOWN` ⇒ Resolver. Also: *any* non-terminal order older than `maxAge` without a venue confirmation/reconcile touch is forced to `UNKNOWN` and queried.

### 2.2 Where the FSM lives and how transitions are driven

The FSM lives in the per-account actor (inside the venue worker) as the `OrderAggregate`. Implement it **explicitly** — a typed, *pure* transition function `transition(state, event): {next, effects[]}` with no I/O; sends, persists, and timers are returned as **effects** executed by the actor runtime. This makes the FSM unit-testable against fuzzed event orderings and replayable. Tooling: XState v5 (hierarchical states, guards, timeouts, serializes well) or a hand-rolled discriminated-union reducer with exhaustive `never`-checked switches.

**Triggers come from exactly four sources**, all normalized to canonical events: (1) the command pipeline (intent/submit/cancel/amend requests), (2) the WS user-data stream, (3) REST query/snapshot (Resolver + Reconciler), (4) local timers (submit/cancel/amend timeouts, heartbeat). **No other source may move an order.** A single writer (the gateway/actor lane) owns all transitions for its orders; strategy reads state, never mutates.

### 2.3 Transition tables

#### Placement path

| From → To | Trigger | Guard | Action | Recovery on failure |
|---|---|---|---|---|
| `∅ → INTENT` | Strategy emits order request | Capital allocator grants reservation; risk gate passes; symbol tradable | Mint deterministic coid; persist `OrderIntent` (durable) | If persist fails → abort, release reservation, surface error. *Never send if intent isn't durable.* |
| `INTENT → PENDING_NEW` | Intent persisted | Durable log fsync'd; rate-limit token available | Send placement with coid; arm submit-timeout (e.g., p99×k) | Send throws *synchronously* (4xx validation) → `REJECTED`. Send throws *transport* (ECONNRESET/timeout) → `UNKNOWN` (could have landed). |
| `PENDING_NEW → ACKED_UNCONFIRMED` | Transport/request ack (venues where ack ≠ live) | request accepted | arm confirm-timeout; await order-stream confirmation | confirm-timeout → `UNKNOWN` |
| `PENDING_NEW`/`ACKED_UNCONFIRMED` `→ LIVE` | Ack/stream: order accepted, `executedQty=0` | coid matches; `venueOrderId` present | Bind `venueOrderId↔coid`; index as open | — |
| `PENDING_NEW → PARTIALLY_FILLED` | Ack already carries fills, or first fill arrives before/with ack | fill `tradeId` unseen; cum ≤ qty | Apply fill(s) idempotently | Out-of-order fill before ack: **buffer keyed by coid (orphan-fill buffer)**, apply on bind |
| `PENDING_NEW → FILLED` | Ack/fills sum to full qty (marketable/IOC fully filled) | cum == qty | Apply fills; finalize | — |
| `PENDING_NEW → REJECTED` | Venue rejects (insufficient balance, bad params, post-only would cross, dup-coid pointing at *different* params) | reason is authoritative | Release reservation; classify reason (retryable vs fatal, → `07 §2`) | Insufficient-balance reject also signals capital-model drift → reconcile balances (we thought we had it) |
| `PENDING_NEW → EXPIRED` | IOC/FOK with no/partial fill, remainder killed | TIF semantics | Apply any fills; release leftover | — |
| `PENDING_NEW → UNKNOWN` | submit-timeout fires **or** transport error | no terminal/ack received | Enqueue Resolver: **query by coid** | see §5 |

#### Fill path (resting)

| From → To | Trigger | Guard | Action |
|---|---|---|---|
| `LIVE → PARTIALLY_FILLED` | Fill event, leftover remains | `tradeId` unseen; cum<qty after apply | Apply fill once: update cumFilled, avgPx, position, fee accrual; shrink reservation by filled notional |
| `LIVE → FILLED` | Fill event consumes full qty | cum==qty | Apply; finalize reservation; remove from open index |
| `PARTIALLY_FILLED → PARTIALLY_FILLED` | Another fill, leftover remains | `tradeId` unseen | Apply once |
| `PARTIALLY_FILLED → FILLED` | Final fill | cum==qty | Apply; finalize |
| `LIVE/PARTIAL → EXPIRED` | GTT/session expiry | venue expiry event | Apply nothing new; release leftover |

#### Cancel path

| From → To | Trigger | Guard | Action | Recovery on failure |
|---|---|---|---|---|
| `LIVE/PARTIALLY_FILLED → PENDING_CANCEL` | Strategy/risk requests cancel | order resting; not already pending-cancel | Send cancel by coid (preferred) or `venueOrderId`; arm cancel-timeout | Send transport error → stay logically resting but mark cancel `UNKNOWN`; Resolver re-queries. Cancel is idempotent — re-send is safe (§5.4) |
| `PENDING_CANCEL → CANCELED` | Cancel ack | leftover>0 at cancel time | Release leftover reservation | — |
| `PENDING_CANCEL → FILLED` | **Cancel lost the race**: order filled before cancel landed | cum==qty | Apply final fill; cancel becomes a no-op | *Expected*, not an error. The fill wins. |
| `PENDING_CANCEL → PARTIALLY_FILLED` (→ then `CANCELED`) | Fill landed, then cancel acked for the remainder | partial applied, leftover canceled | Apply fill, then release remaining leftover | — |
| `PENDING_CANCEL → REJECTED(cancel)` | Venue: "unknown order / already gone" | order already terminal at venue | Resolve true terminal via query, reconcile state | "Order not found" is *evidence it's already terminal* → query to learn **which** terminal |
| `PENDING_CANCEL → UNKNOWN` | cancel-timeout, no ack | — | Resolver queries order status | see §5 |

#### Amend / cancel-replace path

| From → To | Trigger | Guard | Action | Recovery on failure |
|---|---|---|---|---|
| `LIVE/PARTIALLY_FILLED → PENDING_AMEND` | Strategy requests price/qty amend | new params valid; new qty ≥ cumFilled; reservation delta reservable | Snapshot pre-amend order for rollback; reserve any *increase* in notional up front; send amend / cancel-replace; arm amend-timeout | If reservation of the increase fails → reject amend locally, stay resting unchanged |
| `PENDING_AMEND → LIVE/PARTIALLY_FILLED` (amended) | Amend ack (atomic-amend venue: same id) | `cumFilled` preserved; new qty/px applied | Apply new params; settle reservation delta (release if qty decreased) | — |
| `PENDING_AMEND → (old CANCELED + new LIVE)` | Cancel-replace venue: old killed, **successor** with new coid acked | successor linked to predecessor | Mark predecessor `CANCELED`; create successor `LIVE`, carrying forward filled context | If successor placement fails after old canceled → predecessor `CANCELED`, successor `REJECTED`/`UNKNOWN`; strategy notified leftover is *unworked* |
| `PENDING_AMEND → PARTIALLY_FILLED/FILLED` | **Amend lost the race**: filled before amend landed | cum advanced | Apply fill; amend is no-op or rejected | Expected race; fill wins |
| `PENDING_AMEND → REJECTED(amend)` | Venue rejects amend (would-cross post-only, qty<filled) | — | Roll back to pre-amend snapshot; release any reserved increase | Order remains as it was pre-amend (still resting) |
| `PENDING_AMEND → UNKNOWN` | amend-timeout / transport error | — | **Critical**: amend ambiguity can leave the order at old *or* new params *or* canceled. Resolver must query and reconcile, holding the **max of old/new reservations** until resolved | see §5 |

**Amend rule:** treat amend as cancel/replace semantics unless the venue guarantees atomic amend. Where it isn't atomic, model it as the two-step it actually is, with its own race window, and never assume the old order is gone until confirmed.

Illegal transitions are **rejected, logged, and flagged** — an illegal transition signals an out-of-order event or a bug, never something to silently absorb; it triggers a targeted re-fetch of that order to confirm truth, and is itself a gap detector (→ `02 §8.1`).

---

## 3. Monotonic fill accounting (reorder/duplicate safety)

- Track **cumulative filled quantity**, not deltas, keyed by the venue's last-execution identifier. Streams deliver duplicate and out-of-order execution reports; fold them by taking `max(cumulativeFilled)` and ignoring any report whose cumulative figure ≤ what you already hold. This makes fill handling idempotent and reorder-safe.
- Alongside the cumulative figure, keep the **per-fill ledger**: each distinct `tradeId`/`execId` updates filled qty, average fill price, fee paid (in its fee asset), and realized-PnL contribution, dedup'd on execId. The sum of fills must reconcile against the order's cumulative figure and against `fetchUserTrades` (invariant `cumFilled = Σ applied fills`, → `05 §8`).
- Apply a fill only if `execId` unseen *and* the resulting `cumExecQty` is consistent (`cumFilled ≤ orderQty`); reject/buffer otherwise and reconcile the order (likely a duplicate or wrong mapping).

---

## 4. The cancel-to-fill race (canonical HFT hazard)

You send `cancel`, and a fill lands in the same instant. Four real outcomes:

1. Cancel wins, no fill. Order → `CANCELED`.
2. Fill wins fully. Order → `FILLED`; the cancel is rejected/no-op.
3. Partial fill, then cancel of the remainder. Order → `CANCELED` **with non-zero filled qty** — you now hold/owe inventory and the hedge leg must react.
4. Ambiguous: cancel ack and fill report arrive out of order across two transports.

Rules to survive it:

- **The cancel ack is not proof of zero fill.** Never release reserved capital or assume no inventory on a cancel ack alone. Only the *terminal order state with its final cumulative filled qty* settles inventory — and that figure can change between "cancel sent" and "cancel confirmed."
- **Reconcile the order, not just the request.** After any cancel/amend, the order's truth is its post-operation snapshot (`fetchOrderByClientId`), not the ack of the operation. Treat outcome 3 as the default you must always handle: a "canceled" order can carry a fill.
- **Fence with venue sequence/transaction time.** When a cancel-derived state and a fill-derived state disagree, the one with the later venue transaction-time/sequence wins; if you can't order them, force a query and let the venue arbitrate.
- This race deserves a dedicated, deterministic test fixture covering all four outcomes (→ `08 §3`).

---

## 5. The Resolver — `UNKNOWN`/in-doubt resolution

Any path into `UNKNOWN` enqueues the order to the Resolver — the component that converts ambiguity into fact using the venue as truth. The dangerous window: you wrote an order frame, then the connection died (or the ack timed out). TCP write success means nothing about venue receipt.

```
Resolver(order):
  for attempt in backoff(50ms → 5s, jitter):
     r = REST query order status by clientOrderId   # primary
     if r found:
        feed canonical event (Acked/Partial/Filled/Canceled/Rejected/Expired) → transition
        return  # UNKNOWN resolved
     else "not found":
        # ambiguous: either never landed, or landed + already purged from active set
        r2 = REST query *recent orders* + *recent trades* by clientOrderId / time window
        if any fill/trade references this clientOrderId → reconstruct fills → resolve
        elif order absent from open AND no fills AND within venue's "definitely-would-show" window:
             → treat as NEVER PLACED → REJECTED(synthetic, "no venue record") → release reservation
        else keep polling (still ambiguous)
  on exhaustion: escalate → halt new orders for this account, page human, keep reservation locked
```

### 5.1 Key rules

- **Never blind-resend; never resolve from the WS stream alone.** WS can be exactly the thing that dropped the message. Resolution requires an *authoritative pull* (REST — the independent warm path), or WS evidence *corroborated* by a subsequent snapshot.
- **Pessimistic capital:** while `UNKNOWN`, the reservation stays (for an ambiguous amend, the **max** of old/new reservations). You'd rather under-trade than double-spend.
- **"Order not found" is not "order never existed."** Venues are eventually consistent between trade gateway and query endpoints: a fully-filled-and-purged order also reads as "not in open orders," and an order can be "missing" via REST that the stream already confirmed (and vice versa). Treat not-found as *still-in-doubt* for a venue-tuned grace window (typically 500 ms–2 s), re-query, and disambiguate against the trades endpoint and a time window.
- **Declaring dead requires evidence convergence:** not-found *and* venue confirms "unknown order" *and* the connection has been continuously healthy since send → safe to mark dead. Not-found amid connection trouble → assume it may yet exist; re-query until venue time passes the order's `recvWindow`/expiry, then mark dead. Require **two consistent sources** (stream + REST snapshot) before declaring an in-doubt order dead.
- **Retry only after a verified-absent verdict — with the same coid.** Because the coid is deterministic, even if the original *did* land, a duplicate send with the same id is rejected by the venue as a dup (your confirmation) or is a no-op — you cannot accidentally place twice. **Placement is idempotent by construction.** Backoff is never applied to a placement retry until the prior attempt's outcome is *known*.
- A spike in unresolved `UNKNOWN`s trips the pending-unknown breaker — above threshold the scope goes HARD-halted, because **we do not know our exposure** (→ `07 §4`).

### 5.2 Server-side 5xx is in-doubt, not failure

Binance is explicit that 5xx must **not** be treated as a failed operation: execution status is UNKNOWN and could have been a success. In-doubt always resolves through the query-by-coid protocol — never through optimistic assumption in either direction (→ `07 §2`).

### 5.3 Where the Resolver runs

A cold-lane service (separate `worker_thread` or folded into the venue worker's non-hot lane) that owns `UNKNOWN`: query by coid via REST; found → install truth, resume the FSM; not-found → §5.1 rules. On any reconnect it also snapshots open orders + positions, diffs against the local book, alerts on divergence, and (config-gated) auto-cancels anything the venue has that we don't recognize. A periodic background reconcile runs even when healthy (→ `05 §3`) — drift you discover in calm markets is drift that won't kill you in a fast one.

### 5.4 Cancels invert the calculus

Cancelling an already-cancelled/filled order returns "unknown order" — which is **information, not failure** (a good-news error, → `07 §2`). On in-doubt, **aggressively resend cancels — across both transports** (WS and REST). **Double-cancel is free; double-place is a position.** Also handle the cancel-races-place case: "unknown order" on a cancel *immediately after placement* can be eventual consistency — retry the cancel for a short window before concluding the order never existed.

---

## 6. Idempotency & exactly-once (summary of mechanisms)

- **Placement:** idempotent by deterministic coid (§1, §5).
- **Order-state events:** idempotent by `(coid, venueState, venue update id/seq)` — applying the same WS message twice is a no-op because the transition is idempotent for an already-applied terminal/seq.
- **Fills:** idempotent by `(venue, tradeId/execId)` (§7).
- **Funding:** idempotent by `(account, symbol, fundingTime)` (→ `04 §6`).
- **Replays:** because everything is event-sourced, replaying the log from a snapshot is the *normal* recovery path and must produce identical projections. Guarantee determinism: no wall-clock or randomness inside `apply()`; all timestamps come from events; all derived values are pure functions of event content. Replaying the log twice yields byte-identical projections — test this in CI (golden-log replay, → `08 §3`).

---

## 7. Fill / trade lifecycle

Fills are *facts*, not commands; their FSM is small but **exactly-once application is sacred** — fills move money and positions.

### 7.1 Fill states

| State | Meaning | Invariant |
|---|---|---|
| `OBSERVED` | A fill event arrived (WS or REST), not yet applied | keyed by `(venueId, tradeId)` |
| `APPLIED` | Folded into order cumFilled, position, fees, realized PnL | applied **exactly once**; recorded in `seenTradeIds` |
| `SUPERSEDED` | A *correction* fill replaces this one's economics | venues occasionally re-state fills |
| `REVERSED` | Venue busted/canceled the trade (rare, e.g., clearly-erroneous bust) | emit compensating event; never delete |

### 7.2 Fill transitions

| From → To | Trigger | Guard | Action |
|---|---|---|---|
| `∅ → OBSERVED` | Fill event from WS or REST | — | Stage it |
| `OBSERVED → APPLIED` | Dedup check passes | `tradeId ∉ seenTradeIds` | Add to `seenTradeIds`; update order FSM cumFilled/avgPx; update position (size, avgEntry, realizedPnL); accrue fee (in its `feeAsset`); adjust capital reservation by filled notional. **Persist the fill before mutating projections** (→ `06 §3`) |
| `OBSERVED → (dropped)` | Dedup check fails | `tradeId ∈ seenTradeIds` | **No-op.** This is the exactly-once guarantee: duplicate fills (WS replay, REST overlap, reconnect backfill) are silently discarded |
| `APPLIED → SUPERSEDED` | Venue restates a trade (price/fee correction) | correction references same `tradeId` | Append `FillCorrected{delta}`; apply *delta only* to position/fees |
| `APPLIED → REVERSED` | Venue busts trade | authoritative bust notice | Append `FillReversed`; re-open order leftover if applicable |

> **Why a `seenTradeIds` set and not "just trust order cumFilled":** the same fill can arrive (a) on the WS user-data stream, (b) again after a WS reconnect backfill, (c) again in a REST `myTrades` reconciliation pull. Each path is independent and lossy. The only safe dedup key is the venue's immutable `tradeId`. Persist the set (or a Bloom filter + exact backing store) so it survives restart — rebuilt-verifiable from the event log within a TTL window.

**Orphan fills** (fill references an unbound coid because it raced ahead of the ack): buffer keyed by coid; apply on bind. We know we sent the order — the id is ours — so a fill arriving pre-ack may also create a **provisional order**, reconciled when the accept event/REST confirms.

---

## 8. Positions & PnL (derived, reconciled)

Positions are a **projection of fills + funding + fees**, then *reconciled* against the venue's position snapshot. For **spot**, "position tracking" collapses into balance tracking (the arb engine cares about the realized spread between legs, not mark-to-market). For **perps**, position is a first-class object: per `(subaccount, symbol[, positionSide])` maintain signed `size`, `avgEntryPrice`, `realizedPnl`, `unrealizedPnl`, `leverage`, `marginMode` (cross/isolated), `liquidationPrice`, and `positionSide` for hedge-mode venues (long/short legs tracked separately). Market-type accounting differences → `01 §10`.

### 8.1 Average-entry / cost-basis algorithm (sign-aware)

On a fill of signed size `q` at price `p` against current signed size `S` with avg entry `E`:

- **Increasing or opening** (same sign, or from flat): `S' = S + q`; `E' = (E·|S| + p·|q|) / |S'|`. Realized PnL = 0.
- **Reducing** (opposite sign, `|q| < |S|`): avg entry **unchanged**; `realizedPnL += (p − E)·closedQty·sign`. Size shrinks.
- **Closing exactly** (`|q| == |S|`): realize on full size; `E' = 0`, `S' = 0` → FLAT.
- **Flipping** (`|q| > |S|`): the fold must be sign-aware and **split the fill at the zero-crossing** — realize PnL on the closed `|S|`, then open the opposite position of `|q|−|S|` at the fill price.

Update `avgEntry` from fills locally for immediacy, but treat the venue's reported `avgEntry` as **authoritative on reconcile** — venues differ on fee-inclusion and rounding, and small errors compound across many fills.

### 8.2 Position FSM (directional)

| State | Meaning |
|---|---|
| `FLAT` | size 0 |
| `LONG` / `SHORT` | size > 0 / size < 0 |
| `OPENING` | flat, an opening order is working (transient) |
| `REDUCING` | reducing order working |
| `CLOSING` | order working that brings size to 0 |
| `FLIPPING` | order will cross through zero (close + reopen opposite) |
| `LIQUIDATING` | venue liquidation/ADL in progress |
| `LIQUIDATED` | involuntarily flattened by venue |
| `DIVERGED` | local size ≠ venue size; trading halted on symbol |

| From | Trigger / Guard | Action (entry/exit) | To |
|---|---|---|---|
| `FLAT` | opening fill (signed q) | set size=q, avgEntry=p; arm liq + funding tracking | `LONG`/`SHORT` |
| `LONG` | fill same sign | recompute avgEntry (weighted); re-arm liq | `LONG` |
| `LONG` | fill opposite, `|q|<size` | realize PnL; avgEntry unchanged; shrink | `LONG` (`REDUCING`) |
| `LONG` | fill opposite, `|q|==size` | realize on full; size→0; disarm liq+funding | `FLAT` |
| `LONG` | fill opposite, `|q|>size` | **split**: close+realize, then open opposite at p | `SHORT` (`FLIPPING`) |
| `LONG`/`SHORT` | `Liquidation`/`ADL` event | record forced fill; realize; **P0 alert** | `LIQUIDATING` → `LIQUIDATED`/`FLAT` |
| `LIQUIDATED` | — | **emergency: the other arb leg is now unhedged** → flatten/rehedge sibling (→ `04 §3.3`) | (strategy) |
| any | Ring-3 reconcile: size ≠ local beyond tolerance | snap to venue; **halt symbol** | `DIVERGED` |
| `DIVERGED` | resync explains delta (missing fill / funding / liq found) | apply; resume | `LONG`/`SHORT`/`FLAT` |
| (mirror all `LONG` rows for `SHORT`) | | | |

A position **sign flip or unexpected nonzero size is never tolerated** in reconciliation — it is an invariant breach (→ `05 §8`). No position direction flip may occur without a corresponding fill sequence.

### 8.3 Realized vs. unrealized PnL

- **Realized** is event-driven: produced only by reducing/closing fills and by liquidation, computed at fill time from `(fillPrice − avgEntry)·closedQty·sign`, plus settled funding and fees. It is a fact, persisted, never re-marked. Cross-check: realized PnL from fills + funding + fees must equal the observed balance delta over the window (→ `05 §8`).
- **Unrealized** is a continuous *derived view*: `(mark − avgEntry)·size·sign`. **Do not persist uPnL as state** — recompute it; persisting leads to stale-mark bugs.
- **Primary stance on the mark:** recompute uPnL locally from your own orderbook top-of-book bid/ask feed so it updates continuously between venue events; treat venue-pushed uPnL as a **sanity check, not an input**; reconcile `size`/`avgEntry`/`realizedPnl` against the venue, since those are the figures that must match truth.
  > **Alternative view:** one source prefers sourcing uPnL from the venue (mark-price-driven, refreshed on snapshot and mark stream). Either way the agreement is total on the gating rule: **uPnL never gates capital on its own** — it informs risk limits; the venue's reported numbers win on reconcile.

### 8.4 Liquidation-distance tracking

- Prefer the **venue-reported `liqPrice`** as primary (their risk engine is authoritative — liquidation depends on the venue's exact margin formula and mark price), and recompute locally as a **cross-check** using the venue's documented formula (inputs: side, avgEntry, leverage, maintenance-margin rate, wallet/cross balance, isolated vs cross). A large local-vs-venue liq-price discrepancy is itself a divergence signal.
- Track `liqDistance = |mark − liqPrice| / mark` continuously as a first-class **safety signal surfaced to the risk gate**, not a display field.
- **Cross-margin:** a position's liq distance depends on the *whole account's* equity — it cannot be computed per-symbol in isolation; for cross mode the *account-level* margin ratio matters more than any single symbol's distance.

### 8.5 Liquidation / ADL is P0

An unexpected liquidation or ADL (position flattened/flipped with a liquidation fill, or an unexplained margin drop) is **the failure that loses the most money fastest in arb**, because it leaves the opposite leg naked. It gets the loudest path: halt the strategy on that symbol/venue; immediately **flatten or re-hedge the sibling leg**; page a human. It must trigger an *active sibling-leg response*, not a passive state update.

### 8.6 Joint position+balance reconciliation

On derivatives venues, position and balance must be **reconciled jointly**: margin moves between them, so a position-only or balance-only snapshot can be internally inconsistent at the instant you read it. Prefer atomic/near-simultaneous snapshots (e.g., OKX's combined `balance_and_position` channel where available, → `08 §5`) and tolerate small read-skew with bands, not exact equality (→ `05 §4`).
