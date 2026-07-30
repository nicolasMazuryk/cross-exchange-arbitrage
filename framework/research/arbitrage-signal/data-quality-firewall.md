# Data-Quality, Synchronization & Executability Firewall — Engineering Specification

**Scope of authority.** This is the single firewall sitting between raw exchange feeds and every downstream statistical estimator and every live entry decision. It is *one validator with two run modes* (§0.3). It does **not** judge mean-reversion tradeability — that is the Statistical Spread Analysis Framework downstream. It guarantees that the Framework's estimators and the live entry gate consume an uncontaminated, time-aligned, causal, segmented `spread_exec(Q)` series.

---

## 0. Purpose, scope, and position in the pipeline

### 0.1 The core failure to prevent

A single contaminated tick, an undetected websocket gap, a 200 ms clock skew between two venues, or one stale leg silently biases `σ_spread`, kurtosis, the ADF statistic, the cointegration relation, the half-life, or the OU parameters (`θ`, `μ`, `σ`). The result is **phantom statistics** that *look* like a stationary, fast-reverting, tradeable spread but describe the plumbing, not the market. Variance and the fourth moment are hyper-sensitive to single outliers; stationarity tests and OU half-life estimates are corrupted by asynchronicity, gaps, and stale state. Garbage upstream is the dominant source of false edge in this book. This layer is the firewall, and **the book never acts on a statistic — or takes an entry — that could be an illusion of bad feed data.**

The governing rule, stated once: **one bad tick or one synchronization error must never propagate into a downstream statistic the strategy treats as truth, nor into a live fill the strategy treats as executable.**

### 0.2 Pipeline position

```
        Raw L2 websocket feeds (Leg A, Leg B) — distinct clocks, distinct cadences
                                   │
                                   ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────┐
 │  DATA-QUALITY, SYNCHRONIZATION & EXECUTABILITY FIREWALL   (this spec)                  │
 │                                                                                       │
 │  Stage I    Per-feed integrity (ingestion firewall)               §2                  │
 │  Stage II   Clock discipline & cross-venue time synchronization   §3                  │
 │  Stage III  Precision, tick-size & normalization                  §4                  │
 │  Stage IV   Spread construction — spread_exec(Q), causal          §5                  │
 │  Stage V    Staleness & liveness                                  §6                  │
 │  Stage VI   Asynchronous alignment & resampling (Epps)            §7                  │
 │  Stage VII  Robust outlier / wick / bad-tick handling             §8                  │
 │  Stage VIII Gap, halt & downtime handling (segmentation)          §9                  │
 │  Stage IX   Live execution gates  (LIVE RUN MODE ONLY)            §10                 │
 │  Stage X    Microstructure-noise & Δt handoff                     §11                 │
 │                                                                                       │
 │  ── emits (offline): clean segmented series + per-sample validity mask + segment map  │
 │            + WindowQuality telemetry + FIT-HALT verdict                                │
 │  ── emits (live):    spread_exec(Q), boolean `executable`, L_quality, reason codes     │
 └─────────────────────────────────────────────────────────────────────────────────────┘
              │ (clean, sync-validated, gap-aware, executability-validated spread series)
              ▼
        Statistical Spread Analysis Framework  (ADF, OU fit, z_t, t_half, P_converge, S-score …)
              │
              ▼
        Entry logic  (E_net > threshold ∧ |z_t| > z_entry* ∧ … ∧ executable ∧ S ≥ S_min)
```

### 0.3 Two run modes, one codebase

The same validator runs in two projections of the **same** machinery:

- **LIVE mode** — a hard gate on the trading path. Answers: *"can THIS prospective entry be filled right now?"* Per-update, point-in-time. Owns the execution gates of §10 in addition to all shared stages.
- **OFFLINE mode** — the hygiene pass over the historical estimation series. Answers: *"is this SERIES fit to estimate on, and how do I align two async feeds into one causal, segmented series?"* Owns the synchronization, segmentation, and fit-halt logic of §3, §7–§9, §13.

Both modes are **co-equal first-class deliverables.** The Framework's *Data-quality & robust pre-processing statistics* step is exactly the offline output contract of this layer (§12). Implementing the shared primitives once (feed integrity, dynamic staleness `τ_v`, Hampel `k_hampel = 5`, depth-weighted `spread_exec(Q)`, jump/wick discriminator) guarantees the statistics are estimated on the **same series the live path can actually trade.** Where a stage is mode-specific it is marked **[LIVE]** or **[OFFLINE]**; everything else is shared.

### 0.4 What this layer is *not*

- It is **not** the mean-reversion validator. ADF, OU, half-life, `P_converge`, cointegration belong to the Statistical Framework. This layer guarantees those estimators receive an uncontaminated series; it does not judge tradeability.
- The offline mode is the **offline projection** of the live executability machinery, *plus* the synchronization, segmentation, and fit-halt discipline that a point-in-time gate never needs. This layer's cleared-for-fitting gate (§14.1) sits logically **upstream** of the Framework's own conjunctive validation gate: a window not cleared here never produces an OU fit, an ADF verdict, or a half-life for the Framework to evaluate.

### 0.5 Design invariants (non-negotiable)

These govern every stage. They are stated once here and enforced throughout.

1. **Depth-weighted is the only spread.** The signal and every estimator see only `spread_exec(Q)` — the VWAP-to-clip spread (§5). Never touch, never mid. Estimating reversion on a mid- or touch-spread fits the model to a series the book can never trade, and neutralises most thin-book and wick phantoms structurally.
2. **Causality is absolute.** Every emitted sample `spread[t]` is built from book state with update timestamp `≤ t` on *both* legs (previous-tick / last-value-carried-forward, §5, §7). Anything needing future data (signature plots, window-wide MAD, walk-forward splits) is a *diagnostic computed over* the causal series, never a *value inside* it. This is what keeps the live series and the historical series the same object. The look-ahead ban list is §7.4.
3. **Never silently repair across an unobserved interval.** Interpolation, carry-forward beyond the staleness bound, and stitching all *fabricate* observations. Every fabricated or repaired value is flagged and the estimators are told. **The default for a gap is to break the series, not bridge it** (§9).
4. **A removed real move is as dangerous as a kept bad tick.** Deleting a genuine jump biases `σ_OU` down and manufactures fake stationarity; keeping a bad tick biases `σ_OU` up and manufactures fake jumps. The bad-tick discriminator is held to a *two-sided* error standard (§8). Robust handling means *excluding confirmed corruption*, never *clipping real extremes*.
5. **Estimate intervals on a monotonic clock; stamp wall-time on a disciplined clock.** The two are never conflated (§3). An NTP step or a leap second must never surface as a negative inter-arrival or a phantom gap.
6. **The clean series ships with a validity mask, not just values.** An estimator that consumes the bare value vector without the mask is **non-conformant** (§12). Moments run over valid samples only; AR(1)/OU increments run over *consecutive valid samples within one segment* only.
7. **A series that needs heavy cleaning is itself a red flag.** Past a stated cleaned-fraction, the right action is to **halt fitting and suspend the spread**, not to fit harder (§13). Cleaning is a *measured quantity*, surfaced to the risk manager, and a gate input — never a silent background process.
8. **Fail fast, fail cheap, gate hard, then degrade soft.** Stages run in increasing compute cost; a book that fails Stage I never reaches the depth walk in §10. Clear executable/cleanliness violations are hard rejects/halts; uncertainty that cannot be measured with confidence at decision time *degrades* a continuous quality score (`L_quality`) that raises the effective bar, rather than silently passing.
9. **Every rejection is reason-coded, counted, and auditable.** A spike in any single reason code is itself a monitored alarm (§15). Every emitted estimate is traceable to the exact `WindowQuality` record it was fit on.

---

## 1. Canonical event & timestamp model

Every inbound book event is normalized to a common record **before any check runs**. Heterogeneous venue semantics are reconciled here, once.

### 1.1 Normalized event record

| Field | Meaning | Notes |
|---|---|---|
| `leg`, `instrument`, `instr_type` | leg ∈ {A, B} / symbol / {spot, perp} | perp carries `funding_*` fields |
| `seq` | venue sequence / `update_id` | definitive gap detector where published |
| `t_E` (`t_exch_event`) | matching-engine event time | venue-reported; **semantics vary** — see §1.3 |
| `t_S` (`t_exch_send`) | venue transmit time | present on some venues only; used in offset estimate |
| `t_L` (`t_local_recv`) | local receive time | **hardware (NIC/PTP) timestamp where available**, else kernel softirq |
| `t_ingest` | normalizer processing time | internal-latency monitoring only |
| `t_mono` | local monotonic counter at receipt | `CLOCK_MONOTONIC_RAW`; used for **all interval/age/inter-arrival math** |
| `bids[]`, `asks[]` | L2 levels (price, size) | post value-sanity (§2); fixed-point integers (§4) |
| `checksum` | venue CRC where published | §2 |

### 1.2 Notation & conventions (unified)

| Symbol | Meaning |
|---|---|
| `leg`, `v` | a venue/leg, `v ∈ {A, B}`. **Live-mode role mapping:** one leg is the BUY venue, the other the SELL venue; the offline series is venue-symmetric. |
| `spread_exec(Q)` | the depth-weighted executable spread to clip size `Q` (§5); the **only** spread object |
| `spread_exec_bps(Q)` | `spread_exec(Q)` in bps vs `midRef` (§5) |
| `τ_v` | dynamic per-leg staleness bound (§6) |
| `o_v` | per-venue clock offset onto the local reference (§3) |
| `corrected_t_v` | `t_E + o_v` — venue event time expressed on the reference timebase |
| `skew_AB` | systematic cross-venue offset difference, `|o_A − o_B|` (§3.3) |
| `skew_sample` | per-sample residual skew of the two legs forming a spread sample (§3.3) |
| `jitter_v` | residual one-way-delay dispersion for leg `v`; the honest alignment uncertainty (§3.2) |
| `k_*` | a multiplier (`k_hampel`, `k_stale`, `k_gap`, `k_ref`) |
| `Δt` | analysis grid spacing — set by the Framework's signature plot, never hand-set (§7, §11) |
| `Q` | intended clip size (base units) |

Prices and sizes are integer fixed-point throughout the arithmetic (§4); conversion to bps happens only at the reporting boundary.

### 1.3 Timestamp-semantics reconciliation (per-venue timestamp profile)

Venues disagree on what `t_E` means — matching-engine time, order-receipt time, or message-send time — and some publish only one of several relevant timestamps. The normalizer maintains a **per-venue timestamp profile**, verified against current venue API documentation and re-checked on a schedule, declaring:

- which field carries event time, and its resolution (millisecond vs microsecond);
- whether `t_S` is present and distinct from `t_E`;
- known quirks (batched-snapshot timestamps, monotonicity guarantees, sequence-increment step);
- whether a venue publishes an order-book checksum and over how many levels.

**Rule.** All cross-venue alignment uses the *reconciled* event time, never the raw field. Exchange event times `t_E` are **never compared across venues directly** — two matching-engine clocks have independent, unobservable offsets and drift; pairing on raw `t_E` injects exactly the artificial spread moves §3 defends against. A venue whose timestamp profile is **unverified** is treated as `t_E` untrusted → align on `t_L − o_v` (receipt-time minus offset) only, and flagged `PROFILE_UNVERIFIED`.

---

## 2. Stage I — Per-feed integrity (ingestion firewall)  [shared]

Cheapest checks; run **first** on every event. Any failure marks the book `UNRELIABLE`, **quarantines** it (no signal or sample involving it), and **opens a gap segment** (§9) in the estimation series until resync. An undetected `SEQ_GAP` means the local book diverges from the true book in an *unknown* direction; every `spread_exec(Q)` computed from it is wrong, and those wrong values enter `σ_spread` and the OU increments. Gaps must be caught at ingest, before any value is admitted to history.

| Observable | Detection logic | Threshold / test | Action on fire | Reason code | Contaminates if leaked |
|---|---|---|---|---|---|
| **Sequence continuity** | per-book `seq`/`update_id` strictly increments by the venue's documented step | gap ⇒ `seq` jump ≠ step | REST snapshot resync + replay buffered diffs; **open gap segment**; suppress all signals/samples on that book until `N_resync = 20` clean updates | `SEQ_GAP` | everything (unknown book state) |
| **Checksum** | recompute order-book CRC over the venue-published top-N levels each cycle | mismatch | resync as above; local book was corrupt | `CHECKSUM_FAIL` | everything |
| **Crossed / locked book** | within one venue | `bestBid ≥ bestAsk` (crossed) or `bestBid == bestAsk` (locked) | reject event; quarantine until book uncrosses for `N_resync` updates | `CROSSED_BOOK` | `σ_spread`, sign of spread |
| **Value sanity** | per level | price ≤ 0, size ≤ 0, NaN/Inf, or size < venue min-lot | drop the level; if it was top-of-book, drop the event | `BAD_VALUE` | `σ_spread`, kurtosis |
| **Monotonic event time** | reconciled `t_E` (or `corrected_t_v`) non-decreasing within a venue | backward step | buffer & reorder within a bounded window; beyond the window, treat as a gap (§9) | `TIME_REORDER` | interval math, OU increments |
| **Point-in-time clock skew** | `\|t_E − t_L − o_v\|` exceeds ceiling; maintain rolling offset `o_v` (§3) | `> skew_clock_max = 250 ms` | mark leg `UNRELIABLE` for the event; recheck offset | `CLOCK_SKEW` | cross-venue pairing |
| **Internal latency** | `t_ingest − t_L` | `> lat_ingest_max = 5 ms` | telemetry alarm only (does not corrupt the series; signals our own backpressure) | `INGEST_LAG` | — (self-monitoring) |

**Recovery.** On `SEQ_GAP` / `CHECKSUM_FAIL`, trigger a REST snapshot resync and replay buffered diffs; suppress all signals and samples on that book until `seq` continuity is re-established for `N_resync = 20` consecutive updates. The suppressed interval becomes a gap/segment input to §9.

---

## 3. Stage II — Clock discipline & cross-venue time synchronization  [shared; window-kill is OFFLINE]

This is the synchronization discipline the upstream Framework and the live executability gate both assume but neither fully specifies. A 200 ms undetected skew between two venues mis-assigns which leg moved first, biasing the measured cross-leg covariance and therefore `σ_spread`, `θ`, and the OU half-life. **Synchronization error is systematic, not random — it does not average out.**

### 3.1 Local clock discipline (host side)

- **Discipline source.** chrony against a low-stratum / PPS source as fallback. **Not** stock `ntpd`, and never the bare system wall clock (which can step). Continuously monitor local offset and drift (`local_offset`, `local_drift_ppm`).
- **Two clocks, never conflated.**
  - `CLOCK_MONOTONIC_RAW` (`t_mono`) for **all interval / age / inter-arrival math** — immune to NTP slew/step and leap seconds.
  - Disciplined `CLOCK_REALTIME` for wall-clock stamping and cross-venue alignment.
- **Step / leap detection.** A realtime step (NTP step adjustment, leap second) is detected as a divergence between `Δt_realtime` and `Δt_mono` over the same event pair exceeding `step_detect = 5 ms`. On detection: **do not** let it surface as a negative inter-arrival or a gap; re-anchor wall-clock from monotonic and flag the affected window `CLOCK_STEP` (excluded from any statistic using absolute timestamps for that window).
- **Host halt condition.** If `local_offset` uncertainty (PTP/NTP dispersion) exceeds `sync_host_max = 5 ms`, the host clock is itself untrusted → cross-venue alignment downgraded, `HOST_CLOCK_DEGRADED` raised, fit-halt candidate (§13).

### 3.2 Per-venue clock-offset estimation

Clock offset cannot be separated from one-way network delay without venue cooperation, so we **bound** it. For each venue maintain a rolling offset estimate using the **minimum-delay (lower-envelope) estimator** — the network-delay analogue of Cristian's algorithm, the same principle NTP uses: the *fastest* message is the one whose delay is closest to pure offset (least queuing), giving the tightest offset bound.

```
delay_sample_i   = t_L_i − t_S_i          (or t_L_i − t_E_i if t_S absent)   # offset + variable network delay
offset_floor_v   = min over window W_off of delay_sample                      # delay floor ≈ true offset
o_v              = EWMA( offset_floor_v , half-life H_off )                    # track slow drift, ignore jitter
corrected_t_v    = t_E + o_v                                                   # venue event time on the reference
drift_v          = slope of offset_floor_v over W_drift                        # ppm clock drift, for the sick-clock alarm
jitter_v         = p99( delay_sample − o_v , over W_off )                      # residual one-way-delay dispersion
```

- `W_off = 5 min` (short enough to track drift, long enough to sample the delay floor); `H_off = 2 min`; `W_drift = 6 h` (spans diurnal network/temperature cycles).
- Use `corrected_t_v` — **not** `t_L` (which carries full variable network delay and would smear high-frequency structure) and **not** raw `t_E` (uncorrected offset) — as the event's position on the reference grid.
- `jitter_v` is the **honest uncertainty** of the alignment for venue `v`. It is propagated downstream and gates cross-venue statistics (§3.3).

| Observable | Detection logic | Threshold / test | Action on fire | Reason code |
|---|---|---|---|---|
| Offset drift | `\|o_v(t) − o_v(t−)\|` over `W_off`; also `drift_v` | `> offset_drift_max = 50 ms/hour (≈ 13.9 ppm)` | re-estimate; if persistent, distrust venue event-time → align on receipt only | `OFFSET_DRIFT` |
| Sick clock | `drift_v` magnitude | `> drift_max = 50 ms/hour (≈ 13.9 ppm)` sustained | window-kill candidate (§3.3), page infra | `SICK_CLOCK` |
| Negative one-way delay | `delay_sample − o_v < 0` after correction | any | venue clock ahead of corrected local, or bad profile → recheck timestamp profile | `CLOCK_INCONSISTENT` |

> **Reconciliation note (logged in §18):** the two source treatments disagreed on `W_off` (10 min vs 5 min), smoothing (EWMA-of-min vs raw rolling-min), jitter percentile (p95 vs p99), and the drift alarm (`50 ms/hr` vs `20 ppm`). Resolved to the more rigorous/conservative composite above: EWMA-smoothed floor (drift tracking without chasing jitter), tighter `W_off = 5 min`, p99 jitter (conservative tail), and the stricter drift alarm `50 ms/hr ≈ 13.9 ppm`, stated in both units to kill the ambiguity.

### 3.3 Cross-venue alignment & residual skew — three-tier defense

After mapping each venue's events to the common reference via `o_v`, three nested guards apply. They defend **different** failure modes and are all retained.

**Tier 1 — per-sample alignment skew (live + offline).** For each spread sample, the residual skew of the two legs must satisfy:
```
skew_sample = | (t_E_A − o_A) − (t_E_B − o_B) | = | corrected_t_A − corrected_t_B |
reject sample for high-frequency use if  skew_sample > skew_max (100 ms)   → FEED_SKEW / GAP_FLAG
```
A sample exceeding `skew_max` is **not silently stitched** — it is dropped from the fine-grid series or pushed to a coarser grid where the skew is immaterial (§7). This is the per-observation defense and the offline twin of the live `FEED_SKEW` reject.

**Tier 2 — sustained alignment uncertainty (offline).** If `jitter_A + jitter_B > skew_max = 100 ms` sustained, the cross-venue spread for that window is **not trustworthy**: samples are flagged, and high-frequency `Δt` estimation is suppressed.
```
SYNC_UNCERTAIN  ⇔  (jitter_A + jitter_B) > skew_max  sustained
```

**Tier 3 — systematic window-kill (offline).** If over a fitting window `skew_AB = |o_A − o_B|` exceeds `skew_quarantine = 250 ms` for more than `f_skew_max = 2%` of the window, **or** `drift_v > drift_max`, the **whole window is halted** — no OU/ADF parameters emitted, spread suspended. Rationale: an unknown, drifting clock relationship means the *pairing* is unreliable everywhere in the window, not at isolated points, and no amount of per-sample flagging fixes a systematically wrong basis.
```
SKEW_QUARANTINE  ⇔  (skew_AB > skew_quarantine for > f_skew_max of window)  OR  (drift_v > drift_max)
                 →  HALT_FIT, spread suspended
```

> Two clocks that are *both* wrong but mutually consistent are **not** caught by `skew_AB` alone (which measures only the relative offset). They are caught by the normalization assertion (§4.3, mid-price disagreement) and by `drift_max`. The startup price-agreement assertion is the backstop.

---

## 4. Stage III — Precision, tick-size & normalization  [shared]

Representation must be correct *before* any differencing; otherwise a quantization noise floor masquerades as volatility and ADF reads spurious high-frequency structure.

### 4.1 Fixed-point everywhere — no IEEE-754 in the spread arithmetic

Exchange prices arrive as decimal strings with venue-specific precision. Parsing to `float64` and subtracting two venues' prices injects binary-rounding noise at the ULP scale and, worse, makes equal prices compare unequal. **Parse with a decimal library; represent every price as an integer count of a common minimal price increment** — a scaled integer `price × 10^d` with a single shared `d ≥ max(venue decimals)`. All spread arithmetic is integer/fixed-point; convert to bps only at the reporting boundary.

### 4.2 Tick-size mismatch sets a hard resolution floor on measurable volatility

If leg A ticks at `tick_A` and leg B at `tick_B`, the spread inherits the **coarser** grid; spread volatility below the quantization floor is unmeasurable.
```
tick_coarse = max(tick_A, tick_B)
σ_quant     = tick_coarse / √12              # std of uniform rounding error, in price units

if σ_spread < r_quant · σ_quant   (r_quant = 3):  → RESOLUTION_LIMITED
```
A spread whose measured `σ_spread` is within a few `σ_quant` of the floor is **quantization-dominated, not market-driven** — its OU fit, half-life, and ADF describe the rounding lattice, not a tradeable process. Action: **flag and suspend** that spread from estimation/trading (or require it to clear a higher minimum-σ gate), and report `σ_quant` and the `σ_spread / σ_quant` ratio alongside every fitted parameter so the floor is auditable. A common silent failure on tight, high-priced pairs.

### 4.3 Per-venue normalization

Normalize scaling conventions (contract multipliers, quote-currency units) to a single canonical price/size convention **before** differencing. A mismatch here is not noise — it is a systematic, constant or proportional spread bias that ADF may even read as a stable cointegrating mean. **Startup assertion:** the two legs' normalized mid prices must agree to within a few `tick_coarse` during a known-liquid window, else `HALT_FIT` (`NORMALIZATION_FAIL`).

---

## 5. Stage IV — Spread construction: the executable spread at clip size  [shared]

### 5.1 The core primitive

Let `Q` = intended clip size (base units). For each leg, walk the resting book and compute the size-weighted average price to fill `Q`:
```
buyVWAP(Q)  = ( Σ_i pᵢ·qᵢ ) / Q     over ascending  ask levels of the BUY  venue until Σqᵢ = Q
sellVWAP(Q) = ( Σ_j pⱼ·qⱼ ) / Q     over descending bid levels of the SELL venue until Σqⱼ = Q

spread_exec(Q)      = sellVWAP(Q) − buyVWAP(Q)                 [price units, fixed-point]
spread_exec_bps(Q)  = 1e4 · spread_exec(Q) / midRef            [bps; midRef = composite reference, §5.3]
```
If either side cannot accumulate `Q` within the depth band `x_band` (§10.1), `spread_exec(Q)` is **undefined** and the sample is rejected `THIN_BOOK`. **All downstream statistics and all live entry logic run on `spread_exec(Q)` — never on touch or mid** (invariant 1).

### 5.2 Causal previous-tick construction (the only admissible interpolation)

On the uniform `Δt` grid (grid spacing from the Framework's signature plot, §11), at each grid point `t`:
```
bookA(t)  = most recent A book state with corrected_t_A ≤ t
bookB(t)  = most recent B book state with corrected_t_B ≤ t
spread[t] = spread_exec(Q) from bookA(t), bookB(t)            # depth-weighted, strictly ≤ t on both legs
```
This uses no future information. **Linear / spline interpolation between bracketing ticks is forbidden** for the traded and estimation series because it reads `t⁺` to fill `t` (§7.4). Carry-forward is bounded by staleness (§6.4) — a leg older than `τ_v` is not carried into a computed spread.

---

## 6. Stage V — Staleness & liveness  [shared]

A stale leg produces a spread that is arithmetically real but not executable and not co-temporal: the fresh leg moved, the stale leg's number is a ghost. Uncorrected, stale legs inject spurious mean-reverting-looking noise (the stale leg "snaps" to the fresh one on its next update), **biasing the half-life downward** (fake fast reversion) and `σ_spread` downward when frozen (fake quiescence reads as strong reversion).

### 6.1 Dynamic per-leg staleness bound `τ_v`

A naïve fixed ceiling mis-fires on genuinely quiescent-but-valid books. Derive the bound from the book's **own** update cadence, clamped:
```
age_v = t_now − t_last_book_change_v          # last time ANY level of book v changed (not a heartbeat/ping)
τ_v   = clamp( k_stale · p99_gap_v , τ_floor , τ_ceiling )
reject leg v if age_v > τ_v                    → STALE_BOOK / STALE_LEG
```
- `p99_gap_v` = rolling p99 of inter-update intervals for book `v` over `W_gap = 6 h`.
- `k_stale = 3`, `τ_floor = 250 ms`, `τ_ceiling = 1000 ms`.

### 6.2 Cross-feed skew (the pair)

Reject the *pair* if the two legs' last-change times differ by more than `skew_max`:
```
reject pair if | t_last_book_change_A − t_last_book_change_B | > skew_max (100 ms)   → FEED_SKEW
```
(A book that is fresh but simply hasn't moved is fine — this guards the case where one feed genuinely lags. Distinct from §3.3 Tier 1, which is about timestamp *alignment*; this is about *update recency*.)

### 6.3 Liveness oracle — dead feed vs. genuinely quiescent

A book unchanged for `N` ms is **ambiguous**: calm-but-healthy and frozen/dead look identical from the book alone. Resolving it wrong is costly in both directions (over-segment a calm market, or carry a ghost quote). Break the tie with an **independent mover**:
```
book_frozen_v = age_v > τ_v
market_moving = (counterpart leg moved > ε)                        # the other venue
              OR (composite/index reference moved > ε)              # a third reference
```
- **Frozen ∧ market_moving ⇒ DEAD FEED.** The world is moving while this book is static → the feed is stuck. Action: `QUARANTINE` leg `v`'s series over the interval (`STALE_FEED`); downstream excludes it; if it spans `> gap_refit` it becomes a `REFIT_BOUNDARY` (§9).
- **Frozen ∧ ¬market_moving ⇒ GENUINELY QUIESCENT.** Healthy calm book. Action: **keep**; previous-tick carry is legitimate. Dynamic `τ_v` (from the book's own p99 cadence) is what prevents a false `STALE_FEED` on a market that is simply slow.

`ε` default: `ε = max( 2 · tick_coarse , k_ε · MAD(recent moves) )`, `k_ε = 3`. **[Open Item — §17.4: `ε` was undefined in the sources; this default is provisional, confirm.]**

### 6.4 Grid-point staleness action

Independently of feed-health classification: at any grid point where the carried leg's `age_v > τ_v`, the **sample** is flagged `STALE_LEG` / `ASYNC_STALE` and excluded from all statistics — even if the feed is later judged merely quiescent. Reason: a spread built from a leg older than its own cadence bound is not a co-temporal observation, so it cannot be a valid `σ_spread`/OU input regardless of *why* it was stale. This is the bounded-carry rule of §5.2 enforced at the grid point. The carry-forward age ceiling `τ_carry` **is** `τ_v`.

---

## 7. Stage VI — Asynchronous alignment & resampling (the Epps effect)  [OFFLINE]

Two venues update at independent, random times. Naively reading "latest quote from each at grid point `t`" introduces two *systematic* biases that directly forge the statistics the book trades on.

### 7.1 The two biases

- **Staleness bias.** At grid point `t`, one leg's latest quote may be far older than the other's; the spread sample mixes a fresh price with a stale one — a ghost spread (handled by §6.4).
- **The Epps effect.** Measured co-movement between the two legs vanishes toward zero as sampling frequency rises, because non-synchronous updates make genuinely correlated moves look independent. Since a spread is a difference, `Var(spread) = Var(A) + Var(B) − 2·Cov(A,B)`; an Epps-suppressed `Cov` **biases `σ_spread` upward** and corrupts `θ` and half-life. This is the most insidious sync artifact: it manufactures volatility and false reversion out of pure asynchronicity.

### 7.2 Resampling scheme (stated, not hand-chosen)

- **Causal previous-tick (LVCF) onto a uniform `Δt` grid**, with bounded carry-forward age `τ_carry = τ_v` (§5.2, §6.4). Carrying a price older than its staleness ceiling is exactly the staleness bias; bounding the carry converts it into an honest missing value (the mask) instead of a fabricated number.
- **Refresh-time sampling option.** Where async bias is severe (high-frequency `Δt`, illiquid leg), sample the spread **only at instants when both books have updated within `skew_max`** ("both-fresh" sampling). This sacrifices some samples to eliminate staleness mixing.
- **`Δt` is not chosen by hand.** Grid spacing is selected by the Framework's **signature-plot procedure** (§11): coarsen `Δt` until realized variance stabilizes and async/Epps effects vanish. This layer emits the signature-plot inputs computed on the *clean, async-corrected* series.

### 7.3 Async-robust covariance (for cointegration / correlation)

Where a downstream estimator needs the **cross-venue covariance** directly (cointegration, hedge ratio), do **not** estimate it from synchronously-sampled returns. Use a **Hayashi–Yoshida** estimator — it consumes the two series in their native event time with no synchronous grid and is consistent for the covariance under asynchronicity — and/or the noise-robust realized-covariance estimators the Framework names (two-scale / realized kernels). The spread **level** series uses previous-tick LVCF (§5.2); the **covariance objects** use Hayashi–Yoshida. **State which estimator each downstream consumer uses** (§12).

### 7.4 Look-ahead hazards — explicit ban list

| Construct | Uses future data? | Verdict |
|---|---|---|
| Previous-tick / LVCF (`≤ t`) | No | **Allowed** — the only series construction |
| Linear / spline interp between bracketing ticks | Yes (`t⁺`) | **Forbidden** in the traded/estimation series |
| Centered rolling median/MAD for the *value* | Yes | **Forbidden** for the value; allowed only as an *offline diagnostic over the already-built causal series*, and even then prefer trailing windows for anything that gates |
| Window-wide MAD / signature plot / walk-forward split | Yes, by design | **Allowed** — statistics *about* the causal series, not values *in* it |

The discipline: **the per-sample `spread[t]` is causal; everything that needs the future is a property of the window, not a field of the sample.**

### 7.5 Async observables

| Observable | Detection | Threshold | Action | Reason code |
|---|---|---|---|---|
| Stale carry | grid-leg age | `> τ_carry` | grid sample → INVALID (masked) | `STALE_GRID` / `ASYNC_STALE` |
| Epps suspicion | half-life / `σ_OU` sensitivity to `Δt`, rising as `Δt` shrinks | monotone, large | require `Δt` at/above signature-plot stabilization; do not report the fine-grid estimate as primary | `EPPS_SUSPECT` |
| Refresh-time starvation | fraction of grid points with both-fresh data | `< refresh_min = 0.6` | window too async to estimate at this `Δt` → coarsen or fit-halt candidate | `REFRESH_STARVED` |

---

## 8. Stage VII — Robust outlier / wick / bad-tick handling (moment protection)  [shared]

Variance and the fourth moment are hyper-sensitive to single outliers, so this firewall sits **before** any moment is computed.

### 8.1 The sensitivity argument (why a pre-filter is non-negotiable)

A single outlier of magnitude `m·σ` in an `N`-sample window contributes ≈ `m²/N` to the second moment and ≈ `m⁴/N` to the fourth. A lone 20σ bad tick in a 10,000-sample window inflates variance by ~4% but inflates the *raw fourth moment by ~16×* — kurtosis is then dominated entirely by the artifact, and the Framework's heavy-tail / EVT fit, the safety margin `k·σ`, and the stop-band placement are all driven by one bad print. Hence robust outlier handling precedes every statistic (`σ`, skew, kurtosis, ADF, OU, jump tests).

### 8.2 Detection — Hampel / MAD, local and trailing, reused live + offline

```
m_t   = rolling_median( spread_exec_bps , W_hampel )            # TRAILING window (causal)
mad_t = rolling_MAD(    spread_exec_bps , W_hampel )
flag_t  ⇔  | spread_exec_bps[t] − m_t |  >  k_hampel · 1.4826 · mad_t
W_hampel = 101 samples (odd) ,  k_hampel = 5
```
- MAD (not std) is the dispersion estimate so the detector is not blown out by the outlier it is trying to catch; the `1.4826` factor scales MAD to a Gaussian-consistent σ, and `k_hampel = 5` is applied to that **scaled** estimate.
- Detection is **local-window, never global** — a global mean/SD is itself dragged by the outlier (masking it) and a global filter silently deletes real regime shifts.
- This is the **same** filter live and offline, so the trading path and the estimation series agree on what a "bad print" is. For the offline series a *centered* Hampel window may be used as a **diagnostic** (more accurate with future context), but any flag that **gates the live path** uses the trailing window so live and offline agree on the boundary (§7.4).

### 8.3 Wick-specific corroboration (live entry path)  [LIVE]

Before a flagged or favorable print is acted on live, additionally require:
1. **Time persistence.** The entry condition holds for `N = 3` consecutive samples or a dwell `D_dwell = 300 ms`. A one-tick wick dies here.
2. **Book-update survival.** The favorable levels that *create* the edge survive `N_book = 2` subsequent **book updates** (not merely wall-clock samples). A level replaced on the very next diff → `WICK_NO_SURVIVAL`.
3. **Implausibility bound.** Hard reject if `spread_exec_bps(Q) > spread_max_plausible`, where `spread_max_plausible = max( 1.5 · p99.9(spread_hist) , spread_abs_cap )`, `spread_abs_cap = 500 bps` (per-pair). Beyond this ⇒ bad data or a halted venue → `IMPLAUSIBLE`.

### 8.4 Classification — the two-sided discriminator (a flag is not a verdict)

A `k·MAD` excursion can be (a) a corrupt tick, (b) a genuine **jump** (liquidation cascade, listing), or (c) the leading edge of / a sample within a **heavy-tailed but real** diffusive move. Deleting (b)/(c) destroys exactly the events the strategy must see (invariant 4). Classify by **persistence + corroboration**, never by magnitude:

| Evidence | `ERROR_TICK` (corrupt) | `JUMP` (real discontinuity) | `DIFFUSION_EXTREME` (real heavy tail) |
|---|---|---|---|
| Reverts next sample | yes (one-sample excursion) | no — persists | no — persists |
| Depth corroboration | none (the §10 depth gate fails) | whole book moves, depth trades through | depth present |
| Survival | reverts within `N_book = 2` updates | persists ≥ `N_book` updates | persists |
| Cross-venue corroboration | only one venue prints it | both venues / the index move together | corroborated |
| Jump test (Lee–Mykland / BNS) | negative | positive | negative (diffusive) |

```
classify(flagged sample):
  reverts_next   = | spread[t+1] − m_t | < k_hampel·1.4826·mad_t
  no_depth       = §10 depth gate FAILS at t
  no_corrob      = no counterpart move at t
  jump_test_pos  = Lee–Mykland or BNS bipower flags t          # framework

  if reverts_next AND no_depth AND no_corrob:                  → ERROR_TICK
  elif jump_test_pos AND depth_corroborated AND survives N_book updates:  → JUMP
  else:                                                        → DIFFUSION_EXTREME
```

### 8.5 Actions by class — drop, route, or keep (never clip)

| Class | Action | Effect on statistics |
|---|---|---|
| `ERROR_TICK` | **DROP** the sample, mask INVALID; treat as a 1-sample micro-gap (do **not** interpolate a replacement). **Record it** (count, magnitude, timestamp) — never silently delete. The increments *into* and *out of* the dropped sample are removed from the AR(1) design (don't manufacture two fake innovations around the hole). | excluded from `σ`, kurtosis, ADF, OU — the fourth moment is protected |
| `JUMP` | **KEEP**, tag `JUMP_TAG` / `JUMP_CONFIRMED`. Route to the Framework's jump-diffusion separation (fit OU on the diffusive component; jump variance booked separately). **Never deleted** — deleting it would understate `σ_OU` and forge stationarity. Trip the post-jump entry-suppression window. | enters the jump model, **not** `σ_OU` |
| `DIFFUSION_EXTREME` | **KEEP unmodified.** | enters all statistics — this is real heavy-tail mass the Framework's EVT/Student-t fit must see |

**No winsorization path exists.** *(Reconciliation — §18.)* One source permitted winsorizing borderline values (`k_hampel..k_soft`, `k_soft = 8`) to preserve sample count; this is **retired**. A winsorized value is a fabricated boundary print, and the Framework derives stop-band placement and the safety margin `k·σ` from the *fitted tail* — clipping extreme-but-real moves would shrink the measured tail and produce dangerously tight stops. In a dense tick series, sample-count preservation is cheap; tail distortion is expensive and one-directional toward danger. Genuinely ambiguous-and-uncorroborated flags are **dropped + masked**, not clipped. The fit-halt gate (§13) catches any window where too much is dropped.

### 8.7 Repair policy (stated, never silent)

| Situation | Policy |
|---|---|
| Single flagged `ERROR_TICK`, neighbors valid | **drop** + mask INVALID; do **not** interpolate a replacement |
| Burst of flagged ticks (feed incident) | **quarantine the whole burst window** `CONTAM_BURST`; counts toward cleaned-fraction; a burst means the surrounding good-looking ticks are also suspect (§13) |
| Confirmed `JUMP` / `DIFFUSION_EXTREME` | keep per §8.5 — never repaired |

All dropped / masked / quarantined counts are tallied per window for the fit-halt gate (§13) and the monitor (§15).

---

## 9. Stage VIII — Gap, halt & downtime handling (segmentation)  [OFFLINE; detection shared]

A gap is an *unobserved interval*. The cardinal sin is bridging it with a fabricated path; the second sin is mistaking it for a jump or a structural break. Gaps are **the single most dangerous threat** because the two failure modes corrupt in **opposite** directions: a silently carried-forward flat stretch biases `σ_spread` **down** and half-life **up** (false quiescence → fake strong reversion → fake stationarity); a reconnect re-sync produces one huge increment that spikes **kurtosis** and inflates `σ_OU`.

### 9.1 Detection & cause-tagging

| Detector | Logic | Cause tag |
|---|---|---|
| **Sequence hole** | per-book `seq` jump ≠ documented step (§2, definitive) | `dropped_msg` |
| **Heartbeat / cadence** | no book change for `> k_gap · p99_gap_v` *while* the counterpart shows the venue is **not** genuinely quiet (§6.3); `k_gap = 5` | `dropped_msg` / `venue_quiet?` |
| **Receipt-time hole** | jump in `corrected_t_v` between consecutive accepted updates `> gap_min_ms = 2 s` with no intervening updates | `dropped_msg` |
| **Venue halt / downtime** | extended absence + venue status / wallet-status / maintenance schedule | `venue_halt` |
| **Our-side outage** | local monotonic gap with no inbound on **any** venue | `our_outage` |

The cause tag is carried for diagnostics; the **action** is driven by duration (§9.2). *(Reconciliation — §18: the two source taxonomies, by-cause and by-duration, are unified into duration-driven actions crossed with cause tags.)*

### 9.2 Action — classify by duration; never interpolate

**Never linearly or spline-interpolate price across a real gap.** A straight line fabricates a smooth path that biases variance **down** and erases any real jump hidden inside the gap.

| Gap class | Condition | Action |
|---|---|---|
| **Micro** | span `≤ τ_v` (within one leg's live staleness bound) | previous-tick carry is legitimate (the book genuinely hadn't changed); no flag |
| **Short** | `τ_v <` span `≤ gap_refit = 30 s` | `GAP_EXCLUDE` the spanned grid points; they enter **no** moment, ADF, or OU computation. The series continues in the *same segment* with the spanned samples excluded |
| **Long / reconnect** | span `> gap_refit`, OR any `SEQ_GAP`/`CHECKSUM_FAIL` resync, OR venue downtime | insert a **`REFIT_BOUNDARY`**: close the current segment, open a new one after re-sync stabilizes (`N_resync = 20` clean updates) |

Downtime boundaries are **marked** so downtime is **not** mistaken for a structural break (CUSUM/Chow) or a jump (Lee–Mykland) — this satisfies the "stated rule, never silent" requirement.

### 9.3 The increment that must never cross a boundary (load-bearing)

The OU fit is an AR(1) regression on consecutive increments `Δspread_t = spread_t − spread_{t−1}`. Across any gap, `spread_after − spread_before` is **accumulated, partly-unobserved drift**, not a one-`Δt` diffusion innovation; including it injects one enormous spurious residual that simultaneously **inflates `σ_OU`, corrupts `θ`, and spikes kurtosis**.

> **Rule:** the estimator iterates over increments *within a segment only*. The boundary-crossing pair `(spread_before_gap, spread_after_gap)` is **dropped from the lag-1 design matrix**. ADF, OU/AR(1), half-life, and all moments are computed **per contiguous segment** and pooled only across segments of the *same validated regime* — the Framework's structural-break logic decides regime identity; a `REFIT_BOUNDARY` is a *candidate* break to be tested, not silently pooled.

### 9.4 Reconnect is a jump candidate, not a diffusion move

The price step observed at reconnect is unobserved accumulated movement. Route it to the **jump-detection** path (Lee–Mykland / BNS), not the diffusion estimator — it must not enter `σ_OU`. If the post-reconnect level differs materially from pre-gap, trip the Framework's **post-jump entry-suppression window** until the spread is re-validated.

### 9.5 Post-resumption warmup

Price discovery after a halt is transient. Suppress the first `τ_warmup = 60 s` (per-venue) of post-resumption samples from estimation, flag `POST_HALT_WARMUP`.

### 9.6 Segment-aware estimator contract

- **Moments** (`σ`, skew, kurtosis): pooled over all valid samples across segments (level statistics are gap-tolerant).
- **AR(1)/OU and variance-of-increments:** within-segment increments only; segments concatenated for parameter estimation but **no cross-segment increment is ever formed.**
- **ADF / stationarity:** run on the longest valid segment, or a gap-aware specification with segment dummies; report the effective sample and the number/size of segments alongside the p-value (a "stationary" verdict from a series that is mostly gaps is not trusted).

---

## 10. Stage IX — Live execution gates  [LIVE RUN MODE ONLY]

This stage answers the **point-in-time** question the offline firewall never needs: *can THIS prospective entry be filled now?* A spread series can be perfectly mean-reverting in the data and still be untradeable because every attractive print is a wick, a stale quote, or a thin book. These gates **degrade soft** where toxicity/fragility cannot be measured with certainty (invariant 8). They do **not** run over the historical estimation series; they gate live entries only. (The offline series is protected from the same phantoms structurally by `spread_exec(Q)`, §5, and by §6–§9.)

### 10.1 Depth sufficiency

Require cumulative resting depth within the price band `x_band` of the touch to cover the clip plus buffer on **both** sides:
```
depthWithinBand_buy(x_band)  ≥ Q · (1 + buf)
depthWithinBand_sell(x_band) ≥ Q · (1 + buf)
else → reject THIN_BOOK
```
- `x_band` is **derived from the slippage budget**, not hand-set: the touch-distance at which embedded slippage equals the slippage allocation in `C_total`. `buf = 0.25`.

### 10.2 Slippage-budget reconciliation (ties depth → cost model)

The slippage embedded in `spread_exec(Q)` (the VWAP's distance from the touch, both legs, in+out) must not exceed the slippage term modeled in `C_total`:
```
slip_embedded(Q) = (buyVWAP(Q) − bestAsk_buy) + (bestBid_sell − sellVWAP(Q))    [both legs, entry]
reject if slip_embedded_roundtrip(Q) > slippageAllocation(C_total)              → SLIPPAGE_BUDGET
```
If walking the book to `Q` already spends more than the cost model allocated, the net edge is gone *before* the trade — precisely the phantom a top-of-book spread would have shown as profitable.

### 10.3 Round-trip / exit-side depth

Depth must exist on the side you will **exit** into, not only entry — otherwise the position can be opened but not unwound. Require current depth to cover the round trip. Insufficient exit depth → `EXIT_DEPTH`.

### 10.4 Book fragility / concentration (degrade → `L_quality`)

A book whose band-depth is one large order at the touch with a cliff behind it is fragile: that order can be pulled in the time it takes to arrive.
```
conc = depth_top_level / depthWithinBand(x_band)          (or HHI over levels in band)
if conc > κ_conc (0.5):  raise persistence requirement (N += 1) and reduce L_quality
```
Fragility is a **degrade**, not a hard reject (a concentrated-but-real book is still tradeable at a higher confidence bar) — unless it also fails §10.1.

### 10.6 Liquidity-quality coupling to the entry band

The live gate raises the effective entry band when confidence is marginal. A book that *passes* the hard gate but scores low `L_quality` is traded only at a wider edge:
```
z_entry_eff*  =  z_entry*  +  λ · (1 − L_quality)        # default coupling
λ = 0.5 σ_t
```
State the exact coupling in the strategy integration config. **[Open Item §17.5: confirm `λ` units/calibration.]**

---

## 11. Stage X — Microstructure-noise & `Δt` handoff  [OFFLINE]

This layer does not *choose* `Δt` (the Framework does) but it owns the *inputs* and enforces that the choice is made on clean data.

- Emit the **signature plot**: realized variance of `spread_exec(Q)` vs sampling frequency, computed on the post-Stages-I–IX clean, async-corrected series. The Framework coarsens `Δt` until variance stabilizes (noise/async negligible). A single asserted `Δt` is rejected.
- Where high-frequency estimation is genuinely required, expose **noise-robust realized-variance estimators** (two-scale / sub-sampled RV, realized kernels) so the Framework can estimate `σ` without raw-tick bias.
- Report `θ`, `σ_OU`, and half-life **as functions of `Δt`** so a downward-biased half-life from over-fine sampling (the Epps/microstructure artifact) is visible and ruled out.

---

## 12. Output contract — the clean segmented series & quality metadata

An estimator that consumes the bare value vector without the mask is **non-conformant** (invariant 6).

```
CleanSpreadSeries {
  grid_dt          : Δt                          # from signature plot; series reported across a Δt range
  segments         : [ Segment ]                 # contiguous, gap- and break-bounded
  series_quality   : WindowQuality               # per fitting window (below)
}

Segment {
  segment_id, t_start, t_end
  samples : [ CleanSample ]                       # causal, previous-tick, depth-weighted
}

CleanSample {
  t_grid                 # uniform Δt grid timestamp (common reference timebase)
  spread_exec_bps        # depth-weighted to Q; null if INVALID
  valid                  # bool — admitted to estimation?
  segment_id             # contiguous-run id (gap-aware)
  leg_age_A_ms, leg_age_B_ms
  skew_sample_ms         # cross-venue residual skew (§3.3)
  repair_flag            # { none, carried, dropped }     # NOTE: no 'winsorized' — see §8.5
  flags                  ⊂ { VALID, GAP_EXCLUDE, STALE_LEG, ASYNC_STALE, FEED_SKEW,
                             SYNC_UNCERTAIN, HAMPEL_OUTLIER, ERROR_TICK, JUMP_TAG,
                             DIFFUSION_EXTREME, CONTAM_BURST, SEQ_GAP, POST_HALT_WARMUP,
                             CLOCK_STEP, REF_DIVERGENCE, RESOLUTION_LIMITED }
  L_quality ∈ [0,1]      # continuous data-quality score (mirrors live L_quality)
}

WindowQuality {                                   # consumed by the fit-halt gate (§13) and audit (§15)
  N_total, N_valid, N_eff                         # raw / valid / effective (independent) sample count
  cleaned_fraction                                # (dropped + masked) / N_total   — the corruption signal
  frac_excluded                                   # total excluded (cleaned + gaps), reported as telemetry
  contam_burst_count
  largest_gap_fraction                            # max single segment-gap as fraction of window span
  n_refit_boundaries
  segments[]                                      # { id, start, end, n_valid }
  max_sync_uncertainty_ms, max_skew_AB_ms, frac_skew_quarantined
  σ_quant, σ_spread_over_σ_quant
  signature_plot                                  # RV vs frequency (for Δt selection)
}
```

**Consumption rules the estimators must honor (auditable):**
1. ADF / OU / AR(1) / moments iterate **within a segment**; lag-1 pairs **never cross** a `REFIT_BOUNDARY` or a `GAP_EXCLUDE` run (§9.3).
2. Only `VALID` and `DIFFUSION_EXTREME` samples enter `σ_spread`, kurtosis, ADF, OU. `JUMP_TAG` enters the jump model only. Everything else is excluded.
3. Pooling across segments requires same-regime confirmation (Framework structural-break test); a `REFIT_BOUNDARY` is a *candidate* break, not a silent pool.
4. Covariance objects (cointegration, hedge ratio) use the async-robust estimator named for that consumer (§7.3); spread-level series uses previous-tick LVCF.
5. **`HALT_FIT` overrides all** (§13): if any halt condition fires, the layer emits **no fitted parameters** for that window and the spread is suspended.

---

## 13. Estimator-facing FIT-HALT gate (the phantom-statistic firewall)  [OFFLINE]

Before any estimator runs on a window, this conjunctive gate decides whether the **window is clean enough to fit at all** — the enforcement of invariant 7. Failing any condition → **fit halted, spread suspended** (no estimate emitted; the Framework's own conjunctive gate sees a missing/red hygiene precondition and suspends the spread).

| Condition | Observable | Threshold (default) | Action on fail | Reason code |
|---|---|---|---|---|
| **Cleaned fraction** | `cleaned_fraction` (per-tick cleaning — the corruption signal) | `> f_clean_max = 5%` | halt fit, suspend spread, alarm | `DIRTY_WINDOW` |
| **Gap dominance** | `largest_gap_fraction` | `> g_max = 20%` | window unrepresentative → re-window or halt | `GAP_DOMINANT` |
| **Effective sample** | `N_eff` | `< N_min` (per-test, §16) | halt fit | `INSUFFICIENT_N` |
| **Sync trust** | `max_sync_uncertainty_ms` | `> skew_max = 100 ms` sustained | cross-venue stats untrusted → halt high-freq fit | `SYNC_UNCERTAIN` |
| **Systematic skew** | `skew_AB` over window | `> skew_quarantine = 250 ms` for `> f_skew_max = 2%`, or `drift_v > drift_max` | halt fit, suspend, page infra | `SKEW_QUARANTINE` |
| **Host clock** | `HOST_CLOCK_DEGRADED` / `CLOCK_STEP` present | any | halt fit (absolute-time statistics untrusted) | `HOST_CLOCK_DEGRADED` |
| **Normalization** | startup mid-agreement assertion (§4.3) | fail | halt fit | `NORMALIZATION_FAIL` |
| **Resolution floor** | `σ_spread / σ_quant` (§4.2) | `< r_quant = 3` | suspend spread from estimation/trading | `RESOLUTION_LIMITED` |
| **Contamination concentration** | `contam_burst_count` / pattern | burst (not sprinkled) | quarantine window, halt fit, alarm | `CONTAM_BURST` |

**Sprinkled vs concentrated.** Contamination below `f_clean_max` that is **sprinkled** is tolerable random noise (cleaned and proceed). **Concentrated** contamination (a burst) signals a feed incident and is never just cleaned away — the whole window is quarantined, because a burst means the surrounding good-looking ticks are also suspect.

*(Reconciliation — §18: one source lumped all exclusion into a single `frac_excluded ≤ 15%` halt; the decomposed conditions above supersede it — they distinguish "death by a thousand bad ticks" (`cleaned_fraction`) from "one big hole" (`largest_gap_fraction`), and `N_eff` handles usable independent sample count better than a raw percentage. Total `frac_excluded` is still reported as telemetry.)*

---

## 14. Conjunctive gates (auditable statements)

### 14.1 Series CLEARED_FOR_FITTING  [OFFLINE]

A spread series window emits trusted parameters **only if all** hold:
```
cleared_for_fitting ⇔
        no UNRELIABLE leg in window            (§2:  ¬SEQ_GAP ∧ ¬CHECKSUM_FAIL ∧ ¬CROSSED_BOOK ∧ ¬BAD_VALUE)
    ∧   host clock disciplined                 (§3:  ¬HOST_CLOCK_DEGRADED ∧ ¬CLOCK_STEP)
    ∧   max_sync_uncertainty_ms ≤ skew_max     (§3:  ¬SYNC_UNCERTAIN)
    ∧   ¬SKEW_QUARANTINE                        (§3:  skew_AB ≤ skew_quarantine over ≥ (1−f_skew_max) of window
                                                       ∧ drift_v ≤ drift_max)
    ∧   normalization assertion passed         (§4:  ¬NORMALIZATION_FAIL)
    ∧   σ_spread ≥ r_quant · σ_quant            (§4:  ¬RESOLUTION_LIMITED)
    ∧   async not starved at chosen Δt          (§7:  refresh fraction ≥ refresh_min)
    ∧   cleaned_fraction ≤ f_clean_max          (§8/§13: ¬DIRTY_WINDOW)
    ∧   no contamination burst                  (§8/§13: ¬CONTAM_BURST)
    ∧   largest_gap_fraction ≤ g_max            (§9/§13: ¬GAP_DOMINANT)
    ∧   N_eff ≥ N_min                           (§13: ¬INSUFFICIENT_N)
    ∧   every sample built causally (≤ t both legs)            [invariant 2]
    ∧   no AR(1) lag-1 pair crosses a gap/refit boundary       [invariant 2/§9.3]
    ∧   ERROR_TICKs dropped, JUMPs routed to jump model, DIFFUSION_EXTREMEs preserved  [§8.5]
```
Cleared windows emit estimates with full provenance into the Framework. **Any failure halts fitting and suspends the spread.**

### 14.2 Entry EXECUTABLE  [LIVE]

A prospective entry is `executable = TRUE` **only if all** hard gates pass:
```
executable ⇔
        Stage-I all pass, no UNRELIABLE leg     (§2)
    ∧   age_v ≤ τ_v for both legs               (§6:  ¬STALE_BOOK)
    ∧   feed skew ≤ skew_max                     (§6:  ¬FEED_SKEW)
    ∧   skew_sample ≤ skew_max                   (§3:  alignment ok)
    ∧   time-persistence ∧ book-survival pass    (§8.3: ¬WICK_*)
    ∧   spread_exec_bps ≤ spread_max_plausible   (§8.3: ¬IMPLAUSIBLE)
    ∧   depthWithinBand ≥ Q·(1+buf) both sides   (§10.1: ¬THIN_BOOK)
    ∧   slip_embedded ≤ slippageAllocation       (§10.2: ¬SLIPPAGE_BUDGET)
    ∧   exit-side depth sufficient               (§10.3: ¬EXIT_DEPTH)
```
Book fragility (§10.4), `REF_DIVERGENCE` (§8.6), and toxicity **degrade `L_quality`** and widen `z_entry_eff*` (§10.6) rather than hard-rejecting, where they cannot be measured with certainty at signal time.

---

## 15. Calibration, monitoring & audit

**Walk-forward calibration.** Every threshold derived from a feed's own statistics (`τ_v`, `o_v`, `k_ref`, `σ_quant`, dynamic gap thresholds) is re-estimated on a rolling **train** window and validated **out-of-sample**:
- (a) windows/samples flagged dirty correlate with **larger realized OU-fit error / worse forward-window reversion** and with poor realized fills or missing counterpart data;
- (b) accepted windows' `σ_spread` / half-life are stable across the train/forward split;
- (c) **the cleaning must earn its place** — parameters fit on the cleaned series predict forward-window reversion *better* than parameters fit on the raw series. Measure the OOS Sharpe / half-life-stability delta of clean vs. raw. A threshold that does not separate clean from dirty on forward data is mis-tuned.

**Contamination → fit-error correlation (the headline audit metric).** Continuously measure the correlation between `cleaned_fraction` (and `max_sync_uncertainty_ms`) and downstream fit instability (half-life CI width, OU residual Ljung–Box failures, ADF p-value volatility). A *rising* correlation is early evidence the firewall is being breached or thresholds have loosened.

**Risk-manager surface (reason-code dashboards).** Per-venue, per-pair rejection/flag rate by reason code, plus realized-vs-expected fill slippage; `max_skew_AB` and `drift_v` (clock health); `frac_excluded` and `n_refit_boundaries` (feed health); `σ_spread / σ_quant` (resolution health). **Reason-code spikes are alarms with distinct meanings:**
- `SEQ_GAP` / `CHECKSUM_FAIL` / `STALE_FEED` spike → feed or connectivity problem.
- `FEED_SKEW` / `SYNC_UNCERTAIN` / `SKEW_QUARANTINE` / `OFFSET_DRIFT` / `SICK_CLOCK` spike → **synchronization / clock fault**; cross-venue book is suspect; suspend high-frequency trading on the pair and page infra until resolved.
- `CONTAM_BURST` / `HAMPEL_OUTLIER` / `ERROR_TICK` spike → data-error regime (parser/precision fault or venue incident); estimates from the period are not to be trusted.
- `THIN_BOOK` / `SLIPPAGE_BUDGET` spike → liquidity-regime contraction (size down).
- `DIRTY_WINDOW` / `INSUFFICIENT_N` spike → the spread is spending too much time un-estimable; capacity/quality red flag.
- `RESOLUTION_LIMITED` appearing → the pair has tightened into the quantization floor and should drop out of the universe.

Track the **gap between signal frequency and trade frequency** — it is exactly how much raw opportunity this layer is correctly discarding as phantom.

**Auditability.** Every emitted estimate is traceable to the exact `WindowQuality` record it was fit on. A risk manager can reconstruct, for any historical OU fit or ADF verdict, the cleaned fraction, segment map, and sync uncertainty behind it. **No statistic is allowed into the book that cannot be audited back to a clean window.**

---

## 16. Master parameter table

| Param | Meaning | Default | Calibration |
|---|---|---|---|
| `Q` | clip size for `spread_exec(Q)` | per-strategy | sizing/capacity model |
| `skew_max` | per-pair alignment / cross-feed skew | 100 ms | fixed (Shared Framework) |
| `skew_clock_max` | exchange↔local point-in-time clock skew | 250 ms | from clock-offset jitter |
| `skew_quarantine` | window-kill systematic skew | 250 ms | offset-jitter distribution |
| `f_skew_max` | max fraction of window over `skew_quarantine` | 2% | false-quarantine rate |
| `sync_host_max` | host-clock offset-uncertainty ceiling | 5 ms | PTP/NTP dispersion |
| `step_detect` | realtime-vs-monotonic divergence (NTP step/leap) | 5 ms | step/leap detection |
| `lat_ingest_max` | internal ingest-latency alarm | 5 ms | backpressure monitoring |
| `W_off` | offset-estimation min window | 5 min | delay-floor sampling vs drift tracking |
| `H_off` | offset EWMA half-life | 2 min | offset-drift stability |
| `W_drift` | drift-tracking window | 6 h | diurnal network/temperature cycles |
| `offset_drift_max` / `drift_max` | tolerated offset drift / sick-clock alarm | 50 ms/hour (≈ 13.9 ppm) | venue clock-stability empirics |
| `k_stale`, `τ_floor`, `τ_ceiling` | dynamic staleness `τ_v` | 3 / 250 ms / 1000 ms | book inter-update p99 |
| `W_gap` | staleness-cadence rolling window | 6 h | cadence regimes |
| `τ_carry` | LOCF carry-forward ceiling | `= τ_v` | from `τ_v` |
| `ε`, `k_ε` | liveness-oracle move threshold | `max(2·tick_coarse, 3·MAD)` | **provisional, Open Item §17.4** |
| `refresh_min` | min both-fresh fraction at `Δt` | 0.6 | async-starvation study |
| `Δt` | analysis grid spacing | from signature plot | Framework (variance-stabilization) |
| `k_hampel`, `W_hampel` | robust outlier MAD multiple / window | 5 / 101 (odd) | match live + offline |
| `N`, `D_dwell` | live time-persistence | 3 / 300 ms | per-strategy [LIVE] |
| `N_book` | book-update survival count | 2 | wick false-pass rate |
| `spread_abs_cap` | implausibility ceiling | 500 bps (per-pair) | historical p99.9 [LIVE] |
| `k_ref`, `W_ref` | composite-reference divergence MAD multiple / window | 5 / 1 h | **reconstructed, Open Item §17.1** |
| `x_band` | depth band | `=` slippage-budget distance | derived from `C_total` [LIVE] |
| `buf` | depth buffer over `Q` | 0.25 | book-pull empirics [LIVE] |
| `κ_conc` | concentration threshold | 0.5 (HHI alt) | fragility-vs-fill study [LIVE] |
| `λ` | `L_quality`→entry-band coupling | 0.5 σ_t | **Open Item §17.5** [LIVE] |
| `gap_min_ms` | receipt-time gap detect | 2 s | feed cadence |
| `gap_refit` | short-vs-long gap / refit-boundary span | 30 s | max tolerable carried-state age |
| `k_gap` | heartbeat-gap multiple | 5 | dropped-message false-positive rate |
| `N_resync` | clean updates to clear resync | 20 | conservative fixed |
| `τ_warmup` | post-halt warmup suppression | 60 s (per-venue) | resumption-transient study |
| `f_clean_max` | max cleaned fraction before fit-halt | 5% | contamination → fit-error study |
| `g_max` | max single-gap fraction of window | 20% | representativeness study |
| `N_min` | min effective sample to fit | per-test (§17.3) | test-power requirement |
| `r_quant` | resolution-limited multiple | 3 | quantization-vs-market study |
| `d` | shared fixed-point decimal scale | `≥ max(venue decimals)` | venue precision profiles |

---
