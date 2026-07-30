
### 1.3 Equilibrium, normalization, and the z-score

- **Mean/variance of the spread:** exponentially weighted (EWMA) with half-life tied to the spread's own mean-reversion speed (below), with **robust** dispersion (use MAD-scaled or winsorize at the 1st/99th percentile of innovations) so a single flash event doesn't inflate σ and silence the signal for hours.
- **Mean-reversion speed:** fit an Ornstein–Uhlenbeck (OU) process to the spread residual; extract half-life **HL = ln 2 / κ**. HL is used three times in this spec: to set the EWMA window, to set the time stop (§3.3), and to set the funding-accrual horizon in the cost model (§4.4). A pair is only tradeable if HL is estimated with reasonable confidence and sits inside your operating band (for this class of strategy, roughly minutes to a few days; HL longer than ~5 days means funding/borrow drag dominates the convergence PnL — reject the pair).
- **z-score:** `z_t = (S_t − μ_t) / σ_t`, computed event-driven and evaluated on a 100 ms–1 s cadence.


**Build the spread correctly.** Use log prices, and never a static OLS hedge ratio fitted once over history — hedge ratios in crypto are violently unstable. Best practice is a Kalman-filtered dynamic hedge ratio, or a rolling regression with a window matched to your holding horizon (a 90-day window for a 4-hour holding period is a category error).

**Sample in event time, not calendar time.** Crypto activity is wildly non-uniform across the day. Volume-time or trade-time bars produce far better-behaved return distributions than 1-minute bars.

**Use robust normalization.** Standard z-scores with rolling mean and standard deviation get destroyed by single liquidation cascades — one wick inflates the denominator and suppresses your signal for the whole lookback window. Use rolling median and MAD (or exponentially weighted variants), and estimate the spread's half-life by fitting an Ornstein–Uhlenbeck (OU) process on a rolling basis. The half-life is not decoration: it drives the entry threshold, the time stop decisions downstream. If the fitted half-life is unstable or drifting longer, that is itself a signal-decay warning.

Model the spread in a **slippage-adjusted, funding-adjusted, fee-adjusted unit**. Your reversion target isn't zero; it's the no-arbitrage band whose width equals round-trip costs plus expected funding paid/received over expected holding time. Most retail-grade stat arb fails here: the spread mean-reverts beautifully inside a band narrower than the costs to trade it.

**Condition on regime explicitly.** At minimum: realized vol regime, funding regime (sign and magnitude of perp funding on both legs), and an event mask (funding settlement timestamps, exchange maintenance windows, major macro prints, token unlocks/listings/delistings for the specific pair). Mean reversion that works in low-vol chop is frequently a momentum-bleed in trending regimes; the signal should know which world it's in rather than relying on the stop-loss to find out.

**Regime-condition everything.** Crypto spreads behave completely differently in cascade conditions (liquidation-driven, fat-tailed, spreads widen 10x and *keep widening*) versus quiet conditions. A single OU half-life parameter fit across both regimes is fiction. Practical approach: condition on realized vol, funding extremity. Simple regime gates outperform elaborate regime models.


### 1.4 The carry signal (funding RV)

For each candidate structure, compute **expected net carry over the holding horizon H** (set H = 2–3 × HL, or to the next funding settlement(s) for pure carry trades):

```
Carry(H) = Σ over settlements in H of [ E[f_short leg] − E[f_long leg] ]
```

E[f] for the next interval is the venue's published predicted rate; beyond the next interval, shrink toward a 7-day EWMA of settled rates (funding is persistent but mean-reverting; do not extrapolate a single spiky interval across a week — annualizing one 1-hour print is the canonical retail error this strategy harvests).

Note the settlement-interval asymmetry explicitly: a leg on an hourly-settlement venue realizes its predicted funding 8× faster than an 8h-settlement leg. Your carry estimate must sum actual scheduled settlements, not "annualized rates," because annualization hides the timing mismatch that is often the trade.

### 1.5 The composite signal

A structure is **signal-active** when **both** hold:

1. `|z_t| ≥ z_entry` (statistical abnormality; default z_entry = 2.0–2.5, calibrated per pair live), **and**
2. `S_t(Q) + Carry(H) ≥ m × BE(Q)` — the executable spread plus expected carry exceeds a multiple **m** of the break-even cost from §4 (default **m = 1.5**; never below 1.25).

Condition (2) is the bridge demanded by the mandate: no entry condition exists that does not reference the cost model. The z-score alone is never sufficient — a 3σ event on a pair whose σ is 2 bps is noise relative to an 18 bps cost stack.

---


## 2. Entry logic

### 2.1 Persistence / confirmation filters (anti-phantom)

Fire entry only if all of the following hold simultaneously:

- **Time persistence:** the composite signal (§1.5) has been continuously true for **T_confirm** (default 500 ms for cross-venue perp spreads; 2–5 s for slower structural pairs). Dislocations that survive 500 ms on liquid venues are real imbalances, not feed artifacts; dislocations that don't were latency mirages you would have paid taker fees to discover.
- **Update independence:** the condition has been re-confirmed across ≥ 3 distinct book updates on *each* venue (protects against a frozen feed silently "persisting").
- **Spoof/iceberg filter:** the depth supporting `P_sell(B,Q)` and `P_buy(A,Q)` must not be >60% attributable to a single price level or single resting order, and that depth must have survived ≥ 2 update cycles. A spread created by one large resting order that appeared 80 ms ago is bait.
- **Staleness gate:** quote age on both venues < 250 ms (local receive-time basis); no open sequence gaps; per-venue latency estimate within 3× its trailing median.
- **Funding-settlement window:** no settlement on either leg inside the next execution window *unless* the trade is explicitly structured to capture that settlement (carry trades often want to enter just before a settlement on the receiving leg; directional-basis trades want to avoid entering into one and inheriting an unmodeled payment).

### 2.2.1 Pre-trade feasibility checks (must all pass at decision time)

- **Margin:** post-trade margin utilization on each venue ≤ your buffer (check against the venue's *current* tiered margin schedule for that symbol — initial-margin tiers step with position size).
- **Depth:** displayed depth within your slippage budget ≥ **k × Q** on both legs (default k = 3). You should never need the whole displayed book to fill your clip.
- **Instrument state:** symbol not in reduce-only/post-only/auction mode on either venue.
- **Transfer channels (inventory-rebalancing strategies only):** deposits *and* withdrawals open for the asset on both venues. If your strategy's steady state requires periodically flying inventory between venues, a closed withdrawal channel converts an arb into a directional position; this check is therefore an entry condition, not an ops afterthought.

### 2.2.2 Entry timing: how pros avoid catching a falling knife
Spread expansion must decelerate. Pros almost never enter at max spread. They wait for:
	•	Second derivative to turn
	•	Spread widening rate ↓
	•	Failed attempts to push wider
No slowdown = no entry
!!! Your job is not to predict convergence—it is to identify when the marginal force that caused divergence is exhausted.

### 2.3 Execution at entry

Two regimes, chosen by signal type:

**(a) Dislocation capture (cross-venue basis, fast spreads):** simultaneous **market** orders on both legs. Child-clip entries: each child ≤ 25–50% of top-3-level depth.

**(b) Carry capture (funding RV, slow spreads):** same, simultaneous **market** orders on both legs. Child-clip entries: each child ≤ 25–50% of top-3-level depth.



**Threshold in net bps, not z-units.** The z-score is a ranking device; the entry gate is economic: enter only when the expected reversion to your exit point exceeds the modeled round-trip cost by a margin — 2–3x cost coverage is a sane default for structurally anchored spreads, wider for tier-(5) statistical spreads. This automatically widens thresholds on illiquid pairs and in stressed regimes, which is exactly the behavior you want and which fixed z-thresholds fail to produce.

**Gate on toxicity.** Do not enter immediately after a large aggressive sweep in your direction-to-be, when order-book imbalance strongly opposes your fill side, or in the minutes around funding settlement (price routinely dislocates mechanically and snaps back — that dislocation is sometimes the trade, but only if it's modeled, not stumbled into). A simple microprice/imbalance filter on the passive leg meaningfully cuts adverse-selection cost on fills.

**Scale entries across the z-path, not at a single trigger.** Splitting entry across, say, z = 2.0 / 2.5 / 3.0 improves average entry and reduces the all-in-at-the-worst-tick failure mode.

---

## 3. Exit logic

Exits are where stat-arb PnL is actually made or lost; the entry merely buys an option on convergence. Four exit channels, evaluated continuously, first-to-trigger wins:

### 3.1 Convergence / profit-target exit

Exit when the **executable exit spread** (recomputed with the same VWAP machinery, in the unwind direction) satisfies:

```
S_exit(Q) ≤ z_exit band AND remaining expected PnL < cost of waiting
```

Concretely: default `z_exit = 0.25–0.5` (asymmetric to entry — enter at 2+, exit near 0; do **not** wait for z to cross zero and overshoot, you are not paid for the second half of the round trip). The economic override: if the *remaining* convergence value `(S_t − S_exit_target)` is smaller than expected funding/borrow drag over the next HL, exit now regardless of z. Holding a nearly-converged spread that pays negative carry is renting risk for free.

### 3.2 Carry-decay / funding-flip exit (forced unwind class)

Recompute Carry(H) at every funding-rate update. Unwind when:

- expected net carry over the next horizon turns **negative net of exit costs**, confirmed over **m_f = 2–3 consecutive predicted-rate updates** (single-update flips are noise; confirmed flips are regime changes), or
- for pure funding trades: the realized differential has compressed below `BE_exit` for 2 consecutive settlements.

For trades with an hourly-settlement leg, evaluate this hourly — the venue's settlement cadence sets your decision cadence.

### 3.3 Time stop (forced unwind class)

`τ_max = c × HL`, default **c = 3**. A spread that hasn't converged within 3 half-lives is telling you the OU fit is wrong *for the current regime*; the model, not the market, is what you stop out of.

### 3.4 Divergence / structural-break stop (forced unwind class)

Hard unwind, taker on both legs, when any of:

- `|z_t| ≥ z_stop` (default 4.0–4.5) — but **first** run the structural-break check: a CUSUM or rolling-variance-ratio test on spread innovations. If the break test fires, do not "average in" or wait for reversion; the equilibrium you estimated no longer exists (depeg, delisting announcement, exploit, oracle migration). Flatten.
- Venue-health trigger on either leg: WebSocket disconnect beyond resync budget, withdrawal halt on a relevant asset, symbol moved to reduce-only. Rule: **flatten the leg on the *unhealthy* venue first** — you can always manage the surviving exposure; you cannot manage an exposure on a venue that has stopped responding.
- Margin-utilization breach on either venue, with the full liquidation to unwind.

### 3.5 Exit execution

Default **aggressive** (taker) exits.

**Exit before the mean.** The OU drift shrinks as the spread approaches equilibrium, so the last fraction of reversion has the worst expected-return-per-unit-time on the book and often doesn't clear carry costs. Take profit at |z| ≈ 0.25–0.5 rather than 0.

**Time stop keyed to half-life.** If the spread hasn't converged within ~2–3 fitted half-lives, the entry thesis is statistically falsified regardless of P&L — flatten. Time stops are underrated in crypto RV because the alternative is sitting in a position whose hedge ratio has quietly drifted while you waited.

**Separate "wide spread" from "broken spread."** A naive stop at z = 4 just monetizes your worst fills. Better: pair a wide z-stop with explicit structural-break detection — a step-change in the Kalman hedge ratio, a funding-regime flip on a basis trade, a CUSUM-style break in the residual mean, or a discrete event (delisting notice, depeg, withdrawal halt). On a confirmed break, exit aggressively at market.

**Funding-aware exits on perp legs.** Predicted funding should enter the hold/exit decision continuously. If the carry on the position flips against you and the remaining expected convergence no longer covers it, exit even at a small gross loss — and mind that settlement conventions differ across venues (8-hour vs. 1-hour funding), which changes how fast that bleed compounds.


---


## 4. Cost model

This is where most paper strategies die, so the standard is: fitted from your own fills, per venue and per pair, recalibrated continuously.

The cost model is the spine of the system: §1.5 condition (2), §2.3's slippages, §3.1's "cost of waiting," and §3.2's flip threshold all read from it. It must be **per-venue, per-symbol, per-side, programmatically refreshed**, and calibrated against your own fills.

### 4.1 Explicit fee inputs — ingest, don't hardcode

The operational conclusion: **the cost model reads your account's actual fee schedule from each venue's API daily**, including any token-discount and volume-tier effects.

### 4.2 Slippage model (per leg, function of clip and depth)

```
slip(Q) = ½ · spread_touch + λ · (Q / D)^α
```

where `D` = displayed depth within your price band (top 3–5 levels), `α ≈ 0.5–1` (start at 1 for clips ≤ top-of-book depth; square-root regime for larger clips), and **λ is calibrated continuously from your own fill data**: regress realized arrival slippage (fill VWAP vs. decision-time book walk) on `(Q/D)^α`. Pre-trade, you already computed `P_buy/P_sell` by walking the book; the λ term covers the adverse drift between decision and fill plus undisplayed-liquidity effects. If realized slippage persistently exceeds the model on a venue, that venue's λ rises and the breakeven (and hence entry threshold) rises with it — the system self-corrects toward venues where you actually get filled.

### 4.4 Funding and holding-period costs

```
FundingCost(H) = Σ over scheduled settlements in H of  − E[net funding received]
```

with H = expected hold = min(2–3 × HL, τ_max), settlements enumerated from each leg's actual per-symbol schedule (8h / 4h / 1h — heterogeneous by design now, per current exchange practice of 8-hour standard cycles with 4-hour or 1-hour cycles for designated volatile tokens). For carry trades this term is negative (it's the revenue); for basis-convergence trades it is usually a drag and frequently the largest single cost line for HL > 1 day. One operational note that matters at the margin: on most venues funding is only exchanged at the exact settlement timestamp — a position opened and closed between two settlements pays zero funding, so short-HL trades can often be timed to straddle zero settlements.

### 4.5 Transfer / rebalancing costs (inventory strategies)

`Transfer_amortized = (withdrawal fee + gas + spread cost of any asset conversion) / (expected round trips per rebalance)`, plus a **time-at-risk charge**: capital in flight is idle for 1–60+ minutes; charge it at your hurdle rate × transfer time × frequency.

### 4.6 Break-even spread and the entry threshold

For a structure with legs L ∈ {1,2}, entry execution regime e ∈ {taker, taker} and exit regime x:

```
BE(Q) =  Σ_L [ fee_e(L) + slip_e(L,Q) ]            (entry)
       + Σ_L [ fee_x(L) + slip_x(L,Q) ]            (exit)
       + FundingCost(H)                            (holding)
       + Transfer_amortized                         (if applicable)
```

**Entry threshold (closing the loop with §1.5): `S_t(Q) + Carry(H) ≥ m × BE(Q)`, m = 1.5 default.**

Worked example, cross-venue perp–perp basis on a mid-cap, taker-in/taker-out, $50k clip, base-tier fees, HL ≈ 4 h, one 8h settlement expected in hold:

| Line | bps |
|---|---|
| Entry: 2 × taker fee (4.5 each) | 9.0 |
| Entry: 2 × slip (modeled, 1.5 each) | 3.0 |
| Exit: 2 × taker fee (4.5 each) | 9.0 |
| Exit: 2 × slip (modeled, 1.5 each) | 3.0 |
| Expected net funding drag over hold | 2.0 |
| **Break-even** | **≈ 26 bps** |
| **Entry threshold (×1.5)** | **≈ 39 bps** |


**Close the loop with TCA.** Every fill gets a post-trade record: pre-trade cost estimate vs. realized implementation shortfall, decomposed into spread, impact, timing, and fees. The continuous recalibration of the pre-trade model from this log is what keeps the entry gate (the 2–3x cost coverage rule) honest as your size, the venue's liquidity, and your fee tier evolve. A strategy whose cost model is six months stale is running on fiction.
