# 08 — Observability, Testing & Venue Notes

**Scope:** observability for *correctness* (signals, SLOs, alerting), operational practices, the testing strategy (simulators, property tests, replay, chaos), the recommended build sequence, and the venue-specific notes appendix. Cross-references: metrics feed breakers → `07 §4`, drift ladder/discrepancy ledger → `05 §6`, replay determinism → `06 §4`, connection scoring → `02 §5.4`.

---

## 1. Observability for correctness

You cannot operate this system blind; most of these metrics exist to answer *"is the local view trustworthy right now, and how would I know if it weren't?"* Metrics are not passive — the key ones **feed breakers** directly.

**Core signals (per `(venue, subaccount)` unless noted):**

- **Freshness/staleness:** `now − lastEventAppliedAt`, `now − lastReconcileAt` (the gate inputs); time-in-state for the Connection/Health FSMs.
- **Stream health:** reconnects/hour, seq-gap count, duplicate-drop count, buffered-event high-water marks, pong RTT, liveness-probe failures.
- **Reconcile:** diff magnitude and frequency per field class; **discrepancy-ledger growth rate** (the single best early-warning metric); corrections by type; reconcile duration; reconcile-lag SLO (e.g., 99% of accounts reconciled within 2× cadence).
- **Orders:** ack latency p50/p99/p99.9 (place and cancel separately — feeds fallback hysteresis and ack-latency breaker); UNKNOWN count and oldest age; in-flight registry depth and oldest in-flight age; reject rate by taxonomy class; gate-rejection counts by gate.
- **Fills/positions:** orphan-fill buffer depth; fill-application latency; leg-imbalance count and magnitude; liq-distance minimum across book (alarm thresholds); funding FSM states overdue.
- **Capital:** reservation count/age; orphaned-reservation events; Σreservations-vs-venue-locked delta; effective-available vs confirmed gap; safety-buffer consumption.
- **Runtime:** event-loop lag per worker (first-class!), GC pause p99, WAL fsync latency, disk free, queue depths vs bounds, REST 429 rate and bucket utilization, SAB register write-to-read lag.
- **Invariant breaches: the count is ~0 or the system is wrong.** Every breach is an incident-grade event.

**Structured logging:** every log line keyed by `(venue, subaccount, coid)` where applicable; correlation/trace id per intent so an order's whole life — intent → reservation → send → acks → fills → settlement → reconcile touches — reads as one trace. The raw venue payload is in the event log (→ `06 §3`); logs reference `lsn`, never duplicate payloads.

**Alerting tiers map to the drift ladder (`05 §6`):** Soft ⇒ counted, dashboarded; Medium ⇒ alert channel; Hard / invariant breach / liquidation / kill trip ⇒ page. **Drift budget:** alert on *any* `*Corrected` event; page on frequency or magnitude beyond budget. Halt events and divergence counts are SLOs you report on, not just logs.

## 2. Operational practices

- **Boot gate:** no trading until the cold-start reconcile completes per account (`06 §5`) — enforced structurally, surfaced operationally (dashboard shows each account's gate state and why).
- **Replay drills:** periodically rebuild a shadow projection from the event log and diff against live in-memory state (hash compare); any difference is a projection bug found before it matters.
- **Latency vs correctness, separate clocks:** the *gating* path (allocator, canEmit, invariants) may block/synchronize — correctness path; the *quoting/pricing* path must never block on it — it reads the SAB register and lives with staleness measured in microseconds. Don't let dashboards conflate the two latency profiles.
- **Every incident reproducible:** from journal (+ pcap on the order path if captured), an incident replays deterministically into a test (→ §3); "everything that failed once is a test case forever."
- **Runbooks** for: supervised resume from HALTED, key rotation (warm-spare flip, `02 §10.4`), venue maintenance windows, watchdog-fired recovery, storage-full recovery.

## 3. Testing strategy

**Testnets prove protocol conformance only** — auth, message shapes, happy-path flows. They do not reproduce production matching behavior, latency, partial fills under load, or failure modes. Never extrapolate reliability from testnet behavior.

1. **Venue simulator per dialect:** a local WS+REST mock speaking each venue's message dialect with a configurable **cruelty list**: drop the Nth message, duplicate fills, reorder ack vs fill, delay acks past timeout, reject with each error code, send partial snapshots, desequence, expire listenKeys mid-burst, return not-found-then-found, partial batch success, async reject after ack. Every catalog row in `07 §3` has at least one simulator scenario.
2. **Property/fuzz tests (`fast-check`)** over event orderings: generate random interleavings of {acks, fills, cancels, rejects, snapshots, gaps, duplicates} and assert all `05 §8` invariants hold after every step, and that terminal states match a reference oracle. The only way to trust an FSM is to fuzz it.
3. **Golden-log replay determinism (CI):** replay recorded event logs (including production logs) from genesis and from snapshots; projection hashes must be byte-identical run-to-run and equal to the recorded live hash (→ `06 §4`).
4. **Record/replay real traffic:** capture raw venue payloads (already in the event log) and replay through new adapter/reducer versions before deploy — regression-proofs normalization changes.
5. **Crash tests at every interesting point:** kill -9 between intent-append and send; between send and ack; mid-fill-application; mid-reconcile; mid-snapshot — then run cold-start and assert convergence with the simulator's venue truth.
6. **Dedicated cancel/fill-race fixture** covering all four outcomes of `03 §4`, both event orders, both transports.
7. **Chaos injection (staging + scheduled prod drills at tiny size):** drop/dup/reorder streams, kill venue workers mid-burst, stale snapshots, clock skew injection, rate-limit exhaustion, `SIGSTOP` the trading process and **verify the watchdog and venue dead-man fire** (`07 §7`), disk-full on the WAL volume.
8. **Canary orders:** deep-out-of-book post-only orders on a cadence per venue verify the *whole* path (place→ack→stream→cancel→reconcile) in production without economic exposure.
9. **Shadow / read-only mode before capital:** run the full system live — streams, reconcile, projections, gates — with sends stubbed, for days; the discrepancy ledger should be near-silent before real orders flow.

## 4. Build sequence (dependency-ordered)

1. **Numbers + canonical model** — money types, scope keys, event vocabulary, zod schemas.
2. **One venue adapter end-to-end** (pick your highest-volume venue) — normalize, golden tests against recorded payloads.
3. **Actor + WAL** — single-writer engine, intent/event logs, snapshots, replay determinism in CI.
4. **Bootstrap/connection FSM** — the `02 §4` sync + `02 §9` lifecycle against the simulator's cruelty list.
5. **Order FSM + Resolver** — transition tables, UNKNOWN handling, crash tests.
6. **Reservations + allocator** — atomic gate, multi-leg, reaper.
7. **Reconciliation + invariants + drift ladder** — then the gate composition (deployable).
8. **Shadow mode → canaries → tiny size → ramp**, venue by venue behind capability flags. Breakers/kill layers ship **before** the first real order (they're steps 3–7 artifacts, not afterthoughts).

**Closing principle: the account-state layer *is* the risk system.** Strategy code should be unable to lose money faster than this layer can notice and stop it.

---

## 5. Venue notes appendix

> **Re-verify every item at integration time against current venue documentation** — endpoints, channel names, limits, and semantics churn. These notes are retained verbatim from source material as integration starting points, not current truth.

### Binance
- **Separate streams per product**: spot user-data vs USDⓈ-M futures vs COIN-M are distinct endpoints with distinct `listenKey`s; an account spanning spot+futures needs multiple private streams (and the WS order-entry endpoints are separate again, → `02 §2`).
- Spot user-data events: `executionReport` (orders/fills), `outboundAccountPosition` (balances). Futures: `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`. Field vocabularies differ — separate adapter mappings.
- Event time `E` vs transaction time `T` can differ; order by `T` where present (matching-engine time).
- **No usable global sequence on user-data streams** ⇒ periodic REST reconcile is your gap detector (→ `02 §8.1`); tighten cadence.
- listenKey: keepalive PUT ~every 30 min, expiry ~60 min; revoked listenKey ⇒ silent stream death — pair with liveness probes (→ `02 §5.1`).
- Weight-based IP limits + per-account unfilled-order counts; order-count headers (`X-MBX-ORDER-COUNT-*`) are ground truth (→ `02 §14.1`). 429→418 auto-ban escalation.
- Timestamp tightening and percent-encode-then-sign (`-1022`) changes per `02 §10`.

### Bybit (v5 / UTA)
- **Unified Trading Account: one collateral pool across spot/derivatives** — balance semantics depend on account mode; reservation logic must be margin-aware, not per-asset arithmetic (→ `04 §5`).
- Private WS: signed auth frame on connect; subscribe topics `order`, `execution`, `position`, `wallet`. Heartbeat `{"op":"ping"}` ~20 s (→ `02 §7.3`).
- WS trade channel acks ≠ order status — status comes from the private order stream (`ACKED_UNCONFIRMED` applies, → `03 §2.1`).
- Rate-limit usage echoed in `X-Bapi-Limit-Status` headers — feed buckets ground truth.

### OKX (v5)
- Private WS requires `login` op (signed); logins expire — re-auth handling per `02 §6.4`.
- **`balance_and_position` combined channel exists precisely because joint atomic snapshots matter — use it** (→ `03 §8.6`).
- Heartbeat: literal string `ping`/`pong` text frame; server disconnects after ~30 s idle (→ `02 §7.3`).
- **Account modes** (Simple / Single-currency margin / Multi-currency margin / Portfolio margin) change balance/margin semantics drastically — the adapter must know the configured mode (→ `01 §10`).
- Batch ops up to 20, per-item `sCode` — never all-or-nothing (→ `02 §11`). `cancel-all-after` dead-man supported (→ `07 §7.3`).

### Bitget
- v2 private WS: signed login, ping/pong keepalive; channels for orders, fills, positions, account. Newer ecosystem — test reject semantics and eventual-consistency windows extra carefully; keep its sizing limits tighter until proven.

### Cross-cutting hazards (every venue)
- **No usable private-stream sequence numbers** on several venues ⇒ REST reconcile *is* the gap detector; cadence is a correctness parameter, not a tuning nicety.
- **REST snapshot lags the stream** (and vice versa) — both directions of eventual consistency exist on every venue (→ `02 §4`, `03 §5.1`).
- **Weight/limit budgets** must be planned for reconcile load, not just orders — a 15-venue × multi-subaccount reconcile sweep is a real budget line (→ `02 §14.2`).
- **Clock skew** breaks signed requests venue-by-venue (different tolerances); per-venue offset tracking is mandatory (→ `07 §9`).
- **Duplicate delivery on reconnect is normal** everywhere — dedup is not optional (→ `02 §8.3`).
