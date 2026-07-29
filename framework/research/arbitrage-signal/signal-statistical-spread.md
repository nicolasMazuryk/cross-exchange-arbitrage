# Statistical Spread Signal Design for Crypto Mean-Reversion Arbitrage

---

## How to read this spec

- **Pipeline spine.** Part I (Shared Framework) and Part II (Statistical Analysis Framework) are the estimation pipeline, in dependency order. Part III instantiates the four strategies. Part IV is the audit traceability matrix (downstream defenses only).
- **Phantom callouts.** Where a stage exists primarily to kill a specific phantom-arbitrage source, it carries a callout:

  > **▸ Phantom defended — [class id] Title.** *Mechanism* (how false edge is fabricated) · *Tell* (the observable signature) · *Kill* (why this stage neutralizes it).

- **Ownership.** The **upstream feed/book/jump-cleaning/noise tier** is no longer part of this spec — it is the **external Data-Quality, Synchronization & Executability Firewall**, which delivers a clean, time-aligned, causal, gap-segmented `spread_exec(Q)` series (plus a validity mask and `WindowQuality` telemetry) and, on the live path, a boolean `executable` and a continuous `L_quality`. This tier consumes that contract. The **modeling tier** (cost, latency-survival, statistics, regime, selection) defended below is what this spec still owns. The conjunctive validation gate (Part II §6) treats the firewall's `CLEARED_FOR_FITTING` verdict as an inherited precondition and adds the modeling gates on top; the deflated meta-gate sits above all of them.

---

# Part I — Shared Signal Framework (applies to ALL strategies)

Define these primitives once and reference them in every strategy spec.

## Spread construction

- **Input series.** All analysis runs on the firewall's depth-weighted executable spread `spread_exec(Q)` to the intended clip size `Q` — the single spread object the firewall emits (causal, previous-tick, time-aligned, gap-segmented, hygiene-cleaned). This tier neither re-derives the spread from raw L2 nor re-checks depth/skew/mid.

  > **▸ Firewall-absorbed.** Depth-weighting to the clip (vs. top-of-book/mid), the ≤ 100 ms cross-venue skew alignment, and the book-liquidity "size isn't real" phantom are all owned upstream (firewall §5 `spread_exec(Q)`, invariant 1; §3.3 `skew_max = 100 ms`; §10 depth gates). Residual kept here: the **economic meaning** of the spread per strategy and the cost-adjustment below.

- **Analysis grid `Δt`.** The firewall emits the **signature plot** (realized variance vs. sampling frequency on the clean, async-corrected series) and reports `θ`, `σ_OU`, half-life **as functions of `Δt`**. This tier's only residual act is to **select the operating `Δt`** at the point the signature plot stabilizes (noise/async negligible) and to fit on that grid. A single asserted `Δt` is not accepted — the choice must be read off the emitted plot.
- **Cost-adjusted (net) spread:** `spread_net = spread_exec(Q) − C_total`, where `C_total` is defined in the cost model below. All statistical analysis is run on **both** the raw spread (for distribution / reversion characterization) and the net spread (for opportunity counting and break-even logic); each statistic must state which series it uses.

## Total cost (per round trip)

```
C_total = takerFees(both legs, in+out)
        + expectedSlippage(clip size, book depth, both legs, in+out)
        + bidAskCrossCost(both legs, in+out)
        + fundingCarry(holding period)
        + transferCosts(round-trip, if applicable)
        + hedgeCosts(takerFees, expectedSlippage, bidAskCrossCost, in+out, if applicable)
```

Every component stated in **bps of notional**, itemized per venue with the venue's actual fee tier. Slippage is **modeled, not guessed**: state the slippage function (e.g., from depth-weighted book impact at the intended clip size) and how it was calibrated. (The firewall independently enforces, at execution time, that the slippage *embedded* in `spread_exec(Q)` does not exceed this modeled allocation — firewall §10.2 `SLIPPAGE_BUDGET` — but the forward-looking cost-model slippage function is built here.) The **break-even spread** is `C_total` plus the stated safety margin, and must be expressed both in bps and as an equivalent z-score:

```
z_breakeven = (C_total + margin − μ_spread) / σ_spread
```

so it can be compared directly to the signal.

> **▸ Phantom defended — [3.2] Funding-carry under-charge.** *Mechanism:* charging `fundingCarry` against the *mean* convergence time (or a guessed horizon) when the convergence-time distribution is right-skewed, so the trade is "stuck" far more often than the mean implies and pays far more carry — the basis and perp-perp cases live or die on this. *Tell:* realized holding cost systematically exceeds modeled; a tail of trades dominates carry P&L. *Kill:* the `fundingCarry` term uses a convergence-time estimate from the **holding-period distribution** (*Full holding-period distribution*, §II.3) and is charged against a **conservative quantile (p75)** of that distribution, never its mean. For Spot-Perp and Perp-Perp, sign the funding explicitly (credit vs cost) and state break-even **both with and without** the funding term, so the convergence-edge and the carry-edge are separable — this exposes a "convergence" trade that is in fact only profitable via carry that may flip.

## Net edge

```
E_net = spread_exec(Q) − C_total
```

A signal exists only when `E_net > 0` **plus** a safety margin; the safety margin must be stated explicitly (e.g., `E_net > k · σ_spread`, with `k` specified).

> **▸ Phantom defended — [3.5] Safety-margin-too-thin (Gaussian-implied).** *Mechanism:* setting `k·σ` from a Gaussian multiple when the spread is heavy-tailed, so the "edge above cost" is routinely erased by an adverse excursion the Gaussian called negligible — the trade clears break-even on average and loses on the tail. *Tell:* observed stop-hits and worst-case holding costs far exceed the Gaussian-implied frequency; realized loss-on-stop fatter than modeled. *Kill:* `k`, the stop-band placement, and the `z_breakeven` margins are derived from the **fitted tail** (*Heavy-tail distribution fitting*, §II.2) — a Student-t dof or EVT/GPD on exceedances — never a Gaussian multiple, because the tail governs both stop-hit probability and worst-case holding cost.

## Funding carry horizon

The `fundingCarry` term uses a convergence-time estimate from the holding-period distribution (see *Full holding-period distribution*, §II.3), charged against a conservative quantile (e.g., p75) of that distribution, not its mean. (This is the standing instantiation of the [3.2] defense above.)

## Post-jump entry suppression

After a jump is detected, **suppress entries within a stated window until the spread is re-validated** — a post-jump deviation is frequently a regime change, not a reversion opportunity. Define the suppression-window length and the re-validation criterion (the stationarity/OU battery must re-clear before resuming) per strategy.

> **▸ Firewall-absorbed.** Heartbeat staleness, the implausibility/halted-venue bound, the "book lacks depth for the clip" reject, **and the detection of the jump itself plus the tripping of this window** are owned upstream (firewall §6 `STALE_BOOK`; §8.3 `IMPLAUSIBLE`, `spread_abs_cap = 500 bps`; §10.1 `THIN_BOOK`; §8.4–§8.5 jump classification and §9.4 reconnect-jump, both of which "trip the post-jump entry-suppression window"). Residual kept here: the **policy** of the window — its duration and the re-validation-before-resuming rule — which is a regime/modeling decision, not a data-plumbing one.

---

# Part II — Statistical Spread Analysis Framework (applies to ALL strategies)

This is the core of the mandate. For every strategy, the **Signal definition** must instantiate every item below with concrete estimation windows, test thresholds, and named variables. For each statistic, state: which series it runs on (raw vs. net), the lookback / estimation window, the re-estimation cadence, and the pass/fail threshold that gates trading. **All statistics are computed on the firewall's clean, masked, segmented series** — only `VALID` and `DIFFUSION_EXTREME` samples enter moments/ADF/OU; `JUMP_TAG` samples enter the jump model only; AR(1)/OU increments are formed **within a firewall segment only** and never across a `GAP_EXCLUDE` run or `REFIT_BOUNDARY` (firewall §9.3, §12 consumption rules).

## §1 — Spread construction & fair value (upstream of the z-score)

These determine what series everything else runs on; getting them wrong silently biases every downstream statistic.

### Spread history & distribution analysis
- Maintain a rolling history of the spread over a stated lookback `L_hist` (state in both bars and wall-clock, e.g., `L_hist = 30 days @ Δt = 1s`).
- Compute and track: rolling mean `μ_spread`, rolling standard deviation `σ_spread`, skew, excess kurtosis, and empirical quantiles (state which, e.g., p1/p5/p50/p95/p99).
- **z-score:** with a constant center, `z = (spread − μ_spread) / σ_spread`; with a time-varying center and conditional vol, `z_t = (spread − fair_t) / σ_t`. State whether `μ_spread` / `σ_spread` are simple-rolling, EWMA (state the EWMA half-life), GARCH-conditional, or from the fitted OU mean — and justify the choice. The **same z definition must be used in the entry logic and in the spread score.**

### Time-varying, funding-implied fair value
- For spreads with a structural fair value — notably the spot-perp basis and the perp-perp spread — the convergence target is **funding-implied and time-varying**: it drifts with the funding rate and the settlement clock. Measuring deviation against a static long-run mean mis-measures both the deviation and the exit target. Where this applies, model the center as `fair_t = f(funding_rate_t, predicted_funding, settlement_phase)`, compute the deviation as the residual `spread − fair_t`, and run the distribution and OU machinery (see *Ornstein–Uhlenbeck (OU) fit*) on that residual. State explicitly whether a strategy uses a constant `μ_spread` or a time-varying `fair_t` (see strategy deltas for Spot-Perp and Perp-Perp).

  > **▸ Phantom defended — [5.4] Mis-specified-center (static mean where the fair value moves).** *Mechanism:* measuring basis / perp-perp deviation against a flat long-run mean when the true convergence target is funding-implied and time-varying — you read a deviation that is really just the fair value drifting with funding/settlement, enter against a target you will never converge to, and mis-measure both the deviation and the exit. *Tell:* persistent one-sided "deviations" that track the funding clock; z-scores that never mean-revert to zero because zero was never the center. *Kill:* run the z-score, ADF, and OU on the **residual** `spread − fair_t`. Spot-Perp and Perp-Perp **must** use `fair_t`; every strategy states which center it uses.

### Operating-`Δt` selection (narrowed)
- Read the operating `Δt` off the firewall's emitted **signature plot** at the point realized variance stabilizes, and report `θ` / `σ_OU` / half-life sensitivity across the emitted `Δt` range so a downward-biased half-life from over-fine sampling is visibly ruled out before any single `Δt` is adopted.

  > **▸ Firewall-absorbed — microstructure-noise inflation [5.2].** The noise-inflated-volatility / over-fast-half-life phantom is detected and acted on upstream: the firewall emits the signature plot, exposes noise-robust realized-variance estimators (two-scale / sub-sampled RV / realized kernels), and reports the parameter-vs-`Δt` curves (firewall §11; §7.5 `EPPS_SUSPECT` → require `Δt` at/above stabilization, do not report the fine-grid estimate as primary). Residual kept here: the Framework's act of **selecting** the stabilized `Δt` from that plot and fitting on it.

## §2 — Process & distribution model

The OU + Gaussian-z assumptions are routinely violated in crypto; this group validates the process and replaces the static assumptions with conditional ones.

### Stationarity & mean-reversion validation
- The spread must be **statistically validated as mean-reverting** before any trading.
- **Stationarity test:** Augmented Dickey–Fuller (ADF) on the spread series (the `spread − fair_t` residual where a time-varying center applies). State the lag selection (e.g., AIC), the regression form (constant, no trend, for a spread expected to revert to a non-zero mean), and the p-value gate (e.g., `p_ADF < 0.05`). State the minimum sample size for the test to be trusted. (Run on the longest valid firewall segment, or a gap-aware specification with segment dummies, and report the effective sample and segment count alongside the p-value — firewall §9.6.)
- **Persistence / anti-persistence:** Hurst exponent `H` (state estimator, e.g., rescaled-range or DFA). Gate on `H < H_max` (e.g., `H_max = 0.5`, lower = stronger mean-reversion).
- **Validation cadence:** Re-run the test battery every `T_validate` (stated). A pair/spread that fails the battery is **suspended from trading**, not traded at a wider threshold. State this explicitly.

  > **▸ Phantom defended — [5.1] Spurious / non-stationary reversion.** *Mechanism:* a spread that wandered back to its mean a few times in-sample but is not actually stationary — you fit an OU to a random walk and "discover" reversion that will not recur; the deviation is the new level, and there is no pull. *Tell:* ADF fails to reject the unit root; Hurst `H ≥ 0.5`; the AR(1) coefficient `b` not significantly below 1. *Kill:* the stationarity battery is a **hard gate** (ADF p-gate + Hurst `H < H_max`), re-run every `T_validate`, with failing spreads **suspended, not traded wider**. Its companion is the OU fit-quality gate below (`b` statistically `< 1`).

### Conditional volatility & conditional z-scores
- Crypto spread volatility **clusters**: a fixed `z_entry` against a static `σ_spread` represents a far rarer, more extreme event in calm regimes than in turbulent ones, so the trigger's *meaning* drifts with the regime. Estimate a time-varying `σ_t` via EWMA-vol (state the half-life) or **GARCH(1,1)** on the spread (or on the OU fit residuals), track vol-of-vol, and compute the **conditional z-score** `z_t = (spread − μ_t) / σ_t`. MAD-based dispersion (see *Heavy-tail distribution fitting*) is a *static* robustification and does **not** substitute for this *time-varying* one. Optionally vol-target the entry band so the trigger's *probability* is regime-invariant.

  > **▸ Phantom defended — [5.7] Conditional-vol drift (the trigger's meaning moves).** *Mechanism:* a fixed `z_entry` against a static `σ_spread` is a far rarer event in a calm regime than in a turbulent one, so the same z-number is a different-probability event depending on regime — a "2-sigma" entry in calm conditions may be a routine wiggle in turbulent ones. *Tell:* entry frequency and win-rate swing sharply with the volatility regime at a fixed `z_entry`; clustered losses in turbulent windows. *Kill:* conditional `σ_t` (EWMA or GARCH(1,1)) and conditional `z_t`, optionally vol-targeted bands so the trigger's *probability* is regime-invariant. Static MAD robustification does **not** substitute for this time-varying fix.

### Heavy-tail distribution fitting
- Mean-reversion z-scores assume an approximately stable dispersion; if the empirical distribution is heavy-tailed (state the kurtosis threshold), require the entry z-threshold to be raised or the score to use a robust dispersion estimate (e.g., MAD-based `σ_spread`). Do not stop at kurtosis: **fit the tail law explicitly** — a Student-t (estimate the degrees of freedom) for the body-plus-tail, or **EVT / a generalized Pareto distribution (GPD)** on exceedances to model the tail directly. The stop-band placement, the safety margin `k·σ` in the net-edge rule, and the `z_breakeven` margins are derived from the **fitted** tail, since the tail governs stop-hit probability and worst-case holding cost — a Gaussian-implied margin understates both. (The firewall preserves real extreme moves — `DIFFUSION_EXTREME` is kept unclipped, invariant 4 — precisely so this fit sees the true tail mass; it does not fit the tail. This is the estimator that supplies the [3.5] defense wired into *Net edge* in Part I.)

### Ornstein–Uhlenbeck (OU) fit
- Fit the discrete OU / AR(1) model to the spread (or the `spread − fair_t` residual):

  ```
  Δspread_t = θ (μ_OU − spread_{t−1}) Δt + σ_OU √Δt · ε_t
  ```

  or equivalently the AR(1) form `spread_t = a + b · spread_{t−1} + ε_t` with `θ = −ln(b)/Δt`.
- Report the estimated parameters as named variables: `θ` (mean-reversion speed), `μ_OU` (long-run mean), `σ_OU` (instantaneous volatility), and the AR(1) coefficient `b`. State the estimation window `L_OU` and method (OLS on the AR(1) form is acceptable; state it). Fit on the firewall-emitted, signature-plot-stabilized `Δt` grid, **forming lag-1 increments within a single firewall segment only** — no increment crosses a `GAP_EXCLUDE` run or `REFIT_BOUNDARY` (firewall §9.3).
- **Fit-quality gate:** require `b` to be statistically `< 1` (state the t-stat or confidence threshold); a `b` not significantly below 1 means no reliable reversion → **suspend**. (Companion kill for [5.1].)

### Jump-diffusion modeling (narrowed)
- The firewall delivers the series with jump samples already discriminated from corrupt ticks and real heavy-tail diffusion, and tagged (`JUMP_TAG`). On that tagged series: **fit OU on the diffusive component only** (jump variance is booked separately, never into `σ_OU`), and optionally model the series as **OU + a compound-Poisson jump** to characterize jump intensity/size. This separation is especially load-bearing for Perp-Perp. Confirmed jumps feed the structural-stability logic of *Spread stability* (§II.4) and the post-jump suppression policy (Part I).

  > **▸ Firewall-absorbed — jump-injected false deviations [5.3].** The detection and classification — the Lee–Mykland / BNS bipower test as a discriminator, separating `ERROR_TICK` vs `JUMP` vs `DIFFUSION_EXTREME`, keeping/tagging jumps rather than deleting them, and tripping the suppression window — are owned upstream (firewall §8.4–§8.5, §9.4). Residual kept here: the **jump-diffusion model** itself (OU on the diffusive part; optional OU + compound-Poisson), which is a process-modeling choice, not data cleaning.

### Model adequacy & higher-order dynamics
- OU ≡ AR(1) assumes the *only* memory is one lag; if that is false, the half-life and `E[t_converge]` are wrong. Inspect the **ACF/PACF** of the spread and of the OU residuals and run a **Ljung–Box** test on the residuals. Residuals must be approximately white (state the p-value gate) to clear the fit. If autocorrelation structure remains, the one-lag model is inadequate: consider AR(p)/ARMA with a generalized reversion speed, and treat any half-life from the mis-specified OU as untrustworthy. **This is a pass/fail gate, not a diagnostic note.**
- **Variance-ratio profile:** report the variance ratio as a **profile across horizons**, not a single number. The profile reveals whether reversion is fast-then-slow or scale-dependent, and cross-checks the single-lag OU assumption — a VR that only departs from 1 at long horizons is a warning that the one-lag OU model is mis-specified.

  > **▸ Phantom defended — [5.5] Model-inadequacy (one-lag OU when memory is longer).** *Mechanism:* OU ≡ AR(1) assumes the only memory is one lag; if reversion is multi-scale, the fitted half-life and `E[t_converge]` are simply wrong numbers and you gate on a convergence time that does not describe the process. *Tell:* OU residuals fail Ljung–Box (residual autocorrelation remains); the variance-ratio profile departs from 1 only at long horizons. *Kill:* ACF/PACF + Ljung–Box on OU residuals as a **pass/fail gate** (residuals ≈ white by stated p-value), plus the variance-ratio profile across horizons; any half-life from a mis-specified OU is untrustworthy.

## §3 — Reversion as a distribution (not just half-life + expected time)

Half-life and a single expected time are not enough; the trade outcome is a *distribution* over a double barrier.

### Half-life of mean-reversion
- **Half-life:** `t_half = ln(2) / θ = −ln(2) / ln(b)`, in the same time units as `Δt`. Report in wall-clock (e.g., seconds/minutes/hours).
- The half-life is the **primary tradeability gate**: `t_half` must be short enough that the spread is expected to revert and the trade close *before* costs accrue and *before* the regime is likely to shift. State a strategy-specific ceiling `t_half_max`. A spread that reverts too slowly (e.g., `t_half` in days for an intra-day-cost strategy) is rejected even if `E_net > 0`, because the holding cost (funding, capital, regime risk) over that horizon erases the edge. State the reasoning numerically. The gate is applied to the **bias-corrected, CI-bounded** half-life — see *Estimation uncertainty on θ / half-life* (§II.5).
- Track `t_half` over time, not just once: a rising half-life is an early warning of a decaying edge (see *Spread stability*, §II.4).

### Expected time-to-converge
- For an entry at z-score `z_entry`, derive the **expected time to revert** to the exit band (e.g., `z = 0` or `z = z_exit`) from the OU parameters, via the OU first-passage / expected-hitting-time relation, or as a tractable approximation `E[t_converge] ≈ t_half · f(z_entry, z_exit)` (state the function/approximation used).

### Convergence probability (double-barrier first-passage)
- Compute, via the OU **two-sided (double-barrier) first-passage** solution, the probability that the spread reaches `z_exit` **before** hitting the divergence stop band, given entry at `z_entry`, together with the conditional expected time on each branch (win vs stop) and the expected loss-on-stop. This `P_converge` is the model's win rate; expected time alone says nothing about the fraction of entries that diverge to the stop first. **Gate on `P_converge ≥ p_min`** (stated) and carry `P_converge` as a term in the spread score. It pairs directly with break-even: a 60-bp edge at 55% model win-rate is a different trade from the same edge at 80%.

  > **▸ Phantom defended — [5.8] First-passage / win-rate (expected time hides the stop-outs).** *Mechanism:* half-life and `E[t_converge]` say nothing about the fraction of entries that diverge to the stop band first — a spread with a fine average convergence time can still stop out most of the time, so the "edge" is phantom because the win rate is unmodeled. *Tell:* attractive `E[t_converge]` but realized win-rate far below 50%; clustered loss-on-stop. *Kill:* the double-barrier first-passage `P_converge` (probability of reaching `z_exit` before the stop, with conditional expected time and expected loss-on-stop per branch); **gate on `P_converge ≥ p_min`** and carry it in the score.

### Full holding-period distribution
- The convergence-time distribution is right-skewed, so its mean understates how often a trade is stuck. From the OU **first-passage-time density**, report `E[t_converge]`, its variance, and the p50/p90/p95 quantiles. Set `holding_max` and the time-stop multiple `m` (exit logic) from a **tail quantile**, not the mean, and charge the funding/holding term of `C_total` against a conservative quantile (e.g., p75) of convergence time rather than the expectation.
- Require `E[t_converge] < holding_max` (from the quantile above), and require the net edge to survive the cost accrued over the conservative convergence quantile — i.e., `E_net` is computed against cost over the *expected-to-conservative* convergence time, not best-case.

  > **▸ Phantom defended — [5.9] Mean-of-a-skewed-distribution (stuck-trade underestimate).** *Mechanism:* sizing time-stops and charging costs against the *mean* convergence time when the first-passage density is right-skewed, so you systematically underestimate how often a trade is stuck and how much carry/capital it burns. *Tell:* realized holding times and carry costs cluster well above the modeled mean; a heavy right tail of stuck trades. *Kill:* report `E[t_converge]`, variance, and p50/p90/p95 from the first-passage density; set `holding_max` and the time-stop multiple `m` from a **tail quantile**; require `E_net` to survive cost over the conservative (≈p75) convergence time, not best-case. This is the same root as the cost-side defense [3.2] charged in *Total cost* (Part I) — one distribution, charged in both the cost model and the exit logic.

### Asymmetric / sign-conditional reversion
- Reversion speed and the favorable side can differ above vs below the center (directional fees, funding sign, venue-specific liquidity). A single `θ` masks this. Estimate `θ⁺` / `θ⁻` and their half-lives conditional on the sign of the deviation (threshold-AR / two-regime OU), and allow asymmetric thresholds `z_entry⁺ ≠ z_entry⁻` and sign-specific time stops.

### Cost-aware optimal entry/exit bands
- Thresholds are **derived, not asserted.** Given the OU parameters (`θ, σ_OU`) and `C_total`, there exists an optimal `(entry, exit)` pair and a **no-trade band**; hand-set thresholds either leave money on the table or over-trade. Use **Bertram's analytical optimal trading bands** for OU (maximize expected return per unit time net of cost), or an impulse-control / quasi-variational-inequality (QVI) solution for the no-trade region, to output `z_entry*` and `z_exit*` as explicit functions of `θ, σ_OU, C_total`.
- This closes the loop required throughout: **every entry condition references the cost model.** The derived bands replace hand-tuned `z_entry` / `z_exit`, are re-derived whenever the OU parameters or `C_total` are re-estimated, and are subject to the sign-asymmetry of *Asymmetric / sign-conditional reversion* (`z_entry*⁺ ≠ z_entry*⁻`) and the latency discount of *Signal / alpha decay vs execution latency* (§II.5). The spread score ranks among opportunities whose bands clear break-even with the stated safety margin.

  > **▸ Phantom defended — [6.7] Hand-tuned-threshold (over-trade / leave-money).** *Mechanism:* asserting `z_entry` / `z_exit` by hand rather than deriving them — hand-set bands either over-trade marginal deviations that do not clear the true no-trade band, or sit so wide they never fire; either way the entry condition is not actually tied to the cost model. *Tell:* entry frequency wildly off the modeled optimum; thresholds unchanged while `θ, σ_OU, C_total` move. *Kill:* Bertram's analytical optimal bands (or impulse-control/QVI for the no-trade region) output `z_entry*`, `z_exit*` as explicit functions of `θ, σ_OU, C_total`, re-derived whenever those inputs change, subject to sign-asymmetry and the latency discount.

  > **▸ Firewall-absorbed — data-quality band-widening.** The execution layer **consumes** `z_entry*` and may only *widen* it for data-quality reasons; it never *derives* it. That widening is owned upstream and fully specified by the firewall: `z_entry_eff* = z_entry* + λ·(1 − L_quality)`, `λ = 0.5 σ_t`, with `L_quality ∈ [0,1]` the firewall's continuous quality score (firewall §10.6, §16). This resolves the former Open Item — `λ` and `L_quality` are no longer undefined here.

## §4 — Regime, time & liquidity coupling

### Spread frequency / opportunity density
- **Crossing frequency:** Over `L_hist`, count how often the **net** spread crosses the prospective entry threshold (`E_net > entryThreshold`) and subsequently reverts to the exit band — i.e., the count of *completed, profitable round trips* the signal would have generated. Report as `N_signals` and as a rate `f_signal` (signals per day/week).
- **Capacity context:** report the fraction of time the spread is "in opportunity" vs. flat, and the median realized net bps per completed reversion (`bps_per_trip`). A spread that crosses rarely (`f_signal` below a stated floor) is not worth the engineering and capital allocation even if each crossing is profitable — state the minimum `f_signal` and the reasoning. `bps_per_trip` is **capacity-adjusted** to the firewall's depth-weighted `spread_exec(Q)`, so book-liquidity phantoms cannot inflate the opportunity case.
- **Time-conditioned density.** Report opportunity density bucketed by time-of-day / day-of-week and relative to the funding clock (see *Seasonality / time-of-day / funding-clock conditioning*), not just pooled. A spread that is "tradeable on average" may concentrate its opportunities in one session or in the minutes around funding settlement; pooled `f_signal` hides this and mis-sizes the capital case.
- Distinguish **signal frequency** (threshold crossings) from **trade frequency** (crossings that pass feasibility + cost gates). Report both; the gap reveals how much of the raw opportunity is non-actionable. (The firewall also monitors this signal-vs-trade gap as a measure of phantom it discards — firewall §15 — but the opportunity-density and capital case here is a distinct modeling judgment.)

### Spread stability (parameter & structural)
- **Parameter stability:** re-estimate `μ_OU`, `σ_OU`, `θ`, `t_half` on rolling sub-windows (state the sub-window and step). Track their dispersion over time. A spread whose parameters drift materially (state the tolerance, e.g., `t_half` doubling, or `μ_OU` shifting by `> X σ`) is **regime-unstable** — its in-sample statistics will not predict out-of-sample behavior.

  > **▸ Phantom defended — [6.1] Edge-decay / parameter-drift.** *Mechanism:* a genuinely tradeable spread whose `θ, σ_OU, t_half, μ_OU` drift as market structure changes — in-sample stats no longer predict out-of-sample and you keep trading a dead edge; a *rising half-life* is the classic early tell. *Tell:* monotonic drift in rolling parameter estimates; `t_half` trending up; widening sub-window dispersion. *Kill:* re-estimate on rolling sub-windows, track dispersion, flag material drift (stated tolerance, e.g., `t_half` doubling), track `t_half` over time rather than once, and combine with walk-forward (below).

- **Structural breaks:** apply a break test (e.g., CUSUM on the spread, or a rolling-ADF / Chow-style check at suspected break points). On a detected break, reset the rolling statistics and **re-validate before resuming**. Distinguish a *jump* (firewall-tagged; discrete and possibly transient) from a *break* (a persistent parameter shift) — the former drives the entry-suppression window, the latter suspends and re-validates. (The firewall **marks downtime/reconnect boundaries** so a `REFIT_BOUNDARY` is offered as a *candidate* break rather than silently pooled, and so downtime is not mistaken for a break — firewall §9.2, §9.6; the break test and the regime decision are made here.)

  > **▸ Phantom defended — [6.2] Undetected structural-break.** *Mechanism:* a persistent parameter shift (delisting, fee change, market-maker exit, venue mechanics change) moves the spread to a new regime; your rolling mean lags the break, so every "deviation" from the stale mean is a phantom until the statistics catch up. *Tell:* CUSUM excursion / rolling-ADF flip; sustained one-sided residuals against the stale mean. *Kill:* CUSUM / rolling-ADF / Chow-style break test; on a break, **reset rolling stats and re-validate before resuming**. Explicitly separate a transient **jump** (⇒ suppression window) from a persistent **break** (⇒ suspend and re-validate).

- **Out-of-sample / walk-forward validation:** state how the mean-reversion is confirmed out-of-sample (e.g., estimate OU and thresholds on a train window, measure realized reversion and net P&L on a forward window). In-sample stationarity is necessary but not sufficient; the spec must state the walk-forward protocol and the pass criterion (e.g., forward-window realized reversion rate ≥ stated fraction of in-sample).

  > **▸ Phantom defended — [6.6] In-sample-only / no-walk-forward.** *Mechanism:* thresholds and OU fit tuned on the same data they are evaluated on; realized reversion and P&L were never confirmed forward — pure overfit dressed as validation. *Tell:* forward-window realized reversion materially below in-sample; train/forward performance gap. *Kill:* a stated walk-forward protocol — estimate OU and thresholds on a train window, measure realized reversion and net P&L on a forward window, with a stated pass criterion (forward realized reversion ≥ stated fraction of in-sample). Necessary **alongside**, not instead of, the stationarity battery.

### Regime-switching models
- Break tests detect a shift *after* it happens; they do not classify the *current* regime. Fit a **Markov-switching OU / HMM** with 2–3 states (e.g., calm-mean-reverting, trending, high-vol-no-reversion) and **trade only in the validated mean-reverting state**. Expose a **regime green/red gate** alongside the validation gate, and track the state-transition probabilities as an early warning — a rising `P(exit to a trending / no-reversion state)` flags decay before the parameters visibly break.

  > **▸ Phantom defended — [6.3] Wrong-regime / no-reversion-state.** *Mechanism:* break tests detect a shift only after it happens; they do not classify the *current* regime — the spread may be in a trending or high-vol-no-reversion state right now while you trade reversion that is not currently operative. *Tell:* the HMM posterior favors a non-mean-reverting state; rising `P(exit to trending/no-reversion)`. *Kill:* Markov-switching OU / HMM (2–3 states), **trade only in the validated mean-reverting state**, expose a regime green/red gate, and watch the exit-transition probability as an early warning that fires *before* parameters visibly break. This is the **primary gate for Perp-Perp**.

### Seasonality / time-of-day / funding-clock conditioning
- Crypto spreads have strong intraday and weekly seasonality (Asia/US/EU sessions, weekends) and a **funding settlement clock** that mechanically perturbs the basis every funding interval. Pooling across the day mis-estimates `μ_spread`, `σ_spread`, and the opportunity density above. Bucket the statistics by time-of-day / day-of-week, **deseasonalize before OU fitting**, and flag the minutes around each funding settlement as a distinct regime. Where the seasonality is material, use time-of-day-specific thresholds.

  > **▸ Phantom defended — [6.4] Seasonality / funding-clock-aliasing.** *Mechanism:* pooling statistics across the day aliases strong intraday/weekly seasonality and the funding-settlement clock into `μ_spread`/`σ_spread` — the pooled mean is a fiction no session actually sits at, so deviations from it are phantom; and pooled `f_signal` hides that opportunities concentrate in one session or the minutes around settlement, mis-sizing the capital case. *Tell:* residuals with a clear time-of-day/funding-interval periodicity; opportunity density that collapses onto specific sessions. *Kill:* bucket statistics by time-of-day / day-of-week, **deseasonalize before OU fitting**, flag the minutes around each funding settlement as a distinct regime, use time-of-day-specific thresholds where material, and report **time-conditioned** opportunity density, not just pooled.

## §5 — Estimation rigor & anti-overfitting (so the gate means something)

### Estimation uncertainty on θ / half-life
- AR(1)-OLS half-life is **small-sample biased** (toward over-fast reversion) and must not be gated as a bare point estimate. Use a **median-unbiased / bias-corrected** AR(1) estimator, and produce a **block-bootstrap confidence interval** on `θ` and `t_half`. Gate on the **upper CI bound** of the half-life (`t_half_upper < t_half_max`), not the point estimate — a noisy estimate that only passes at its center is not cleared. The spread score penalizes wide CIs (`w_ci · ci_width_norm`).

  > **▸ Phantom defended — [5.6] Small-sample half-life bias.** *Mechanism:* AR(1)-OLS half-life is small-sample biased *toward over-fast reversion* — a noisy estimate that only passes `t_half_max` at its point estimate is a phantom pass, because the true half-life may be well over the ceiling. *Tell:* wide bootstrap CI on `t_half`; point estimate inside the ceiling but upper CI bound outside it. *Kill:* median-unbiased / bias-corrected AR(1) + block-bootstrap CI, and **gate on the upper CI bound** (`t_half_upper < t_half_max`), not the point estimate; the score penalizes wide CIs. This is the explicit fix for "passes only at the center."

### Multiple-testing / overfitting control
- Scanning many pairs × many parameter sets and keeping the winners **guarantees** false positives; walk-forward is necessary but does not correct for the *selection*. Report the **number of trials**, and gate on a **Deflated Sharpe Ratio (DSR)** and the **Probability of Backtest Overfitting (PBO)**; when comparing many candidate configurations, apply **White's Reality Check / Hansen's SPA** test. State a minimum *deflated* performance, not raw — a spread that "passes" only because 200 were tried has not passed. **This meta-gate sits above the per-spread gates.**

  > **▸ Phantom defended — [6.5] Selection / multiple-testing (the big one).** *Mechanism:* scanning many pairs × many parameter sets and keeping the winners guarantees false positives — the "best" spread passed because 200 were tried, not because it has edge; per-spread walk-forward does **not** correct for selection across spreads, so this phantom sits *above* every per-spread gate (all of them can be green on a spread that only looks good by luck of the search). *Tell:* performance collapses out of the selected sample; raw Sharpe high but DSR low; PBO high. *Kill:* report the **number of trials**; gate on **Deflated Sharpe Ratio** and **PBO**; for comparing many configs use **White's Reality Check / Hansen's SPA**; require minimum *deflated* performance. This is the meta-gate above the conjunctive per-spread gate.

### Signal / alpha decay vs execution latency
- The edge is measured at signal time `t`, but execution completes at `t + δ`. Feed staleness and sync are already neutralized upstream; this is a different quantity — how much of the *edge* erodes over the round-trip latency `δ`. State the realized `δ` (feed → decision → both legs acknowledged) and estimate `E[E_net(t+δ) | signal at t]` — i.e., the edge-vs-latency curve. Compare the spread's predictability horizon (≈ its half-life) to `δ`: if the half-life is close to or below the latency, much of the measured edge is structurally unreachable and the strategy is **flagged regardless of in-sample statistics**. Discount the entry threshold by the realized decay over `δ`.

  > **▸ Phantom defended — [4.1] Alpha-decay-over-latency.** *Mechanism:* edge is measured at signal time; execution completes at `t+δ`. If the spread's predictability horizon (≈ its half-life) is close to or below the round-trip latency `δ`, most of the measured edge has already reverted before both legs acknowledge — establishing that a deviation *lasts* (the firewall's persistence/wick check) is not the same as the edge *surviving the round trip*. *Tell:* realized fills systematically worse than modeled; the edge-vs-latency curve is steeply negative; `t_half ≲ δ`. *Kill:* state realized `δ` (feed → decision → both legs acked), estimate the edge-vs-latency curve, compare half-life to `δ`, **discount the entry threshold by the realized decay over δ**, and **flag the strategy outright when `t_half ≲ δ`** regardless of in-sample stats. This guard is **decisive, not advisory**, for Spot-Spot V1, where the transfer window is a long, non-reverting latency layered on top (see [4.3], Part III).

## §6 — Validation gate & scoring

### How the phantoms compose (why no single guard is enough)
The dangerous cases are **stacked**: a point-estimate-only half-life pass ([5.6]), on a spread selected from 200 candidates ([6.5]), measured against a static center that should have been funding-implied ([5.4]) — every individual number looks plausible, and only the **conjunctive gate plus the deflated meta-gate** catches the compound. The feed/book/jump/noise tier is no longer part of this composition — it is neutralized upstream by the firewall and arrives as a `CLEARED_FOR_FITTING` precondition. A spread signal is real and capturable only if, **given clean firewall-cleared data**, it also survives every independent modeling way of being fake — cost, latency-survival, statistics, regime, and selection. This is why the validation summary is conjunctive (failing any one suspends) **and** the overfitting meta-gate sits above it.

### Spread validation summary (conjunctive gate)
A spread is **cleared for trading** only if it passes **all** of:
1. The firewall emitted a `CLEARED_FOR_FITTING` window for the data this fit ran on (no `DIRTY_WINDOW` / `SKEW_QUARANTINE` / `RESOLUTION_LIMITED` / `INSUFFICIENT_N` / sync or normalization halt) — **inherited from the upstream firewall**, not re-checked here **AND**
2. The stationarity battery (*Stationarity & mean-reversion validation*) **AND**
3. OU fit quality including residual whiteness, fit on the diffusive component (*Ornstein–Uhlenbeck (OU) fit* / *Model adequacy & higher-order dynamics* / *Jump-diffusion modeling*) **AND**
4. `t_half_upper < t_half_max` on the bias-corrected, CI-bounded half-life (*Estimation uncertainty on θ / half-life*) **AND**
5. `P_converge ≥ p_min` (*Convergence probability*) **AND**
6. `f_signal ≥` floor (*Spread frequency / opportunity density*) **AND**
7. Parameter-stability / regime-green / walk-forward (*Spread stability* / *Regime-switching models*) **AND**
8. The overfitting meta-gate — deflated performance (*Multiple-testing / overfitting control*).

State this as an explicit conjunctive gate; **failing any one suspends the spread.** Item 1 is a precondition the firewall supplies (a window not cleared upstream never produces an OU/ADF/half-life for items 2–7 to evaluate); the meta-gate (item 8) is evaluated above the per-spread items 2–7: a spread cannot be cleared on those alone if it owes its appearance to selection across many trials.

### Spread scoring
- Combine the above into a single **spread score** `S` used to rank and gate opportunities. State the exact formula and the weight/normalization of each term. A workable form:

  ```
  S = w_z   · z_norm
    + w_edge · (E_net / σ_t)
    + w_p    · P_converge
    − w_hl   · (t_half / t_half_max)
    − w_ci   · ci_width_norm
    − w_inst · instability
    − w_stale· staleness_penalty
  ```

  where `z_norm` uses the **conditional** z (`z_t`), `E_net / σ_t` uses the conditional dispersion, `P_converge` is the double-barrier win probability of *Convergence probability*, `ci_width_norm` penalizes a wide bootstrap CI on the half-life (*Estimation uncertainty on θ / half-life*), `instability` is a measured quantity from *Spread stability* (e.g., normalized parameter drift), and `staleness_penalty` is sourced from the firewall's per-window `L_quality` / cleaned-fraction telemetry (not recomputed here). Each term is defined and normalized in the spec, and `w_*` are stated weights. State the **minimum score** `S_min` required to trade, and how `S` is used alongside the hard conjunctive gate — the gate is necessary; the score ranks among gated-eligible opportunities and can raise the effective entry threshold when `S` is marginal.

---

# Part III — Strategy Group A — Spread Mean-Reversion Strategies

**Members:** Spot-Spot Variant 1 (Buy → Transfer → Sell), Spot-Spot Variant 2 (Pre-positioned Inventory), Spot-Perp Basis Arbitrage, Perp-Perp Spread Arbitrage.

## Common logic (define once)

- **Signal:** The cost-adjusted executable spread between the two instruments/venues, fully characterized via the Statistical Spread Analysis Framework (Part II) — distribution (with conditional vol and a fitted tail), stationarity validation, OU fit on the diffusive component with white residuals, bias-corrected half-life, the convergence-time distribution and double-barrier win probability `P_converge`, opportunity frequency, regime state, anti-overfitting, and composite score `S`. Signal strength is expressed simultaneously as absolute net bps (`E_net`), the conditional z-score `z_t`, and score `S`. The spread is tradeable only if it passes the conjunctive validation gate **and** `S ≥ S_min`.
- **Entry:** Trigger when `E_net > entryThreshold` (in bps, stated per strategy) **AND** `|z_t| > z_entry*` (the cost-derived, possibly sign-asymmetric band of *Cost-aware optimal entry/exit bands*) **AND** `P_converge ≥ p_min` **AND** `S ≥ S_min` **AND** `t_half_upper ≤ t_half_max` **AND** the regime gate is green **AND** no jump-suppression window is active **AND** the firewall reports `executable` (its live hard gate — depth, slippage budget, exit depth, staleness, sync, wick survival — stands in for any feed-level entry guard). Both legs (or the leg + hedge) must be submitted simultaneously; specify the maximum acceptable leg-fill latency — if one leg is not filled within it, the open leg must be closed.

  > **▸ Firewall-absorbed.** The persistence-filter / wick-survival entry guard and the "is this fillable now" checks are the firewall's live `executable` verdict (firewall §8.3, §10, §14.2); this tier consumes it rather than re-implementing a persistence filter. The `z_entry*` widening for marginal data quality is also the firewall's (`z_entry_eff*`, §10.6).

- **Exit:** Spread convergence to a stated target expressed in spread-statistics terms (e.g., `z_t ≤ z_exit*`, or `spread_net ≤ exitThreshold`), **OR** a **time stop derived from the convergence-time distribution** (`holding_max = m × t_half`, with `m` set from a tail quantile p90/p95 of the first-passage density, not an arbitrary clock), **OR** a forced unwind on divergence beyond a stop band (stated in σ or bps, placed from the fitted tail), **OR** a forced unwind if the validation/regime gate flips red mid-trade (structural break, regime exit, or stationarity loss).
- **Cost model:** Instantiate the base cost model (Part I) with taker fees on both legs in and out (state each venue's fee tier in bps), expected slippage on both legs in and out at the intended clip size, and bid/ask crossing cost on both sides. The funding/holding component uses a conservative quantile (e.g., p75) of the convergence-time distribution from *Full holding-period distribution*, not a guessed horizon. State the resulting break-even spread in bps **and** as `z_breakeven`; the entry threshold must sit above it by the stated, tail-derived safety margin.

## Per-strategy deltas (specify only what differs)

### Spot-Spot Variant 1: Buy → Transfer → Sell
- **Signal delta:** Signal must ingest chain-congestion and venue wallet-status data: estimated confirmation time and withdrawal/deposit availability on both venues are signal inputs, not afterthoughts. Critically, the **transfer window is a fixed, non-reverting latency** layered on top of the spread's natural reversion — so the relevant statistic is whether the spread is expected to *persist* (not revert) across the transfer window. Use the OU parameters to estimate `P(spread still favorable after E[transfer_time])` and gate on it (state the threshold). The funding component of the hedge cost is forecast over the *estimated transfer window*, so transfer-time estimates feed directly into `C_total`. Because the transfer latency is typically long relative to the spread's half-life, the signal-decay-vs-latency check (*Signal / alpha decay vs execution latency*, §II.5) is **decisive here, not advisory.**

  > **▸ Phantom defended — [4.3] Transfer-window persistence (Spot-Spot V1 specific).** *Mechanism:* you are not betting the spread *reverts* — you are betting it *persists* across a fixed, non-reverting transfer latency while your asset is in-flight and uncapturable; a spread with a short half-life will have *reverted away* by the time the transfer confirms, so a half-life that looks attractive for a reversion trade is actively *bad* here. *Tell:* short half-life relative to `E[transfer_time]`; `P(spread still favorable after transfer)` low despite a wide entry spread. *Kill:* the V1 signal gate is **inverted** — estimate `P(spread still favorable after E[transfer_time])` from the OU parameters and gate on *persistence*, not reversion; ingest chain-congestion and wallet-status (withdrawals open on source, deposits open on destination, confirmation-time estimate below a max) as signal inputs; hedge with a perp short so the in-flight directional risk is neutralized, and forecast hedge funding over the *estimated transfer window*.

- **Cost model delta:** Add to the base model: round-trip on-chain withdrawal/deposit fees in **both** directions (including the eventual transfer back to the source venue), and the full hedge cost — perp taker fees both ways, expected slippage in and out, bid/ask crossing cost, expected funding for the transfer window, and the spot-perp basis cost at hedge entry/exit. State each in bps at the intended clip size; the break-even spread for this variant is typically the **widest of the four strategies** and must be stated explicitly, along with `z_breakeven`.
- **Entry delta:** Trigger only if `E_net > 0` after hedge costs **AND** `P(spread favorable after transfer) ≥` threshold **AND** withdrawals are open on the source venue **AND** deposits are open on the destination **AND** estimated transfer time is below a stated maximum. At trigger: buy spot and short an equal quantity of the asset's perp in the same instant.
- **Exit delta:** No convergence condition on the spot leg — the exit is mechanical: sell spot immediately upon deposit confirmation on the destination venue and close the perp hedge at the same moment. The half-life / time-to-converge analysis here governs **entry eligibility** (will the spread survive the transfer), not exit timing. Define a transfer time-out escalation (e.g., transfer exceeds X× the estimate → alert; the hedge stays on until inventory lands).

### Spot-Spot Variant 2: Pre-positioned Inventory
- **Signal delta:** Signal must track per-venue inventory levels — available base and quote on each side are entry inputs. Because legs fill simultaneously from inventory, the **full statistical workup applies cleanly** here: this is the canonical case for half-life, the convergence-time distribution, win probability, and opportunity-frequency gating, since there is no transfer latency distorting the reversion. Report `f_signal`, `bps_per_trip`, and `P_converge` prominently — they justify the parked capital.
- **Cost model delta:** No transfer costs on the trade itself. Instead: amortize expected rebalancing transfer costs into the break-even spread (state the amortization assumption, e.g., expected trades per rebalance cycle, informed by `f_signal`), include the hedge's funding carry on the perp short covering total base inventory, and state the opportunity cost of capital parked on both venues as an annualized hurdle the strategy's realized bps must clear (informational — it shapes the entry threshold, not sizing).
- **Entry delta:** Trigger only if both venues hold sufficient inventory for the clip (base on the rich venue to sell, quote on the cheap venue to buy) **AND** the common-logic statistical gates pass. Simultaneous execution of both legs; near-zero leg risk is the point of this variant.
- **Exit delta:** Both legs fill at entry — the trade-level exit is immediate (capture the spread). Define the **rebalancing exit** instead: rebalance when either side's inventory falls below a stated floor (e.g., < 25% of target), executed preferentially by netting against opposite-direction signals, otherwise via transfer when the spread is within a stated flat band (near `μ_OU`).

### Spot-Perp Basis Arbitrage
- **Signal delta:** Spread = perp price − spot price (the basis), tracked against its historical distribution and run through the full statistical framework. The basis mean-reverts toward a **funding-implied, time-varying fair value `fair_t`**, not a flat zero — model the center as `fair_t = f(funding_rate_t, predicted_funding, settlement_phase)` (see *Time-varying, funding-implied fair value*, §II.1, which carries the [5.4] mis-specified-center defense) and run the z-score, ADF, and OU on the residual `basis − fair_t`. **Validate the reversion (don't assume it).** Add expected funding carry over the holding period (against the convergence-time quantile of *Full holding-period distribution*) to the edge: short the perp at a premium and positive funding accrues to the position, adding to `E_net`; state the funding forecast method (e.g., current rate + predicted rate from premium index). Report whether the basis's `t_half` is short relative to the funding period — this determines whether the trade is a pure convergence play or a convergence-plus-carry play.
- **Cost model delta:** Round-trip fees and slippage on both the spot and perp legs (four executions). Funding enters with its sign: expected funding *received* over the convergence horizon is a negative cost (credit) in `C_total`; if positioned on the paying side at any point, it flips to a cost. State the break-even **both excluding and including** the funding credit, so the convergence edge and the carry edge are separable (the [3.2] requirement, made strategy-specific). Provide `z_breakeven` for both.
- **Entry delta:** Trigger when the basis `|z_t| > z_entry*` (measured against `fair_t`) **AND** `P_converge ≥ p_min` **AND** `S ≥ S_min` **AND** `t_half_upper ≤ t_half_max` **AND** `E_net` (including expected funding carry over the convergence horizon) > entry threshold **AND** regime green **AND** the firewall reports `executable`. Long spot + short perp simultaneously.
- **Exit delta:** Close both legs when the basis converges to the target band around `fair_t` (`z_t ≤ z_exit*`); alternatively hold while funding remains favorable — define the hold-vs-close decision rule explicitly (e.g., remain in position while expected funding per period > expected convergence capture from closing now). Time stop at `m × t_half` (with `m` from the first-passage tail quantile). Forced unwind if the basis widens beyond a stated stop, funding flips negative for a stated number of consecutive periods, or the validation/regime gate flips red.

### Perp-Perp Spread Arbitrage
- **Signal delta:** Spread = perp price on Venue A − perp price on Venue B for the same contract, run through the full statistical framework as a conditional z-score against its rolling band, measured against a **funding-differential-implied center** where the two venues' funding clocks diverge (see *Time-varying, funding-implied fair value*, §II.1). This spread tends to mean-revert fast but with **lower stability** around listings, liquidation cascades, and venue-specific events — so the jump-diffusion modeling (*Jump-diffusion modeling*, on the firewall's jump-tagged series) and structural-break / regime classification (*Spread stability* / *Regime-switching models*, carrying the [6.2]/[6.3] defenses) are **especially load-bearing** here: state a stricter break-detection and re-validation cadence, a stricter post-jump suppression window, and **treat the regime gate as primary** (the [6.3] kill names Perp-Perp as its primary owner). The expected funding differential over the convergence horizon may be positive or negative edge — sign it explicitly in the signal.
- **Cost model delta:** Fees and slippage on four executions (two in, two out) plus bid/ask crossing on both venues, with potentially different fee tiers — itemize per venue. Add the expected funding differential over the convergence horizon with its sign (credit if the position receives net funding, cost if it pays). Break-even spread stated for the full four-leg round trip, with `z_breakeven`.
- **Entry delta:** Trigger when `|z_t| > z_entry*` **AND** `P_converge ≥ p_min` **AND** `S ≥ S_min` **AND** `t_half_upper ≤ t_half_max` **AND** `E_net` (after the four-leg cost and funding differential) > entry threshold **AND** regime green **AND** no jump-suppression window active **AND** the firewall reports `executable`. Short the rich venue, long the cheap venue, simultaneously.
- **Exit delta:** Close both legs when the spread reverts to its mean (`z_t` within `z_exit*`). Time stop at `m × t_half` from the first-passage tail quantile (this spread can persist around listings / liquidation cascades — a measured, distribution-based stop is essential, not arbitrary). Forced unwind if the funding differential turns against the position by more than a stated bps/period for a stated duration, the spread diverges beyond a stop band, a jump or structural break is detected, or the regime gate flips out of the mean-reverting state.

---

# Part IV — Phantom → Defense Traceability Matrix (modeling-tier residual only)

This matrix indexes the **downstream/modeling** defenses that remain in this spec. The upstream tier — Class 1 (Feed: "the print isn't real"), Class 2 (Book: "the size isn't real"), 5.2 (microstructure-noise inflation), the feed/jump *detection* arm of 5.3, and feed-layer hygiene — is **no longer indexed here**: those phantoms are detected and acted on by the external Data-Quality, Synchronization & Executability Firewall and arrive neutralized (see that spec's §2, §3, §4, §5, §6–§11, §13). A risk manager verifies the upstream rows against the firewall's reason-code dashboards and `CLEARED_FOR_FITTING` gate; the rows below are verified at the modeling estimators named.

| Class / id | The lie (phantom) | Primary kill (defense) | Killed at (section) |
|---|---|---|---|
| 3.2 — Cost | funding-carry under-charge | p75 convergence-quantile carry; signed, with/without-funding break-even | Part I *Total cost*; §II.3 *Full holding-period distribution* |
| 3.5 — Cost | safety-margin too thin (Gaussian) | tail-derived `k·σ`, stop band, `z_breakeven` margin | Part I *Net edge*; §II.2 *Heavy-tail distribution fitting* |
| 4.1 — Execution | gone by fill (alpha decay over δ) | edge-vs-latency curve, threshold discount, flag when `t_half ≲ δ` | §II.5 *Signal / alpha decay vs execution latency* |
| 4.3 — Execution | transfer-window non-persistence (V1) | gate on persistence not reversion; wallet/chain inputs; perp hedge | Part III *Spot-Spot V1* |
| 5.1 — Statistics | spurious / non-stationary reversion | ADF + Hurst battery; OU `b < 1`; suspend-not-widen | §II.2 *Stationarity & mean-reversion validation* + *OU fit* |
| 5.3 — Jumps (model arm) | jump variance leaks into `σ_OU` | OU on the diffusive component; optional OU + compound-Poisson on the firewall's jump-tagged series | §II.2 *Jump-diffusion modeling* |
| 5.4 — Statistics | mis-specified static center | run z/ADF/OU on `spread − fair_t` | §II.1 *Time-varying, funding-implied fair value* |
| 5.5 — Statistics | one-lag OU when memory is longer | Ljung–Box on residuals (pass/fail) + variance-ratio profile | §II.2 *Model adequacy & higher-order dynamics* |
| 5.6 — Statistics | small-sample half-life bias | bias-corrected AR(1) + block-bootstrap CI; gate on `t_half_upper` | §II.5 *Estimation uncertainty on θ / half-life* |
| 5.7 — Statistics | conditional-vol drift (trigger meaning moves) | conditional `σ_t` (EWMA/GARCH), conditional `z_t`, vol-target bands | §II.2 *Conditional volatility & conditional z-scores* |
| 5.8 — Statistics | win-rate hidden by expected time | double-barrier `P_converge`; gate `≥ p_min` | §II.3 *Convergence probability* |
| 5.9 — Statistics | mean of a skewed convergence time | first-passage quantiles; `holding_max`/`m` from tail; cost over p75 | §II.3 *Full holding-period distribution* |
| 6.1 — Regime | edge-decay / parameter drift | rolling re-estimation + drift tolerance; track `t_half` over time | §II.4 *Spread stability* (parameter) |
| 6.2 — Regime | undetected structural break | CUSUM / rolling-ADF; reset + re-validate; jump-vs-break split | §II.4 *Spread stability* (structural) |
| 6.3 — Regime | wrong / no-reversion current regime | Markov-switching OU / HMM; trade only mean-reverting state; green/red gate | §II.4 *Regime-switching models* |
| 6.4 — Regime | seasonality / funding-clock aliasing | bucket + deseasonalize before OU; settlement as distinct regime | §II.4 *Seasonality / time-of-day / funding-clock conditioning* |
| 6.5 — Selection | multiple-testing selection bias | trial count; Deflated Sharpe + PBO; White/Hansen SPA; meta-gate | §II.5 *Multiple-testing / overfitting control* |
| 6.6 — Selection | in-sample-only / no walk-forward | train/forward protocol with stated pass criterion | §II.4 *Spread stability* (walk-forward) |
| 6.7 — Selection | hand-tuned thresholds | Bertram/QVI-derived `z_entry*`, `z_exit*` as functions of `θ, σ_OU, C_total` | §II.3 *Cost-aware optimal entry/exit bands* |

---
