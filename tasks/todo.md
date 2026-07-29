# Hot-Path Perf Re-Architecture — Phase 0 + 1

## Phase 0 — Measurement groundwork
- [x] New `src/core/monitoring/hotPathCounters.ts` (inc/drain registry)
- [x] `performanceMonitor.ts`: drain counters into flush log, optional `label`, EL delay resolution 10→1

## Phase 1 — Allocation churn
- [x] 1a Remove tracing from hot path: binance/bybit/okx/bitget WS handlers, orchestrator orderbookUpdate handler, arbitrageEngine topOfBookUpdate listener, tradeMonitor topOfBookUpdate listener; traceId optional on OrderBookUpdate/TopOfBook; trace created at opportunity emission (scanOpportunities), opportunity.traceId stamped there (orchestrator `opportunities` handler unchanged)
- [x] 1b Shared `parseLevels` helper (single parseFloat per field, indexed loop) in all 4 adapters
- [x] 1c New `src/core/orderbook/bookMerge.ts` (applyDeltaInPlace binary-search, applySnapshotInPlace with sortedness self-heal + NaN guard); orderbookManager mutates stored book on both snapshot and delta paths
- [x] 1d Persistent TopOfBook per (exchange,symbol), fields mutated, emit gate preserved; consumer audit: tradeMonitor/tradeExecutor/fundingFeeCollector all copy scalars synchronously — no retained refs; "valid during emit tick" contract documented on the interface
- [x] 1e Engine scratch reuse: class-level legs array, 4 reusable DepthSimulationResult passed as `out`, FundingEvent.time (Date-per-event) dropped
- [x] Build + lint clean (only pre-existing errors remain: scripts/, orchestrator unused `startOpportunityTracker`)
- [x] Runtime verify + TEMP-VERIFY removed

## Review

**Offline harness** (scratchpad/verify-phase1.js, compiled dist): 28 checks green — directed merge edge cases (qty update in place, delete top/absent, insert front/mid/back/empty, asks asc/bids desc), 10,000-case fuzz equality vs legacy `processDeltaLevels`, snapshot-in-place identity, parseLevels equivalence (incl. OKX 4-element tuples), emit-gate semantics (first-update no emit, qty-only no emit, top-price emit, persistent object identity, re-broadcast emit), counters accumulate/drain.

**Live runs** (dev machine, `npm start`, live feeds, ~2 min steady state each):
- New code: 830k real deltas merged in place, 0 invariant violations (sortedness, crossed-book), 0 snapshot re-sorts, 0 errors. Counters in perf line: ob_updates ~8–9k/s, tob_emits ~1.2–1.4k/s.
- Baseline (HEAD worktree, same machine/config): eluPct 0.46–0.55, gcCount 53–78/10s, gcTotalPauseMs 80–121.
- New: eluPct 0.41–0.48, gcCount 23–29/10s typical, gcTotalPauseMs ~19–27 — GC count/pause down >55%, meets the −50% minor-GC target. elP99 2.1ms (baseline p99 not comparable: old resolution 10ms floors it); elMax similar-to-better.
- Baseline had no counters, so update rates not directly comparable; runs were minutes apart on the same markets.

**Self-review findings applied**: parseFloat kept over unary `+` (malformed input → NaN, not silent qty-0 delete); NaN guard in applyDeltaInPlace (NaN price could poison index 0); snapshot path self-heals unsorted sides (binary-search precondition no longer trusts feeds unguarded); locked-book (bid==ask) not treated as violation.

**Not mine**: `arbitrageEngine.ts` VANA/SATS skip-list additions were already uncommitted in the working tree before this task.

**Next**: Phase 2 ingest workers (spike vendor SDKs in worker_threads first). Production baseline (3× 10-min samples) still to be captured on prod before/after deploy.
