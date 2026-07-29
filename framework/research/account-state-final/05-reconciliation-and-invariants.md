# 05 — Reconciliation & Invariants

**Scope:** the reconciliation architecture (mechanisms, cadence, triggers), the three-way reconcile, tolerances, fencing of in-flight operations, the repair policy (including unknown-entity handling), the Reconciliation and Health FSMs that gate trading, and the consolidated invariant set with detection and recovery. Cross-references: snapshot↔stream sync discipline → `02 §4`, order/fill/position truth rules → `03`, reservation reconcile → `04 §2.3`, funding-aligned reconcile → `04 §6.4`, breakers tripped by divergence → `07 §4`, reconcile metrics/SLOs → `08 §1`.

Reconciliation is not a cron job that patches mistakes — it is the **system's primary correctness mechanism** (the outermost of the three rings, → `01 §6`); the streams are a latency optimization layered on top. Run it like a heartbeat, not an apology.

---

## 1. Three concurrent mechanisms

1. **Continuous invariant checking** (every event application): assert the §8 invariants on the touched aggregates. An invariant violation is a *detection*, fired in milliseconds — not something a periodic job finds later.
2. **Triggered reconciliation** (event-driven): on reconnect, on sequence gap, on illegal FSM transition, on any invariant breach, on reject reasons implying drift (e.g., "insufficient balance" we didn't predict), on `UNKNOWN` resolution, after kill-switch activation, after venue maintenance windows, on liquidation/ADL events. Targeted scope where possible (→ `02 §8.4` recovery hierarchy: targeted ≫ domain ≫ full).
3. **Periodic full reconciliation** (timer): REST snapshot of balances + open orders + positions (+ recent trades window) per `(venue, subaccount)`, diffed field-by-field against local projections.

---

## 2. The three-way reconcile

Three views per account: **(local projection) vs (WS-derived state) vs (REST snapshot)** — in practice the local projection *is* the WS-derived state plus our intents, so the comparison is local vs REST, with WS health as context.

| Object | Compare | On mismatch |
|---|---|---|
| Open orders | set difference by `clientOrderId`, then field diff (state, `cumFilled`, price, qty) | **Order venue-has-but-local-doesn't:** adopt it into tracking (it's at this venue under our account — likely our lost intent or an external/manual order), bind by coid if it's ours, **halt new trading on that scope** pending classification, alert. If policy mandates, cancel adopted unknowns (config-gated). **Local-has-but-venue-doesn't:** force `UNKNOWN` → Resolver verdict (filled-and-purged vs never-landed, → `03 §5`). |
| Order fill progress | `cumFilled` local vs venue | venue higher ⇒ missed fill(s): pull `fetchUserTrades` for the window, apply missing fills idempotently; venue lower ⇒ impossible (monotonicity breach) ⇒ HALT scope |
| Balances | per asset: `total`, `available`, `locked` | within tolerance band (§4): accept venue, log dust; beyond: **freeze scope**, snap to venue *after* explaining (or `BalanceCorrected` + alert), investigate |
| Positions | signed size (exact), `avgEntry` (epsilon), side/mode | size mismatch ⇒ `DIVERGED`, halt symbol, hunt missing fill/funding/liquidation via trades+income history; never "average it out" |
| Trades/fills | `fetchUserTrades(since)` vs fill ledger | missing locally ⇒ apply (idempotent); present locally but not at venue ⇒ serious: investigate possible bust or mis-mapping |
| Reservations | Σ active vs venue `locked` (converted per venue convention) | reconcile orders first, then repair ledger (→ `04 §2.3`) |
| Funding | cumulative settled vs venue income history | post missing settlements (idempotent on `fundingTime`); alert — a missed settlement implies a stream gap |
| PnL | realized PnL from fills+funding+fees vs venue-reported / balance deltas | reconcile **cumulatively** (per-interval comparisons whipsaw); persistent drift ⇒ fee/funding model bug |

---

## 3. Cadence & triggers

| Layer | Cadence | Content |
|---|---|---|
| Continuous invariants | every event | touched-aggregate assertions |
| Light reconcile | every few seconds per active account (balances + open-orders set check) | cheap delta sanity |
| Full reconcile | every 30–60 s per `(venue, subaccount)`, **jittered** across accounts to spread REST weight | balances + orders + positions + recent trades |
| Funding-aligned | at each symbol's funding boundary (+grace) | balance + position + funding history (→ `04 §6.4`) |
| Triggered | immediately on the §1.2 list | scoped to the suspect domain |

Cadence ranges differ across sources (loose: 30–60 s; tight: light checks every few seconds). Resolve by **load**: per-account full reconcile at 30–60 s jittered is the floor; tighten the light layer toward seconds on venues without stream sequence numbers (where periodic REST *is* your gap detector, → `02 §8.1`). All reconcile REST calls flow through the shared per-venue rate limiter at *critical* priority — below order ops, above everything else (→ `02 §14.2`).

---

## 4. Tolerances (what counts as divergence)

- **Orders:** exact set-match by coid; `cumFilled` exact (monotonic).
- **Positions:** size **exact** (any mismatch is an incident); `avgEntry` within a small epsilon (venue fee/rounding conventions differ, → `03 §8.1`).
- **Balances:** `total` exact per asset after dust threshold; `available`/`locked` split may disagree **transiently** (in-flight orders move the split) — compare the split only at a fence (§5) or band it with a *time-bounded* epsilon: a split mismatch must clear within N seconds or it escalates.
- **PnL / fees / funding:** reconcile **cumulative** figures with a small epsilon; never chase per-interval noise.
- **Dust:** per-asset dust epsilon applies *only* at the venue-comparison boundary — internal arithmetic is exact integer math (→ `01 §9`).
- Joint position+balance snapshots tolerate read-skew via bands, not exact equality (→ `03 §8.6`).

---

## 5. Fencing in-flight operations (reconciling a moving target)

A REST snapshot is a photo of a moving object: orders are in flight, fills are landing while you fetch.

- **Fence:** record `fence = max(local event seq applied, venue server-time of snapshot request)` per domain when the snapshot is taken. Snapshot data answers "state as of fence."
- **Classification of in-flight intents against the fence:**

| Local state | Venue snapshot says | Verdict |
|---|---|---|
| `PENDING_NEW` sent *before* fence | absent | suspicious → Resolver (query by coid) |
| `PENDING_NEW` sent *after* fence | absent | expected; ignore this round |
| `LIVE` locally | absent from snapshot | `UNKNOWN` → Resolver (filled-and-purged? canceled?) |
| absent locally | present in snapshot | adopt per §2 (orders row) |
| terminal locally | present in snapshot | venue lag or our error → re-query; if venue insists live, **venue wins** → reopen via correction event + alert |

- **Buffer-and-merge while live:** during a live-account reconcile, **continue buffering stream events** (same discipline as bootstrap, → `02 §4`); apply the snapshot at the fence, then drain buffered events *after* the fence on top. Never let a stale snapshot clobber a concurrent fill — and never apply the snapshot with an `await`-interleaved gap (→ `01 §5`).
- Process suspect/`UNKNOWN` orders **before** trusting any balance comparison — an in-doubt order corrupts the expected `locked` figure.

---

## 6. Repair policy (drift handling)

- **Truth wins, but as an explicit event.** Repairs are appended as first-class correction events (`BalanceCorrected`, `PositionCorrected`, `OrderAdopted`, `FillBackfilled{...}`) carrying `{from, to, source: RECONCILE, evidence}` — **never silent in-place mutation**. The audit trail must show every place local state was wrong; corrections are auditable and replayable like everything else.
- **Diff, don't blindly overwrite:** compute field-level diffs first; *explainable* diffs (a missed fill found in trades history, a funding settlement) are applied as their *natural* events (backfilled fill, funding posting), which keeps projections derivable; only the unexplainable residue becomes a `*Corrected` event.
- **Auto-repair vs HALT:**
  - **Auto-adopt (capital-safe):** missed events recovered from venue history; dust-level balance drift; venue-confirmed terminal states for in-doubt orders; unknown-but-ours orders bound by coid.
  - **HALT (human or hard gate):** any diff implying **unknown exposure** — unexpected nonzero/flipped position, unexplained balance jump beyond tolerance, **unknown position on a venue (always HALT the scope: a position you can't explain is unbounded risk)**, monotonicity violations, fills at venue we cannot map. Halt the scope (symbol → subaccount → venue as severity demands, → `07 §6`), keep reconciling, page.
- **Unknown-entity stance (locked policy):** unknown **position** → halt scope immediately, no auto-adoption of directional risk; unknown **order** → adopt into tracking + halt *new* trading on the scope + alert (adopted orders may be canceled under config-gated policy); **cold-start adoption is benign** — orders/positions discovered on boot that match persisted intents/coids are simply ours, rebound silently (→ `06 §5`).
- **Confirm-twice debounce:** before *acting* on a divergence (trading halt, auto-repair), re-read once after a short delay — transient REST-vs-stream lag self-heals and must not whipsaw breakers. Persistent divergence acts.
- **Discrepancy ledger:** every divergence — including self-healed ones — is recorded `{scope, field, local, venue, delta, resolution, evidence}`. Its *growth rate* is a first-class health metric and SLO (→ `08 §1`); recurring small drifts reveal systematic bugs (fee model, funding sign, rounding) that single corrections hide.
- **Materiality threshold:** correction magnitude above config ⇒ trip the **divergence breaker** for the scope (→ `07 §4`) and require human ack to clear.
- **Drift ladder (graduated response):**

| Level | Condition (examples) | Response |
|---|---|---|
| **Soft** | dust drift; split-mismatch within time bound; single explained missed event | auto-correct, log, count |
| **Medium** | repeated soft drifts; order set mismatch; funding settlement missed; reservation↔locked mismatch | auto-correct + targeted resync + alert; scope `DEGRADED` (deployable=0) until two clean reconciles |
| **Hard** | position size/sign mismatch; unexplained balance jump; monotonicity breach; unknown position | **halt scope** (cancel-only), full reconcile loop, page human; exit requires clean reconcile + operator ack above materiality |

---

## 7. The Reconciliation & Health FSMs (the trading gate)

Two small FSMs compose with the Connection FSM (→ `02 §9`) into the gate the allocator reads.

**Reconciliation FSM (per account):** `FRESH → DUE → RUNNING → (FRESH | DIVERGED)`; `DIVERGED → RUNNING` (repair loop) `→ FRESH` or `→ HALTED-divergence`. `RUNNING` uses the §5 fence/buffer discipline. `FRESH` carries a TTL = cadence × tolerance multiplier; TTL expiry ⇒ `DUE`; `DUE` past a hard bound ⇒ account is **stale** (Health degrades — *inability to verify* is itself a failure: no LIVE account may have an overdue reconcile).

**Health FSM (per account) — the confidence flag every consumer sees:**

| State | Meaning | Trading allowed |
|---|---|---|
| `LIVE` | stream healthy, reconcile fresh, invariants hold | **yes** |
| `DEGRADED` | soft fault (latency, partial sub, medium drift) | no new orders; cancels allowed |
| `RECONCILING` | reconcile/resync in progress after suspicion | no; cancels allowed |
| `STALE` | cannot verify (stream silent + reconcile overdue / REST unavailable) | no; cancel-and-reduce-only |
| `HALTED` | hard breach / breaker / kill | no; cancel-only or flatten per policy |

**Composition (the only line strategy code ever consults):**

```
deployable(scope) > 0  ⇔  Connection==LIVE ∧ Health==LIVE ∧ Reconcile==FRESH ∧ invariants hold
```

Fail-closed by construction: any component falling out zeroes deployable on the next SAB read (→ `01 §4`); no message delivery is required for safety.

---

## 8. Consolidated invariants (continuously asserted)

Checked on every event application for touched aggregates; full sweep on every reconcile. **Any violation: freeze the scope (deployable=0, cancel-only), snapshot evidence (event window + projections), alert; auto-repair only where marked.**

| # | Invariant | Detection | Recovery |
|---|---|---|---|
| I1 | `available + locked == total` per asset cell (within dust) | every balance event + reconcile | re-snapshot balances; explain or `BalanceCorrected`; persistent ⇒ halt scope |
| I2 | `Σ active reservations(asset) ≤ confirmed available(asset)` | every grant + every balance event | freeze new grants; reconcile orders→reservations; reaper resolves orphans (→ `04 §2`) |
| I3 | Every reservation ↔ a non-terminal linked order; every open order ↔ a reservation (or explicit exemption) | reconcile + reaper | Resolver on the order; then release/retire reservation |
| I4 | `0 ≤ cumFilled ≤ orderQty` and `cumFilled == Σ applied fills(coid)` | every fill | re-pull order + trades; rebuild fill set; mismatch ⇒ halt scope |
| I5 | Each `(venue, tradeId)` applied **exactly once** | `seenTradeIds` on apply | duplicate ⇒ no-op (by design); missing ⇒ backfill from trades history |
| I6 | Order FSM transitions legal; monotonic fields never regress (`cumFilled`↑, `leavesQty`↓); terminal states absorbing | transition function | illegal event ⇒ reject + targeted re-fetch of the order (→ `03 §2`) |
| I7 | Position equals venue position (size exact); **every position's origin is explainable by our coids/fills — else HALT** (no auto-adoption of unknown positions) | joint reconcile | `DIVERGED` state; hunt fills/funding/liq via history; venue wins via correction + page |
| I8 | No position sign flip or size change without a corresponding fill sequence | position fold | breach ⇒ halt symbol; reconcile |
| I9 | `clientOrderId` unique forever; persisted **before** send; counter strictly increasing across restarts | mint path + boot check | counter anomaly at boot ⇒ refuse to trade; rebuild from `log max + gap` (→ `03 §1`) |
| I10 | `deployable == 0` unless `LIVE ∧ FRESH ∧ invariants` (gate integrity) | allocator read path | structural (computed, not stored); test in CI |
| I11 | Per-domain fence/sequence cursors strictly monotonic; no event applied at/before its fence twice | sequencer | gap ⇒ `RESYNCING` (→ `02 §8.1`); regression ⇒ drop as stale |
| I12 | `lsn` (local log sequence) strictly increasing; event log append-only; replay(snapshot+log) == live projections (hash check) | persist layer + CI replay | divergence ⇒ projection bug: rebuild from log; halt if live state was wrong (→ `06 §4`) |
| I13 | No order in `PENDING_*`/`ACKED_UNCONFIRMED`/`UNKNOWN` older than its deadline without Resolver engagement; UNKNOWN count below breaker threshold | in-flight registry sweep | force `UNKNOWN` → Resolver; breaker above threshold (→ `07 §4`) |
| I14 | No `LIVE` account with reconcile overdue past hard bound | reconcile TTL | Health → `STALE`; deployable 0 |
| I15 | Realized PnL from fills + funding + fees ≡ observed balance deltas (cumulative, epsilon) | periodic PnL reconcile | persistent drift ⇒ fee/funding model bug; freeze scope sizing until explained |
| I16 | Margin equation sanity on derivatives accounts (`equity ≈ balance + uPnL`; venue availability within local sanity bound) | balance+position joint reconcile | beyond bound ⇒ `DEGRADED`; trust venue figure; investigate (→ `04 §5`) |
| I17 | Leg balance: `Σ filled exposure across paired arb legs == 0` within strategy tolerance | fill attribution fold (→ `04 §3.3`) | unwind/re-hedge policy fires; scope sizing frozen until flat |
| I18 | Every venue-side entity (order/position/balance motion) maps to a known scope cell; cross-scope routing impossible | scope key on every event (→ `01 §7.1`) | unroutable event ⇒ reject loudly + reconcile the venue's account topology |
