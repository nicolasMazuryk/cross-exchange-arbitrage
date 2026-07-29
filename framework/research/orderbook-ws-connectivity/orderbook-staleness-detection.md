# Orderbook Market-Data WS Connectivity — Staleness Detection, False Positives, Threshold Calibration & Granularity

---

## 1. Staleness Signals (the full independent set)

The word that matters is **independent** — each catches a failure the others miss.

### Timing-class (detect "feed stopped/slowed")

1. **Transit / skew — `exchange_ts − local_recv_ts`.**
   Catches feed lag (exchange-side queuing, network buffering, your ingest thread falling behind). End-to-end delay plus clock offset. Catches slow paths, network/queue buildup, and your own ingest backpressure.
   *Critical caveat:* you don't know your absolute clock offset, so use the **drift** of this delta, not its absolute value. Track a rolling baseline of the skew and alarm when transit *grows* relative to baseline.
   *Watch out for* heterogeneous timestamp semantics across venues — event-time vs send-time vs match-engine-time, ms vs µs granularity, and venues that don't per-message timestamp at all.

2. **Inter-message watchdog (connection silence) — `now − last_recv_any_msg`.**
   Catches a dead/stalled socket and a dead symbol. The most reliable low-level liveness check, both at the **connection** and **book** levels. Catches dead/half-open sockets that TCP hasn't noticed.

3. **Max book age (content freshness) — `now − last_time_this_book_changed`.**
   Catches a book driven by old events, or not advancing. The per-symbol signal, and the hard one, because of the false-positive problem (§3). On its own it **cannot** distinguish "quiet market" from "stalled symbol."

---

## 2. Which venue timestamp field feeds which signal

Most venues publish more than one time, and they mean different things. This is where teams silently get it wrong.

| Venue / channel | Send time | Engine (event) time | Sequencing | Correct field for content-freshness |
|---|---|---|---|---|
| **Binance spot** (`@depth`) | `E` | — (not published) | `U`, `u` | `E` (degrades to send-time) |
| **Binance USDⓈ-M futures** (diff depth) | `E` | `T` (matching engine; `T` precedes `E`) | `U`, `u`, `pu` | **`T`** |
| **Bybit v5** (`orderbook.*`) | `ts` | `cts` (matching engine; correlates with trade-feed `T`) | `u`, `seq` | **`cts`** |
| **OKX** (`books`) | `ts` | — (none on this channel) | `seqId`, `prevSeqId` | `ts` (degrades to send-time) |
| **Bitget** (depth) | `ts` | — (none) | `seq` | `ts` (degrades to send-time) |


## 3. "No data" ≠ "bad data" — the central false-positive problem

The naive fixed per-symbol timer ("alarm if no update in 2s") is wrong because it's **simultaneously too tight for illiquid books** (constant false positives) **and too loose for liquid ones** (misses real stalls). The fix is layered, and the key insight is decoupling two things people conflate.

### A. Separate connection liveness from book liveness — this is the whole game

If the **connection** is receiving anything (heartbeats, ping/pong, other symbols' updates), then "this one symbol is quiet" is almost certainly a quiet market, because a genuine feed stall manifests at the connection level. So:

- Put your **strict, content-independent real-time watchdog at the connection level** (signal #2 + heartbeat cadence). Here, "no data" genuinely *is* abnormal, so a hard timer is correct.
- At the **per-symbol level, do not run a hard timer at all.** You cannot distinguish quiet from stalled by that symbol's time-since-update alone, so don't try.

### B. Cross-symbol corroboration on the multiplexed connection

A connection carrying ~2000 symbols has an aggregate message-rate signal that's a **strong** stall detector. Maintain a rolling baseline of the connection's message rate; if a socket that normally does ~thousands of msg/s collapses to near-zero while the socket reports "up," that's a real stall hitting everything — caught with **no per-symbol timer**.

### C. Activity-correlated expectation, not fixed timers (the §4 link)

Model expected silence from the symbol's **own realized arrival process**. A book updating ~10/s going silent 2s is a multi-sigma event → `STALE`. A book updating ~1/min sees 2s as nothing. The "threshold" is **derived from behavior**, not chosen as a constant.

### D. Peer-venue corroboration — your unfair advantage

You're running an arb system, so the same instrument trades elsewhere. If venue A's BTC-USDT hasn't moved in 3s but venue B's spot *and* the perp are both moving, A is likely stale. Operationalize on the **trading side**: a detected edge that *persists longer than the time it should take competition to close it* is a staleness signal, not free money. Gate every signal on *"is the leg I think is mispriced actually just stale?"* — the cheapest and most decision-relevant staleness check you have, and it directly prevents the phantom-arb bad fill.

### Replacing the fixed per-symbol timer — the recommended scheme

1. Hard real-time watchdog **only at connection + heartbeat level**.
2. Per-symbol: mark `STALE` only when silence exceeds an **adaptive** threshold (§4) **and** there's corroboration (connection healthy + same-connection peers updating, or cross-venue divergence).
3. Promote `STALE → trading-disabled` conservatively, exploiting an asymmetry: **disabling a quiet illiquid book from trading is nearly free** (you weren't trading size there, and if you were you want certainty), whereas reconnecting the whole connection is expensive and risks dropping the 1999 healthy books. So *"when in doubt, stop trading **this book**"* beats *"alarm/reconnect the connection."*

### Unifying principle

> **A book only needs to be fresh relative to the latency of the opportunity you'd act on with it.**

A 30s-quiet altcoin you'd never arb at size doesn't need a 2s guarantee; a BTC book you'd fire on within 5ms needs sub-100ms confidence. Tie the staleness verdict to the **trading decision**, not to an absolute clock.

---

## 4. Threshold calibration & liquidity-adaptive intervals

### Data-driven per-(venue × symbol) thresholds

Track two rolling distributions per book: inter-message gap `Δt`, and transit-skew **deviation from baseline**.

- **Silence threshold** ≈ `clamp(floor, k × p99.9(Δt), ceiling)`, with `k ≈ 3–5×`. p99.9 captures "the longest we normally go quiet"; `k` keeps normal tail gaps from tripping it.
- **Transit alarm** on `current_skew − rolling_median_skew` exceeding ~p99 of skew-deviation — tracking deviation neutralizes the unknown constant clock offset.

### Computing percentiles cheaply at 30k books

You can't keep histories. Use streaming/approximate structures, tiered by how much the book matters:

| Structure | Property | Use for |
|---|---|---|
| **DDSketch** | Relative-error guarantee on tail quantiles, bounded memory, merges cleanly across windows. Modern default; suits latency-style data. | T0/T1 **liquid** books where tail accuracy matters. |
| **P² (Jain & Chlamtac)** | O(1)-memory streaming p99. | When you want a single quantile without a full sketch. |
| **EWMA of mean+variance** → `threshold = mean + zσ` (z ≈ 4–6) | Tiny memory, but `Δt` is heavy-tailed so it under-models the tail. | The ~28k **illiquid** books — cheap path, tail precision neither affordable nor needed. |

*(t-digest is the alternative to DDSketch; DDSketch's relative-error guarantee suits latency data better.)*

**Recommended split:** DDSketch and/or P² (Jain & Chlamtac).

### Floors and ceilings

- **Floor (~50–100ms):** never alarm faster than network jitter alone produces gaps, and never faster than you could meaningfully react.
- **Ceiling (~30–60s):** even the most illiquid "normal" book gets re-snapshotted on principle past the ceiling — confidence has decayed, and a cheap resync restores certainty for free.

### Tiering ~30k subscriptions

Don't run 30k fully-adaptive estimators in the hot path. Classify each book into a few tiers (e.g., **T0 majors / T1 liquid / T2 mid / T3 thin / T4 dormant**) by a single rolling stat (EWMA message rate or notional). Each tier carries a **template profile** (floor, ceiling, `k`, expected-rate band); a book inherits its tier's profile, with per-book fine-tuning reserved for T0.

This is exactly the BTC-vs-altcoin example:

- **T0 BTC silent 2s** trips its ~hundreds-of-ms threshold = **emergency**.
- **T3 alt silent 2s** is well under its tens-of-seconds ceiling = **normal**.

Maintain tiers on a **slow cadence** (re-evaluate every few seconds, not per message), O(1) per book per tick — trivial at 30k. Make tier transitions **hysteretic** (cross a band by a margin *and* persist) to stop flapping.

### Warmup behavior

- **Cold (insufficient samples):** fall back to the **tier template as a prior** — you already know roughly how Binance BTC-USDT spot behaves before you've measured it. Be permissive during warmup (lean on the ceiling) and only "activate" the adaptive threshold after N samples. Conceptually Bayesian: start at the template prior, let data pull the threshold toward the book's true behavior.
- **After reconnect / resync:** distinguish path-dependent from market-dependent stats.
  - **Transit-skew baseline is path-dependent → reset it** (new socket, new path) and re-warm with a short EWMA.
  - **Arrival-rate / tier classification is market-dependent → persist it across reconnects** (the market's liquidity didn't change because your socket blipped). Persisting Δt sketches and tier assignments across reconnects is what keeps you from re-warming 30k estimators every blip.

**Bootstrapping and guard rails.**
- A new symbol starts on a per-venue prior (e.g., that venue's median-symbol parameters) and converges as data accrues — you cannot hand-tune 30k subscriptions.
- Always clamp learned thresholds to sane `[min, max]` bounds so a bad learning window (e.g., params learned *during* an outage) cannot produce an absurd threshold.
- Persist learned params across restarts so you do not cold-start blind after every deploy.


### Staleness budgets and the freshness SLO

Give each signal an explicit budget — e.g., **transit 200ms**, **connection-silence 1s**, **per-book age = tier-dependent**, **checksum cadence = period × k**. Compose them:

- A book is `LIVE` iff all hard budgets hold and no structural signal fired.
- `STALE` if a soft budget is exceeded.
- `RESYNC` on any structural failure.

Structural signals **veto** (any one ⇒ RESYNC); timing budgets compose as the **max staleness across signals**.

The per-tier **freshness SLO** then reads concretely, e.g.:

> *For T0: P(book age > 250ms | connection healthy) < 0.1%, and any seq/checksum failure detected within one message and resynced within X ms.*

Monitor SLO burn empirically and use it to tune `k` and the tier bands. Crucially, the budget feeds the **order logic**: only fire when

```
book_age + transit + worst_case_one_message_resync  <  opportunity_latency_budget
```

— that's how the SLO directly bounds adverse selection.

### Anti-flap and the correctness override.
- Probabilistic signals get hysteresis: require a breach sustained for *k* checks or *k*-of-*n* signals agreeing (e.g., silence past p99.9) before declaring STALE, and debounce the recovery.
- Deterministic correctness signals — seq gap, checksum mismatch, crossed book — **bypass the vote and trigger immediate resync**, no quorum. This is the concrete expression of "correctness > latency": a probabilistic staleness suspicion can wait for confirmation; proven corruption cannot.

---

## 6. Granularity: per-book tracking without timer storms

The naive design — one OS/async timer per symbol, armed and cancelled on every message — gives you 2000 timers/connection × 15 = **30k timers thrashing on every message**. Catastrophic for cache and scheduler. Don't do it. Options, best first for this access pattern:

### 1. Single periodic sweep + last-update timestamps (recommended)

Per book, store one `last_update_ts` (plus `last_seq`, `state`). On each message: `last_update_ts = now` — a single O(1) store, zero timer bookkeeping. One coarse timer per connection (or global) fires every ~50–100ms and linearly scans, comparing `now − last_update_ts` to each book's threshold.

This converts *"2000 timer arm/cancels per message"* into *"one store per message + one cache-friendly linear scan per tick."* At N=2000, the hot freshness data is **~16KB — fits in L1/L2**, scan is nanoseconds.


### 3. Lazy / point-of-use checking — the elegant fit

Check freshness **when the arb engine reads the book**: compute `now − last_update_ts` at that moment. You only pay for freshness on books you're about to trade — perfectly aligned with *"freshness matters only relative to action."* Keep the background sweep purely for telemetry/alerting on books not currently being evaluated. **This is what I'd build.**

### 4. Cache-friendly layout (SoA)

Keep hot freshness state as a **structure-of-arrays** indexed by dense book id:

```
last_update_ts[]   threshold[]   state[]   tier[]
```

The sweep is a vectorizable linear scan with no pointer chasing and no per-book objects. The large L2 price-level structures live elsewhere; **the freshness checker never touches them.** This decoupling is the key to scale.

### 5. Coarse clock

Don't hammer `clock_gettime` / `Instant::now()` in the sweep; cache "now" once per tick or use `CLOCK_MONOTONIC_COARSE` for freshness comparisons. Reserve a precise timestamp for the one receive-time read per message (needed for the transit signal).

### 6. Connection-level aggregate counters

For §3's cross-symbol corroboration, maintain per-connection `msg_rate` (rolling) and `last_any_msg_ts` — O(1) updates giving the cheap, reliable connection-liveness signal without touching per-book state.

### 7. Threading

Hot path does only O(1) work per message: timestamp store, seq check, checksum accumulate. The sweep, tier reclassification, and sketch maintenance run on a **separate lower-priority cadence** so they never add ingest latency. Own each connection's books on its own thread (no cross-thread contention on the hot path); expose the small freshness array to the arb engine via atomics or a **seqlock** for cheap lock-free reads.

---

## Architecture-level consequences (single-host / single-region / 30k subs / low-ms / correctness-first)

- The single host makes signal **(j)** — local apply latency and queue depth — disproportionately important. A GC pause or a blocked consumer does not desync one book, it desyncs all of them, and will masquerade as a venue-wide transit spike. Instrument your own pipeline as carefully as you instrument the venues.
- Multiplexing many symbols per connection is not just a rate-limit workaround; it is what *makes* cross-symbol corroboration possible. Design the connection-to-symbol mapping deliberately so that "which symbols share a socket" is a property you can reason about, not an accident of subscription order.

## Stack choices, calibrated to your constraints

Low-ms and correctness-first on a single host:

- **Real bottleneck = JSON parsing**, not the network: use `simd-json` or `simdjson` (C++), and prefer **binary/SBE feeds** where venues offer them.
- **System:** pin and isolate hot cores (`isolcpus`); run **chrony** — your transit signal is meaningless without disciplined clocks.

---
