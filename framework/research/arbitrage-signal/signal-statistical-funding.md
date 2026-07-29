# Statistical Funding-Carry Signal Design Analysis Framework — Strategy Group B

*Hardened engineering specification. This document supersedes the base framework and its phantom-carry companion; it is self-contained.*

Every estimator and pipeline stage below is hardened against a named **phantom-carry source** — a contaminant that fabricates false carry. **Phantom carry** is any funding-carry signal that *looks* tradeable on the screen but resolves to negative net carry, a trapped leg, a forced unwind at an adverse basis, or parked delta-neutral capital that never clears its hurdle. A carry trade has **three places to lie to you** — the *number* (what funding you think you'll receive), the *duration* (how long you'll receive it), and the *basis* (what you pay to get in and out) — plus a meta-layer where the *backtest itself* is the artifact. Each phantom is labeled `[Phantom X]` and wired in at the exact stage where its lie would otherwise propagate into a downstream statistic the strategy treats as truth. The recurring discipline, enforced throughout: **never net carry and cost into one number, always gate on the conservative bound, and never let a point estimate stand in for a distribution.**

---

### What is statistically different about funding carry (read this first)

Group A trades a **spread that reverts**: the alpha *is* the deviation, the object is an OU process, the trade outcome is a double-barrier first-passage (converge before stop), and a **short** half-life is good. Group B is not that problem. Three inversions define it, and the whole framework follows from them:

1. **The signal is a forecast, not an observable.** The spread in Group A is observed at signal time. The carry in Group B is *expected future funding accrued over an uncertain holding period* — `expectedCarry(annualized) − C_total(annualized over E[H])`. The forecast (premium-index → next-period funding) is a first-class predictive model that must be **scored out-of-sample against a naïve baseline**, not assumed. Group A has no real analog of this; it is §5's load-bearing addition here and the most likely *silent* failure mode of the group (see `[Phantom E1]`).
2. **Persistence is the alpha, not anti-persistence.** Group A gates on `H < 0.5` (fast reversion). Group B wants the favorable funding **regime to persist** long enough to clear round-trip cost. The core distributional object is therefore a **survival / first-passage-to-unfavorable** problem (how long does favorable funding last), not a first-passage-to-convergence. The gate analog of Group A's `P_converge` is `P(favorable-funding duration ≥ break-even holding period)`.
3. **There is an embedded Group-A problem inside every Group-B trade — the basis leg.** The position is delta-neutral by construction, so price is not the risk; the **basis (perp − spot) or inter-venue perp spread is both the entry cost and the exit-timing problem.** You pay it on the way in and want it near zero on the way out. That sub-problem *is* mean-reversion and is governed by the **full Group A OU / first-passage / Bertram machinery applied to the basis** — this framework reuses it rather than re-deriving it (see §1 *Basis leg* and §3 *Basis-exit timing*). This is the Group-A problem living inside every Group-B trade, and it is where genuine, durable carry is most often handed back at the door (see `[Phantom D1]`, `[Phantom D2]`).

So Group B = a **carry/survival problem** (funding) wrapping an **embedded mean-reversion problem** (basis exit), tied together by a **break-even holding period** that the survival distribution must clear. Everything below operationalizes that.

---

## Shared Carry Framework (applies to ALL Group B strategies)

Define these primitives once and reference them in every strategy spec.

### Funding-rate construction

- **Realized funding to the position `f_t`:** the funding actually exchanged per settlement, **signed so that `f_t > 0` is a credit to the position** (long-spot/short-perp receives when the perp funding rate is positive; the Perp-Perp differential is signed analogously). Sourced from each venue's settlement record.
- **Funding interval & annualization.** State the funding interval `Δτ` **per venue** (commonly 8h; some venues 1h/4h, some dynamic). Annualize as `F_t = f_t × P`, where `P = periods_per_year = (365 d) / Δτ`. All carry, cost, and hurdle quantities below are stated in **annualized bps** so the carry signal and the annualized round-trip cost are directly comparable. Per-venue `Δτ` must be a named parameter — do not assume 8h.
- **Predicted funding `f̂_{t+1}` (and the forecast path `f̂_{t+1..t+h}`).** The signal is forward-looking: build a forecast from the **premium index** plus the venue's funding formula (premium component + interest-rate/clamp component, with the venue's cap). State the model form explicitly (e.g., `f̂_{t+1} = clamp(premiumIndexEWMA + interestComponent, −cap, +cap)`), the premium-index sampling/EWMA half-life, and the multi-period path construction (persistence-decayed forward funding from §2). The forecast model is **validated as a model** in §5 — it does not enter trading until it clears the baseline.
- **Funding series for statistics.** Maintain the per-period funding history over a stated lookback `L_fund` in both funding periods and wall-clock (e.g., `L_fund = 90 d → ~270 prints @ Δτ = 8h`). Funding-print counts are small relative to Group A's tick series — every estimator below must state its **minimum print count** to be trusted, and short histories (new listings) are flagged, not silently fit (see `[Phantom F2]`).

### Basis / execution-spread construction (the embedded mean-reversion leg)

- **Basis `b_t`:** the executable, depth-weighted price spread you actually cross to open and close — `b_t = perpBid_depthWeighted − spotAsk_depthWeighted` for Spot-Perp (to the intended clip), or the inter-venue executable perp spread for Perp-Perp. Constructed **identically to the Group A executable spread** (L2, timestamp-aligned to ≤ 100 ms skew, never top-of-book mid), on the same signature-plot-selected `Δt` grid (Group A, *Microstructure-noise-corrected estimation*).
- **The basis is run through the Group A framework, not this one.** Its distribution, stationarity/cointegration validation, OU fit, jump-cleaning, half-life `t_half^b`, first-passage convergence, and Bertram bands are exactly the Group A objects. This framework consumes three outputs from that machinery: (i) `b_entry` — the basis paid at entry, a cost; (ii) `t_half^b` and the basis first-passage density — the **exit-timing** distribution (how long until the basis is near zero); (iii) the basis **tail / blowout** model — the interim-divergence risk (§2, §3). State explicitly that the basis sub-analysis is the Group A spec applied to `b_t`.

### Total cost (per round trip, annualized)

`C_total(bps) = takerFees(both legs, in+out) + expectedSlippage(clip, depth, both legs, in+out) + bidAskCrossCost(both legs, in+out) + b_entry + b_exit`

- Every component in bps of notional. Slippage is **modeled** from depth-weighted book impact at the intended clip, not guessed (Group A cost-model standard).
- **`[Phantom D1] — Wide entry basis paid to chase thin carry.** You cross an adverse basis to open the position and capture funding thinner than the basis you just paid — the classic way these trades lose. **Defense:** `b_entry` is an explicit, real cost line in `C_total`, never a rounding error and never netted against carry. Enforce an **entry band** `b_t ≤ b_max` (§*Persistence & sign-consistency filter*, strategy *Entry* gates) so the position is not opened paying a wide basis for thin carry. Treat the basis **as a signal, not only a cost**: entering when the perp is rich (Spot-Perp) *adds* convergence credit on top of carry; entering when it is cheap subtracts it.
- **`[Phantom D2] — No clean exit (the basis you can never get out of).** `b_exit` is *modeled* from the basis-exit-timing distribution (§3): the expected basis you cross at unwind given you wait for the clean-basis band subject to the grace window `W_grace`. **Defense:** model `b_exit` from the Group A basis first-passage density at **both** the expected level **and** a conservative **p75** level, and price the conservative `b_exit` into `C_total` *up front*. A long basis half-life `t_half^b` means the clean band is rarely reached, so carry harvested over the hold is handed back at the door — report the ratio `t_half^f / t_half^b` (§3) and flag long-half-life basis as an exit-cost risk even when carry is high. State both the expected `b_exit` and the conservative (p75) `b_exit`.
- **Annualization:** `C_annual = C_total × (P / H_periods)`, where `H_periods` is the **expected holding period in funding periods** (from §3's survival distribution, charged at a conservative quantile — p25 of favorable duration, i.e., assume you get *out early*, not at the median). Annualizing the round-trip cost over an optimistic holding period understates the hurdle; the conservative-quantile convention is mandatory.
- **Break-even holding period `H_be`:** the holding period at which cumulative expected carry equals `C_total`: `H_be = C_total / E[f per period]` (periods), stated in wall-clock. This is the central tradeability number and is gated in §3.

### Net carry edge

`E_carry(annualized) = Carry_annual − C_annual`, where `Carry_annual` is the persistence-adjusted expected annualized funding over the forecast path (§2/§3), **not** the current single print. A carry signal exists only when `E_carry > R_margin` (an annualized-bps safety margin stated explicitly and derived from the **fitted funding tail** of §2 — not a Gaussian multiple — because the downside is an adverse funding spike, which is fat-tailed). The hurdle rate is `R_hurdle = C_annual + R_margin`. Keep **funding received as a revenue line, out of `C_total`** — compare carry-vs-cost explicitly so the carry edge and the basis/execution cost are never netted into one opaque number.

### Persistence & sign-consistency filter

This is the Group B analog of Group A's persistence filter and it is **load-bearing, not hygiene** — no entry on a one-print funding anomaly.

- **`[Phantom A1] — Single-print squeeze mirage.** One large favorable print (a liquidation-driven funding spike) dominates a short window and the annualized carry looks enormous; by the next settlement it is gone — squeeze funding mean-reverts fast, and the print you chased was frequently the *worst* moment to enter (you cross a blown-out basis to capture funding that has already evaporated). **Defense:** gate on **sign-consistency**, not on the headline print.

Require, over the last `K` funding periods (state `K` per strategy):
- **Sign-consistency** `ρ_sign = (#favorable-sign periods) / K ≥ ρ_min` (state `ρ_min`), and
- the **predicted** next-period funding `f̂_{t+1}` also favorable and above the per-period hurdle.

A single large favorable print with `ρ_sign` below floor is **rejected** — funding spikes mean-revert fast and are frequently the *worst* time to enter (you pay a wide basis to chase a print that is gone next period). The spike mass is not discarded; it is routed into the tail model (§2 *Heavy-tail fitting*), never into central tendency (see `[Phantom A2]`).

### Staleness / sanity guards

Reject entries if: the predicted funding exceeds the venue cap (formula/feed error); the basis exceeds an implausibility bound (bad data or halted venue); or a funding **jump/regime break** was detected within a stated suppression window (§2) and the regime is not yet re-validated. For Perp-Perp, additionally reject if the two venues' funding clocks are misaligned beyond the stated tolerance for the differential to be meaningful — the cross-venue **staleness guard** for `[Phantom A6]` (see §1 *Cross-venue alignment*): suppress the signal when settlement timestamps drift beyond tolerance.

---

## Statistical Funding-Carry Analysis Framework (applies to ALL Group B strategies)

The core of the mandate. For every strategy, the **Signal definition** must instantiate every item below with concrete estimation windows, re-estimation cadence, named variables, and the pass/fail threshold that gates trading. State for each statistic which series it runs on (funding `f_t`, predicted `f̂`, or basis `b_t`), the lookback, the re-estimation cadence, and the gate. All statistics are computed on the hygiene-cleaned series (§5 *Data-quality*).

### 1. Funding & basis construction and forecast (upstream of the carry signal)

These determine what series everything downstream runs on; getting them wrong silently biases every gate. **This is where the *number* lies** — the funding figure you are reading may not be the funding you will accrue, before any question of persistence or basis arises.

**Funding-rate history & distribution analysis**
- Over `L_fund`, compute and track on the per-period funding `f_t` (and annualized `F_t`): rolling mean `μ_f`, rolling std `σ_f`, **skew and excess kurtosis** (funding is strongly skewed and fat-tailed — squeeze prints dominate), and empirical quantiles (p1/p5/p50/p95/p99).
- **`[Phantom A2] — Unconditional-mean inflation by rare spikes.** A high *average* funding over the lookback can be built almost entirely from a handful of fat-tailed liquidation prints; a high unconditional mean is not a steady favorable median — it is a thin tail wearing a trend's clothing. **Defense:** report the **conditional-on-favorable-sign** mean and the **median** separately from the **unconditional** mean, alongside skew/kurtosis and p1–p99. **Gate the tradeable edge on the steady median** (the central-tendency number), and route the spike mass into the tail model (§2 *Heavy-tail fitting*), never into central tendency. A high unconditional mean built from rare huge prints is not the same tradeable edge as a steady favorable median.
- Track the **structural funding level** `μ_f^struct`: funding does not revert to zero, it reverts to a market-structure-dependent, regime-dependent level (positive in bull regimes, negative in bear). The deviation that decays is `f_t − μ_f^struct`, and §2's process model runs on that residual, not on raw `f_t`.

**Funding forecast `f̂` (the analog of fair value)**
- The premium-index → next-period funding map is the predictive core. State: the premium-index source and sampling, the EWMA/half-life used to smooth it, the venue funding formula it is fed through (interest component, clamp/cap), and the multi-period forward path `f̂_{t+1..t+h}` built by decaying toward `μ_f^struct` at the funding-decay speed `θ_f` from §2. The forecast is a **named, versioned model**; its out-of-sample skill is gated in §5 (`[Phantom E1]`) before it can move size.

**Cross-venue alignment (Perp-Perp only)**
- **`[Phantom A6] — Cross-venue clock misalignment.** The differential `Δf_t = f(short venue, received) − f(long venue, paid)` is only meaningful when the two venues' settlement clocks, intervals, and caps are aligned; computed across venues whose clocks differ, the number is an apples-to-oranges artifact rather than an accruable edge. **Defense:** convert both venues to a common **annualized accrual rate** and align on **overlapping settlement windows** only; **itemize each venue's `Δτ`, cap, and fee tier** — they are not assumed equal. Flag and **suppress** (per *Staleness guards*) when settlement timestamps drift beyond the stated tolerance.

**Basis leg construction**
- Construct `b_t` per the Shared Framework and hand it to the **Group A** machinery. The only Group-B-specific choices here: the clip size for depth-weighting must match the carry clip, and the basis must be measured against its **funding-implied, time-varying fair value `fair_t`** (Group A, *Time-varying, funding-implied fair value*) — because in a carry trade the basis is *expected* to sit away from zero by roughly the funding it is pricing. Exit-to-zero is exit-to-`fair_t`, not exit-to-0.

### 2. Process & distribution model (funding and basis)

The funding process, not a spread, is the primary object; the basis process is the secondary (Group-A-governed) object. **This is where *duration* begins to lie** — the regime can be right today yet decay or flip before it clears cost.

**Funding-rate process & persistence model**
- Fit a mean-reverting model to the funding residual `f_t − μ_f^struct`: discrete OU / AR(1), `f_t − μ^struct = φ (f_{t−1} − μ^struct) + ε_t`, with funding-decay speed `θ_f = −ln(φ)/Δτ` and **funding half-life `t_half^f = ln2/θ_f`**. Report `φ, θ_f, t_half^f` with the estimation window `L_OU^f` and method. **Interpretation is inverted vs Group A:** a *long* `t_half^f` (slow decay of the favorable anomaly) is *good* — it means the carry persists. The gate is `t_half^f ≥ t_half_min^f` chosen so the favorable regime is expected to outlast `H_be`, and is enforced on the **lower CI bound** (§5).
- **`[Phantom C2] — Phantom persistence (a long half-life that is a fitting artifact).** AR(1) on a short funding history overstates persistence; a slowly-decaying ACF can be misread; and `t_half^f` looks reassuringly long when the favorable anomaly will actually decay in a few periods. **Defense (this subsection + §2 *Model adequacy* + §5 *Estimation uncertainty*):** corroborate the AR(1) half-life with the **long-memory estimate `d`** and the **empirical funding ACF profile**, use **bias-corrected AR(1)** and a **block bootstrap** for CIs, and **gate on the lower-CI bound** of `t_half^f`. A half-life that only passes at its center is not cleared.
- **Long-memory check.** Funding can exhibit long memory (slowly decaying ACF) that AR(1) understates. Estimate the fractional-integration parameter `d` (GPH or local-Whittle estimator) and report it alongside `t_half^f`. `d > 0` corroborates persistence; `d ≈ 0` warns the AR(1) half-life overstates regime durability. An ACF that decays to zero within a few periods *contradicts* a long fitted `t_half^f` and **must reconcile before trading** (cross-reference *Model adequacy* below). State the gate or use `d` as a score input.
- **Sign-flip dynamics.** **`[Phantom C3] — Underestimated sign-flip hazard.** The real risk is often not slow decay but a *sign flip* — favorable funding turning adverse next period — and a model that only fits decay speed misses it entirely. **Defense:** estimate the per-period **flip hazard** `λ_flip` (probability favorable funding turns adverse next period) conditional on current state (**premium-index level and vol regime**), e.g., via a logistic hazard model, and feed `λ_flip` **directly into the survival distribution** in §3. Do not open carry into a high-vol, high-flip-hazard regime even at high current funding (vol-state entry gate below).

**Conditional volatility of funding & basis**
- Funding volatility clusters around events, liquidations, and listings; the basis vol does too. Estimate time-varying `σ_f,t` (EWMA-vol, state half-life, or GARCH(1,1) on the funding residual) and `σ_b,t` (on the basis). A fixed adverse-funding margin against a static `σ_f` mis-states the tail risk in turbulent regimes exactly when sign-flips and basis blowouts cluster. **Vol state also gates entry** (the entry half of the `[Phantom C3]` defense): do not open carry into a high-vol, high-flip-hazard regime even at high current funding.

**Heavy-tail fitting of funding (the downside that matters)**
- The dominant Group-B tail risk is an **adverse funding spike** (a squeeze on your side) and a **basis blowout** at the same moment. Do not stop at kurtosis: fit the funding tail explicitly — a Student-t (estimate dof) for body-plus-tail, and **EVT / generalized Pareto (GPD)** on adverse-side funding exceedances to model the spike tail directly. This is also where the favorable-spike mass excluded from central tendency by `[Phantom A1]`/`[Phantom A2]` is correctly accounted. The safety margin `R_margin`, the worst-case adverse-funding accrual in the carry distribution (§3), and the basis stop band are derived from the **fitted** tail, not a Gaussian multiple — a Gaussian margin badly understates squeeze risk.
- Fit the **basis** tail separately (same GPD tooling, on `b_t`): this governs the basis-blowout interim band and the conservative `b_exit`.

**Jump detection (funding regime changes & basis dislocations)**
- A funding **regime jump** (listing, market structure shift, an exchange changing its funding formula) is a discontinuous change in `μ_f^struct`, not a fast-reverting deviation — entering on the old regime's statistics is a structural error. Detect level shifts in funding with a CUSUM / Bai-Perron break test on the funding series (small-N appropriate); on a detected funding break, **suspend and re-validate `μ_f^struct`** before resuming (Shared *Staleness guards*).
- A **basis jump** (liquidation cascade) is detected on `b_t` with the Group A jump tests (Lee-Mykland / BNS bipower) and drives the basis-blowout interim rule and the post-jump entry-suppression window. Distinguish a transient basis jump (mark-to-market, hold) from a persistent regime break (exit/re-validate) — this distinction *is* the Spot-Perp "basis-blowout interim rule" of the strategy definition, made statistical.

**Model adequacy**
- **`[Phantom F2] — Small-sample over-fit of the process model.** Funding histories are short (≈270 prints at 90 d / 8 h), so an over-parameterized OU/hazard/survival fit will overfit and produce confident phantom statistics — especially on new listings. **Defense:** prefer the **simplest model that whitens residuals**. Inspect ACF/PACF of `f_t` and of the AR(1) residuals, run **Ljung-Box** on residuals with a stated p-value gate, and prefer the simplest whitening model. State a **minimum print count** for every estimator (Shared *Funding series*), and **flag short histories explicitly** rather than silently fitting them. Report the funding **autocorrelation profile across horizons** — it is the empirical persistence the whole carry case rests on; a profile that decays to zero within a few periods contradicts a long fitted `t_half^f` and must reconcile before trading (the ACF half of the `[Phantom C2]` defense).

### 3. Carry as a distribution (not just a point carry estimate)

Point carry × a guessed holding period is the Group-B equivalent of "half-life alone" — it omits the two distributions that decide the trade: how long the favorable regime survives, and what the cumulative carry net of basis actually is. **This is where *duration* and *basis* are priced honestly.**

**Favorable-regime survival (the analog of double-barrier convergence)**
- **`[Phantom C1] — Carry that doesn't survive to break-even.** A 30%-annualized carry that stays favorable past the break-even holding period only 55% of the time is a fundamentally different trade from the same carry at 85% — but they read identically as "30% carry." **Defense:** estimate the distribution of `T_fav` = duration the funding stays favorable-and-above-per-period-hurdle from entry, **two ways and reconcile**: (i) **non-parametrically**, a **Kaplan-Meier** survival curve `S(t) = P(T_fav > t)` from historical favorable-funding episode durations, with proper **right-censoring** of episodes cut by data end; (ii) **parametrically**, from the §2 flip hazard `λ_flip` and funding decay `θ_f` (a **Weibull / hazard-based** first-passage of `f_t` to the hurdle). Report `S(t)`, the **median and the lower-tail p10/p25 durations** — here the *lower* tail is the risk (regime dies early), the mirror of Group A caring about the right tail of convergence time.
- **This is the central gate.** `P(T_fav ≥ H_be) ≥ p_min` (state `p_min`), evaluated on the **lower-CI survival** (§5), is the Group-B analog of `P_converge ≥ p_min`: the model probability that the favorable regime outlasts the break-even holding period `H_be = C_total / E[f per period]`, i.e., the probability the trade clears its round-trip cost. Gate on the lower-CI bound — a survival number that only passes at its center is not cleared.

**Cumulative-carry distribution**
- Simulate cumulative net carry over the holding period by drawing funding paths from the fitted process (§2) with its tail (so adverse spikes appear at their fitted frequency) and integrating `Σ f_τ` until the exit rule fires, net of `C_total`. Report `E[netCarry]`, its variance, the **p5 (worst-case) net carry**, and `P(netCarry > 0)`. Gate the net edge against the **p25 cumulative carry**, not the mean — require the trade to clear cost on a conservative path, not the expected one. This replaces Group A's "net edge must survive cost over the conservative convergence quantile."

**Basis-exit timing (the embedded Group-A first-passage)**
- The exit rule prefers to unwind when the basis is near `fair_t`. This is the `[Phantom D2]` defense priced as a distribution: from the **Group A** basis OU first-passage density, report the distribution of **time-to-clean-basis** and set the **grace window `W_grace`** (max time the position waits for a clean basis after the carry signal dies) from a basis first-passage tail quantile, and the **conservative `b_exit`** (the basis you expect to cross if forced out at `W_grace`), modeled at both the **expected** and the **conservative p75** level. If the basis half-life `t_half^b` is long relative to the funding interval, clean exits are rare → `b_exit` is large → it **must be priced into `C_total` up front** (§*Total cost*). Report `t_half^b` and flag long-half-life basis as an exit-cost risk even when carry is high.
- **Coupling note:** the ideal trade has **long `t_half^f` (carry persists) and short `t_half^b` (clean exits available)**. The ratio `t_half^f / t_half^b` is a compact tradeability descriptor — high is good (persistent carry with cheap exits is the canonical good case). State it in the score.

**Asymmetric / sign-conditional carry**
- The receive side and pay side are not symmetric (directional fees, the venue's funding clamp is often asymmetric, liquidity differs). Estimate decay and flip hazard conditional on sign, and allow asymmetric hurdles and persistence requirements by side.

### 4. Regime, funding-clock & liquidity coupling

**Carry opportunity density / frequency**
- **`[Phantom G1] — Carry too infrequent to earn the parked capital.** The subtlest phantom: a trade genuinely profitable per episode but whose fundable episodes arrive so rarely that the delta-neutral capital sits idle below its hurdle most of the time — per-trade profitability masks portfolio-level drag. **Defense:** over `L_fund`, report the fraction of time funding clears the per-period hurdle, the count and rate of **fundable episodes** `f_signal` (entry-to-flip cycles that would pass persistence + basis-feasibility + cost gates), and the **median realized net carry per completed episode** `bps_per_episode` (after `C_total`). Enforce an **opportunity-density floor** on `f_signal` with stated reasoning: a market whose carry clears the hurdle too rarely does not justify the parked delta-neutral capital even if each episode is profitable. **Distinguish signal frequency** (funding crosses the hurdle) **from trade frequency** (crossings that *also* pass persistence, basis-band, and forecast-skill gates) — the gap measures non-actionable carry.

**Funding regime stability & structural breaks**
- Re-estimate `μ_f^struct, θ_f, t_half^f, λ_flip` on rolling sub-windows; track drift. A market whose structural funding level or persistence drifts materially is **regime-unstable** — in-sample carry statistics will not hold out-of-sample. Apply the §2 funding break test; on a break, reset and re-validate before resuming.
- **Regime-switching model.** Break tests detect a shift after it happens; they do not classify the current regime. Fit a **Markov-switching model** on funding with ≥ 2–3 states (e.g., persistent-positive-carry, persistent-negative-carry, choppy/no-carry) and **trade carry only in a validated persistent-favorable state.** Expose a regime green/red gate; a rising `P(exit to choppy/flip state)` is an early warning of carry decay before `ρ_sign` visibly breaks.

**Funding-clock & seasonality conditioning**
- This is *more* central than in Group A. Funding settles on a fixed clock and has strong structure: intraday/weekly seasonality (session and weekend effects), a market-wide regime bias (bull → structurally positive funding), and mechanical basis perturbation around each settlement. Bucket funding and basis statistics by time-of-day / day-of-week and by proximity to settlement; deseasonalize before fitting `μ_f^struct` and `θ_f`. Time entries relative to the settlement clock so you are not opening a position that owes funding before it receives any (state the rule: enter such that the first settlement after fill is a credit, not a debit).

### 5. Estimation rigor & anti-overfitting (so the gate means something)

**This is the meta-layer where the *backtest itself* is the artifact** — even with every per-market gate green, the estimation and selection process can manufacture a passing market out of noise.

**Estimation uncertainty on persistence / survival**
- The funding history is short and the AR(1)/survival estimates are small-sample biased (the `[Phantom C2]` and `[Phantom F2]` defense at the CI level). Use a **bias-corrected** AR(1) for `θ_f` and a **block bootstrap** (block length ≥ the funding ACF horizon) for confidence intervals on `θ_f`, `t_half^f`, and the survival curve `S(t)`. **Gate conservatively on the bound that hurts:** the **lower** CI bound of `t_half^f` and of `P(T_fav ≥ H_be)` — a persistence or survival estimate that only passes at its center is not cleared. The score penalizes wide CIs.

**Funding-forecast model validation (no Group A analog — mandatory)**
- **`[Phantom E1] — A forecast that never beat the naïve baseline.** The premium-index → funding model may be doing no real work — last-funding persistence (or the raw premium index) predicts just as well — while quietly moving size as if it had skill. This is the most likely *silent* failure mode of the group. **Defense:** validate the forecast **as a model**, walk-forward out-of-sample: report **directional hit-rate** (will next funding be favorable?), a **Brier score** and reliability/calibration curve for the probabilistic forecast, and the forecast's **sign/magnitude skill versus a naïve baseline** (last-funding persistence and the raw premium index), tested with **Diebold-Mariano**. The forecast may inform sizing/entry **only if it beats the naïve baseline at stated significance**; otherwise **demote it to non-size-moving** and fall back to realized-persistence-only entry, stated explicitly. An unvalidated forecast moving size is the most likely silent failure mode of this group.

**Multiple-testing / overfitting control**
- **`[Phantom F1] — Multiple-testing / data-mining.** Scanning many assets × venues × parameter sets for carry guarantees false positives; some markets "pass" by luck, and the carry of a market that passes *only because 200 were scanned* has not passed. **Defense:** report the **number of trials** and gate on a **Deflated Sharpe Ratio** and **Probability of Backtest Overfitting (PBO)**; when comparing many configurations apply **White's Reality Check / Hansen's SPA**. This meta-gate sits **above** the per-market gates — a per-market green is not a clearance until the search artifact is deflated out.

**Carry decay vs execution latency**
- Carry accrues over hours/days, so the *carry* is far less latency-sensitive than a Group A spread — but the **entry basis `b_entry` is latency-sensitive** (you pay the basis at fill, not at signal). State realized `δ` (feed → decision → both legs acknowledged) and the expected `b_entry` slippage over `δ`; discount the entry decision by it. Do not import Group A's "half-life vs latency" gate wholesale — here the relevant latency check is on the basis leg, not the funding signal.

**Data-quality / robust pre-processing**
- Funding and premium-index series need the same hygiene as the basis. Apply a robust outlier flag (Hampel / rolling-median ± k·MAD) to historical funding **only to catch feed errors, never to clip genuine squeeze prints** — a real adverse spike is signal for the tail model (§2), not an outlier to remove; state the rule that distinguishes the two (e.g., cross-check against the premium index and the venue cap). Handle missed settlements, venue downtime, and clock skew explicitly (exclude vs interpolate, stated), mark boundaries so downtime is not mistaken for a regime break, and report the fraction cleaned/excluded. A market needing heavy cleaning is itself a red flag.

### 6. Validation gate & scoring

**Carry validation summary (conjunctive gate)**
- A market/venue(-pair) is **cleared for carry trading** only if it passes **all** of:
  - hygiene/pre-processing clean (§5) AND
  - funding-process validated with whitened residuals (Ljung-Box gate, simplest whitening model — `[Phantom F2]`) and a current non-broken regime (§2, §4) AND
  - persistence cleared — `t_half^f` lower-CI ≥ `t_half_min^f`, `ρ_sign ≥ ρ_min`, long-memory/ACF profile consistent (`[Phantom A1]`, `[Phantom C2]`) (§2, Shared filter) AND
  - `P(T_fav ≥ H_be) ≥ p_min` on the lower-CI survival (`[Phantom C1]`/`[Phantom C3]`) (§3) AND
  - the **basis leg passes the Group A validation gate** (stationary/cointegrated, OU-validated, jump-clean, with a tradeable `t_half^b` and feasible clean-exit band — `[Phantom D1]`/`[Phantom D2]`) (§1, §3) AND
  - `f_signal ≥` floor (`[Phantom G1]`) (§4) AND
  - the funding **forecast beats baseline** (DM-significant) or is demoted to non-size-moving (`[Phantom E1]`) (§5) AND
  - regime-green / parameter-stable / walk-forward (§4) AND
  - the overfitting meta-gate (deflated performance, PBO — `[Phantom F1]`) (§5).
- State as an explicit conjunctive gate; failing any one **suspends** the market — it is not traded at a wider hurdle.

**Minimal kill-list (triage index — every check is enforced at its stage above)**
This is a quick-reference into the gates already wired in above, not a parallel spec; each line points to where it lives and which lie it defeats. If you do nothing else, these seven catch the large majority of phantom carry:
1. **`ρ_sign ≥ ρ_min` + favorable `f̂`** (Shared *Persistence filter*, §1) — kills the single-print squeeze (`[Phantom A1]`).
2. **Conditional-on-sign mean and median, separate from unconditional; gate on the median** (§1 *Funding-rate history*) — kills spike-inflated averages (`[Phantom A2]`).
3. **Per-venue `Δτ`, clock-aligned to a common annualized accrual rate** (§1 *Cross-venue alignment*, Shared *Staleness guards*) — kills annualization and staleness artifacts (`[Phantom A6]`).
4. **`P(T_fav ≥ H_be) ≥ p_min` on the lower-CI survival** (§3 *Survival*, §5 *Estimation uncertainty*) — kills carry that won't reach break-even, including via slow decay and sign flip (`[Phantom C1]`–`[Phantom C3]`).
5. **`b_entry` as explicit cost + entry band `b_t ≤ b_max` + modeled conservative (p75) `b_exit`** (Shared *Total cost*, §3 *Basis-exit timing*) — kills the uncapturable-basis trap (`[Phantom D1]`–`[Phantom D2]`).
6. **Forecast must beat naïve baseline (DM-significant) or not move size** (§5 *Forecast validation*) — kills the phantom predictive edge (`[Phantom E1]`).
7. **Deflated Sharpe / PBO over the trial count** (§5 *Multiple-testing*) — kills the search artifact (`[Phantom F1]`).

The unifying principle across all seven, and across the framework: **a carry signal is a distribution, not a number — gate on the bound that hurts, price the basis you pay both ways, and make every predictive claim earn its place out-of-sample.**

**Carry scoring**
- Combine into a single **carry score** `S_carry` to rank and gate opportunities. State the exact formula, weights, and normalizations. A workable form:

  `S_carry = w_carry · (E_carry / σ_F) + w_surv · P(T_fav ≥ H_be) + w_pers · persistence_norm + w_ratio · (t_half^f / t_half^b)_norm + w_fc · forecastSkill_norm − w_be · (H_be / H_be_max) − w_basis · b_entry_norm − w_ci · ci_width_norm − w_inst · instability − w_tail · adverseTail_norm`

  where `E_carry / σ_F` is the annualized net carry per unit funding dispersion, `P(T_fav ≥ H_be)` is the survival win-probability (§3), `persistence_norm` blends `ρ_sign`, `d`, and the funding ACF profile, `(t_half^f / t_half^b)_norm` rewards persistent carry with cheap exits, `forecastSkill_norm` is the §5 out-of-sample skill over baseline, `H_be` penalizes trades that take long to break even, `b_entry_norm` penalizes paying a wide basis for thin carry, `adverseTail_norm` penalizes a heavy fitted funding/basis tail, and each `w_*` is a named, stated weight. State `S_carry_min` to trade and how `S_carry` is used alongside the hard conjunctive gate — the gate is necessary; the score ranks among gate-eligible markets and raises the effective hurdle when `S_carry` is marginal.
- Every weight, normalization, and `S_carry_min` is a named variable with a stated default and a validation method (e.g., choose weights to maximize forward-window Sharpe of completed carry episodes; state the procedure).

---

## Strategy Group B — Funding Carry Strategies

**Members:** Spot-Perp Funding-Rate Arbitrage, Perp-Perp Funding-Rate Arbitrage.

**Common logic (define once):**

- **Signal:** The funding rate (or differential), annualized, fully characterized via the Statistical Funding-Carry Analysis Framework above — funding distribution with a fitted adverse tail, structural level `μ_f^struct`, persistence (`t_half^f`, `d`, `ρ_sign`) and the validated forecast `f̂`, the favorable-regime survival distribution and break-even-clearing probability `P(T_fav ≥ H_be)`, the basis leg validated and priced through the Group A machinery, opportunity frequency `f_signal`, regime state, anti-overfitting, and composite `S_carry`. The carry signal is `E_carry = Carry_annual − C_annual`, expressed simultaneously as annualized net bps, the survival win-probability, and `S_carry`. The market is tradeable only if it passes the conjunctive gate and `S_carry ≥ S_carry_min`.
- **Entry:** Trigger when `E_carry > R_hurdle` (annualized) AND `ρ_sign ≥ ρ_min` AND `f̂_{t+1}` favorable and above per-period hurdle AND `P(T_fav ≥ H_be) ≥ p_min` AND `S_carry ≥ S_carry_min` AND the basis at entry is within the acceptable band `b_t ≤ b_max` (do not pay a wide basis for thin carry — `[Phantom D1]`) AND the regime gate is green (not a high-vol/high-flip-hazard state — `[Phantom C3]`) AND no funding-break / basis-jump suppression window is active AND the validation gate is currently green. Both legs entered simultaneously, delta-neutral by construction; specify the maximum acceptable leg-fill latency and basis level at fill — if one leg is not filled within it, the open leg is closed.
- **Exit:** Unwind both legs together when expected net carry falls below `R_hurdle` for a stated number of consecutive funding periods, OR the funding sign flips against the position for a stated number of periods, OR the regime/validation gate flips red mid-trade (funding regime break). **Time the unwind on the basis:** prefer to exit when the basis is within the clean band around `fair_t` (from the Group A first-passage), subject to a maximum **grace window `W_grace`** (set from the basis first-passage tail quantile) after which the position is unwound regardless. A diverging basis mid-hold is a mark-to-market event, not an exit trigger, **unless** it breaches the fitted basis-blowout extreme band (§2/§3).
- **Cost model:** Instantiate the base cost model — round-trip fees and slippage on both legs in+out, bid/ask crossing on both sides, **`b_entry` and modeled (expected + conservative p75) `b_exit` as explicit cost components**. Annualize `C_total` over the **conservative (p25) holding-period quantile** from the survival distribution so it is directly comparable to annualized carry; `R_hurdle = C_annual + R_margin` with `R_margin` from the fitted funding tail. State `H_be` in wall-clock and the minimum holding period at which the trade breaks even given current funding.

**Per-strategy deltas (specify only what differs):**

### Spot-Perp Funding-Rate Arbitrage
- **Signal delta:** Single-venue (or cross-venue) funding on one perp; position is long spot + short perp, so the favorable regime is `f > 0` (shorts receive) — run the funding-process and survival machinery on the signed single-venue funding. The **spot-perp basis at entry is a signal input, not just a cost** (`[Phantom D1]`): entering when the perp is rich (basis high) *adds* convergence credit on top of carry (the embedded Group A Spot-Perp Basis trade is favorable in the same direction); entering when the perp is cheap subtracts it. Report whether `t_half^f` (carry persistence) is long relative to `t_half^b` (basis exit) — the canonical good case for this strategy.
- **Cost model delta:** Two legs (spot + perp) → four executions round trip (fee + slippage) plus bid/ask crossing both sides. **Funding received is the revenue line, kept out of `C_total`**; compare carry-vs-cost explicitly. `b_entry`/`b_exit` are the spot-perp basis crossed in/out, priced from the Group A basis machinery.
- **Entry delta:** `f` (current `ρ_sign`-cleared + validated `f̂`) > per-period hurdle AND `P(T_fav ≥ H_be) ≥ p_min` AND `S_carry ≥ S_carry_min` AND spot-perp basis at entry within the acceptable band (or favorable). Long spot + short perp simultaneously.
- **Exit delta:** Standard group exit. **Basis-blowout interim rule, made statistical:** a temporarily diverging basis is a mark-to-market event (hold), **not** an exit signal, **unless** it breaches the fitted GPD extreme band (§2) — distinguish the two cases explicitly, using the jump-vs-break separation of §2 (transient jump → hold; persistent break → exit/re-validate). Manage the perp short's margin through the held period so a transient basis/price excursion cannot force a liquidation — flag this as a risk dimension the definition leaves implicit (see *Open Items*).

### Perp-Perp Funding-Rate Arbitrage
- **Signal delta:** Funding **differential** `Δf = funding(short venue, received) − funding(long venue, paid)`, annualized and **clock-aligned** across venues (§1 *Cross-venue alignment*, `[Phantom A6]`). Differentials are noisier and mean-revert faster than single-venue funding — use a **shorter persistence lookback `K` but a stricter sign-consistency requirement `ρ_min`** (state both), and rely more on the §2 flip hazard since `t_half^f` of a differential is short. The **inter-venue perp price spread at entry is a signal input**, same logic as the basis above. Sign the expected differential explicitly over the (short) holding horizon.
- **Cost model delta:** Four perp executions round trip across two venues with potentially different fee tiers and different `Δτ` — **itemize per venue** (`[Phantom A6]`). Because the differential mean-reverts quickly, the expected holding period is short: annualizing `C_total` over an optimistic holding period understates the hurdle, so charge `C_annual` against a **conservative (p25 or lower) holding-period quantile** and require the persistence-adjusted expected differential to clear the resulting, higher hurdle. State `H_be` conservatively.
- **Entry delta:** `Δf` (current `ρ_sign`-cleared + validated forecast) > hurdle AND `P(T_fav ≥ H_be) ≥ p_min` AND `S_carry ≥ S_carry_min` AND inter-venue price spread within the entry band AND venue funding clocks aligned within tolerance. Long the venue where longs are paid (or pay less), short where shorts are paid (or pay less), simultaneously.
- **Exit delta:** Standard group exit on differential compression or sign flip — but with a **shorter consecutive-period count** given fast differential mean-reversion (state it). **Exit preferentially when the inter-venue price spread is near zero** (Group A first-passage on that spread); define the maximum time `W_grace` the position may wait for a favorable spread after the carry signal dies before forcing the unwind anyway. Forced unwind on a funding break, a price-spread blowout beyond the fitted extreme band, or a regime-gate flip.

---