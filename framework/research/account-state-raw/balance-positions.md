# Reliable Local Account State for CEX-CEX Crypto Arbitrage

**Balances · Orders · Trades/Fills · Positions · Funding · Fees**
A reconciliation-first reference architecture for a single-host, multi-venue (≈15 exchanges), multi-subaccount Node.js/TypeScript system.

---

## 0. The One Idea Everything Hangs On

> **The exchange is the only source of truth. Local state is a cache that is always assumed wrong until proven right, and is gated so that "wrong" can never spend money it doesn't have.**

Every design decision below derives from three premises you stated and I am hard-coding into the architecture:

1. **Every ack can be lost, every stream drops messages, every local view eventually diverges.** Therefore local state is *optimistic* and *provisional*, and there is always an independent authoritative path (REST) that overwrites it.
2. **Silently-wrong state is worse than no state.** Therefore divergence is detected aggressively, surfaced as a first-class signal, and triggers *halt-then-resync*, never "patch and keep trading."
3. **Capital is shared across legs.** Therefore the gate that lets the strategy spend is a *pessimistic reservation ledger* that is decremented the instant an intent is formed — before the order is even sent — and is atomic by construction.

The system is built as **three concentric rings of truth**, each correcting the one inside it:

```
        ┌─────────────────────────────────────────────┐
        │  RING 3: REST snapshot reconciler (TRUTH)     │  periodic + on-anomaly
        │   ┌───────────────────────────────────────┐  │
        │   │ RING 2: Private WS deltas (AUTHORITATIVE│  │  continuous
        │   │   ┌───────────────────────────────────┐│  │
        │   │   │ RING 1: Optimistic local model    ││  │  instant, low-latency
        │   │   │   (our own actions + acks)        ││  │
        │   │   └───────────────────────────────────┘│  │
        │   └───────────────────────────────────────┘  │
        └─────────────────────────────────────────────┘
   Ring 1 gives latency. Ring 2 corrects Ring 1. Ring 3 corrects everything.
   On conflict: outer ring always wins. Venue (Ring 3) is final.
```

---

## 1. Architecture Overview

### 1.1 Component topology

```
Per-venue WS adapter ─┐
Per-venue REST adapter─┤→ NORMALIZER (anti-corruption layer)
                       │      │ canonical events only
                       │      ▼
                       │  SEQUENCE/GAP GUARD ──(gap)──► forces RESYNC
                       │      │
                       │      ▼
                       │  EVENT LOG (append-only, fsync'd)  ◄── source of truth for replay
                       │      │
                       │      ▼
                       │  PROJECTIONS:  Orders FSM | Balances+Reservations | Positions FSM | Funding FSM
                       │      │
                       │      ▼
                       │  INVARIANT CHECKER (continuous) ──(violation)──► HALT scope + alert
                       │      │
RECONCILER (Ring 3) ───┘      ▼
                          CAPITAL GATE  ◄── strategy asks "can I spend X?" (synchronous, atomic)
                              │
                              ▼
                          STRATEGY / ORDER ROUTER
```

### 1.2 The anti-corruption layer (non-negotiable for 15 venues)

Fifteen venues means fifteen dialects of field names, sign conventions, precision rules, funding cadences, and margin models. **The core state engine must never see a raw venue payload.** Each venue gets an adapter that translates raw frames into one **canonical event vocabulary**:

| Canonical event | Carries | Emitted from |
|---|---|---|
| `OrderAccepted` | clientOrderId, venueOrderId, symbol, side, type, qty, price, ts, seq | WS + REST |
| `OrderRejected` | clientOrderId, reasonCode, ts | WS + REST + ack |
| `OrderFill` | clientOrderId, venueOrderId, **execId**, fillQty, fillPrice, fee, **feeAsset**, isMaker, ts, seq | WS + REST trades |
| `OrderCanceled` / `OrderExpired` | clientOrderId, cumQty, ts | WS + REST |
| `BalanceSnapshot` | scope, asset, total, available, locked, ts | REST |
| `BalanceDelta` | scope, asset, deltaTotal, deltaAvailable, cause, ts, seq | WS |
| `PositionSnapshot` | scope, symbol, signedSize, avgEntry, leverage, liqPrice, uPnL, marginMode | REST |
| `PositionDelta` | scope, symbol, signedSizeΔ, newAvgEntry, ts, seq | WS |
| `FundingSettled` | scope, symbol, amount, asset, fundingRate, ts | WS + REST funding history |
| `Liquidation` / `ADL` | scope, symbol, qty, price, ts | WS + REST |

Every event carries a **scope** key: `{venue, subaccount, marketType, asset|symbol}`. Cross-scope contamination (applying a Bybit-UTA delta to a Binance-spot cell) is one of the nastiest silent-corruption bugs; the scope key in every event makes it structurally impossible to route an event to the wrong cell.

Validate every inbound payload at this boundary with **zod** (or equivalent) before it becomes a canonical event. A malformed/partial frame must be rejected loudly, not coerced.

---

## 2. Data Structures & Algorithms (Dimension 5)

### 2.1 Money is never a float

JS `number` is IEEE-754 double; `0.1 + 0.2 !== 0.3`. Accumulating fills/funding in float guarantees slow divergence and eventual invariant violations.

- **Storage & arithmetic:** `decimal.js` (or `big.js`/`dnum`) for all monetary quantities, or **scaled `bigint`** (integer minor units at the asset's max precision) on hot paths.
- **Direction of rounding is a safety property, not an aesthetic.** Always round in the *conservative* direction:
  - `available` → round **down**.
  - `reservation` / required capital → round **up**.
  - quantities to venue `lotSize`/`stepSize`, prices to `tickSize`, using the venue's own filters.
- Persist precision metadata per (venue, asset, symbol): `pricePrecision`, `qtyPrecision`, `stepSize`, `tickSize`, `minNotional`. Refresh from exchange-info on startup and daily.

### 2.2 Core in-memory structures

```ts
// Orders — three indices so every event-correlation key resolves O(1)
ordersByClient: Map<ClientOrderId, Order>          // primary, our key
clientByVenueId: Map<VenueOrderId, ClientOrderId>  // venue→ours (WS often has venue id)
openOrdersBySymbol: Map<ScopeKey, Set<ClientOrderId>>  // for set-diff reconcile

// Fill idempotency — dedup is mandatory; fills arrive via WS *and* REST reconcile
appliedExecIds: BoundedSet<`${Venue}:${ExecId}`>   // LRU in RAM, mirrored to disk

// Balances — two-tier
confirmed: Map<ScopeKey→AssetKey, { total: Dec, available: Dec, locked: Dec }>
reservations: Map<ReservationId, Reservation>
reservedByAsset: Map<ScopeKey→AssetKey, Dec>       // running sum, maintained incrementally

// Positions
positions: Map<ScopeKey→Symbol, Position>          // signedSize, avgEntry, leverage, liqPrice, uPnL...

// Sequence cursors — per (venue, channel)
seqCursor: Map<ChannelKey, { lastSeq: bigint, lastApplied: ts }>

// Funding
fundingState: Map<ScopeKey→Symbol, FundingCell>
```

### 2.3 Algorithms you will implement precisely

**A. Average-entry / cost-basis update (perp & margin spot).** On a fill of signed size `q` at price `p`:

- **Increasing or opening** (same sign, or from flat): new size `S' = S + q`; new avg `E' = (E·|S| + p·|q|) / |S'|`. Realized PnL = 0.
- **Reducing** (opposite sign, `|q| < |S|`): avg entry **unchanged**; `realizedPnL += (p − E)·(closedQty)·sign`. Size shrinks.
- **Closing exactly** (`|q| == |S|`): realize on full size, `E' = 0`, `S' = 0` → FLAT.

**B. Idempotent fill application.** `apply(fill)`:
```
key = venue + ":" + fill.execId
if appliedExecIds.has(key): return            // dedup — exactly-once
persistEvent(fill); appliedExecIds.add(key)   // persist BEFORE mutating projections
order.cumQty += fill.qty
balance/position updated; reservation reconciled
```

**C. Open-order set-diff reconcile.** `localOpen = openOrdersBySymbol[scope]`, `venueOpen = REST.openOrders(scope)`:
- `inVenueNotLocal` → we missed an `OrderAccepted` (or restarted). **Adopt** it.
- `inLocalNotVenue` → order terminalized at venue but we missed the event. Query its terminal state by clientOrderId, apply, release reservation.
- `inBoth` but qty differs → missed fill(s). Pull trade history for that order, apply missing fills idempotently.

**D. Gap detection.** Per channel, expect monotonic seq. On `recv.seq != cursor.lastSeq + 1` (or venue's `prevSeqId != lastSeq`): do **not** apply the delta; mark scope `STALE`; trigger Ring-3 resync; resume only after snapshot reconciles.

---

## 3. Order Lifecycle FSM (the spine)

Balance, position, and funding state are all *downstream* of order outcomes, so the order FSM is defined first. Every order is keyed by a **deterministic clientOrderId generated before sending** — this is the correlation key that survives lost acks, restarts, and stream gaps.

### 3.1 States

| State | Meaning | Terminal? |
|---|---|---|
| `INTENT` | Strategy decided to place; capital reservation requested | no |
| `RESERVED` | Capital held locally; not yet sent | no |
| `SENDING` | Request in flight to venue | no |
| `OPEN` | Acked, live on book, 0 fills | no |
| `PARTIALLY_FILLED` | Live, `0 < cumQty < qty` | no |
| `CANCELING` | Cancel requested, awaiting confirmation | no |
| `FILLED` | `cumQty == qty` | **yes** |
| `CANCELED` | Venue confirmed cancel | **yes** |
| `REJECTED` | Venue rejected | **yes** |
| `EXPIRED` | TIF/GTD/post-only expiry | **yes** |
| `UNKNOWN` | Ack lost / gap / restart-orphan — true state must be queried | no (resolves) |

### 3.2 Transition table

| From | Trigger / Guard | Action (entry of target) | To |
|---|---|---|---|
| `INTENT` | reservation **succeeds** | create `Reservation`, persist | `RESERVED` |
| `INTENT` | reservation **fails** (insufficient effective available) | emit `OrderRejected(local)`, abort sibling leg | `REJECTED` |
| `RESERVED` | send REST `placeOrder` | start ack timer; persist `SENDING` **before** socket write | `SENDING` |
| `SENDING` | ack received, accepted | bind venueOrderId; index | `OPEN` |
| `SENDING` | ack received, rejected | release reservation | `REJECTED` |
| `SENDING` | ack **timeout** | (see §7.1 lost-ack) → query by clientOrderId | `UNKNOWN` |
| `OPEN` | `OrderFill`, cumQty<qty | apply fill; convert reserved→spent | `PARTIALLY_FILLED` |
| `OPEN` | `OrderFill`, cumQty==qty | apply fill; release residual reservation | `FILLED` |
| `OPEN` | strategy cancel | send cancel | `CANCELING` |
| `OPEN` | `OrderExpired` | release reservation | `EXPIRED` |
| `PARTIALLY_FILLED` | more fills, cumQty==qty | apply; release residual | `FILLED` |
| `PARTIALLY_FILLED` | cancel of remainder | send cancel | `CANCELING` |
| `CANCELING` | cancel confirmed | release reservation on unfilled qty | `CANCELED` |
| `CANCELING` | **fill races in** before cancel lands | apply fill (venue wins); maybe FILLED | `PARTIALLY_FILLED`/`FILLED` |
| `CANCELING` | cancel rejected ("unknown order"/already done) | query terminal state, adopt | terminal |
| `UNKNOWN` | REST: order exists | adopt full venue state | matching live/terminal |
| `UNKNOWN` | REST: not found after grace window | safe to treat as never-placed | `REJECTED` |
| any non-terminal | **age > maxAge** without venue confirmation | force REST query | `UNKNOWN` |

### 3.3 Entry/exit actions that matter

- **On `RESERVED` entry:** the hold exists and `effective_available` drops for *all* concurrent decisions — this is what stops double-commit.
- **On any terminal entry:** the reservation is fully resolved (consumed for filled qty, released for the rest). **Invariant: no terminal order may leave a live reservation.**
- **On `SENDING` entry:** persist *before* the network write. A crash between write and ack is then recoverable: restart finds a `SENDING`/`UNKNOWN` order and queries it.

---

## 4. Balance & Capital Accounting (Dimension 6)

### 4.1 The two-tier model

```
effective_available(scope, asset)
      = confirmed_available(scope, asset)          // from venue (Ring 2/3)
      − Σ active_reservations(scope, asset)         // local pessimistic holds
```

`confirmed_available` is **never computed by us** for the wallet itself — it is whatever the venue last told us (WS `BalanceDelta` applied to last REST `BalanceSnapshot`). Our only locally-authored quantity is the **reservation overlay**. This split is the whole trick: the venue owns "what we have," we own "what we've promised to spend."

### 4.2 The reservation (capital hold) lifecycle — and its FSM

A `Reservation` is escrow against our own ledger, keyed to a clientOrderId.

| State | Meaning | Terminal? |
|---|---|---|
| `REQUESTED` | gate checking feasibility | no |
| `HELD` | capital subtracted from effective available | no |
| `PARTIALLY_CONSUMED` | a partial fill consumed part of the hold | no |
| `CONSUMED` | fully spent (order filled) | **yes** |
| `RELEASED` | order died unfilled (cancel/reject/expire) → capital returned | **yes** |
| `ORPHANED` | hold exists but no matching live order (bug/lost event) | recovers → `RELEASED` |

| From | Trigger / Guard | Action | To |
|---|---|---|---|
| `REQUESTED` | `effective_available ≥ required` (required = qty·price·(1+feeBuf)+slipBuf, rounded **up**) | `reservedByAsset += required`; persist | `HELD` |
| `REQUESTED` | insufficient | reject (no mutation) | — (gate returns false) |
| `HELD` | partial fill | move filled notional+fee from hold to spent; shrink hold to remaining | `PARTIALLY_CONSUMED` |
| `HELD`/`PARTIALLY_CONSUMED` | order `FILLED` | hold→0; spent recorded | `CONSUMED` |
| `HELD`/`PARTIALLY_CONSUMED` | order `CANCELED`/`REJECTED`/`EXPIRED` | return remaining hold to available | `RELEASED` |
| `HELD` | **reaper:** no live order for this hold AND TTL exceeded AND REST confirms order terminal | release | `ORPHANED`→`RELEASED` |

### 4.3 Preventing double-commit across legs (the core arb requirement)

Two things make this airtight:

1. **Atomicity for free from Node's single thread.** The gate's check-and-reserve runs as one **synchronous** function with **no `await` inside the critical section**. Because JS runs one tick at a time, no two opportunities can interleave between "read effective available" and "write reservation." This is a genuine architectural advantage of Node here — *do not* `await` between the check and the commit, or you reintroduce the race.

   ```ts
   // ATOMIC — single synchronous tick, no await
   function tryReserve(holds: HoldRequest[]): ReservationId[] | null {
     for (const h of holds)                       // all-or-nothing pre-check
       if (effectiveAvailable(h.scope, h.asset).lt(h.required)) return null;
     return holds.map(commitHold);                // then commit; persist after
   }
   ```

2. **Multi-leg all-or-nothing.** An arb decision reserves capital for **every leg before sending any leg**. If any leg's reservation fails, none are committed (local saga / 2PC). This prevents the classic failure where leg A fires, leg B can't be funded, and you're left unhedged. If legs draw on the *same* asset/scope (e.g., two strategies competing for the same USDT pool), they serialize through the one reservation authority and the second simply sees reduced `effective_available`.

### 4.4 Fees, precision, dust

- **Reserve for worst-case fee** (taker) even if hoping for maker; reconcile the *actual* fee from the fill's `fee`/`feeAsset`.
- **Fee asset asymmetry:** fees may be charged in quote, base, or a third asset (e.g., a fee-token discount). The fill event carries `feeAsset`; deduct from the correct cell. A fee paid in a non-position asset silently moves a balance you weren't watching — track it explicitly.
- **Dust/residue:** after closing, expect small leftover balances from rounding/funding. Don't treat tiny nonzero balances as "still in a trade"; carry a per-asset dust threshold below which a cell is logically flat.

### 4.5 Unified-margin caveat

For **unified-margin / portfolio-margin** accounts (Bybit UTA, OKX unified), `available` is computed by the **venue's risk engine** from total equity − maintenance margin − order margin, with cross-collateral and unrealized PnL folded in. You **cannot** reliably reconstruct it locally. Best practice: treat the venue's reported `equity` / `availableBalance` / `marginBalance` as authoritative (Ring 3, polled more often), and run your reservation overlay *on top of* it. Your local capital math degrades to "track what the venue says, subtract our pending holds" — which is exactly the two-tier model, just with `confirmed_available` driven entirely by the venue.

---

## 5. Position & PnL Tracking (Dimension 7)

### 5.1 Spot vs. perp accounting differences

| | **Spot** | **Linear perp (USDT-margined)** | **Inverse perp (coin-margined)** |
|---|---|---|---|
| "Position" is | just the asset balance | separate position object | separate position object |
| Margin | n/a (or borrowed in margin spot) | posted from quote wallet | posted from coin wallet |
| Size unit | base asset | base/contracts | USD-notional contracts |
| PnL/funding asset | implicit in balances | quote (USDT) | base coin |
| Liquidation | none (unless margin/loan) | yes | yes (different formula) |
| Cost basis | optional (arb cares about realized spread) | required (avg entry) | required |
| Available depends on uPnL? | no | yes (esp. cross margin) | yes |

For **spot**, "position tracking" collapses into balance tracking; the arb engine cares about the realized spread between legs, not a mark-to-market. For **perps**, position is a first-class object with size, avg entry, leverage, liq price, and continuously-marked uPnL.

### 5.2 Position FSM (directional)

| State | Meaning |
|---|---|
| `FLAT` | size 0 |
| `LONG` | size > 0 |
| `SHORT` | size < 0 |
| `OPENING` | flat, an opening order is working (transient) |
| `REDUCING` | reducing order working |
| `CLOSING` | order working that brings size to 0 |
| `FLIPPING` | order will cross through zero (close+reopen opposite) |
| `LIQUIDATING` | venue liquidation/ADL in progress |
| `LIQUIDATED` | involuntarily flattened by venue |
| `DIVERGED` | local size ≠ venue size; trading halted on symbol |

| From | Trigger / Guard | Action (entry/exit) | To |
|---|---|---|---|
| `FLAT` | opening fill (signed q) | set size=q, avgEntry=p; arm liq + funding | `LONG`/`SHORT` |
| `LONG` | fill same sign | recompute avgEntry (weighted); re-arm liq | `LONG` |
| `LONG` | fill opposite, `|q|<size` | realize PnL; avgEntry unchanged; shrink | `LONG` (`REDUCING`) |
| `LONG` | fill opposite, `|q|==size` | realize on full; size→0; disarm liq+funding | `FLAT` |
| `LONG` | fill opposite, `|q|>size` | **split**: close+realize, then open opposite at p | `SHORT` (`FLIPPING`) |
| `LONG`/`SHORT` | `Liquidation`/`ADL` event | record forced fill; realize; **P0 alert** | `LIQUIDATING`→`LIQUIDATED`/`FLAT` |
| `LIQUIDATED` | — | **emergency: the other arb leg is now unhedged** → flatten/rehedge sibling | (strategy) |
| any | Ring-3 size ≠ local size beyond tol | snap to venue; **halt symbol** | `DIVERGED` |
| `DIVERGED` | resync explains delta (missing fill/funding/liq found) | apply; resume | `LONG`/`SHORT`/`FLAT` |
| (mirror all `LONG` rows for `SHORT`) | | | |

### 5.3 Realized vs. unrealized PnL

- **Realized** is event-driven: produced only by reducing/closing fills and by liquidation, computed at fill time from `(fillPrice − avgEntry)·closedQty·sign`. It is a fact, persisted, never re-marked.
- **Unrealized** is a continuous *derived view* from `(orderbook best bid/ask price − avgEntry)·size·sign`. **Do not persist uPnL as state** — recompute from orderbook best bid/ask price. Use the venue's orderbook best bid/ask price. Persisting uPnL leads to stale-mark bugs.

### 5.4 Liquidation-distance tracking

- Prefer the **venue-reported `liqPrice`** as primary (their risk engine is authoritative), and recompute locally as a **cross-check** using the venue's documented formula (inputs: side, avgEntry, leverage, maintenance-margin rate, wallet/cross balance, isolated vs cross). A large discrepancy between local and venue liq price is itself a divergence signal.
- Track `liqDistance = |orderbook best bid/ask price − liqPrice| / orderbook best bid/ask price` as a continuous risk metric; cross-margin liq depends on the whole account, so for cross mode the *account-level* margin ratio matters more than any single symbol's distance.
- Liquidation is the highest-severity state event because in arb it leaves the **opposite leg unhedged** — it must trigger an immediate sibling-leg response, not just a state update.

---

## 6. Funding Fees (Dimension 8)

### 6.1 Mechanics by market type

- **Linear (USDT) perps:** funding settles in **quote (USDT)** → directly hits wallet `available`/`total`.
- **Inverse perps:** funding settles in **base coin** → hits the coin-margin balance.
- **Cadence varies:** 8h is common, but many symbols/venues use 4h or 1h; some use dynamic intervals. Store `fundingInterval` and `nextFundingTime` per symbol from exchange info; never hard-code 8h.
- **Direction:** positive rate → longs pay shorts. Your payment = `−sign(size)·|size|·markPrice·fundingRate` (sign conventions differ per venue; normalize in the adapter).

### 6.2 Does funding touch cost basis? (be precise)

**On most venues, no.** Funding is a **separate cash flow** that settles to the wallet and is recorded as realized funding PnL; it does **not** change `avgEntry` or position `size`. Folding funding into avg entry corrupts your cost basis and will diverge from the venue's reported entry. 

If a strategy wants an *effective* breakeven that includes funding paid, compute that as a **derived view** (`effectiveBreakeven = avgEntry ± accumulatedFunding/size`) — keep it separate from the canonical `avgEntry` that you reconcile against the venue.

### 6.3 Funding FSM (per position-interval)

| State | Meaning |
|---|---|
| `NO_ACCRUAL` | flat, or no position held this interval |
| `ACCRUING` | holding a position within the current interval; predicted funding tracked |
| `SETTLEMENT_PENDING` | at/just past `nextFundingTime`, awaiting settlement event |
| `SETTLED` | funding applied to balance for this interval |
| `RECONCILING` | verifying applied funding against venue funding history |

| From | Trigger / Guard | Action | To |
|---|---|---|---|
| `NO_ACCRUAL` | position becomes non-flat | start predicted accrual = `size·mark·predictedRate` | `ACCRUING` |
| `ACCRUING` | mark/rate update | refresh predicted funding (used by the gate: arb edge must exceed expected funding over hold time) | `ACCRUING` |
| `ACCRUING` | `now ≥ nextFundingTime` | freeze predicted; expect settlement | `SETTLEMENT_PENDING` |
| `SETTLEMENT_PENDING` | `FundingSettled` event | apply amount to balance (idempotent on funding id/ts); record realized funding | `SETTLED` |
| `SETTLEMENT_PENDING` | grace window passes, **no** settlement event | pull REST funding history | `RECONCILING` |
| `SETTLED`/`RECONCILING` | venue funding history checked | if applied ≠ actual, correct balance; advance `nextFundingTime` | `ACCRUING` or `NO_ACCRUAL` |

### 6.4 Prediction for gating

The strategy must include **expected funding cost over the expected holding period** when deciding whether an arb is profitable (a spot-perp carry can be eaten alive by funding). Maintain a predicted-funding estimate per open perp leg from the venue's `predictedFundingRate` + `size`, refreshed each tick. This is a *forecast view*, not persisted state.

---

## 7. Failure Modes, Errors & Invariant Violations (Dimension 13)

Each entry: **detection → recovery**. The default recovery posture is **halt the affected scope, resync against the venue, resume only when invariants hold again.** Never "guess and continue."

### 7.1 Lost order ack
- **Detection:** ack timer fires with no response → order is `UNKNOWN`.
- **Recovery:** query by **clientOrderId** via REST. Found → adopt venue state. Not found after a grace window (covers propagation delay) → treat as never-placed (`REJECTED`), release hold. **Never blindly resend** — that risks a duplicate order. The deterministic clientOrderId is what makes this safe and idempotent.

### 7.2 Lost fill event
- **Detection:** Ring-3 reconcile shows position/balance delta unexplained by known fills, or `order.cumQty(venue) > Σ known fills`.
- **Recovery:** pull trade history for that order/symbol; apply missing fills idempotently (dedup by execId). Position and balance correct themselves through normal fill-application.

### 7.3 WS disconnect / stale stream / heartbeat loss
- **Detection:** missed pong/heartbeat, or "no events for T seconds while REST shows changes."
- **Recovery:** mark all scopes on that socket `STALE`; reconnect; **full REST resync before re-trusting deltas**; resume.

### 7.4 Sequence gap / reordering
- **Detection:** `seq != expected` (or `prevSeqId != lastSeq`); or illegal FSM transition (e.g., cancel before accept).
- **Recovery:** drop the suspect delta, mark scope `STALE`, Ring-3 resync. The FSM rejecting an illegal transition is itself a gap detector.

### 7.5 listenKey expiry (Binance-class)
- **Detection:** keepalive failure, or stream silently stops while REST shows changes.
- **Recovery:** obtain new listenKey, reconnect, resync. Run keepalive well within the venue's TTL.

### 7.6 Clock skew
- **Detection:** signed-request rejections (`recvWindow`), or funding-time logic firing early/late.
- **Recovery:** maintain a **venue server-time offset** (periodically sample server time); stamp requests with corrected time; use `process.hrtime`/`performance.now` (monotonic) for internal ordering, never wall-clock.

### 7.7 Rate limit / IP ban (429)
- **Detection:** 429 / ban response; weight budget exhausted.
- **Recovery:** exponential backoff with jitter; a per-venue weight budgeter that **prioritizes critical reconcile calls** (open orders, balances, positions) over nice-to-haves; prefer WS for live data so REST budget is reserved for reconciliation.

### 7.8 Cancel/fill race
- **Detection:** cancel rejected as "unknown/already filled," or a fill arrives during `CANCELING`.
- **Recovery:** venue wins — query and adopt the terminal state; reconcile filled vs. canceled qty; resolve the reservation accordingly.

### 7.9 Duplicate / out-of-order events
- **Detection:** execId already in `appliedExecIds`; or seq/timestamp ordering.
- **Recovery:** dedup drops duplicates (exactly-once). Ordering handled by seq guard.

### 7.10 Orphaned reservation
- **Detection:** a `HELD` reservation with no matching non-terminal order, past TTL.
- **Recovery:** **reaper** job cross-checks against open orders + recent terminal events + REST; if order is genuinely terminal, release the hold (carefully — confirm via REST first, so you don't release capital for an order that's actually live). Without the reaper, lost terminal events slowly leak available capital.

### 7.11 Negative/impossible available
- **Detection (invariant I1):** `effective_available < 0`, or `Σ reservations > confirmed_available`.
- **Recovery:** halt scope, Ring-3 resync of balances, audit reservation ledger for orphans/double-holds.

### 7.12 Position divergence
- **Detection:** local signed size ≠ venue size beyond tolerance.
- **Recovery:** snap to venue, `DIVERGED`, halt symbol; investigate via missing-fill / funding / liquidation reconcile; resume when explained.

### 7.13 Unexpected liquidation / ADL (**P0**)
- **Detection:** position flattened/flipped with a liquidation fill or ADL event; unexplained margin drop.
- **Recovery:** **critical.** Halt the strategy on that symbol/venue; immediately **flatten or re-hedge the opposite arb leg** (it is now naked); alert a human. This is the failure that loses the most money fastest in arb, so it gets the loudest path.

### 7.14 Funding mis-settlement
- **Detection:** balance delta at funding time ≠ predicted; or settlement event missing past grace window.
- **Recovery:** reconcile from REST funding history; correct balance; do not let predicted funding masquerade as realized.

### 7.15 Process crash mid-flight
- **Detection:** restart finds non-terminal orders (`SENDING`/`UNKNOWN`) and stale cursors.
- **Recovery:** replay event log → rebuild projections → Ring-3 reconcile every scope against the venue → resolve every `UNKNOWN` by clientOrderId → adopt venue-side orphans → only then unblock the strategy. (See §8.)

### 7.16 Precision / rounding drift
- **Detection (invariant I8/I4):** accumulated size/balance disagrees with venue beyond a tight tolerance.
- **Recovery:** decimal/integer math + conservative rounding prevent most; on detection, snap to venue and log the source.

### 7.17 Cross-scope contamination
- **Detection:** an event whose scope key doesn't match any known cell; or an invariant violation localized to a wrong cell.
- **Recovery:** scope keys on every event make mis-routing structurally hard; reject unrecognized scopes loudly.

### 7.19 The invariant set (checked continuously)

| ID | Invariant | On violation |
|---|---|---|
| I1 | `effective_available ≥ 0` per (scope, asset) | halt scope, resync |
| I2 | `Σ reservations ≤ confirmed_available` | halt, audit holds |
| I3 | `order.cumQty == Σ applied fills` | pull trade history |
| I4 | `position.size == signed Σ fills since flat` (± liq) | snap to venue, `DIVERGED` |
| I5 | every active reservation ↔ a non-terminal order | reaper releases orphans |
| I6 | every non-terminal order has a hold (unless reduce-only) | re-derive or halt |
| I7 | local open-orders set == venue open-orders set | adopt/terminalize diff |
| I8 | local avg-entry ≈ venue avg-entry (tol) | snap to venue |
| I9 | no non-terminal order older than maxAge unconfirmed | force `UNKNOWN` query |
| I10 | no execId applied twice | dedup (enforced at apply) |

A violation is never patched silently; it is **logged as a divergence metric, halts the smallest scope that contains it, and triggers resync.** Divergence count is a first-class SLO — a rising rate means a real bug, not noise.

---

## 8. Persistence & Restart Recovery (single host)

You said single-region/single-host with survive-restart. Embedded storage is the right call — no network hop, synchronous, crash-safe.

- **Engine:** `better-sqlite3` (synchronous, WAL mode, fast, transactional) or `lmdb-js`. Synchronous writes pair naturally with the synchronous reservation critical section.
- **Persist (event-sourcing + snapshots):**
  1. **Append-only event log** — the source of truth (every canonical event).
  2. **Periodic snapshot** of projections (balances, reservations, orders, positions, funding) for fast restart.
  3. **Auxiliary:** `appliedExecIds` dedup set, sequence cursors, last-reconcile timestamps.
- **Write ordering = a write-ahead discipline (this is the crash-safety contract):**
  - Persist `SENDING`/reservation **before** the socket write → a crash leaves a recoverable `UNKNOWN`.
  - Persist a fill **before** mutating projections or acting on it → exactly-once survives crashes.
  - `fsync` the critical writes (reservation create, fill apply, terminal transitions).
- **Cold-start sequence:**
  1. Load latest snapshot.
  2. Replay event log after the snapshot point → rebuild projections.
  3. **Ring-3 full reconcile** every scope (balances, open orders, positions, recent fills, recent funding).
  4. Resolve every non-terminal/`UNKNOWN` order by clientOrderId; adopt venue-side orphans.
  5. Run the full invariant set; release orphaned holds via the reaper.
  6. Only after all scopes pass invariants → unblock the strategy/gate.

---

## 9. Recommended Node.js / TypeScript Stack

| Concern | Choice | Why |
|---|---|---|
| Decimal math | `decimal.js` / `big.js` / `dnum`, or scaled `bigint` hot-path | never float for money; conservative rounding |
| FSMs (orders/positions/funding) | **XState** for lifecycle FSMs; typed discriminated-union reducers on hottest paths | XState gives explicit, inspectable, *auditable* statecharts — illegal transitions become detectors; reducers where perf dominates |
| Boundary validation | **zod** | parse untrusted venue payloads → fail loud, not coerce |
| Persistence | **better-sqlite3** (WAL) or **lmdb-js** | synchronous, transactional, crash-safe, single-host |
| WS | `ws` + per-venue adapters | normalize into canonical events |
| Time | venue server-time offset + monotonic `hrtime` | recvWindow correctness; ordering without wall-clock |
| Concurrency | exploit Node's single thread; **no `await` in the reserve critical section** | atomic capital gate for free |
| Observability | structured logs + metrics: divergence rate, reconcile lag, reservation utilization, halt events, orphan-reap count, liq-distance | divergence and halts are first-class SLOs |

---

## 10. Operating Principles (the short version)

1. **Venue is truth; local is a gated cache.** Outer ring always wins on conflict.
2. **Reserve before you send.** Pessimistic, atomic, all-or-nothing across legs — this is what stops double-commit.
3. **Deterministic clientOrderId on everything.** It survives lost acks, gaps, and restarts.
4. **Idempotent, exactly-once fill application** keyed by execId.
5. **Gap/heartbeat/seq detection → STALE → resync.** Never apply across a gap.
6. **Halt-then-reconcile on divergence.** Silently-wrong state is the enemy; halting the smallest scope is cheap, trading on bad state is not.
7. **Liquidation/unhedged-leg is P0** — it triggers an active sibling-leg response, not a passive state update.
8. **Decimal/integer math, conservative rounding** in the safe direction always.
9. **Write-ahead persistence**: persist intent before acting, so every crash is recoverable.
10. **Divergence count and halt events are SLOs.** A clean system should reconcile to zero diffs; a rising diff rate is a bug, surfaced loudly.