# ARBINET — Trader UI / Visualization Spec

## Context

ARBINET ingests 1 Hz orderbook snapshots from >15 exchanges × ~1500 symbols into ClickHouse (warm path) while the hot path runs spread detection and execution. The trader UI must turn that warm-path data into informed entry/exit decisions and let a human distinguish *real* quality arbitrage opportunities from noise (one-tick flashes, low liquidity, stale orderbooks etc) that can't be captured.

This document specifies, from the trader's perspective:
1. What data must be visualized.
2. What data must be tracked/watched in real-time.
3. How the data should be filtered, scored, and arranged on screen so the operator can make decisions in seconds — not minutes.

---

## 1. Mental model — what a trader needs to see

A profitable arb decision answers six questions in order:

1. **Is the opportunity real right now?** (current spread, both sides priced, books not stale)
2. **Has it persisted long enough to capture?** (≥ N seconds across ≥ M snapshots)
3. **What does this pair normally look like?** (median spread, distribution, anomaly check)
4. **How does the spread typically decay?** (half-life: short flash vs. minutes-long)

## 2. Top-level layout

A multiple-zone single-screen workspace (think Bloomberg / TradingView hybrid):

- A. Search (by marketType, exchange and symbol for both legs). Ability to search and view the chart for any historical arbitrage 2-leg pair. Prefferably reuse TradingView UI elements, if possible.
- B. Top-50 real-time opportunities watchlist (sidebar, similar to TradingView watchlists) for all strategies: spot-spot, spot-perp, perp-perp.
- C. TradingView Chart displaying real-time and historical spread on the selected in Search or in Top-50 opportunities arbitrage pair. Spread is based on bid/ask of both legs as if we were entering the trade. Ability to display multiple spreads on the same chart at the same time.
- D. Selected Pair Spread Stats: 
    - Distribution / regime stats for focused pair
    - median spread (p50), max spread high (p95), min spread low (p95)
    - half-life, frequency
    - current z-score, historical median z-score
    - cointegration - does spread historically always converged? How long it takes to converge 50%, and 100%? If spread doesn't converge for long-time (days) - we need to flag it and do not enter the trade. It is a risky opportunity.
    - orderbook updates latency for each leg (how much time it takes to travel from exchange to our system)
    - Orderbooks depth of two legs (both bid/ask on both legs). Show liquidity and depth in orderbooks

UX rules:
- Click any row in A/B → C/D/E rebind to that pair.
- Refresh budget: B/C/D/E every 1 s;.
- Time selectors: 1 s / 3 s / 5 s / 15 s / 1 m (TradingView convention).

## 3. Panel A — Search

Search (by marketType, exchange and symbol for both legs). Ability to search and view the chart for any historical arbitrage 2-leg pair. Prefferably reuse TradingView UI elements, if possible.


## 3. Panel B — Top-50 Opportunities (live watchlist)

**Purpose:** the only place a trader looks to find the next trade. Replaces scrolling logs.

**Columns (sortable, all live):**

| Column | Source field | Why |
|---|---|---|
| Pair | `normalizedPair` | identity |
| Buy@ / Sell@ | `buyExchange` / `sellExchange` | route |
| Markets | `buyMarketType` / `sellMarketType` (SPOT, LINEAR, INVERSE) | leg type matters for cost & funding |
| Costs % | `costsPercent` | total costs |
| Funding leg | `fundingProfitPercent`, sign and direction arrow | strategy classifier |
| Spread % | `spreadProfitPercent` | raw signal |
| Net % | `estimatedProfitPercent` | the only number that matters |
| Net $ | `estimatedProfitUsd` (for `orderAmountUsd`) | absolute |
| Persistence | live counter: `now − firstDetectedAt` ms + `min(consecutiveSnapshots)` | quality gate |
| Half-life | rolling estimate from snapshots table | will it survive entry latency? |
| Depth @ size | slippage % from `DepthSimulationResult` at `orderAmountUsd` | capacity |
| Confidence | `confidenceScore` (0–1) | engine's own verdict |
| Age | `now − orderbookUpdateTimestamp` per leg | staleness alarm |
| Anomaly z | z-score of current spread vs. trailing 1 h median | flash detector |

**Visual treatment:**
- Row tint: green if `Net % > minProfitThreshold AND persistenceMs ≥ minPersistenceMs AND confidence ≥ 0.7`. Otherwise neutral.
- Strikethrough row: any leg's `orderbookAge > maxOrderbookAge` (currently 2000 ms).

**Filters (panel B, side-rail):**
- Strategy: funding | spread
- Leg types: spot-spot | spot-perp | perp-perp
- Min `Net %`, min `Net $`, min confidence, min persistence ms, max depth slippage at size, exclude pair denylist, exchanges include/exclude.
- "Hide flashes": auto-suppresses rows whose half-life < user-set seconds (default 3 s).


---

## 4. Panel C — Spread chart (the killer feature)

**Purpose:** TradingView-style historical + real-time chart so the trader sees *behavior*, not just the current value.

**Performance target:** 50 simultaneous spread series, 1 s tick, 24 h scroll-back without jank.

**Recommended stack:**
- **TradingView Lightweight Charts** (canvas, WebGL-free, ~45 KB, 1 ms repaint for thousands of points). Backend feeds via WebSocket fanout from Redpanda.
- Alternative if Lightweight Charts can't render 50 panels: **uPlot** (faster but plainer)

**Series & overlays on the focused pair's chart:**

1. **Primary line — Net spread %** (`estimatedProfitPercent`). The decision line.
2. **Secondary line — Raw cross-leg spread %** (`spreadProfitPercent`), thinner.
5. **Funding event vertical markers** at `nextFundingTimestamp` for both legs; tooltip shows `buyExchangeFundingRate`, `sellExchangeFundingRate`, `netFundingRate`.
6. **Trade entry/exit markers** (▲ entry, ▼ exit) drawn from `TrackedTrade.entryTimestamp` / `exitTimestamp`. Hover → PnL bubble (`pnlUsd`, `pnlPercent`, `exitReason`).
7. **Persistence-validated shading**: any candle where the spread held above the threshold for ≥ `minPersistenceMs` over ≥ `minConsecutiveSnapshots` is tinted green. Visual answer to "could we have captured it?"
8. **Statistical bands**: median, p25/p75, and ±2σ of spread over selected lookback. So the eye sees *anomaly vs. regular*.
9. **Half-life annotation**: hover any spike → tooltip showing "lasted 47 s, decayed to 50% in 12 s".


---

## 5. Panel D — Decision and Stats panel (per-pair drill-down)

**Purpose:** everything you need to pull the trigger, in one place. Opens when a row is "armed".

### D1. Cost & profit breakdown (waterfall)
- Gross spread % → trading fees % → slippage % → funding contribution % → **Net %**. Bars in dollars and percent. Sourced from `OpportunityScore` (`spreadProfitPercent`, `tradingFeesPercent`, `fundingProfitPercent`, `costsPercent`, `estimatedProfitPercent`).

### D2. Depth ladder (both legs side-by-side)
- L2 bids/asks from `OrderBook.bids/asks` with cumulative size column.
- Highlight the level the engine would walk to fill `orderAmountUsd`.
- Show `avgExecutionPrice`, `slippagePercent`, `hasError` from `DepthSimulationResult` at three sizes: 0.5×, 1×, 2× of `orderAmountUsd`. So the trader sees capacity and what happens if they upsize.

### D3. Confidence radar (or 4-bar mini)
Four spokes — freshness (40%), spread quality (35%), exchange health (25%), persistence — matching the engine's weighting. Numerical `confidenceScore` in the center. Tells the trader *why* the engine likes/dislikes this.

### D4. Funding timeline (only when `strategy = funding`)
Mini horizontal timeline of `FundingProjection.timeline`:
- Each `FundingEvent` plotted with `netFundingRate` as a vertical bar.
- Vertical "now" cursor + "next funding in 00:14:23" countdown.

### D5. Entry checklist (auto-validated, all must be green)
- [ ] Persistence ≥ `minPersistenceMs` AND snapshots ≥ `minConsecutiveSnapshots`.
- [ ] Both books fresh (age < `maxOrderbookAge`).
- [ ] `Net %` ≥ minimum (`minTotalProfitPercent` or spread-strategy equivalent).
- [ ] Depth simulation `hasError = false` at size.
- [ ] Anomaly z-score < threshold (not in a flash spike).
- [ ] Available balance ≥ size on both legs (from `BalanceInfo.available`).


---

## 6. Panel E — Distribution / regime stats (the "is this normal?" panel)

**Purpose:** turn one number into a distribution so the trader can spot anomalies and pick targets.

**Components for the focused pair (over selectable lookback):**

1. **Spread histogram** — count of 1 s snapshots per spread bucket. Vertical line at current spread. Immediate visual answer to "is this big?".
3. **Persistence histogram (half-life)** — for spreads above each threshold (0.2%, 0.4%, 0.6%, 0.8%, 1.0%), show distribution of how long they lasted. The single most important chart for separating flashes from capturable opportunities.
4. **Frequency** — events per hour exceeding each threshold over last 24 h / 7 d. Tells the trader if it's a one-off or a regular flow.
5. **Convergence curve** — average normalized decay shape: starting at t=0 when spread crosses threshold, plot mean spread over the next 60 s. Shows if spreads converge fast (chase doomed) or slowly (capturable).
6. **Summary tiles**: mean, median, p90, p99, σ, current-vs-median ratio, anomaly z, count today vs. trailing 7 d avg.

These analytics run server-side as ClickHouse materialized views / rollups so the UI just renders.



# PHASE 2


---

## 7. Panel F — Open positions strip

Live list of `TrackedTrade` rows where `status = open`:
- Pair · legs · entry timestamp · age · entry spread % · current spread % · unrealized PnL $ / % · funding accrued · distance to TP target · distance to stop ·


## 8. Panel G — Recent fills & exit attribution

Last 50 closed `TrackedTrade`s:
- Entry/exit timestamps, strategy, gross delta, funding net, fees, slippage, **PnL $**, **PnL %**, `exitReason`.
- Group-by selector: by exchange pair, by `exitReason`, by strategy. Surfaces which routes/setups actually pay.
- Click row → opens Panel C historical chart positioned at entry timestamp with entry/exit markers visible (replay mode default).


## 9. Capital and Inventory

- **Capital per exchange** Breakdown off all assest on all exchages and market types (spot, perp-linear, perp-inverse).
- **Total Capital** across all exchanges.
- **Open exposure** $, %, and `maxPositionAmountUsd` cap. Bar that turns red near limit. Per exchange, per strategy and total.
- **Available Capital** $, %. Per exchange, per strategy and total.

- **Historical and Today's Daily PnL** (realized + unrealized), # trades, win rate. Per strategy.

- **Exchange health pills** per exchange: WS connected, last orderbook age, REST/WS latency, error rate last 5 m. Click → drills into per-exchange detail.
- **Kill switch**: pause all new entries; existing positions continue monitoring. Big, red, two-click confirmation.


## 10. Alerts / push notifications

Trader can't watch the screen 24/7. Configurable alert rules → desktop notification + optional Slack/Telegram:


# PHASE 3

## 11. Backtesting

Replay from the cold path (Parquet/S3). Trader specifies:
- Strategy
- Entry rule (`min Net %`, persistence, confidence, depth at size)
- Exit rule (TP %, convergence %, widening %, max hold, window)
- Date range, exchange/pair filters

Output:
- Equity curve, drawdown, # trades, win rate, avg hold, PnL distribution histogram, exit-reason pie, per-pair P&L table, per-exchange-route P&L heatmap.



---

## 13. Tech recommendations (UI implementation)

- **Charts**: TradingView Lightweight Charts as primary; uPlot fallback for high-density panels (heatmap, histogram).
- **Data transport to UI**: WebSocket fanout fed by Redpanda topic; one channel per focused pair plus a multiplexed channel for the Top-50 table.
- **State**: Zustand; do not re-render per tick — coalesce to one repaint per RAF.
- **Table**: TanStack Table (virtualized) for the Top-50 to stay smooth at 1 Hz × 50 rows × ~15 columns.
- **Backend query API**: thin layer over ClickHouse using materialized views for histogram, half-life, frequency, spread statistics, regime bands, etc. UI never runs heavy aggregates on raw `ob.snapshots`.

---


## 14. Critical fields to persist in ClickHouse for these views

Minimum required (per snapshot, 1 Hz):
- timestamp, exchange, symbol, market_type, best_bid, best_ask, mid, microprice, top-N (10) bid/ask levels (price, size), update_id, sequence gap flag.

Per opportunity (event-time, when detected/refreshed):
- All `ArbitrageOpportunity` + `OpportunityScore` fields, `confidenceScore`, both candidates' persistence counters, depth simulation result at standard sizes.

Per trade (event-time):
- Full `TrackedTrade` including order legs, fee breakdown, slippage, funding accrual, `exitReason`.

Derived rollups (materialized views, refreshed minutely):
- Per-pair-per-route: spread quantiles, half-life by threshold, anomaly threshold (rolling 1 h median + MAD).

---