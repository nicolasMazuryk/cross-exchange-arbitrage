# 07 — Reliability: Failure Catalog, Circuit Breakers & Kill Switches

**Scope:** the core reliability principles, the unified error taxonomy, the **master failure-mode catalog** (single source of truth — domain docs cross-reference here), circuit breakers, pre-trade gates and continuous protections, hierarchical halt scopes and graded actions, the three kill-switch layers, graceful shutdown, and time discipline. Cross-references: connection FSM recovery paths → `02 §9.4`, Resolver → `03 §5`, reservation reaper → `04 §2`, drift ladder/repair → `05 §6`, persistence-failure policy → `06 §6`, testing the failure modes → `08 §3`.

---

## 1. Core reliability principles

1. **Crash-only software.** The process must be killable at any instant (`kill -9`, OOM, power) and recover to a correct state from WAL + snapshots + venue reconciliation. There is no "graceful shutdown required for correctness" — graceful shutdown is an optimization (§8). Design recovery first; normal operation is a special case of recovery.
2. **Fail closed.** Every ambiguity resolves to the *less exposed* interpretation: unknown order ⇒ assume live (capital stays reserved); unknown connection ⇒ assume dead (re-snapshot); unknown balance ⇒ assume unavailable; unclassified error ⇒ most conservative class (§2). Components that fail render their scope *untradeable*, never *unguarded*.
3. **Bounded everything.** Every queue, buffer, retry loop, and in-flight set has a bound; hitting a bound is a health signal (DEGRADED), not an exception path. Unbounded anything = eventual memory blowup during exactly the storm you most need to survive.
4. **Detection beats prevention.** You cannot prevent venue-side weirdness; you can detect it in milliseconds (invariants, watchdogs, reconcile) and stop the bleeding. Optimize time-to-detect and time-to-safe, not probability-of-never-happening.
5. **Escalate by scope, act by gradation.** Symbol → subaccount → venue → global; soft-halt → hard-halt → flatten → freeze (§6). Make halting *cheap and frequent* so nobody hesitates to trigger it; an unnecessary 30-second halt costs basis points, a suppressed one costs the book.
6. **Everything that failed once is a test case forever** (→ `08 §3`).

---

## 2. Unified error taxonomy

Classify **every** venue error/response into exactly one class; the class — not the raw code — drives behavior. Per-venue `code → class` mapping tables live in the adapter and are **code-reviewed at integration time against current venue docs** (codes churn). **Default for unclassified errors: the most conservative plausible class** — an unknown error near order placement is `AMBIGUOUS`, never retried blind; repeated unclassified errors HALT the scope.

| Class | Meaning | Examples (representative — re-verify) | Action |
|---|---|---|---|
| `FATAL_REJECT` | Venue understood and refused; deterministic | bad params, tick/lot violation, post-only would cross, insufficient balance, qty < filled on amend | No retry. Release reservation. *Insufficient balance also flags capital-model drift ⇒ triggered balance reconcile.* Param rejects = our bug ⇒ alarm on rate |
| `RETRYABLE_TRANSIENT` | Venue/transport hiccup, request definitely **not** executed | 429 (with hard bucket gate), connection refused before send, explicit "service busy, not processed" | Bounded retry with jitter **same coid**; counts toward breaker |
| `AMBIGUOUS / IN-DOUBT` | Outcome unknown — may have executed | timeout, ECONNRESET after write, **any HTTP 5xx** (Binance: explicitly "execution status UNKNOWN"), WS drop mid-request | → `UNKNOWN` state → Resolver (→ `03 §5`). Never optimistic in either direction |
| `RATE_LIMITED` | Throttle state, not an error per se | 429 / -1003 / venue rate codes; response headers near cap | Gate the bucket (→ `02 §14`); shed places, never cancels; 418 ⇒ venue HALT |
| `VENUE_DEGRADED` | Systemic venue trouble | maintenance notices, error storms across endpoints, cancel-works-place-doesn't asymmetry | Trip venue breaker ⇒ cancel-and-reduce-only; reconcile on recovery |
| `GOOD_NEWS` | "Error" that is actually information | cancel → "unknown order" (already terminal); duplicate-coid reject (our dedup confirmation) | Treat as evidence: query to learn *which* terminal; dup-coid = placement confirmed once |

**Venue quirks the taxonomy must absorb** (details → `02`, `08 §5`): ack ≠ accepted ≠ live (async post-risk rejects); batch responses are per-item, never all-or-nothing; REST and stream are eventually consistent *in both directions*; unified-margin rejects attribute at **account** scope, not symbol (→ `04 §5`); timestamp-rule rejects consume rate budget (→ `02 §10.3`); a `-1022` signature storm after a venue signing change is an ops alarm, not weather.

---

## 3. Master failure-mode catalog

The single consolidated catalog. Columns: how it's **detected**, the **immediate response** (bleeding stopped), the **recovery** path, and the invariant/mechanism that protects (→ `05 §8` I-numbers).

### 3.1 Order path

| Failure | Detection | Immediate response | Recovery | Protects / ref |
|---|---|---|---|---|
| Lost place ack (timeout / conn died post-send) | submit-timeout (p99×k); in-flight registry sweep | → `UNKNOWN`; reservation held | Resolver query-by-coid; verified-absent ⇒ synthetic REJECTED; found ⇒ install truth | I13; `03 §5` |
| Lost cancel ack | cancel-timeout | order stays logically resting; cancel marked in-doubt | **Re-send cancel aggressively, both transports** (idempotent); then query order | `03 §5.4` |
| Amend ambiguity | amend-timeout | hold **max(old,new)** reservation | query; reconcile to actual params; rollback snapshot if rejected | `03 §2.3` |
| Cancel-to-fill race | cancel ack + fill arrive ∼simultaneously / out of order | apply fill; never release capital on cancel ack alone | post-op order snapshot decides; fence by venue seq/ts | `03 §4` |
| Async reject after ack (`ACKED_UNCONFIRMED`) | confirm-timeout; reject on order stream | state regresses to REJECTED via stream event | release reservation; classify reason | `03 §2.1` |
| Double-send risk on retry | — (prevented) | retries reuse the same coid; venue dedup | dup-coid reject = `GOOD_NEWS` confirmation | I9; `03 §1, §5` |
| "Order not found" eventual consistency | not-found inside grace window (500 ms–2 s) | keep in-doubt; re-query | two consistent sources (stream + REST) before declaring dead | `03 §5.1` |
| Batch partial success | per-item `sCode`/`sMsg` | process each item independently | failed items follow their own class; never assume atomic | `02 §11` |
| Zombie order (non-terminal past maxAge) | registry age sweep | force `UNKNOWN` | Resolver | I13 |
| Unknown order at venue (reconcile orphan) | open-orders set diff | **adopt + halt new trading on scope + alert**; cancel if policy-gated | classify (ours-lost-intent / manual / external); bind by coid if ours | `05 §6` |
| Reject storm (params/signature) | reject-rate breaker | trip scope breaker; stop placing | fix bug; signature storms = ops alarm | §4 |
| Unfilled-order budget exhaustion (Binance-class) | order-count headers near cap | shed places; preserve cancel floor | wait window; re-evaluate strategy requote rate | `02 §14` |

### 3.2 Stream & connection

| Failure | Detection | Immediate response | Recovery | Protects / ref |
|---|---|---|---|---|
| Silent half-open socket | data watchdog + failed liveness probe (idle ≠ alive) | force-close; Health degrades; deployable 0 | reconnect + full §02 §4 sync | `02 §5` |
| Dropped events / seq gap | seq mismatch where available; else REST reconcile, balance-delta-without-fill, cum-jump cross-checks; illegal FSM transition | mark stream SUSPECT; stop applying past gap; gate scope | targeted ≫ domain ≫ full re-snapshot | I11; `02 §8` |
| Out-of-order delivery | per-event seq/ts vs cursor | FSM forward-only; absorb data, ignore regressive transition | reorder buffer where seq exists | I6; `02 §8.2` |
| Duplicate delivery (reconnect replay, WS+REST overlap) | dedup namespaces | no-op by design | — | I5; `02 §8.3` |
| listenKey / login expiry | expiry timer; auth probe failure; auth reject | `REAUTHING`; never discover via a real order | refresh on warm spare → swap | `02 §7.4` |
| Partial subscription | sub-ack accounting | `DEGRADED` (a channel you think is on but isn't = silent blindness) | retry channels; else recycle socket | `02 §9` T12 |
| Reconnect storm / thundering herd | breaker on attempts/window | full-jitter backoff; coalesce snapshots through shared limiter | circuit half-open probes | `02 §6.2, §14.2` |
| Stream↔REST mutual lag (both directions) | reconcile sees order on stream missing from REST or vice versa | not-found grace windows; adopt-don't-discard during sync | idempotent overlap absorption | `02 §4`; `03 §5.1` |
| Snapshot non-atomicity across endpoints | by design | per-domain fences; banded split tolerances | follow-up reconcile after LIVE | `02 §4`; `05 §4–5` |

### 3.3 Data integrity (money)

| Failure | Detection | Immediate response | Recovery | Protects / ref |
|---|---|---|---|---|
| Missed fill (often undetectable live on no-seq venues) | reconcile: venue cumFilled > local; balance delta w/o fill; position mismatch | gate scope sizing | `fetchUserTrades` backfill (idempotent) | I4, I5; `05 §2` |
| Double-applied fill | `seenTradeIds` | structurally prevented (no-op) | — | I5; `03 §7` |
| Fill correction / trade bust | venue restatement / bust notice | apply delta  as `FillCorrected`/`FillReversed` | recompute position/fees from ledger | `03 §7.2` |
| Orphan fill (fill before ack/bind) | coid unbound | buffer by coid; provisional order | apply on bind; reconcile confirms | `03 §7.2` |
| Phantom balance motion (no explaining event) | I1 check; reconcile diff | freeze scope | explain via trades/funding/fees history; else `BalanceCorrected` + page | I1; `05 §6` |
| Position size/sign mismatch | joint reconcile (exact size) | `DIVERGED`: halt symbol | hunt missing fill/funding/liq; venue wins via correction | I7, I8 |
| **Unknown position at venue** | reconcile finds position we can't explain | **HALT scope, always** — never auto-adopt directional risk | human classification; explicit adoption decision | I7; `05 §6` |
| **Liquidation / ADL** | liq/ADL event; unexplained margin drop; forced fills | **P0**: halt symbol/venue; **flatten or re-hedge sibling leg immediately**; page | reconcile; post-mortem margin model | `03 §8.5`; I17 |
| Funding missed settlement | funding FSM grace timeout; cumulative mismatch vs income history | scope `DEGRADED` | backfill from income history (idempotent on fundingTime) | `04 §6` |
| Funding sign/convention error | golden tests; cumulative PnL reconcile drift | freeze sizing on symbol family | fix adapter; backfill corrections | I15; `04 §6.1` |
| Fee-asset surprise / third-asset drain | per-fill `feeAsset` posting; min-balance alarm on fee assets | top-up alarm | model from fills, not schedule | `04 §4` |
| Precision/rounding drift | exact-integer internal math; dust-band reconcile | — (prevented) | conservative rounding direction; venue filters | `01 §9` |
| Cross-scope contamination | scope key on every event; unroutable ⇒ reject | loud reject | reconcile account topology | I18 |

### 3.4 Infrastructure

| Failure | Detection | Immediate response | Recovery | Protects / ref |
|---|---|---|---|---|
| Clock skew | continuous offset monitor vs each venue (alarm ~200 ms); `-1021`-class rejects | trading not enabled while clock alarm red; re-sample offset | chrony/NTP discipline; signing uses venue offset | §9; `02 §10.3` |
| Rate-limit exhaustion → 429 → **418 ban** | local buckets near cap; 429 responses | hard-gate bucket; shed places, never cancels (20% cancel floor) | backoff; 418 ⇒ venue HALTED; standby egress IP if available | `02 §14` |
| Venue maintenance (often asymmetric) | maintenance notices; error storms; health-vector asymmetry (cancels ok, places failing) | venue breaker ⇒ cancel-and-reduce-only | resume via half-open probe + mandatory full reconcile | §4; `02 §5.4` |
| Persist failure (disk full / fsync error) | write errors; fsync-latency + disk-space alarms | **halt all order submission immediately** (cancel-only) | restore storage; cold-start | `06 §6` |
| Process crash (any instant) | supervisor; missing clean-shutdown flag | — (crash-only design) | cold-start sequence; trading gated until reconciled | `06 §5` |
| Crash loop | >K restarts in window T | stop restarting; leave HALTED; page | human root-cause; supervised resume | `01 §3.5` |
| Split-brain (second instance) | data-dir advisory lock | second instance refuses to start | — (structural) | `06 §1` |
| coid counter rollback | boot check vs log max | **refuse to start trading** | rebuild counter = log max + gap | I9 |
| Event-loop blocking / GC stall | event-loop-lag + GC-pause metrics; in-thread watchdog stops heartbeating | orchestrator treats as hung ⇒ venue policy fires; restart worker | offload CPU work to workers; heap tuning | `01 §11`; `02 §12` |
| Unbounded buffer growth (storm) | bounded queues; saturation = DEGRADED | shed/degrade per backpressure policy | drain; resync | §1.3 |
| Endpoint decommission / DNS rot | connect failures to pinned endpoints | failover to alternate IPs/endpoints from config | update config (endpoints live in config, not code) | `02 §2` |

### 3.5 Capital

| Failure | Detection | Immediate response | Recovery | Protects / ref |
|---|---|---|---|---|
| Double-commit / double-spend | — (prevented by atomic single-writer gate) | — | — | I2; `04 §3.1` |
| Reservation leak / orphan | TTL reaper; Σreservations vs venue locked | reaper holds (never blind-release); alert | venue-confirmed terminality ⇒ release | I3; `04 §2` |
| Negative effective available | I2 continuous check | freeze new grants on scope | reconcile orders → reservations → balances | I2 |
| **Unhedged leg / leg imbalance** | constant-time fill-attribution fold; `Σ paired exposure ≠ 0` | top-priority signal; pre-decided unwind/re-hedge fires; freeze scope sizing | flatten/re-quote per policy; post-mortem | I17; `04 §3.3` |
| Unified-margin headroom collapse via sibling symbol | venue availability re-pulled after each leg; I16 sanity bound | account-scope (not symbol) classification; shrink sizing | reconcile margin state | `04 §5` |
| Transfer in flight lost/unknown | transfer FSM timeout | scope buffer widened; no double-count | poll transfer status; reconcile both cells | `04 §1` |

---

## 4. Circuit breakers

Breakers exist because retry loops against a broken dependency make outages worse (rate bans, queue blowups) and because *degraded* is a state to be managed, not powered through. Mechanics: **CLOSED → OPEN** on threshold breach; **OPEN → HALF_OPEN** after cool-down; **HALF_OPEN** sends probe traffic only; success → CLOSED, failure → OPEN with escalated cool-down (full-jitter). Three rules: (1) **trips have hysteresis** — trip fast, clear slow (N successes to close, 1 failure to re-open in HALF_OPEN); (2) **fail closed** — an OPEN breaker zeroes deployable for its scope; (3) **HALF_OPEN → CLOSED requires re-running the reconcile gate**, not just a successful probe.

Per-concern breakers, keyed per `(venue[, endpoint-class])`:

| Breaker | Trips on | Scope action |
|---|---|---|
| Staleness | freshness gate red past bound | deployable 0 (structural) |
| Divergence | correction magnitude > materiality; repeated medium drifts | scope halt per drift ladder (`05 §6`); human ack to clear |
| Connection | reconnects/window; pong failures | venue `RECONNECTING`/HALTED; backoff governs |
| Rate-limit | local bucket ≥ ~80%; any 429 | hard-gate bucket; shed places; cancel floor preserved |
| Reject storm | rejects/min per class (params, signature, margin) | stop placing on scope; alarm (param storms = our bug) |
| Order-rate anomaly | orders/sec beyond strategy envelope | freeze strategy (runaway-loop guard) |
| Pending-UNKNOWN | count of unresolved UNKNOWN > threshold | HARD halt scope — exposure unknown | 
| Ack-latency | place/cancel ack p99 over budget | route to fallback transport; size down (`02 §13`) |
| Drawdown / loss | realized+unrealized loss limits per scope/global | graded: size-down → halt → flatten (§6) |
| Reconnect storm (global) | Σ venues reconnecting ≥ K | global pause of new risk; coalesced resync |

A tripped venue degrades to **cancel-and-reduce-only** — never "fully off": you must always retain the ability to reduce risk. Breaker state changes are events (logged, alertable, persisted so a HALT survives restart, → `06 §2`).

---

## 5. Pre-trade gates & continuous protections

**Every order-send path evaluates `canEmit` immediately before the wire write** — cheap enough to be unconditional:

```ts
function canEmit(scope: ScopeKey, order: OrderDraft): boolean {
  return !Atomics.load(ctl, GLOBAL_KILL)                 // kill register, §7
      && !Atomics.load(ctl, venueKillIdx(scope.venue))
      && venueReg.tradeable(scope)                        // Connection LIVE (01 §3.3)
      && health(scope) === LIVE && reconcileFresh(scope)  // 05 §7 composition
      && invariantsClean(scope)
      && allocator.hasReservation(order.coid)             // reserve-before-send (04)
      && withinExposure(scope, order)                     // position/notional caps
      && priceSane(order)                                 // limit within X% of mark/top-of-book
      && qtySane(order)                                   // lot/tick/minNotional vs cached specs
      && rateToken(scope, order.kind)                     // 02 §14 buckets (cancel floor exempt)
      && !inFlightDup(order.coid);                        // no duplicate coid outstanding
}
```

Any false ⇒ no send, with a counted, classified gate-rejection metric (a gate that trips often is telling you something).

**Continuous protections (always-on, independent of strategy):** aggregate notional caps per scope and global; max concurrent open orders per scope; max order rate; **self-trade/wash prevention across your own subaccounts** (your two legs must not cross each other on the same venue book — check resting own-orders before send); PnL/drawdown monitors feeding the loss breaker; per-strategy capital allocation limits (a runaway strategy can only spend its own pool); an anomaly detector (order rate, reject rate, fill rate vs baseline) that can FREEZE a scope on weirdness without waiting for a specific named failure.

---

## 6. Hierarchical scope & graded actions

Halts have a **scope** and a **grade**; pick the smallest scope and lowest grade that contains the risk, escalate on evidence:

- **Scope ladder:** symbol → subaccount → venue → global.
- **Grade ladder:**

| Grade | Meaning |
|---|---|
| `SOFT_HALT` | no new risk-increasing orders; reduce/cancel allowed; auto-clear on green reconcile |
| `HARD_HALT` | cancel all open orders in scope; no new orders; human or explicit condition to clear |
| `FLATTEN` | cancel + actively close positions in scope (market/aggressive-limit per policy) |
| `FREEZE` | no orders of any kind — for suspected *systemic* misbehavior (possible duplicate-order bug) where even cancels might be wrong; requires connectivity-independent venue dead-man as backstop (§7.3) |
| `GLOBAL_KILL` | all venues: cancel everything, flatten per policy, stop all workers' send paths |

`FLATTEN` requires working connectivity — which is precisely what you may not have; hence the venue dead-man layer (§7.3). **Never auto-resume from `GLOBAL_KILL` or any human-triggered halt**; scoped auto-halts may auto-clear only via the full reconcile gate.

---

## 7. Kill switches — three independent layers

Design principles: **fail-closed** (the kill check is on the send path; if in doubt, the answer is "don't send"); **independent** (each layer works when the others are wedged); **cheap to trigger, deliberate to clear** (one atomic store to trip; supervised gate + reconcile to clear); **audited** (every trip/clear is an event with reason and actor); kill state **persists across restart**.

### 7.1 Layer 1 — in-process SAB control register

A `SharedArrayBuffer` register: `[GLOBAL_KILL, perVenueKill[15], perStrategyFreeze...]`, written by the orchestrator **and** by any venue worker (a worker that detects its own corruption can self-kill its venue), read via `Atomics.load` in every `canEmit` (§5). Properties: works even when message queues are backed up or the orchestrator's loop is busy — readers see the flag on their next instruction, no delivery required. Trip ⇒ each venue worker also fires its local policy (cancel-all for scope, etc.).

### 7.2 Layer 2 — independent watchdog OS process

A separate, tiny OS process (not a `worker_thread` — it must not share the trading process's event loop, heap, or fate): holds **pre-authenticated REST credentials** to every venue; consumes the trading process's heartbeat (file/socket/shared-mem); on heartbeat loss past threshold, operator command, or explicit poison-pill from the trading process: **REST cancel-all on every venue + reduce-only flatten per policy**, then alerts. It is deliberately boring: no strategy, no state model, hard-coded conservative actions. Test it weekly (chaos drill `SIGSTOP` the trading process and verify the watchdog fires, → `08 §3`).

### 7.3 Layer 3 — venue-side dead-man switches

The venue cancels for you when *you* go dark — the only layer that works when your host, network, or region is gone: **OKX** `cancel-all-after` (countdown reset on heartbeat), **Bybit** disconnect-cancel-all / DCP on supported products, **Binance futures** `countdownCancelAll`, **Deribit** best-in-class cancel-on-disconnect (re-verify availability and product coverage per venue at integration). Arm where supported with a conservative countdown (e.g., 10–30 s), re-armed by the same heartbeat cadence that proves the trading loop alive. Where unsupported, the watchdog (Layer 2) is the only external backstop — factor that into per-venue size limits.

### 7.4 Triggers (any of)

Manual operator action (one command, always available); position/notional limit breach; breaker cascade (≥K venue breakers open); reconcile divergence above materiality; heartbeat loss (per-worker or global); crash loop; clock-skew alarm; multi-venue simultaneous divergence (smells like our bug, not theirs); realized-loss limit; any *impossible* state (negative available, position without origin). Graduated by §6 — most triggers hit a scoped grade first; the global kill is for cascade or operator judgment. **Make halting cheap and frequent.**

---

## 8. Graceful shutdown (optimization, not requirement — §1.1)

```
1. Close intake: stop accepting new strategy intents (gate closed, deployable 0).
2. Drain in-flight: wait (bounded) for PENDING_*/UNKNOWN to resolve via acks/Resolver.
3. Per policy: cancel resting orders (and flatten if configured) per scope.
4. Flush WAL; write snapshot; write clean-shutdown flag; disarm venue dead-man timers last.
5. Stop workers in reverse dependency order; release locks; exit 0.
```

If any step exceeds its bound, fall through to crash-only semantics — the cold-start path (`06 §5`) is always correct.

## 9. Time discipline

- **Host:** chrony/NTP (PTP where offered) against venue-region servers; the skew alarm is a production breaker — trading does not enable while red.
- **Per-venue offset:** continuously measured vs each venue's `serverTime`; used for signing and recvWindow (→ `02 §10.3`); alarm at ~200 ms drift.
- **Ordering:** prefer venue sequence numbers / venue transaction-time for event ordering; never local arrival time (→ `02 §8.2`).
- **Durations/timeouts/latency:** monotonic clock only (`process.hrtime.bigint()`); wall clock is for venue-anchored instants (funding times, expiry, rate windows) — keep the two uses strictly separate.
