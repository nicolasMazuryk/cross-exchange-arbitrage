# 04 — Balances, Capital, Funding & Fees

**Scope:** the two-tier balance model, the capital reservation ledger and its FSM, the atomic reservation gate and multi-leg (arbitrage) all-or-nothing commitment, fee modeling, unified-margin accounts, and the funding-rate lifecycle. Cross-references: canonical balance events/structures → `01 §7`, order FSM & fill application → `03`, reconciliation tolerances → `05`, persistence → `06`, breakers/gates → `07`.

The capital ledger is where arb systems quietly die: two opportunities firing 3 ms apart against the same balance read is the classic double-spend.

---

## 1. The two-tier balance model

Maintain **two layers** per `(venue, subaccount, marketType, asset)` cell, and never confuse them:

1. **Confirmed (venue) balance** — what the venue last told us: `total`, `available`, `locked`. Owned by venue events + reconcile. **Only the venue moves it.** Updated from WS deltas, snapped to REST on reconcile.
2. **Reservation overlay (ours)** — capital we have *internally committed* but the venue doesn't know yet (orders not yet acked, in-flight legs, safety buffers). Owned by the capital allocator.

Strategy sizing reads the derived figure:

```
effective_available(scope, asset) =
    confirmed_available(scope, asset)
  − Σ active_reservations(scope, asset)
  − safety_buffer(scope, asset)
```

Properties that make this safe:

- **The venue owns `confirmed`; we own `reservations`.** No code path may "adjust" confirmed balance because we *think* a fill happened — confirmed moves only on venue evidence (event or snapshot). Our optimism lives entirely in the overlay, where it can be audited and expired.
- **Never sum balances across market types the venue segregates.** Spot, linear-futures wallets are distinct cells; transfers between them are explicit, tracked operations (initiate → poll/confirm → apply), not arithmetic. Sub-account transfers have their own latency and failure modes — model a transfer as a tiny FSM (`REQUESTED → SENT → CONFIRMED/FAILED/UNKNOWN`) like an order.
- **The safety buffer is not paranoia décor:** it absorbs in-flight fees, funding accrual since the last snapshot, and venue rounding (set per scope from observed fee/funding magnitudes, §4–§6).
- The deployable figure is additionally gated by health: `deployable = effective_available × (state == LIVE ∧ fresh ∧ invariants hold ? 1 : 0)` (→ `05 §7`). Stale or diverged ⇒ deployable is **0** by construction.

---

## 2. The reservation ledger

### 2.1 Reservation FSM

| State | Meaning | Invariant |
|---|---|---|
| `REQUESTED` | Strategy asked; allocator evaluating | not yet counted against available |
| `HELD` | Granted and **counted against effective_available** | has TTL; linked to an order intent (coid) or transfer |
| `PARTIALLY_CONSUMED` | Linked order partially filled; reservation shrunk to leftover exposure | reserved ≥ worst-case remaining cost |
| `CONSUMED` | Linked order filled; the venue's own `locked`/balance movement now reflects reality | overlay entry retired (venue took over) |
| `RELEASED` | Order terminal-without-full-fill (canceled/rejected/expired leftover) or TTL expiry **after venue-confirmed safety** | capital returned to effective_available |
| `ORPHANED` | TTL expired but linked order state unknown | **not auto-released**; Resolver must resolve the order first |

| From → To | Trigger | Guard | Action |
|---|---|---|---|
| `REQUESTED → HELD` | allocator grant | `effective_available ≥ amount` **atomically checked & decremented in one synchronous step** (§3) | append `ReservationHeld`; start TTL |
| `REQUESTED → (denied)` | insufficient | — | strategy informed; no state change |
| `HELD → PARTIALLY_CONSUMED` | linked order partial fill | fill applied exactly-once (→ `03 §7`) | shrink reservation by filled-notional + fees |
| `HELD/PARTIALLY_CONSUMED → CONSUMED` | linked order `FILLED` | venue balance delta observed (or snapshot confirms) | retire overlay entry |
| `HELD/PARTIALLY_CONSUMED → RELEASED` | linked order `CANCELED/REJECTED/EXPIRED` | leftover computed from final cumFilled | release leftover only |
| `HELD → ORPHANED` | TTL expiry | linked order non-terminal or `UNKNOWN` | alert; hand to Resolver; **keep holding** |
| `ORPHANED → RELEASED/CONSUMED` | Resolver verdict | venue-confirmed terminal state | settle accordingly |

**Why TTL + reaper:** a reservation leak (granted, never settled) silently shrinks deployable capital until the system thinks it's broke; the reaper guarantees convergence. **Why the reaper must not blind-release:** releasing while the linked order might be live re-creates the double-spend. The reaper **confirms with the venue (REST query by coid) before releasing** — reservation release requires *venue-confirmed* terminality of the linked order.

### 2.2 Two-phase protocol (tied to the order FSM)

```
Reserve (sync, atomic)      → before send; INTENT may not become PENDING_NEW without it
Adjust  (on partial fills)  → shrink to leftover worst-case
Commit/Release (terminal)   → CONSUMED on FILLED; release leftover on CANCELED/REJECTED/EXPIRED
Pessimistic hold (UNKNOWN)  → reservation persists until Resolver verdict (max(old,new) for ambiguous amends)
```

### 2.3 Reservations are reconciled too

Periodically assert `Σ open reservations ≈ Σ venue-side locked` for orders we believe are open (convert reservations to the venue's locking convention before comparing — venues lock quote-for-buys / base-for-sells / margin-for-derivatives differently; encode per-venue locking rules in the adapter). Persistent mismatch ⇒ a leaked or missing reservation ⇒ reconcile orders first, then repair the ledger (→ `05`). Invariant: every reservation's linked order is non-terminal; every open order has a matching reservation (or an explicit exemption, e.g., adopted external orders).

---

## 3. The atomic gate & multi-leg commitment

### 3.1 No-await critical section (the double-spend killer)

Reservation **check-and-decrement is one synchronous, no-await step** inside the single-writer allocator. In Node, synchronous code is atomic with respect to the event loop — but only if you never yield mid-operation:

```ts
// Inside the allocator (single writer). No await between check and reserve.
tryReserve(scope: ScopeKey, asset: Asset, amount: Dec, ref: OrderRef): Reservation | null {
  const avail = this.effectiveAvailable(scope, asset);   // pure, in-memory
  if (avail.lt(amount)) return null;
  const r = new Reservation(scope, asset, amount, ref, ttl);
  this.reservations.set(r.id, r);
  this.reservedByAsset.adjust(scope, asset, amount);     // incremental running sum
  this.journal.append({ k: 'ReservationHeld', ...r });   // sync append; fsync per 06 §3
  return r;
}
// The venue call happens AFTER, outside the critical section, as an effect.
```

An `await` between the check and the write reopens the race (→ `01 §5`). Two strategies hitting the allocator in the same tick serialize through this synchronous path; the loser sees the updated figure.

### 3.2 Allocator placement in the worker topology

With per-venue workers (→ `01 §2`), per-venue/per-asset reservations live naturally in the venue worker's actor. **Cross-venue, cross-leg capital policy needs one authority:** run the *global* allocator as a single-writer component (its own small worker, or in the execution worker), granting leg reservations against per-venue cells via the venue workers' synchronous grant protocol — request/grant over the peer channel, with the per-cell check-and-decrement still executing inside the owning venue worker's thread (so each cell keeps exactly one writer). The strategy's SAB reads (→ `01 §4`) are *advisory* sizing inputs; **only the allocator's grant is binding.**

### 3.3 Multi-leg (arbitrage) all-or-nothing

A two-leg arb must **reserve both legs before sending either**:

```
1. tryReserve(legA) — venue A cell
2. tryReserve(legB) — venue B cell
   └─ on failure: release legA immediately; abort opportunity (no partial commitment)
3. persist both intents (06 §3) → send both legs
4. settle reservations independently as each leg's order FSM resolves
```

- **Atomic across legs at the *reservation* layer** — you cannot guarantee atomicity at the venue layer, so guarantee it where you can: capital. A one-legged *reservation* must be impossible; a one-legged *fill* is then a bounded, known exposure rather than an unfunded surprise.
- **The unwind path is mandatory:** leg A filled, leg B rejected/unfilled/UNKNOWN ⇒ you are directionally exposed. The strategy layer must have an explicit, pre-decided unwind/re-hedge policy (market-out, re-quote, or hold-with-limit), and the account layer must surface **leg imbalance** as a top-priority signal — `Σ(filled exposure across paired legs) ≠ 0` beyond tolerance is effectively a position-limit breach in disguise. Liquidation/ADL on one leg triggers the *active sibling response* (→ `03 §8.5`).
- **Fill attribution:** because the coid encodes `(strategy, leg)` (→ `03 §1`), every fill maps to its arb decision instantly — leg-imbalance detection is a constant-time fold over fills, not a forensic exercise.

---

## 4. Fees

- **Reserve worst-case (taker) fees** at reservation time; reconcile to actual fees on fill events. Fee tiers change (volume tiers, promos) — refresh fee schedules periodically off the hot path, but *account* from per-fill data, not the schedule. The fee schedule predicts; **the fill record decides.**
- **`feeAsset` asymmetry is real money:** fees may be charged in base, quote, or a third asset (venue token discounts: BNB-style). A fee in a *third* asset silently drains a balance you weren't watching — every fill's fee posts a `FeeCharged{asset, amount}` event against the *correct* asset cell, and third-asset fee balances are watched cells with their own minimum-balance alarm (running dry can flip your *effective* fee tier mid-day and change maker/taker economics).
- **Rebates are negative fees** — model sign properly end-to-end (a maker-rebate venue can make `fee < 0`; the ledger must not clamp).
- **Dust:** rounding + fees leave dust residues; per-asset dust thresholds keep reconciliation honest (→ `01 §9`, `05 §4`).
- Fees and funding both feed the per-scope **safety buffer** (§1) so the overlay absorbs costs the venue hasn't yet reflected.

---

## 5. Unified margin / portfolio margin accounts

On unified accounts (Bybit UTA, OKX multi-currency/portfolio margin), "available" is a **portfolio-margin computation over shared collateral**, not a per-asset subtraction — and one symbol's adverse move shrinks margin available to *all* symbols, including your other arb legs on that venue.

- **The venue's reported `availableBalance` / equity / IMR-headroom is authoritative for gating.** Do **not** recompute portfolio margin locally to gate trades — you will be wrong in the tails (haircuts, tiered IMR, mark nuances). Recompute only as a *sanity bound* (alarm when venue-reported and locally-bounded figures diverge wildly).
- **Re-pull margin state aggressively after every leg execution** on a unified venue — your *own* fills move the whole account's headroom.
- The reservation overlay still applies **on top of** the venue's availability figure: reservations model *your in-flight intents*, which the venue cannot know.
- **Cross-instrument reject attribution:** on unified accounts, an "insufficient margin" reject on symbol X may be caused by exposure on symbol Y. Classify these rejects at the *account* scope, not the symbol scope, or your error accounting will chase the wrong instrument (→ `07 §2`).
- Margin mode (cross vs isolated; account mode on OKX) changes the semantics of every figure above — the adapter declares the mode, the model follows it (→ `01 §10`, `08 §5`).

---

## 6. Funding (perpetuals)

Funding is the slow leak that turns winning arb into losing arb; it deserves the same FSM rigor as orders.

### 6.1 Mechanics, normalized

- **Linear perps:** funding settles in the **quote** asset (USDT/USDC).The canonical `FundingSettled{scope, symbol, amount, asset, rate, ts}` event carries the asset explicitly; the reducer posts it to the right cell.
- **Intervals vary** — 8 h standard, but 4 h/1 h on some venues/symbols, and venues adjust intervals on volatile symbols. Store `fundingIntervalMs` and `nextFundingTime` **per symbol from venue instrument metadata, refreshed periodically — never hardcode the schedule.**
- **Direction:** `funding = −sign(size) · |size| · markPrice · fundingRate` in the settlement asset (positive rate ⇒ longs pay shorts). Normalize each venue's sign/notional convention **in the adapter** with golden tests — sign errors here are silent and symmetric, the worst kind.

### 6.2 Funding does NOT touch cost basis

Keep funding **out of `avgEntryPrice`**. Funding affects *PnL*, not *entry*: post settlements to `realizedPnl` (or a dedicated `fundingPnl` ledger), and if the strategy wants a "true breakeven including carry," compute `effectiveBreakeven = avgEntry ± cumFunding/size` as a **derived view**. Mixing funding into avg entry makes venue reconciliation impossible — the venue's `avgEntry` won't include it, and every reconcile will scream false divergence.

### 6.3 Funding FSM

| State | Meaning |
|---|---|
| `NO_ACCRUAL` | flat at last funding boundary |
| `ACCRUING` | open position; predicted funding accumulating (estimate from current/predicted rate) |
| `SETTLEMENT_PENDING` | funding timestamp passed; awaiting venue settlement event |
| `SETTLED` | venue settlement received & posted (balance delta + `FundingSettled`) |
| `RECONCILING` | local predicted vs venue settled diverged; pulling funding/income history |

| From → To | Trigger | Action |
|---|---|---|
| `NO_ACCRUAL → ACCRUING` | position opens | start predicted accrual (current + predicted rate, refreshed) |
| `ACCRUING → SETTLEMENT_PENDING` | `now ≥ nextFundingTime` ∧ position open | freeze prediction for the window; await venue event |
| `SETTLEMENT_PENDING → SETTLED` | venue `FundingSettled` (WS or income history) | post actual to PnL + balance cell; **clear prediction; idempotent on `(account,symbol,fundingTime)`** |
| `SETTLEMENT_PENDING → RECONCILING` | no settlement event within grace (e.g., 2 min) **or** settled ≠ predicted beyond tolerance | pull funding/income history via REST; reconcile |
| `RECONCILING → SETTLED` | history confirms | post truth; alert if a settlement was missed (stream gap evidence → `02 §8.1`) |
| `ACCRUING → NO_ACCRUAL` | position closes before boundary | discard prediction (no settlement due) |

### 6.4 Prediction vs settlement (keep the ledgers separate)

- **Predicted/accrued funding** exists for **gating and sizing**: in funding-sensitive arb (cash-and-carry, cross-venue perp spreads), compare entry edge against `expected funding over expected holding period`; refuse entries whose edge a single funding interval erases; surface accrued-but-unsettled funding into the safety buffer.
- **Settled funding** is the only thing that posts to balances/PnL. **Settle against the venue's number, never your prediction** — rates are re-marked at settlement; predicted ≠ charged.
- Reconcile cumulative funding against the venue's funding/income history endpoint periodically (it's the recovery path for missed settlement events), and **schedule a balance+position reconcile aligned to each symbol's funding boundary** — right after settlement is exactly when local and venue views are most likely to disagree (→ `05 §3`).
