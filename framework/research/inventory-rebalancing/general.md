# Inventory Rebalancing Engine for CEX–CEX Arbitrage

**Reliable capital-movement infrastructure: on-chain withdrawals/deposits and internal transfers — design, stack, and operational practices (Node.js / TypeScript, single host).**

---

## 0. Assumptions & framing

Stated by you, restated so the recommendations are auditable:

- 15 venues, multiple subaccounts each; many internal transfers/hour; many on-chain rebalances/day per corridor.
- Single region, single host. State must survive unclean restarts with withdrawals mid-flight on chain.
- Correctness > latency on conflict. Internal transfers confirmed in seconds; on-chain in minutes.
- Capital is shared across legs; the in-flight view gates trade sizing, so the accounting layer is in the trading hot path (reads), even though movements themselves are slow.

**Priority legend used throughout:** 🟥 table stakes (do not ship without) · 🟨 strongly recommended · 🟩 advanced / mature-system optimization.

---

## 1. Sources of truth & the state model

### The layering (🟥)

There are exactly three layers of knowledge about a movement, and they must never be conflated in one field:

| Layer | What it is | Authoritative for | Never trust it for |
|---|---|---|---|
| **L0 — Local intent log** | Your own durable record: "I decided to move X and (maybe) submitted it" | The fact that *you* initiated something; idempotency keys; what should exist venue-side | Whether it actually executed |
| **L1 — Venue ledger (REST history endpoints)** | Withdrawal/deposit/transfer history, balance endpoints | Terminal truth of every movement on that venue; the *only* arbiter when local and push disagree | Freshness (seconds–minutes stale, paginated, sometimes windowed) |
| **L2 — Push events (private WS, webhooks)** | Balance/transfer/deposit notifications | Low-latency *hints* that state changed | Completeness or ordering. Treat every WS event as "go poll L1 now," not as a state transition by itself |

Plus, for on-chain legs only:

| Layer | Authoritative for |
|---|---|
| **L3 — The blockchain** (txid, confirmations, via public RPC or explorer API) | Whether a withdrawal was actually broadcast, how deep it is, whether a deposit will eventually credit. The venue can say "completed" before broadcast or credit long after finality; the chain disambiguates *which side is lying or slow*. |

**Rule:** state transitions in your FSM are *driven* by L1 (and L3 for on-chain stages); L2 only accelerates polling; L0 only creates the movement and its idempotency key. A movement is never marked `SETTLED` off a WebSocket event alone — the WS event triggers an immediate confirming poll of the history endpoint, and the poll commits the transition.

Why this strictness: every venue's private WS drops events (reconnects, silent subscription death, maintenance), and several venues' transfer events fire *before* the destination wallet is actually spendable (Bybit UTA transfers and OKX funding→trading have both shown credited-event-before-spendable behavior under load). Polling-confirmed transitions cost you 1–3 seconds of latency on internal transfers — inside your budget — and buy you immunity to the entire class of "WS said so" bugs.

### Balance endpoints are a checksum, not a source (🟥)

Venue balance snapshots (`GET /balance` style) are *derived* state. Use them for reconciliation invariants (§5), never to infer movement completion ("balance went up by ~X so the deposit must have landed") — concurrent trading activity makes balance deltas unattributable. The movement-history endpoints with explicit IDs are the truth.

---

## 2. Movement lifecycle & FSMs

### One movement = one saga with two ledger-visible phases

Every movement, of any type, has the same macro shape: **decide → reserve → submit → track → settle/fail → reconcile**. The per-type FSMs differ only in the `track` stage.

### Internal transfer FSM (🟥)

```
CREATED ──submit──> SUBMITTED ──ack(id)──> PENDING ──history shows done──> SETTLED
   │                    │                      │
   │                    ├──timeout/no ack──> AMBIGUOUS ──found in history──> PENDING/SETTLED
   │                    │                        └──absent after N probes + balance invariant──> FAILED_UNSUBMITTED
   │                    └──explicit reject──> FAILED
   └──pre-submit abort──> CANCELLED
```

Key decisions:

- **`AMBIGUOUS` is a first-class state, not an error.** A lost ack (timeout, 5xx, connection reset after request was written) puts the movement here. The *only* exit is via L1: query transfer history filtered by your client ID. Never resubmit out of `AMBIGUOUS`; resubmission happens only after `FAILED_UNSUBMITTED` is proven (the client ID is absent from history *and* enough time has passed to exceed the venue's history-visibility lag, which is venue-specific — use ≥60s before declaring absence, longer for venues with known laggy history like KuCoin).
- Internal transfers on most venues are near-synchronous, but **do not model them as request/response**. Model them with the full FSM and let the happy path collapse `SUBMITTED→PENDING→SETTLED` in one poll cycle (~1–2 s). The FSM earns its keep the day Bybit returns a transfer ID with status `PENDING` for 40 minutes during an internal incident — which happens.

### On-chain withdrawal FSM (🟥)

```
CREATED → SUBMITTED → VENUE_REVIEW → BROADCAST(txid) → CONFIRMING(n/N) → COMPLETED_VENUE_SIDE
              │            │              │                                      │
              │            │              └─ reorg: confirmations drop → CONFIRMING (re-enter)
              │            ├─ rejected/cancelled by venue (pre-broadcast) → REJECTED (funds returned to source)
              │            └─ stuck > SLA → STUCK_REVIEW (alert, halt corridor)
              ├─ no ack → AMBIGUOUS (resolve via withdrawal history by client ID)
              └─ ...

COMPLETED_VENUE_SIDE is NOT terminal. The movement is only done when the *deposit leg* settles:
COMPLETED_VENUE_SIDE → DEST_DETECTED → DEST_CONFIRMING → DEST_CREDITED → SETTLED(reconciled amounts/fees)
                              └─ broadcast on chain but never credited > SLA → STUCK_CREDIT (alert)
```

Critical modeling choices:

- **A venue→venue on-chain rebalance is ONE movement with two legs**, not a withdrawal object and an unrelated deposit object. The linkage key is the txid (plus memo/tag where applicable). The deposit leg starts in a "expected deposit" registry the moment the withdrawal reaches `BROADCAST`; the deposit poller on the destination venue matches incoming deposit-history rows against expected deposits by (asset, chain, txid). Unmatched deposits above dust are an alertable anomaly (someone sent funds you didn't expect, or your matching is broken — both are serious).
- **Cancel races:** many venues allow cancelling a withdrawal in `VENUE_REVIEW`. Model cancel as a *request* that itself can lose the race (`CANCEL_REQUESTED` overlay state): the venue may broadcast anyway. Resolution is again L1: the withdrawal record's final status decides; until then capital stays reserved.
- **Reorg handling:** confirmations can go down. `CONFIRMING` must tolerate non-monotonic n. Practically only relevant if you count confirmations yourself via RPC (🟩); if you rely solely on venue crediting, the venue absorbs reorg risk and you just see slower crediting.

### Deposit-only FSM (external inbound, sweep behavior)

`EXPECTED → DETECTED → CONFIRMING → CREDITED → SWEPT_TO_TRADING → SETTLED`. The `CREDITED ≠ tradable` distinction matters: several venues credit to a funding/main wallet, and you need an internal transfer (its own child movement!) to make funds tradable — e.g., **OKX credits deposits to the Funding account; trading requires an explicit Funding→Trading transfer. KuCoin similarly splits main vs. trade accounts.** Model the sweep as a child internal-transfer movement spawned automatically on `CREDITED`, so it gets the full FSM/idempotency treatment rather than being a fire-and-forget afterthought.

### Where FSMs live and what drives transitions (🟥)

- FSM definitions live in code as **explicit transition tables** (`Map<[State, Event], {next, guards, effects}>`). Persisted state is the event history (§9), current state is a projection.
- Transitions are driven by a single-threaded **movement orchestrator** loop per movement (§15/§17): it owns the movement, schedules its polls, applies events, and is the only writer of that movement's state. No transition ever happens from inside a WS handler — WS handlers enqueue "poke movement M" messages.

**Tooling — FSM library?** Hand-roll the transition table. **XState v5** is the obvious library candidate (excellent typing, statecharts, visualizer); its tradeoff is that its persistence model (actor snapshots) fights an event-sourced design and adds a conceptual layer your on-call engineer must learn at 3 a.m. For ~5 small FSMs with <15 states each, an explicit `transition(state, event)` pure function + exhaustive `switch` with TypeScript's `never`-checking gives you the same safety with zero dependency. 🟨 If you want the statechart visualization for documentation, define the machines in XState but execute them through your own persistence — don't adopt actor persistence.

---

## 3. Idempotency & exactly-once semantics

There is no exactly-once over a flaky HTTP API to 15 heterogeneous venues. What you build is **at-least-once submission + venue-side dedup + L1-verified effects = effectively-once**.

### The non-negotiable sequence (🟥)

For *every* movement, in this order:

1. **Generate the client ID locally** — ULID, embedding nothing venue-specific. One client ID per movement *intent*, reused across retries forever.
2. **Durably persist the intent (with client ID, full request params) and the capital reservation in one transaction** — the write-ahead intent record (§9). Only after fsync...
3. **Submit to the venue, passing the client ID** in the venue's dedup field.
4. On timeout/ambiguity: **query by client ID before any retry.**

If the process dies between 2 and 3, recovery finds an intent with no submission record and resolves via history-by-client-ID — same path as a lost ack. If it dies between 1 and 2 the movement never existed; the capital was never reserved; nothing leaks. There is no ordering of these steps other than the above that is safe.

### Venue support for client IDs — the gotcha table (🟥 know these cold)

| Venue | Withdrawal dedup | Internal transfer dedup | Gotcha |
|---|---|---|---|
| **Binance** | `withdrawOrderId` (client-supplied, queryable in withdraw history) | Universal Transfer returns `tranId`; **no client ID on transfers** | Transfer dedup must be done by your own pre-submit intent log + post-timeout matching on (asset, amount, route, time window) against `GET /sapi/v1/asset/transfer` history. Match windows, not exact timestamps. |
| **OKX** | `clientId` on withdrawal, queryable | `clientId` supported on funds-transfer (`/asset/transfer`) and queryable via `/asset/transfer-state` | Best-in-class: `transfer-state` by clientId is the canonical lost-ack resolver. Use it. |
| **Bybit** | no true client withdrawal ID historically — verify current API; treat as Binance-transfer-style matching if absent | `transferId` is **client-supplied UUID** (required) | Bybit makes *you* generate the transfer UUID — resubmitting the same UUID is rejected as duplicate, which is exactly what you want; capture the "duplicate" error as *success confirmation*. |
| **Bitget** | `clientOid` on withdrawal | `clientOid` on transfer | History endpoints have short default time windows; always pass explicit windows. |
| **KuCoin** | client withdrawal ID supported; history laggy | `clientOid` on inner transfer | History visibility lag is the worst of the majors; widen your absence-proof timeout. |

(Verify each at integration time — these APIs move. The structural point stands: **where the venue gives you no dedup key, the dedup is your intent log + windowed history matching, and that matching code is among the most safety-critical in the system.**)

### Duplicate notifications & replays (🟥)

All inbound facts (poll results, WS events) are processed idempotently: the event application is keyed on `(movementId, venueRecordId, statusObserved)` and re-applying is a no-op. Because state is event-sourced with monotonic guards ("can't go from SETTLED back to PENDING"), replaying an entire day of poll results is harmless — which is precisely what makes crash recovery (§9) simple.

### The cardinal sin to design out

**Never** retry a submission because the *response* failed. Responses fail constantly; submissions usually succeeded. The retry decision is made only by the resolver that has consulted L1. Encode this in the type system: the function that calls `venue.withdraw()` returns `Submitted | Ambiguous`, never `Failed` — there is no failure path from a network error at submit time, only ambiguity.

---

## 4. Event & status-stream reliability

### Polling is the backbone; push is an accelerator (🟥)

Opinionated stance: for movement tracking (as opposed to market data), **design as if private WS doesn't exist, then add it for latency**. The polling system must be sufficient on its own, because for several of your 15 venues it will be (not all venues push transfer/withdrawal status at all, and none push reliably).

**Adaptive per-movement polling schedule**, not a global cadence:

| Movement stage | Poll interval |
|---|---|
| Internal transfer, just submitted | 500 ms–1 s, backing off to 5 s after 30 s |
| Withdrawal in `VENUE_REVIEW` | 15–30 s |
| Withdrawal `BROADCAST`/`CONFIRMING` | 30–60 s on venue endpoint; per-block on RPC if self-tracking |
| Expected deposit, not yet detected | 30 s on destination deposit history |
| Deposit `CONFIRMING` | 30–60 s |
| Anything past SLA (stuck) | 60 s + alert already fired |

This keeps you trivially inside rate limits even with dozens of concurrent movements, because each poll is scoped (history endpoint filtered by client ID / time window), and idle corridors cost zero.

**Plus a slow full-window sweep** per venue (every 2–5 min): fetch the last N hours of withdrawal/deposit/transfer history *unfiltered* and diff against local state. This is the gap-and-missed-event catcher: it finds movements you somehow don't know about (manual UI action by a human, a recovery edge case, a venue-side adjustment) and status changes your scoped polls missed.

### Gaps, ordering, replay vs. snapshot (🟥)

- **Out-of-order:** guard every transition with monotonic stage ordering; a late-arriving "PENDING" after "SETTLED" is dropped (and counted — a metric on dropped-stale-events is a free health signal).
- **Gap detection on WS:** sequence numbers where the venue provides them; otherwise heartbeat-based staleness (no event in T → assume gap). Recovery from any suspected WS gap is always the same: **snapshot via REST history sweep**, never "replay the WS buffer" — venue WS replays are unreliable or nonexistent, and your design doesn't need them because polling is the backbone.
- **Pagination gotchas on history endpoints (🟥):** Binance withdraw/deposit history limits query windows to **90 days per request** and pages by time; OKX paginates by ID cursor (`before`/`after` semantics are inverted from intuition — `after` returns *older* records); Bybit caps windows (commonly 30 days for transfer query) and silently truncates. Every venue adapter must expose `iterateHistory(window)` as an async iterator that internally handles that venue's pagination dialect, tested against a recorded fixture — pagination bugs are the #1 source of "reconciliation missed a movement."

### Where push genuinely earns its keep (🟨)

Binance `balanceUpdate`/user-data stream, OKX account channel, Bybit wallet stream: subscribe, and on any relevant event, immediately poke the relevant movement's poller (collapse its backoff to "now"). This gets internal-transfer confirmation latency from ~1 s to ~100–300 ms without ever trusting the event content.

---

## 5. Reconciliation

Reconciliation is not a batch job bolted on later; it is the **immune system** and runs continuously at three tiers.

### Tier 1 — Per-movement reconciliation at settlement (🟥)

When a movement reaches a terminal state, reconcile *that movement's numbers* before releasing reservations: requested amount vs. venue-recorded amount, expected fee vs. actual fee (fee-inclusive vs. fee-on-top conventions differ — §6), withdrawal amount vs. credited deposit amount. Discrepancy → movement parks in `SETTLED_WITH_DISCREPANCY`, reservation stays, alert fires. This catches partial credits and surprise fee changes at the only moment you have full context.

### Tier 2 — Continuous ledger-vs-venue balance invariant (🟥)

Every 30–60 s per venue (piggybacking on balance polls the trading engine already does):

```
venue_reported_balance(asset, wallet)
  ≟ local_ledger_balance(asset, wallet)
    + Σ pending_credits_to_this_wallet
    − Σ pending_debits_not_yet_reflected
    ± trading_engine_unsettled_delta   ← the hard term
```

The hard part is the trading term: fills, funding payments, and fees move balances concurrently. Practical approach: the rebalancer owns *movement* deltas, the trading engine owns *trading* deltas, and the invariant is checked on the **sum**, with a per-asset tolerance band (covering in-flight fills + venue rounding). Drift beyond tolerance for > grace period → corridor breaker trips (§12). Drift that *grows monotonically* trips faster than noisy drift — track the derivative, not just the level.

### Tier 3 — Slow full-history reconciliation (🟥)

The §4 full-window sweep doubles as this tier: every venue movement record in the window must match a local movement (by client ID, venue ID, or txid), and every local terminal movement must appear venue-side. Orphans on either side are auto-investigated: a venue-side orphan transfer becomes an **imported movement** (created retroactively in `SETTLED` with provenance `discovered`, posting its ledger entries) so the books converge; a local-side orphan (we think it settled, venue has no record) is a 🔴 page — it means your matching logic lied.

### Reconciling safely while movements are in flight (🟥)

The trap: reconciler sees source debited, destination not credited, "fixes" the books, then the deposit lands → double count. Rules that prevent it:

1. Reconciliation **never writes balance adjustments directly**; it only (a) creates discovered movements, (b) transitions existing movements via the same guarded FSM, (c) trips breakers. All capital effects flow through movement settlement — one write path.
2. In-flight movements are **excluded from invariant violation** by construction: the Tier-2 equation already carries pending terms, so an in-flight movement is not drift.
3. Repairs to amounts (fee differed, partial credit) post **correcting ledger entries** referencing the movement, never edits to existing entries (append-only ledger, §6).

Cadence summary: Tier 1 = at settlement; Tier 2 = 30–60 s; Tier 3 = 2–5 min rolling window + nightly deep sweep over 7 days (catches late venue-side adjustments and your own pagination bugs).

---

## 6. In-flight capital accounting

### Use a double-entry ledger with an explicit in-transit account. Not optional. (🟥)

The three candidate models:

| Model | Failure mode |
|---|---|
| **Debit-at-source** (decrement source on submit, increment dest on credit) | Capital "disappears" while in flight. Sounds safe (conservative) but it's not: global invariants don't sum, reconciliation can't distinguish in-flight from lost, and stuck-movement detection has nothing to anchor on. |
| **Credit-at-destination optimism** (count it at dest once submitted) | Trading against funds in transit. Catastrophic by your own definition. Never. |
| **Explicit in-transit bucket** (debit source → credit `in_transit:movementId`; on settle, debit in-transit → credit dest) | None structural. Slightly more code. This is the answer. |

With double-entry, the invariants you care about are *theorems*, not hopes: total capital = Σ wallets + Σ in-transit + Σ fees-paid; nothing is ever in two places; a movement stuck for 6 hours is a nonzero in-transit account with an old timestamp — trivially alertable.

### Account structure (🟥)

```
asset:USDT
 ├─ venue:binance:sub:arb1:wallet:spot          (available)
 ├─ venue:binance:sub:arb1:wallet:spot:reserved (committed to pending movements/legs)
 ├─ venue:okx:main:wallet:funding
 ├─ in_transit:movement:01J9X...                (one per movement; zero & closed at settle)
 └─ expense:withdrawal_fees / expense:network_fees
```

**Reservation is a ledger posting** (available → reserved), made in the same transaction as the movement intent (§3 step 2). The trading engine's sizing reads `available` only. This single mechanism prevents double-commit across simultaneous arbitrage legs *and* simultaneous rebalances, because both consume from the same `available` account under the same single-writer serialization (§15) — there is no separate "rebalance reservation" and "trading reservation" system to desync.

### Fees, precision, minimums (🟥)

- **Fee conventions differ per venue and per endpoint:** Binance withdrawal `amount` is the amount that *leaves your balance*, fee deducted from it (receiver gets amount − fee) — i.e., fee-inclusive; OKX lets you query the fee and the request `amt` is what's deducted with fee inside; some venues/chains take fee on top. **Never hardcode the convention** — encode `feeConvention: 'inclusive' | 'on_top'` per venue adapter, assert it at Tier-1 reconciliation, and treat a convention violation as a breaker event (it means the venue changed behavior).
- **Arithmetic: scaled BigInt, not floats, not even decimal.js for storage.** Store every amount as `(bigint mantissa, int8 scale)` in SQLite/Postgres as text/numeric; do arithmetic in `bigint` at a fixed per-asset scale. `decimal.js` is acceptable at the edges (parsing venue JSON — which you must read as *strings*, never `JSON.parse` to `number`; use a JSON parser config or parse amounts from raw with a regex/`json-bigint`). Rationale: one float rounding on a reservation release is a slow capital leak that reconciliation will flag forever.
- **Minimums & step sizes:** withdrawal minimums, amount precision per (asset, chain), and dust: round *down* to venue precision, verify post-round amount ≥ minimum, and account for the dust remainder explicitly (it stays at source — don't let it vanish from the plan vs. actual comparison).

### Sizing under in-flight uncertainty (🟨)

Expose three balances per wallet to the decision layers: `available` (spend now), `available + inbound_in_transit_eta_within(t)` (planning horizon), `total_committed`. The arbitrage engine sizes on the first; the rebalancer plans on the second; breakers watch the third. Never collapse these into one number.

---

## 7. Rebalancing decision logic

### Targets & triggers (🟥)

- **Target inventory** is declared per `(venue, subaccount, walletType, asset)` as a band `[min, target, max]`, not a point — point targets cause oscillation. Targets are *inputs* from the strategy layer (where do opportunities historically pay?), refreshed slowly (hours), with manual override.
- **Triggers**, in priority order:
  1. **Opportunity-driven (pull):** the arb engine signals "leg unfundable on venue X, need Y of asset Z within T" — highest priority, sized to the opportunity pipeline, allowed to pay for speed.
  2. **Threshold (drift):** wallet outside its band → enqueue rebalance back to target (with hysteresis: trigger at band edge, refill to target, not to max).
  3. **Scheduled consolidation:** off-peak sweeps of dust, fee-asset top-ups (BNB/OKB for fee discounts, gas assets), and netting.
- **Netting before moving (🟨, becomes 🟥 at your transfer frequency):** batch the decision loop (every 10–30 s), compute the *net* desired flow matrix across all pending needs, and cancel offsetting moves. With capital shared across legs, naive per-need movement generation produces A→B and B→A simultaneously — pure fee burn.

### Corridor selection (🟥)

A **corridor** = (source venue/wallet, dest venue/wallet, mechanism, chain?). Ranked per decision by total cost:

```
cost(corridor, size) = withdrawal_fee + network_fee
                     + time_out_of_market(size, eta) × opportunity_rate
                     + risk_premium(corridor_health, eta_variance)
```

- Internal transfer corridors (same venue) cost ≈ 0 and settle in seconds — always preferred when topology allows. A surprising amount of "rebalancing" is solvable as sub↔sub / wallet↔wallet without touching a chain; exhaust internal options first, including **triangular routes** (master account as hub: sub A → master → sub B, since most venues only permit sub↔master, not sub↔sub directly — Binance is the notable exception with direct sub-to-sub for some account types).
- `opportunity_rate` is your realized arb yield per unit capital per hour — measure it, don't guess; it's the term that decides TRC20 ($1–2, ~2 min) vs. slower/cheaper, and whether a $50 fee on a $500k move is irrelevant (it is).
- `risk_premium` comes from per-corridor health stats (§11): rolling ETA p50/p95, recent stuck events, venue wallet status. A corridor with a 40-minute p95 is not "cheap," whatever its fee.
- **Unified-margin nuance:** moving into a UTA/unified account can fund *all* market types at once (spot+linear collateral shared) — the corridor graph should model unified wallets as one node, which often removes an internal hop entirely.

### Sizing under uncertainty (🟨)

Size from `available` only; treat inbound in-transit as *future* supply with its ETA distribution, not present supply. Cap any single movement at the corridor cap (§12), and never commit more than X% (start: 50%) of a wallet's available in one movement — the remainder is your buffer against the movement getting stuck while an opportunity needs funding.

---

## 8. Chain & network specifics

The gotchas here destroy more funds than all software bugs combined. (🟥 throughout.)

- **Same asset, many chains:** USDT exists on 10+ networks per venue. The corridor is keyed by the venue's *network code*, and network codes are **not standardized across venues** (`TRX` vs `TRC20` vs `TRON`; `BSC` vs `BEP20`; `ARBITRUM` vs `ARB` vs `ARBONE`). Maintain an explicit mapping table per venue, sourced from each venue's currency/chain info endpoint (Binance `/sapi/v1/capital/config/getall`, OKX `/asset/currencies`, Bybit coin-info), refreshed periodically — these endpoints also carry per-chain withdrawal enable/disable flags, fees, minimums, and confirmation counts, and are the backbone of corridor health (§11). **Pre-flight every withdrawal:** assert (asset, network) is deposit-enabled at the destination *right now*, and that the deposit address you hold was issued for exactly that network. Wrong-network deposits range from "recoverable with a support ticket and a fee" to "gone."
- **Confirmation requirements are per (venue, chain), not per chain.** Venues publish credit-after-N: e.g., BTC commonly 1–2 confs to credit, ETH ~6–64 blocks pre/post-finality policies, TRC20 ~19–20 blocks (~1 min), SOL ~finalized commitment (~30 s). Pull these from the venue chain-info endpoints rather than hardcoding; your ETA model and stuck-SLA derive from them.
- **Memo/tag assets (XRP, XLM, EOS-style, ATOM, TON):** the memo *is* the account. A missing/wrong memo means a manual recovery ticket measured in weeks. Enforce structurally: the deposit-address record type for these chains makes the memo field non-optional (`type AddressWithMemo`), and the withdrawal pre-flight refuses to submit a memo-asset withdrawal without one. Prefer to simply **exclude memo assets from automated rebalancing** unless you truly need those corridors — the risk/benefit is poor. 🟨
- **Address whitelisting & lock windows:** run all venues in whitelist-only withdrawal mode (an account-takeover containment measure — table stakes for a treasury holding real size). Gotcha: **adding/changing a whitelist entry triggers a withdrawal lock, commonly 24 h (Binance and others), on some venues account-wide.** Therefore: provision *all* corridor addresses ahead of time as a deliberate, manual, ceremonied operation; the engine treats the whitelist as read-only and a non-whitelisted destination as a hard pre-flight failure, never something to fix automatically.
- **Deposit address rotation:** some venues/chains rotate deposit addresses (notably BTC and some account types). Never cache a deposit address across rebalances without revalidation — fetch the current address at movement creation, and store *which address* the withdrawal targeted in the movement record so the deposit-matcher and any incident response know exactly where funds went.
- **Stablecoin corridor choice (🟨, opinionated):** for fast venue↔venue USDT/USDC: TRC20-USDT remains the workhorse (cheap, ~1–2 min, universally supported); Arbitrum and Solana USDC are excellent where both venues support them (fast finality, low fee) — Solana especially for sub-minute corridors; avoid ERC20 mainnet for routine rebalancing (fee + variance) and keep it as the fallback corridor of last resort. Always maintain ≥2 enabled chains per major corridor so a single-chain wallet suspension doesn't strand a route.
- **Self-custody hop (only if you run one):** venue→your wallet→venue adds custody and signing concerns but decouples you from "destination venue deposits suspended." If used: a hardware-backed or MPC signer (e.g., Fireblocks if budget allows — it also abstracts much of this section; tradeoff: cost, API dependency, and their policy engine's latency), your own chain watcher per chain (WebSocket to your own or a managed RPC — Alchemy/QuickNode class), and the same FSM treatment for the on-chain leg you control. 🟩

---

## 9. Sub-account & wallet-type transfer mechanics

- **Permission topology (🟥):** map, per venue, which transfers each API key can perform. The master key generally moves master↔sub and (sometimes) sub↔sub on behalf; sub keys usually cannot move funds out of their own sub unless explicitly granted. **Principle of least privilege with one deliberate exception:** the rebalancer's keys are the *only* keys with transfer permission, trading-engine keys have trade-only, and **no key anywhere has withdrawal permission except the rebalancer's withdrawal keys, which are IP-whitelisted and used by exactly one process.** Binance requires enabling "universal transfer" on the key; OKX permissions are per-key bitmasks (read/trade/withdraw) — withdraw covers transfers out of funding; Bybit UTA distinguishes transfer permission separately. Audit this quarterly; venues reset/migrate permission models.
- **Transferable ≠ total ≠ free (🟥):** what you can move out of a derivatives/unified wallet is `transferable = equity − initial margin − unrealized loss buffer − open order locks`, and venues compute it differently (Bybit UTA exposes `totalAvailableBalance` vs per-coin `availableToWithdraw`; OKX trading account has "available equity" vs "available balance"; cross-margin positions make this fluctuate tick by tick). **Always query the venue's transferable/max-withdrawal figure immediately pre-submit** (OKX `/account/max-withdrawal`, Bybit transferable query) rather than computing it yourself, then request ≤ min(plan, venue-reported transferable × 0.99) — the 1% headroom absorbs the race between your query and your submit while positions move.
- **Unified-margin constraints (🟥):** moving collateral *out* of a unified account reduces margin for *all* open positions across spot margin and perps simultaneously. The rebalancer must consult the trading engine's risk view ("post-transfer margin ratio ≥ floor") before any outbound transfer from a unified wallet — this is a cross-module pre-flight guard, and it's the one place rebalancing and risk management cannot be decoupled. Also: some venues restrict which assets are transferable out of unified accounts while borrowing is active (auto-repay-on-transfer semantics differ — OKX may net against liabilities; verify per venue).
- **Margin-locked funds blocking transfers:** a transfer rejected with "insufficient transferable" while balance looks ample is the most common spurious failure. Classify it as `RETRYABLE_FUNDING` (re-evaluate transferable, possibly shrink, retry with backoff), distinct from hard rejects.

---

## 10. Crash recovery & persistence

### Stack recommendation (🟥)

**Primary store: SQLite via `better-sqlite3`, `journal_mode=WAL`, `synchronous=FULL` for movement-intent and ledger writes.**

- *Rationale:* single host, modest write volume, and `better-sqlite3` is synchronous — which is a *feature* here: the intent write completes (fsynced) before the line of code that calls the venue runs, with no async scheduling gap in which the process can die having "decided" but not persisted. Transactions across intent + reservation + idempotency key are trivial and fast (sub-ms). Zero operational footprint; backup = file copy / `litestream` replication (🟨 run **Litestream** streaming the DB to S3-compatible storage — near-zero-cost off-host durability for the single-host setup).
- *Tradeoff:* single-writer (fine: the design wants a single writer, §15); weaker tooling for ad-hoc ops queries than Postgres; if you later go multi-host, you migrate. **Alternative:** Postgres if you already run it for the trading stack — then also adopt **pg-boss** for durable scheduling and keep everything in one store. Don't run Postgres *just* for this.
- *Avoid:* Redis as the source of truth for movement state (persistence is configurable-but-fragile, and it tempts you into treating cache as truth); Kafka/NATS-class infra (cost/benefit absurd at this scale on one host).

### Schema shape (🟥)

Event-sourced movements + materialized projections, all in SQLite:

```
movements(id ULID PK, type, status, venue_src, venue_dst, asset, chain,
          amount_mantissa, scale, client_id UNIQUE, venue_id, txid,
          created_at, updated_at, sla_deadline)
movement_events(seq INTEGER PK AUTOINC, movement_id, event_type,
                payload_json, observed_at, source)   -- append-only, the truth
ledger_entries(seq PK, movement_id?, account, asset,
               delta_mantissa, scale, created_at)     -- append-only, Σ per txn = 0 enforced
idempotency(client_id PK, movement_id, request_hash)
expected_deposits(txid?, asset, chain, dest_venue, movement_id, ...)
```

`movements` is a projection rebuildable from `movement_events`; in practice you maintain both transactionally and a startup integrity check re-derives and compares (cheap, catches projection bugs).

### Cold start / unclean restart procedure (🟥)

1. Open DB, run projection-integrity check.
2. **Resolve all non-terminal movements**: each enters its FSM at its persisted state; the orchestrator immediately schedules a resolution poll. `AMBIGUOUS`/`SUBMITTED`-with-no-ack movements run the lost-ack resolver (history by client ID). Intents persisted but with no submission event are treated as ambiguous, **not** as "never sent" — the crash may have hit after the HTTP request left the NIC.
3. **Discovery sweep** (Tier-3 reconciliation, §5) over a window covering [last clean checkpoint − 24 h, now] on every venue: finds movements submitted by a previous life of the process that never made it into the DB at all (shouldn't be possible given write ordering, but the sweep is your defense against your own bugs and against humans clicking in the venue UI).
4. Re-derive ledger `available` per wallet, re-arm SLAs and breakers from persisted state (a breaker that was tripped stays tripped across restart — persist breaker state).
5. Only after 1–4 complete does the engine accept new movement requests. Trading can resume earlier *if* it sizes only from reconciled wallets; simplest policy: gate trading per-venue on that venue's recovery completing.

Mid-flight on-chain withdrawals survive this trivially under the event-sourced design: the movement is in `CONFIRMING` with a txid; recovery just resumes polling. That's the test to put in CI: kill -9 the process at randomized points of a simulated withdrawal (fault-injection harness) and assert post-recovery convergence with no duplicate submission and no ledger leak. 🟨

---

## 11. The other FSMs (connection, reconciliation, corridor health, venue availability)

Same discipline as movement FSMs — explicit transition tables, persisted where state must survive restart. (🟥 for corridor/venue availability; 🟨 for the rest being formal FSMs rather than ad-hoc flags.)

- **Venue connectivity FSM** (per venue, per credential): `CONNECTED → DEGRADED (elevated errors/latency) → RATE_LIMITED (with venue-supplied retry-after honored absolutely — a ban mid-flight is a §13 scenario) → DOWN`. Movement orchestrators consult it: in `RATE_LIMITED`, status polls continue at minimum cadence using the spare budget (resolving in-flight movements outranks everything), but **no new submissions**.
- **Reconciliation FSM** (per venue): `IN_SYNC → CHECKING → DRIFT_SUSPECTED (within grace) → DRIFT_CONFIRMED (breaker) → REPAIRING → IN_SYNC`. New movements require `IN_SYNC` or `CHECKING` at the source and destination.
- **Corridor health FSM** (per corridor): `HEALTHY → SLOW (ETA p95 breached) → SUSPECT (stuck movement or repeated retryable failures) → CLOSED (manual or breaker)`, carrying rolling stats: ETA p50/p95, success rate, last-success timestamp, current fee level vs. trailing median. The decision layer's `risk_premium` (§7) reads directly from this.
- **Venue withdrawal/deposit availability FSM** (per venue × asset × chain): driven by the chain-info endpoints (§8) which expose enable/disable flags, plus inference (deposits detected on chain but crediting stalled across multiple movements ⇒ suspected suspension even if the flag still says enabled — venues flip the flag late). Maintenance windows from venue announcements feed this where you bother to ingest them (🟩).

---

## 12. Circuit breakers & protections

Breakers are **default-deny on uncertainty**: anything the system cannot explain halts the relevant scope. Scopes nest: movement → corridor → venue → global. (🟥 except where marked.)

**Trip conditions:**

| Condition | Scope tripped |
|---|---|
| Tier-2 drift confirmed (beyond tolerance + grace) | Venue (no new movements touching it; in-flight continue resolving) |
| Movement exceeds stage SLA (stuck in review / never credited) | Corridor + alert; venue if ≥2 corridors stuck |
| ≥N rejects in window on a corridor | Corridor |
| Withdrawal/deposit suspended flag, or inferred suspension | (venue, asset, chain) availability → corridors using it |
| Fee spike > k× trailing median on a chain | Corridor soft-close (only opportunity-driven, repriced moves allowed) 🟨 |
| Reconciliation job itself failing/erroring | Venue — *inability to verify* is treated as drift |
| Ledger invariant violation (Σ≠0, negative available) | **Global halt.** This is a software bug with money involved. |
| Discovered movement (venue-side orphan) above dust | Venue, pending human ack 🟨 |

**Caps (🟥):** per-movement max (per asset tier), per-corridor outstanding max (limits blast radius of one bad corridor), per-venue total in-flight max, per-time-window volume caps (24 h notional per venue — bounds account-compromise damage and fat-fingered loops), and a global in-transit ceiling as % of total capital (start ~15–20%; in-transit capital earns nothing and carries all the operational risk).

**Manual approval (🟥):** movements above a notional threshold create the intent and reservation, then park in `AWAITING_APPROVAL` until a human approves out-of-band (a signed CLI command or a bot message with 2-person rule at the largest tier 🟨). The approval path uses the same FSM — no side door.

**Anti-flap:** breakers half-open with a probe (one small canary movement through a recovering corridor before reopening fully 🟨 — a $50 canary withdrawal validating a corridor before a $500k move is the cheapest insurance you will ever buy).

---

## 13. Failure modes — the catalogue and the playbook

Each row is a state + automated response + human-escalation rule. The unifying principle: **funds remain reserved (in-transit) until L1/L3 proves where they are; the system prefers frozen capital to wrong numbers.**

| Failure | Detection | Automated response |
|---|---|---|
| **Lost ack on submit** | timeout / 5xx / conn reset | → `AMBIGUOUS`; resolver polls history by client ID; resubmit only after proven absence (§3) |
| **Withdrawal stuck in venue review** | stage SLA (per-venue baseline p95 × 3) | corridor `SUSPECT`; alert; attempt status detail fetch; **do not cancel automatically** (cancel races, §2) |
| **Broadcast but never credited** | txid confirmed on chain (or venue marks complete) but destination deposit absent > SLA | verify txid on chain via RPC/explorer (L3): if chain shows success to the right address → destination crediting problem → (venue,asset,chain) availability suspect + support ticket payload auto-generated with txid/amount/address 🟨; if chain shows nothing → source venue lied about broadcast → escalate against source |
| **Wrong-network deposit** | deposit detected on unexpected chain matching an expected amount | should be impossible given pre-flight (§8); if seen: freeze matching, page — this is recovery-ticket territory |
| **Missing memo/tag** | structurally prevented (§8); inbound third-party deposits without memo are the venue's problem | n/a — design-out |
| **Partial credit** | Tier-1 amount mismatch at settlement | `SETTLED_WITH_DISCREPANCY`, residual stays in in-transit account, alert; common benign cause: fee-convention misconfig — check that first |
| **Venue rejection after debit** (withdrawal rejected but balance not yet returned) | reject status + source balance not restored | keep in-transit open in `REJECTED_AWAITING_RETURN`; poll source balance/history for the refund record; SLA → ticket |
| **Chain congestion / fee spike** | corridor ETA & fee monitors | soft-close corridor; in-flight movements just take longer (SLA derived from live chain conditions, not static, where you track them 🟩) |
| **Reorg** | confirmation count decreases / txid disappears | re-enter `CONFIRMING`; if txid gone > T → treat as never-broadcast *only* with extreme care: requires venue's withdrawal record to also revert; otherwise human |
| **Rate-limit ban mid-flight** | venue connectivity FSM | freeze submissions; status polling at minimum cadence within allowed budget; in-flight movements tolerate slow resolution by design |
| **Cancel-withdrawal race** | cancel requested, venue broadcasts anyway | `CANCEL_REQUESTED` overlay resolves from final venue record; reservation held throughout; both outcomes (cancelled / broadcast) are normal transitions |
| **Venue UI / human interference** (someone moves funds manually) | Tier-3 discovers orphan | import as discovered movement + venue-scope hold pending human ack |

---

## 14. Architecture, process topology & decomposition

### Topology (🟥)

**A modular monolith for the rebalancer: one Node.js process, strict in-process module boundaries, separate from the trading engine process(es).** On one host, processes are your isolation primitive; IPC between rebalancer and trading engine over local gRPC/HTTP or a Unix socket with a small, explicit contract.

Rationale for *separate from trading*: different change cadence (trading logic iterates daily; movement code should be boring and rarely touched), different blast radius (a trading-engine crash-loop must not take down in-flight withdrawal tracking), different permissions (only this process holds withdrawal-enabled keys). Rationale for *not* microservices within the rebalancer: every boundary you add between "reserve capital" and "record intent" reintroduces distributed-transaction problems that the single SQLite transaction solves for free.

### Modules and ownership

```
┌─ rebalancerd (single process) ──────────────────────────────────┐
│  decision/        targets, triggers, netting, corridor choice   │
│  orchestrator/    per-movement sagas, FSM execution, scheduling │
│  ledger/          double-entry, reservations  ← single writer   │
│  venues/<name>/   typed adapters: REST+WS, pagination, fee conv │
│  recon/           tiers 1–3, drift detection                    │
│  health/          connectivity, corridor, availability FSMs     │
│  breakers/        trip/half-open/caps/approval gate             │
│  store/           better-sqlite3, event log, projections        │
│  api/             read API for trading engine + ops CLI surface │
└──────────────────────────────────────────────────────────────────┘
```

- **Single-writer ledger:** all ledger postings execute on one serialized path (a simple in-process queue; with `better-sqlite3` synchronous transactions this is naturally race-free without locks). This is the linchpin of no-double-commit.
- **Trading engine integration contract:** trading *reads* `available` (push-updated snapshot + on-demand query) and *requests* funding (`needFunds(venue, asset, amount, deadline)`); the rebalancer *queries* trading's risk view for unified-margin pre-flights (§9). Neither writes the other's state. Keep this contract to those three verbs.
- **Venue adapters:** one package per venue implementing a single `VenueTreasury` interface (`withdraw`, `transfer`, `iterateWithdrawals/Deposits/Transfers`, `chainInfo`, `transferable`, `depositAddress`) with **Zod schemas on every response** — venue APIs change silently, and a schema violation should fail loud at the adapter, not corrupt state three modules later.

### Library & tooling stack — consolidated recommendations

| Concern | Recommendation | Rationale / tradeoff |
|---|---|---|
| Persistence/WAL | **better-sqlite3** (+ **Litestream** off-host replication 🟨) | Synchronous fsynced transactions = correct intent ordering by construction. Tradeoff: single-host ceiling, fewer ops tools than Postgres. Use Postgres+pg-boss instead iff already operating Postgres. |
| Scheduling / polling jobs | **In-process scheduler** (per-movement timers re-armed from DB at boot); avoid BullMQ | BullMQ drags in Redis = second stateful system whose loss strands your timers. At your volume, timers + persisted `next_poll_at` per movement are simpler and survive restarts via the recovery path anyway. Tradeoff: you write ~200 lines of scheduler. |
| Validation | **Zod** (v4) on every venue response + every internal command | Runtime safety at the trust boundary; tradeoff: per-call overhead (irrelevant at this volume). |
| Decimal math | **BigInt mantissa+scale** core; `json-bigint`/string-parse at edges; decimal.js only for display/ratios | Exactness where money is stored; tradeoff: ergonomics — wrap in a small `Money` value type with the asset and scale baked in so mixed-scale arithmetic won't typecheck. |
| HTTP | **undici** with per-venue agents, explicit timeouts, no automatic retries on POST | Retries live in the resolver, never in the HTTP layer (§3). |
| IDs | **ulid** | Sortable, collision-safe client IDs. |
| Testing | **Vitest** + recorded venue fixtures + a **fault-injection harness** (kill-points, dropped acks, duplicated events, reordered polls) 🟨 | The recovery guarantees in §10 are only real if CI proves them continuously. |

---

## 15. Orchestration

How the pieces actually run (🟥):

1. **Decision tick** (every 10–30 s, plus on-demand from trading's `needFunds`): read targets + `available` + in-flight ETAs → desired flow matrix → net → check breakers/caps/corridor health → emit movement intents.
2. **Per-movement saga**: each intent becomes an orchestrator task — a small, resumable state-machine driver that (a) posts reservation + intent in one txn, (b) runs pre-flight (network enabled, address whitelisted+validated, transferable check, unified-margin guard, fee sanity), (c) submits with client ID, (d) loops: `next_poll_at`-driven status fetch → FSM event → persist → reschedule, accelerated by WS pokes, (e) on terminal: Tier-1 reconcile → post settlement ledger entries → close in-transit account → notify decision layer. Every step is idempotent and the loop is re-entered from persisted state after any crash.
3. **Background loops**: Tier-2 invariant checks; Tier-3 sweeps; chain-info refresh; corridor stats rollup; SLA watchdog (scans `sla_deadline` — independent of the per-movement pollers so a wedged poller can't silence its own alarm).
4. **Ops surface**: a CLI/API for the humans — list in-flight, force-resolve ambiguous (with reason), approve large movements, trip/reset breakers, trigger sweeps, replay a movement's event history. Every manual action is itself an event in `movement_events` with an operator identity. 🟨

**Concurrency model:** Node's single thread is an asset — all state mutation happens on one event loop, the ledger writer is serialized by construction, and the only true concurrency is outbound I/O. Don't add worker threads to this system; if a venue adapter needs CPU (it won't), that's the only excuse.

---

## 16. Build order (what "table stakes" means in sequence)

1. Ledger + reservations + intent log (§3, §6, §10) — nothing moves until this exists.
2. Two venue adapters (your top corridor), internal-transfer FSM end-to-end, lost-ack resolver.
3. Withdrawal/deposit FSM on one chain corridor (TRC20-USDT), expected-deposit matching, Tier-1 reconciliation.
4. Tier-2/3 reconciliation + breakers + caps + crash-recovery procedure, with the fault-injection harness in CI.
5. Decision layer (thresholds → netting → corridor costing), remaining venues.
6. Then, and only then, the 🟩 items: chain self-tracking via RPC, fee-spike adaptive SLAs, canary probes, maintenance-calendar ingestion, Temporal migration if you ever leave one host.

The ordering encodes the core opinion of this document: **the rebalancer is an accounting system with a network problem, not a networking system with an accounting feature.** Get the ledger, idempotency, and recovery semantics right first; everything else is replaceable.