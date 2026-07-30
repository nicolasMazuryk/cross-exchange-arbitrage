# Reliable Reconciled Local Account State for CEX–CEX Crypto Arbitrage

**Scope:** balances, orders, trades/fills, positions, funding, fees — full lifecycle, crash-safe, reconciled against the venue.
**Runtime:** Node.js / TypeScript, single host, single region, multi-venue (≈15), multi-subaccount.
**Governing principle:** *The exchange is the only source of truth. Local state that is silently wrong is worse than no state.* Every design decision below subordinates latency to provable correctness when the two conflict.

---

## 0. Design Tenets (read these first)

1. **Append-only truth, derived views.** The durable core is an immutable, ordered **event log** (commands and venue events). Balances, orders, positions, capital — *all* of it — are **projections** rebuilt deterministically from the log. You never mutate a balance "in place" as the primary record; you append an event and fold it. This is what makes crash recovery and reconciliation tractable.

2. **Reconcile, don't trust.** A live event stream is an *optimization*, never the system of record. Treat WebSocket as "probably complete, probably ordered" and continuously prove it against authoritative REST snapshots. The moment you cannot prove it, you degrade to a known-safe state.

3. **Every ack can be lost.** The hard cases are not "order rejected" — those are clean. The hard cases are *no answer*: you sent a placement and the socket died before the response. The FSM must have first-class **in-flight** states and a **resolver** that turns "unknown" into "known" via the venue.

4. **Idempotency is the spine.** Deterministic client order IDs + dedup on venue-assigned IDs make placements, cancels, and fill ingestion safely repeatable. Replays and duplicates must be *non-events*.

5. **Capital is a reservation ledger, not a number.** Two legs of one arb must never spend the same dollar. Available capital is computed, not read, and gated by a single-writer allocator.

6. **Fail loud, fail safe.** On any unresolvable divergence: stop opening, flatten if mandated, page a human. A frozen-but-honest system beats a fast-but-lying one.

7. **One canonical model, venue adapters at the edge.** Internally everything is normalized (venue-agnostic states, signed quantities, unified asset ids). Each venue's quirks (listenKey expiry, sequence semantics, amend atomicity) live in an **adapter**, never in core logic.

---

## 1. System Architecture

### 1.1 The three pipelines

```
                        ┌──────────────────────────────────────────┐
   Strategy / Sizer ──► │  COMMAND PIPELINE (intent → venue)         │
                        │   reserve capital → persist intent →       │
                        │   send → await ack → resolve               │
                        └───────────────┬────────────────────────────┘
                                        │ appends
                                        ▼
   Venue WS (user data) ─► ┌────────────────────────────┐   folds   ┌─────────────────┐
   Venue REST (snapshots)─►│  EVENT LOG (append-only,    │ ────────► │  PROJECTIONS     │
                           │  ordered, durable WAL)      │           │  (in-memory +    │
   Reconciler ───────────► └────────────┬────────────────┘           │   snapshotted)   │
                                        │                            │  • orders FSM    │
                        ┌───────────────▼────────────────────────┐   │  • fills ledger  │
                        │  RECONCILIATION PIPELINE                │   │  • positions     │
                        │   periodic + triggered 3-way diff,      │◄──┤  • balances      │
                        │   sequence-gap detection, drift repair  │   │  • capital ledger│
                        └─────────────────────────────────────────┘   │  • funding/fees  │
                                                                       └─────────────────┘
```

- **Command pipeline** — the only writer of *intent* events. It owns the lifecycle from "strategy wants to trade" to "order is in a terminal state."
- **Event ingest** — normalizes WS user-data events and REST snapshot deltas into canonical events and appends them.
- **Reconciliation pipeline** — continuously compares projection ⇄ venue and emits *correction* events when they disagree.

All three converge on **one ordered log**. Projections are pure folds: `state' = apply(state, event)`. Same log ⇒ same state, always. That determinism is the whole game.

### 1.2 Why event sourcing here specifically

Account state in HFT has three properties that make CRUD-on-a-row a trap and event sourcing a fit:

- **Out-of-order, duplicated, lost inputs.** You need to *replay* and *re-derive*, not patch.
- **Auditability under real money.** "Why did we think we had $50k free at 14:02:11.327?" must be answerable to the millisecond. The log *is* the answer.
- **Reconciliation as first-class.** A correction is just another event. Repairing drift never means "secretly editing a balance" — it means appending `BalanceCorrected{from,to,reason,evidence}`, which is auditable and reversible.

### 1.3 Single-writer discipline

Concurrency is where account state dies. Enforce **one logical writer per aggregate**:

- One **per-(venue, subaccount) actor** owns that account's order FSMs, balances, positions. All mutations for that account are serialized through its mailbox/queue. In Node this is naturally a single event loop, but you must still *serialize across awaits* — an `async` handler that `await`s mid-transition can interleave with another event. Use an explicit per-account **command queue** (a promise chain or an async mutex), not raw `async` handlers racing on shared state.
- One **capital allocator** (global) owns cross-account/cross-leg reservations.
- The event log has one append point with a monotonic local sequence (`lsn`).

---

## 2. Canonical Data Model

Normalize everything at the adapter boundary. Internal types are venue-agnostic.

### 2.1 Identity & keys

| Entity | Primary key | Notes |
|---|---|---|
| Account | `(venueId, subAccountId, marketType)` | `marketType ∈ {spot, linear, unified}` |
| Order | `(accountKey, clientOrderId)` | `clientOrderId` is **ours**, deterministic, never reused |
| Venue order ref | `venueOrderId` | venue-assigned; may arrive late; map to `clientOrderId` |
| Fill/Trade | `(venueId, tradeId)` | venue-assigned; **the dedup key** |
| Position | `(accountKey, symbol, [positionSide])` | hedge mode ⇒ `positionSide ∈ {long,short}` |
| Funding event | `(accountKey, symbol, fundingTime)` | settlement instants |
| Balance | `(accountKey, asset)` | available / locked / total |

### 2.2 Money is never a float

Use a fixed-point/decimal representation end-to-end (string-backed bigint scaled by venue tick/step, or a decimal lib). **No IEEE-754 floats for quantities, prices, balances, or PnL.** Quantize every value to the venue's `tickSize`/`stepSize`/`minNotional` at the adapter, and carry the scale with the value. Float drift in a reconciliation comparator manufactures phantom discrepancies and, worse, real ones.

### 2.3 Signed, unified position math

- Linear/spot: quantity in base asset.
- **Unified margin**: balances are shared collateral across instruments; "available" is a *portfolio margin* computation, not a per-asset subtraction. Treat the venue's reported available-margin/equity as authoritative and *never* try to recompute portfolio margin yourself for gating — recompute only as a *sanity bound*.

### 2.4 The aggregates

- **OrderAggregate** — the FSM (Section 3). Holds: state, qty, cumFilledQty, avgFillPx, leftoverQty, linkage to amend successors/predecessors, in-flight request metadata, last venue event id.
- **FillLedger** — append-only set of fills keyed by `tradeId`; the source for cumFilled, realized PnL, fee accrual.
- **PositionProjection** — derived from fills + funding; reconciled against venue position snapshot.
- **BalanceProjection** — derived; reconciled against venue balance snapshot.
- **CapitalLedger** — reservations (Section 6).
- **FundingLedger** — accruals/settlements (Section 7).

---

## 3. Order Lifecycle — The Finite State Machine

This is the core deliverable. The FSM is **venue-agnostic**; adapters map venue event vocabularies onto these canonical states/triggers.

### 3.1 State catalogue

Each state is classified by **kind**: `in-flight` (a request is outstanding, capital committed, outcome unknown), `resting` (venue holds it, can still fill/cancel), `terminal` (no further transitions for this `clientOrderId`), or `quarantine` (we cannot prove the state and must resolve it before trusting anything derived from it).

| # | State | Kind | Meaning | Key invariants | On-entry action | On-exit action |
|---|---|---|---|---|---|---|
| 1 | `INTENT` | pre-flight | Strategy decided; record + clientOrderId minted; **persisted before any network I/O** | capital reservation exists; `venueOrderId=null`; `cumFilled=0` | append `OrderIntent`; reserve capital; start no timer yet | — |
| 2 | `PENDING_NEW` | in-flight | Placement request dispatched, no ack | reservation held; `sentAt` set; idempotency key = clientOrderId | append `OrderSubmitted`; **arm submit-timeout** | clear submit-timeout |
| 3 | `LIVE` | resting | Venue acked, resting, `cumFilled=0` | `venueOrderId` known; `leftover=qty` | append `OrderAcked`; register in open-orders index | deregister from open-orders index |
| 4 | `PARTIALLY_FILLED` | resting | Acked, `0<cumFilled<qty` | `leftover=qty-cumFilled>0`; each fill applied once | append `OrderPartiallyFilled`; update position/fees | — |
| 5 | `PENDING_AMEND` | in-flight | Amend/replace dispatched, no ack | prior resting snapshot retained for rollback; reservation delta held | append `OrderAmendSubmitted`; **arm amend-timeout** | clear amend-timeout |
| 6 | `PENDING_CANCEL` | in-flight | Cancel dispatched, no ack | cancel may *lose a race* to a fill | append `OrderCancelSubmitted`; **arm cancel-timeout** | clear cancel-timeout |
| 7 | `FILLED` | terminal | `cumFilled=qty` | reservation fully committed→released; position updated | append `OrderFilled`; finalize reservation | — |
| 8 | `CANCELED` | terminal | Venue confirmed cancel; `leftover` released | leftover reservation released; partial fills (if any) already applied | append `OrderCanceled`; release leftover reservation | — |
| 9 | `REJECTED` | terminal | Venue refused placement/amend | no fills; reservation released; reason captured | append `OrderRejected`; release reservation; raise typed error | — |
| 10 | `EXPIRED` | terminal | TIF expiry / IOC-FOK unfilled remainder / session expiry | leftover released; any fills applied | append `OrderExpired`; release leftover reservation | — |
| 11 | `UNKNOWN` | quarantine | Ack lost / timeout / conflicting evidence; true state unproven | **no derived state may be trusted**; capital stays reserved (pessimistic) | append `OrderUnknown{cause}`; enqueue to **Resolver**; raise alert | append `OrderResolved{to,evidence}` |

> **Design choices worth defending:**
> - `INTENT` is a real, *persisted* state, not an in-memory nicety. Persisting the `clientOrderId` **before** the network call is what makes lost-ack recovery possible (Section 4/9).
> - `UNKNOWN` exists deliberately. Most naive implementations collapse "timeout" into "failed" — that is the single most dangerous bug in order management, because a "failed" placement may actually be resting and filling. `UNKNOWN` is pessimistic: capital stays locked and the order is non-tradable-around until resolved.
> - Amend is modeled as cancel-replace semantics with explicit successor linkage, because most venues do not give true in-place amend with stable identity.

### 3.2 Transition table

Columns: **Trigger** (what causes it), **Guard** (must be true to fire), **Action** (effect, beyond the entry/exit actions above), **Recovery** (what happens if this transition's own attempt fails).

#### Placement path

| From → To | Trigger | Guard | Action | Recovery on failure |
|---|---|---|---|---|
| `∅ → INTENT` | Strategy emits order request | Capital allocator grants reservation; risk gate passes; symbol tradable | Mint deterministic `clientOrderId`; persist `OrderIntent` (durable) | If persist fails → abort, release reservation, surface error. *Never send if intent isn't durable.* |
| `INTENT → PENDING_NEW` | Intent persisted | Durable log fsync'd; rate-limit token available | POST placement with `clientOrderId`; arm submit-timeout (e.g. p99×k) | Send throws *synchronously* (e.g. 4xx validation) → `REJECTED`. Send throws *transport* (ECONNRESET/timeout) → `UNKNOWN` (could have landed). |
| `PENDING_NEW → LIVE` | Ack: order accepted, `executedQty=0` | `clientOrderId` matches; `venueOrderId` present | Bind `venueOrderId↔clientOrderId`; index as open | n/a (terminal-ish good path) |
| `PENDING_NEW → PARTIALLY_FILLED` | Ack already carries fills, or first fill arrives before/with ack | fill `tradeId` unseen; cum ≤ qty | Apply fill(s) idempotently | Out-of-order fill before ack: buffer keyed by clientOrderId, apply on bind |
| `PENDING_NEW → FILLED` | Ack/fills sum to full qty (e.g. marketable/IOC fully filled) | cum == qty | Apply fills; finalize | — |
| `PENDING_NEW → REJECTED` | Venue rejects (insufficient balance, bad params, post-only would cross, dup clientOrderId pointing at *different* params) | reason is authoritative | Release reservation; classify reason (retryable vs fatal) | — |
| `PENDING_NEW → EXPIRED` | IOC/FOK with no/partial fill, remainder killed | TIF semantics | Apply any fills; release leftover | — |
| `PENDING_NEW → UNKNOWN` | submit-timeout fires **or** transport error | no terminal/ack received | Enqueue Resolver: **query by clientOrderId** | see Resolver (3.4) |

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
| `LIVE/PARTIALLY_FILLED → PENDING_CANCEL` | Strategy/risk requests cancel | order is resting; not already pending-cancel | Send cancel by `clientOrderId` (preferred) or `venueOrderId`; arm cancel-timeout | Send transport error → stay logically resting but mark cancel `UNKNOWN`; Resolver re-queries |
| `PENDING_CANCEL → CANCELED` | Cancel ack | leftover>0 at cancel time | Release leftover reservation | — |
| `PENDING_CANCEL → FILLED` | **Cancel lost the race**: order filled before cancel landed | cum==qty | Apply final fill; cancel becomes a no-op | This is *expected*, not an error. The fill wins. |
| `PENDING_CANCEL → PARTIALLY_FILLED` (→ then `CANCELED`) | Fill landed, then cancel acked for the remainder | partial fill applied, leftover canceled | Apply fill, then release remaining leftover | — |
| `PENDING_CANCEL → REJECTED(cancel)` | Venue: "unknown order / already gone" | order already terminal at venue | Resolve true terminal via query, reconcile state | Treat "order not found" as evidence it's already terminal → query to learn which terminal |
| `PENDING_CANCEL → UNKNOWN` | cancel-timeout, no ack | — | Resolver queries order status | see Resolver |

#### Amend / cancel-replace path

| From → To | Trigger | Guard | Action | Recovery on failure |
|---|---|---|---|---|
| `LIVE/PARTIALLY_FILLED → PENDING_AMEND` | Strategy requests price/qty amend | new params valid; new qty ≥ cumFilled; reservation delta reservable | Snapshot pre-amend order for rollback; reserve any *increase* in notional up front; send amend / cancel-replace; arm amend-timeout | If reservation of increase fails → reject amend locally, stay resting unchanged |
| `PENDING_AMEND → LIVE/PARTIALLY_FILLED` (amended) | Amend ack (atomic-amend venue: same id) | `cumFilled` preserved; new qty/px applied | Apply new params; settle reservation delta (release if qty decreased) | — |
| `PENDING_AMEND → (old CANCELED + new LIVE)` | Cancel-replace venue: old killed, **successor** with new `clientOrderId` acked | successor linked to predecessor | Mark predecessor `CANCELED`; create successor in `LIVE` carrying forward filled context as needed | If successor placement fails after old canceled → predecessor is `CANCELED`, successor `REJECTED`/`UNKNOWN`; strategy notified leftover is *unworked* |
| `PENDING_AMEND → PARTIALLY_FILLED/FILLED` | **Amend lost the race**: order filled before amend landed | cum advanced | Apply fill; amend is no-op or rejected | Expected race; fill wins |
| `PENDING_AMEND → REJECTED(amend)` | Venue rejects amend (e.g. would-cross post-only, qty<filled) | — | Roll back to pre-amend snapshot state; release any reserved increase | Order remains as it was pre-amend (still resting) |
| `PENDING_AMEND → UNKNOWN` | amend-timeout / transport error | — | **Critical**: amend ambiguity can leave order at old *or* new params *or* canceled. Resolver must query and reconcile, holding the *max* of old/new reservations until resolved | see Resolver |

### 3.3 Where the FSM lives and how transitions are driven

- **Lives in:** the per-account actor, as the `OrderAggregate`. Implement the FSM **explicitly** — a typed transition function `transition(state, event): {next, effects[]}` that is *pure* (no I/O). I/O (send, persist, timers) is returned as **effects** and executed by the actor runtime. This makes the FSM unit-testable against fuzzed event orderings and replayable.
- **Recommended tooling:** XState v5 for the statechart (it models hierarchical states, guards, and timeouts cleanly and serializes well), *or* a hand-rolled discriminated-union reducer if you want zero deps and total control. Either way: **transitions are driven by events appended to the log, not by direct method calls.** A WS fill, a REST snapshot delta, a timeout, and a Resolver verdict are all just events fed to the same `transition`.
- **Triggers come from four sources**, all normalized to canonical events: (1) command pipeline (intent/submit/cancel/amend requests), (2) WS user-data stream, (3) REST query/snapshot (Resolver + Reconciler), (4) local timers (submit/cancel/amend timeouts, heartbeat). No other source may move an order.

### 3.4 The Resolver (the heart of `UNKNOWN` recovery)

Any path into `UNKNOWN` enqueues the order to the Resolver. The Resolver is the component that converts ambiguity into fact, using the venue as truth:

```
Resolver(order):
  for attempt in backoff(50ms → 5s, jitter):
     r = REST query order status by clientOrderId   # primary
     if r found:
        feed canonical event (Acked/Partial/Filled/Canceled/Rejected/Expired) → transition
        return  # UNKNOWN resolved
     else "not found":
        # ambiguous: either never landed, or landed+already purged from active set
        r2 = REST query *recent orders* + *recent trades* by clientOrderId / time window
        if any fill/trade references this clientOrderId → reconstruct fills → resolve
        elif order absent from open AND no fills AND within venue's "definitely-would-show" window:
             → treat as NEVER PLACED → REJECTED(synthetic, "no venue record") → release reservation
        else keep polling (still ambiguous)
  on exhaustion: escalate → halt new orders for this account, page human, keep reservation locked
```

Key rules:
- **Never resolve `UNKNOWN` from the WS stream alone.** WS can be exactly the thing that dropped the message. Resolution requires an *authoritative pull* (REST), or WS evidence *corroborated* by a subsequent snapshot.
- **Pessimistic capital:** while `UNKNOWN`, the reservation stays. You'd rather under-trade than double-spend.
- **"Order not found" is not "order never existed."** It's ambiguous and must be disambiguated against the trades endpoint and a time window, because a fully-filled-and-purged order also reads as "not in open orders."

---

## 4. Fill / Trade Lifecycle FSM

Fills are *facts*, not commands, so their FSM is small but its **exactly-once** application is sacred — fills move money and positions.

### 4.1 Fill states

| State | Meaning | Invariant |
|---|---|---|
| `OBSERVED` | A fill event arrived (WS or REST), not yet applied | keyed by `(venueId, tradeId)` |
| `APPLIED` | Folded into order cumFilled, position, fees, realized PnL | applied **exactly once**; recorded in `seenTradeIds` |
| `SUPERSEDED` | A *correction* fill replaces this one's economics | venues occasionally re-state fills |
| `REVERSED` | Venue busted/canceled the trade (rare, e.g. clearly-erroneous bust) | emit compensating event; never delete |

### 4.2 Fill transitions

| From → To | Trigger | Guard | Action |
|---|---|---|---|
| `∅ → OBSERVED` | Fill event from WS or REST | — | Stage it |
| `OBSERVED → APPLIED` | Dedup check passes | `tradeId ∉ seenTradeIds` | Add to `seenTradeIds`; update order FSM cumFilled/avgPx; update position (size, avgEntry, realizedPnL); accrue fee; adjust capital reservation by filled notional |
| `OBSERVED → (dropped)` | Dedup check fails | `tradeId ∈ seenTradeIds` | **No-op.** This is the exactly-once guarantee: duplicate fills (WS replay, REST overlap, reconnect backfill) are silently discarded |
| `APPLIED → SUPERSEDED` | Venue restates a trade (price/fee correction) | correction references same `tradeId` | Append `FillCorrected{delta}`; apply *delta only* to position/fees |
| `APPLIED → REVERSED` | Venue busts trade | authoritative bust notice | Append `FillReversed`; re-open order leftover if applicable |

> **Why a `seenTradeIds` set and not "just trust order cumFilled":** the same fill can arrive (a) on the WS user-data stream, (b) again after a WS reconnect backfill, (c) again in a REST `myTrades` reconciliation pull. Each path is independent and lossy. The only safe dedup key is the venue's immutable `tradeId`. Persist this set (or a Bloom filter + exact backing store) so it survives restart.

---

## 5. Position Lifecycle (derived, reconciled)

Positions are a **projection of fills + funding + fees**, then *reconciled* against the venue's position snapshot.

- **Folded from fills:** signed size, average entry (cost-basis, sign-aware on flips), realized PnL on reductions/flips, leverage and liquidation distance from venue snapshot (do not compute liquidation yourself for gating — it depends on the venue's exact margin formula and mark price; read it).
- **Position flip handling:** a fill that crosses zero (e.g. long 5 → sell 8) realizes PnL on the closed 5 and opens a new short 3 at the fill price. The fill→position fold must be sign-aware and split the fill at the zero-crossing.
- **Reconciliation:** on every periodic snapshot, compare `derivedSize == venueSize` and `derivedAvgEntry ≈ venueAvgEntry` (within tolerance). On mismatch → `PositionCorrected` event with the venue value, *and* an investigation alert (a position mismatch usually means a missed or double-applied fill, which is a money bug). The venue value wins for gating immediately; the alert forces root-cause.
- **Unrealized PnL / liq distance:** sourced from venue (mark price driven), refreshed on snapshot and on mark-price stream; never gates capital on its own — it informs risk limits.

---

## 6. Balances & Capital — Double-Spend Prevention

This is where arbitrage systems lose real money. Two legs sizing off the same "available" balance will double-commit.

### 6.1 Available is computed, not read

```
available(account, asset) =
    venueReportedFree(account, asset)            # authoritative, from snapshot/stream
  − Σ open local reservations (intents + in-flight + resting unfilled notional)
  − inFlightSafetyBuffer                          # for fees/slippage/race
```

You do **not** trade off `venueReportedFree` directly, because the venue hasn't yet accounted for orders you've decided to send but that aren't resting yet (intent + pending-new), and because two strategies can read the same free balance in the same tick.

### 6.2 Reservation ledger (two-phase)

A single global **CapitalAllocator** (single writer) owns reservations:

| Phase | When | Effect |
|---|---|---|
| **Reserve** | At `INTENT`, before send | Atomically decrement computed-available by required notional + fee buffer. If insufficient → order is never minted (strategy gets `INSUFFICIENT_CAPITAL`). |
| **Adjust** | On each partial fill | Reservation shrinks by filled notional (which converts into position/locked at the venue) |
| **Commit/Release** | On terminal state | `FILLED`: reservation fully consumed. `CANCELED/EXPIRED`: leftover released. `REJECTED`: full release. `UNKNOWN`: **held** until Resolver verdict. |

Because both legs of an arb reserve through the *same* allocator before either sends, the second leg sees the first leg's reservation and cannot double-spend. Cross-leg atomicity for a single arb opportunity: reserve *both* legs' capital up front (all-or-nothing); if either reservation fails, release the other and skip the opportunity.

### 6.3 Reconciling balances

- Venue free/locked is authoritative and arrives via stream + snapshot.
- Local check: `venueLocked ≈ Σ resting-order locked notional + position margin`. Divergence beyond tolerance ⇒ a missed order/fill ⇒ trigger order/fill reconciliation, not just a balance patch.
- **Unified margin caveat:** "available" is portfolio-margin equity, cross-collateralized. Reserve against the venue's reported available-margin and re-pull it aggressively after each leg, because one instrument's fill changes available margin for *all* instruments. Do not subtract per-asset; subtract from the portfolio available-margin number the venue gives you.

---

## 7. Funding & Fees

### 7.1 Funding (perp)

- **Accrual (prediction):** between settlements, maintain a *predicted* funding accrual = `positionNotional × predictedFundingRate × timeFraction`, sourced from the venue's predicted-rate field. This is **estimate-only**, flagged as unsettled, and used by the strategy for carry-aware sizing — never folded into realized balances.
- **Settlement:** at each funding instant, the venue debits/credits. Capture it as a `FundingSettled{symbol, amount, time}` event keyed by `(account, symbol, fundingTime)` for idempotency. This *is* a balance/PnL move and folds into realized.
- **Reconcile:** pull funding history periodically; any settled funding event present at venue but absent locally → append it (dedup on `fundingTime`). Predicted accrual is reset to zero at each settlement and re-accrued.

### 7.2 Fees

- **Trading fees** accrue per fill (maker/taker, possibly in a fee asset like BNB or a discount token). Captured *from the fill event itself* (venues report fee + feeAsset per trade) — never estimated when the actual is available. Fold into realized PnL and reduce the relevant asset balance.
- **Fee asset ≠ quote asset** must be modeled: a fill can decrement a third asset. The balance projection handles arbitrary fee assets.
- **Rebates** (negative maker fees) are just negative fee amounts.

---

## 8. Idempotency & Exactly-Once

### 8.1 Client order IDs

Deterministic, unique, never reused, decodable:

```
clientOrderId = `${envTag}${strategyId}-${accountShard}-${monotonicSeq}`   # ≤ venue maxLen
```

- **Monotonic seq** from a persisted counter (survives restart; never resets backward). Pre-allocate ranges so a crash mid-batch can't reissue an id.
- **Persisted before send** (the `INTENT` rule). The id is your idempotency key for placement *and* your lookup key for the Resolver.
- **Length/charset** clamped per venue (adapters validate). Some venues mutate or reject ids — adapter normalizes and stores both ours and the venue's.

### 8.2 Lost ack (placed, no response) — the canonical hard case

1. `PENDING_NEW` submit-timeout or transport error → `UNKNOWN`.
2. Resolver queries the venue **by clientOrderId** (not by guessing).
3. Outcomes: found resting → `LIVE`; found filled → `FILLED`; found canceled/expired → terminal; *truly* absent within a confidence window → synthetic `REJECTED("never landed")`.
4. **Retry only after a verified-absent verdict.** Because `clientOrderId` is deterministic, even if the original *did* land, a duplicate send with the same id is rejected by the venue as a dup (or is a no-op), so you cannot accidentally place twice. This is the payoff of deterministic ids: **placement is idempotent by construction.**

### 8.3 Duplicate events

- Order events: idempotent by `(clientOrderId, venueState, venue update id/seq)`. Applying the same WS message twice is a no-op because the FSM transition is idempotent for an already-applied terminal/seq.
- Fill events: idempotent by `tradeId` (Section 4).
- Funding: idempotent by `fundingTime`.

### 8.4 Replays

Because everything is event-sourced, replaying the log from a snapshot is the *normal* recovery path and must produce identical projections. Guarantee determinism: no wall-clock or randomness inside `apply()`; all timestamps come from the events; all derived values are pure functions of event content. Replaying the log twice yields byte-identical projections — test this property in CI (golden-log replay).

---

## 9. Crash Recovery & Persistence

### 9.1 What's durable, and the write order

The **only** hard rule that prevents lost money: *durable intent precedes network effect.*

```
mint clientOrderId → append OrderIntent → fsync → THEN send placement
```

If you crash after fsync but before/after send, recovery + Resolver figures out the truth. If you send before fsync and crash, you have an order at the venue you have no record of — an orphan that can fill and leave an unhedged leg. Never do that.

### 9.2 Storage layout (Node, single host)

| Layer | Tech (opinionated) | Role |
|---|---|---|
| **Event log / WAL** | **SQLite via `better-sqlite3`** in WAL mode, *or* an append-only segment file + `fsync`. SQLite is the pragmatic default: synchronous API (no await races in the hot path), durable, transactional, embeddable, battle-tested. | Append-only ordered events with local `lsn`; the system of record |
| **Snapshots** | Periodic serialized projection state (every N events / T seconds) into SQLite or flat file | Bounds replay time on restart |
| **Dedup stores** | `seenTradeIds`, processed venue-update-ids, clientOrderId counter | Persisted; rebuilt-verifiable from log |
| **Hot projections** | In-memory typed structures | Speed; always reconstructable |


### 9.3 Restart sequence (deterministic, defensive)

```
1. Load latest snapshot (lsn = S).
2. Replay log events (lsn > S) → rebuild all projections in memory. (pure folds)
3. Identify all non-terminal orders:
     - PENDING_NEW / PENDING_CANCEL / PENDING_AMEND / UNKNOWN  → enqueue Resolver
     - LIVE / PARTIALLY_FILLED                                 → mark "needs verification"
4. FULL RECONCILIATION before trading is enabled:
     - REST pull: open orders, recent orders, recent trades, positions, balances, funding
     - 3-way reconcile (Section 10) for every account
     - Resolve every in-flight/UNKNOWN order against venue truth
5. Rebuild capital reservations from reconciled order/position state.
6. Only after every account passes reconciliation → flip strategy gate to ENABLED.
   Any account that fails reconciliation stays QUARANTINED (no new orders; flatten per policy).
```

**Trading is disabled until reconciliation completes.** A fast restart that starts trading on stale projections is how you double-commit capital after a crash. The cost of a few seconds of reconciliation at boot is trivial against the cost of one desynced trade.

### 9.4 Snapshot/replay correctness

- Snapshots store `lsn` and a hash of projection state. On load, replay-from-snapshot must reach a verifiable state.
- Periodically (and in CI) **replay the entire log from genesis** and assert it equals the snapshot-based state. If they ever differ, a fold is non-deterministic — a critical bug.

---

## 10. Reconciliation Engine

Continuous proof that local == venue. This is the safety net under the FSM.

### 10.1 Three-way reconciliation

For each `(account, marketType)` compare three views:

1. **Local projection** (what we think).
2. **WS-derived state** (what the live stream said).
3. **REST snapshot** (authoritative pull): open orders, positions, balances, recent trades, funding.

Reconcile **REST as truth**, WS as corroboration, local as the thing being corrected.

| Object | Comparison | On mismatch |
|---|---|---|
| Open orders | local-open set vs venue-open set | local-open-but-venue-absent → query → resolve to terminal (it filled/canceled and we missed it). venue-open-but-local-absent → **orphan**: ingest as discovered order, link/clientOrderId, alert hard |
| Order qty/cum | per-order cumFilled vs venue | pull `myTrades`, apply missing fills (dedup), correct |
| Positions | derived size/avgEntry vs venue | `PositionCorrected` (venue wins) + investigate missed fill |
| Balances | derived vs venue free/locked | `BalanceCorrected` (venue wins) + investigate |
| Funding | local settlements vs venue funding history | append missing `FundingSettled` (dedup on fundingTime) |
| Fees | accrued vs venue (where queryable) | correct via fill re-pull |

### 10.2 Cadence & triggers

- **Periodic baseline:** lightweight reconcile every few seconds (open orders + positions + balances), full (incl. trades/funding history) every minute or few minutes.
- **Triggered (event-driven) reconcile** — react immediately, don't wait for the timer:
  - WS reconnect / `listenKey` (or equivalent) refresh or expiry.
  - **Sequence gap** detected (10.3).
  - Heartbeat/staleness: no WS message in `T` while we have resting orders.
  - Any `UNKNOWN` order.
  - Balance/position mismatch above tolerance.
  - Rate-limit ban / 5xx storm subsiding.

### 10.3 Sequence-gap detection (per venue semantics)

Most user-data streams carry an ordering token (update id, sequence number, or per-event monotonic counter). Track last-seen per stream. On `received != expected+1`:

1. Mark stream `SUSPECT`.
2. Trigger full REST reconciliation for that account.
3. Do **not** trust derived state in the gap window; capital decisions pause for that account until reconciled.

Venues differ (some give global update ids, some per-symbol, some none — for those, lean harder on periodic REST and shorter heartbeat timeouts). The adapter declares the venue's ordering capability; core adapts cadence accordingly.

### 10.4 Tolerances

Comparisons are quantized to venue step/tick. Define explicit tolerances (ideally **zero** for order qty/cum and position size after quantization; small epsilon only for funding/unrealized which involve mark price). A mismatch beyond tolerance is *always* an event + alert, never a silent patch.

---

## 11. Failure Modes & Error Handling (detection + recovery for each)

| # | Failure mode | Detection | Immediate response | Recovery / resolution | Invariant protected |
|---|---|---|---|---|---|
| 1 | **Lost placement ack** (sent, no response) | submit-timeout / transport error | → `UNKNOWN`; keep reservation | Resolver queries by clientOrderId → true terminal/resting; deterministic id makes retry safe | No phantom or duplicate order |
| 2 | **Lost cancel ack** | cancel-timeout | cancel marked unknown; order stays logically resting | Resolver re-queries; cancel is idempotent (re-send safe) | No "thinks-canceled but still resting" leg |
| 3 | **Lost amend ack** | amend-timeout | hold max(old,new) reservation; order quarantined | Resolver determines old/new/canceled; reconcile params | No wrong-price/size resting order trusted |
| 4 | **Cancel/amend loses race to fill** | terminal fill arrives during PENDING_CANCEL/AMEND | fill wins; cancel/amend no-op | normal transition to FILLED/PARTIAL | No double-accounting of canceled-then-filled |
| 5 | **Missed fill (WS drop)** | order/position/balance reconcile mismatch; sequence gap | trigger trade re-pull | apply missing fill via `myTrades` (dedup by tradeId) | Position/PnL correctness; no unhedged leg |
| 6 | **Duplicate fill** (WS replay / REST overlap) | `tradeId ∈ seenTradeIds` | drop (no-op) | n/a | Exactly-once fill application |
| 7 | **Out-of-order events** (fill before ack) | event references unbound clientOrderId | buffer keyed by clientOrderId | apply on bind/ack | No dropped early fills |
| 8 | **WS disconnect** | heartbeat/ping timeout, socket close | reconnect w/ backoff; mark stream SUSPECT | full reconcile on reconnect + backfill via REST | No silent staleness while resting orders exist |
| 9 | **listenKey / stream auth expiry** | venue expiry event / 401 on stream | refresh key, resubscribe | reconcile across the gap | No undetected stream death |
| 10 | **Sequence gap** | seq != expected+1 | stream SUSPECT; pause capital decisions for account | full REST reconcile, then resume | No trusting incomplete stream |
| 11 | **Orphan order at venue** (venue-open, local-absent) | open-orders reconcile | ingest as discovered; link clientOrderId; hard alert | reservation created; strategy informed; possibly cancel if unrecognized | No untracked exposure |
| 12 | **Stale projection after crash** | always assumed on boot | trading disabled until reconciled | §9.3 restart sequence | No trading on stale state |
| 13 | **Rate-limit / IP ban (429/418)** | HTTP code + headers | back off; pause submits for account; honor retry-after | resume after window; reconcile (events may have been missed during ban) | No request storm; no missed-event blindness |
| 14 | **5xx / venue maintenance** | HTTP 5xx, venue status | exponential backoff + circuit breaker per venue; halt new orders for venue | on recovery: full reconcile before re-enable | No action on a degraded venue |
| 15 | **Clock skew / timestamp window reject** (`recvWindow`) | venue rejects with timestamp error | resync NTP; widen window within reason; retry | re-send (idempotent by clientOrderId) | No false rejects, no dup placement |
| 16 | **Insufficient balance reject** | venue REJECTED reason | release reservation; signal capital model drift | reconcile balances (we thought we had it) → find the discrepancy | Reservation ↔ venue balance consistency |
| 17 | **Partial venue downtime** (orders OK, positions endpoint flaky) | per-endpoint error rates | degrade: keep trading only if *all* gating endpoints healthy | reconcile when endpoint returns; else quarantine | No gating on unverifiable state |
| 18 | **Fill correction / bust** | venue restatement/bust notice | `FillCorrected`/`FillReversed` (delta only) | re-fold position/fees/PnL; re-open leftover if busted | Audit-correct economics |
| 19 | **Position mismatch** (derived ≠ venue) | reconcile | `PositionCorrected` (venue wins) immediately for gating | investigate missed/dup fill (root cause is a money bug) | Correct exposure for sizing |
| 20 | **Balance mismatch** | reconcile | `BalanceCorrected` (venue wins) | trace to missing fill/funding/fee | Correct capital |
| 21 | **Funding missed** | funding-history reconcile | append `FundingSettled` (dedup) | realized balance corrected | PnL correctness |
| 22 | **Persist failure (disk full / fsync error)** | write throws | **halt all order submission immediately** (we can't guarantee durable intent) | alert; do not send anything that can't be logged first | "Durable intent precedes effect" |
| 23 | **Counter rollback / dup clientOrderId** | counter not strictly increasing on boot | refuse to start trading; rebuild counter from log max+gap | reconcile; never reuse an id | Idempotency of placement |
| 24 | **Reconciliation can't converge** (repeated mismatch) | mismatch persists across N cycles | QUARANTINE account; flatten per policy; page human | manual intervention | Never trade on a lying view |
| 25 | **Two strategies double-commit** | prevented by design | allocator rejects 2nd reservation | n/a (design-time prevention) | No double-spend across legs |

**Cross-cutting error policy:**
- **Classify every error** into: `FATAL_REJECT` (don't retry — bad params), `RETRYABLE_TRANSIENT` (backoff+retry, idempotent), `AMBIGUOUS` (→ UNKNOWN → Resolver), `RATE_LIMITED` (honor window), `VENUE_DEGRADED` (circuit-break). Adapters map venue error codes to these classes; core handles by class.
- **Circuit breaker per (venue, endpoint).** Trips on error-rate/latency; while open, that account is gated. Closes after probes succeed *and* reconciliation passes.
- **Backoff is jittered exponential**, capped, and *never* applied to a placement retry until the prior attempt's outcome is *known* (Resolver verdict) — retrying an ambiguous placement is only safe because of deterministic ids, and even then only after verified-absent.

---

## 12. Invariants (continuously checked; violation ⇒ event + alert ⇒ recovery)

Treat invariants as runtime assertions evaluated on every relevant fold and on every reconcile. A violation is never ignored.

| Invariant | Check | Recovery on violation |
|---|---|---|
| `cumFilled ≤ orderQty` | per fill apply | reject/buffer fill; reconcile order (likely dup or wrong mapping) |
| `cumFilled = Σ applied fills` | per order | re-pull trades; rebuild from fills |
| Each `tradeId` applied ≤ once | dedup set | drop duplicate |
| Order in exactly one state; terminal is absorbing | FSM | illegal transition → log + ignore + reconcile |
| `Σ reservations ≤ venue free + accounted-locked` | allocator + balance reconcile | tighten available; reconcile; quarantine if persistent |
| `derived position size == venue size` (quantized) | position reconcile | venue wins; investigate |
| `derived balance == venue balance` (within tol) | balance reconcile | venue wins; investigate |
| No resting order without `venueOrderId` binding | order index | resolve binding via query |
| No order at venue without local record (no orphans) | open-orders reconcile | ingest orphan; alert |
| clientOrderId counter strictly increasing | boot + per mint | refuse start / re-derive from log |
| Durable intent exists before any venue send | write-order assertion | halt submits if violated |
| Both arb legs reserved before either sends | allocator | reject opportunity if not |
| Event log `lsn` strictly increasing, no gaps | append | crash-recover; never accept out-of-order append |

---

## 13. Concrete Node/TypeScript Stack (opinionated, as of now)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict`, no `any` on money/state types | Exhaustiveness checking on FSM discriminated unions catches missing transitions at compile time |
| FSM | **XState v5** (statecharts, serializable, guard/timeout native) or hand-rolled typed reducer | Testable, replayable, visualizable. Use exhaustive `switch` on state+event with `never`-check default |
| Money | `decimal.js` / `big.js` or scaled `bigint` | No float drift |
| Durable log/store | **`better-sqlite3`** (WAL mode, synchronous) | ACID, embedded, no async write-path races, survives restart |
| Schema/validation | **Zod** at every venue boundary | Untrusted venue payloads validated before they touch core; bad shapes never corrupt state |
| Concurrency | Per-account async queue / `async-mutex`; single-writer actors | Serialize mutations; kill interleaving-across-await bugs |
| Time | NTP-synced host; monotonic clock for timers; venue time for windows | recvWindow correctness |
| WS | `ws` + per-venue adapter (reconnect, heartbeat, listenKey/seq mgmt) | Resilient streams |
| HTTP | `undici` (keep-alive pools, low overhead) | Fast authoritative pulls |
| IDs | `crypto`-free deterministic scheme + persisted counter | Idempotent placement |
| Observability | structured logs (pino), metrics (prom-client), traces; **per-account reconcile-lag, UNKNOWN-count, drift-correction-count dashboards + alerts** | You cannot operate this blind |
| Testing | property/fuzz tests over event orderings (fast-check); golden-log replay determinism test; chaos (drop/dup/reorder/timeout injection) in CI | The only way to trust an FSM is to fuzz it |

> **Node-specific landmine:** the event loop gives you *cooperative* single-threading, not transactional handlers. An `async` event handler that `await`s an HTTP call mid-transition yields control; a second event for the same order can run and observe half-applied state. **Serialize every account's mutations through an explicit queue** so each event is fully applied (synchronous fold + durable append) before the next begins. Do the network I/O *outside* the critical section, as effects. This single discipline prevents a whole class of phantom-state bugs.

---

## 14. Operational Practices

- **Boot gate:** no trading until every account reconciles clean (§9.3).
- **Kill switch / global flatten:** one command halts all submits and (per policy) cancels resting + flattens positions. Wire it to the circuit breakers and the QUARANTINE state.
- **Per-account health = f(WS freshness, reconcile-lag, UNKNOWN-count, error-rate).** Unhealthy ⇒ no new orders for that account; existing legs managed conservatively.
- **Drift budget:** alert on *any* `*Corrected` event; page if correction frequency or magnitude exceeds threshold (correction is a symptom of a real bug, not a routine event).
- **Reconcile-lag SLO:** max age of last successful full reconcile per account; breach ⇒ degrade.
- **Replay drills:** regularly rebuild projections from the log in a shadow process and diff against live — proves determinism and catches silent fold bugs.
- **Latency vs correctness, codified:** the gating path may *block* on reconciliation/Resolver; the market-data/quoting path may not. Keep them on separate clocks. Correctness wins on the capital-committing path, full stop.

---

## 15. Anti-Patterns (do not do these)

- ❌ Mutating a balance/position number in place as the source of truth. (Append events; project.)
- ❌ Trusting WS as authoritative. (It's an optimization over REST truth.)
- ❌ Treating a timeout as "failed." (It's `UNKNOWN`; resolve it.)
- ❌ Retrying a placement before knowing the prior attempt's outcome (without deterministic ids).
- ❌ Random/wall-clock inside `apply()`. (Breaks replay determinism.)
- ❌ Floats for money.
- ❌ Recomputing portfolio margin yourself to gate trades on unified-margin venues. (Read the venue's available-margin.)
- ❌ Starting to trade on boot before reconciliation completes.
- ❌ Silent patching of a mismatch. (Always an event + alert.)
- ❌ Sharing one "available balance" read across two legs without a reservation ledger.
- ❌ Async handlers racing across `await` on shared order/account state.

---

### One-paragraph summary

Make an **append-only event log** the single source of local truth and derive every balance, order, position, and reservation as a **deterministic projection** of it. Drive orders through an **explicit FSM** with first-class **in-flight** (`PENDING_*`) and **`UNKNOWN`** states, so a lost ack becomes a *resolvable* condition rather than a guess; resolve it against the venue via **deterministic client order IDs** (idempotent placement) and a **Resolver** that pulls authoritative REST status. Apply fills **exactly once** by `tradeId`. Prevent double-spend with a **single-writer capital reservation ledger** that both arb legs pass through before either sends. **Persist intent before sending**, and on restart **reconcile every account against the venue before enabling trading**. Run **continuous three-way reconciliation** (local ⇄ WS ⇄ REST), detect **sequence gaps**, and on any unresolvable divergence **degrade to a safe, frozen, honest state and page a human** — because in this system, a stale-but-silent account view is the one failure that loses real money.