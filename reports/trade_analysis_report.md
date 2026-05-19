# ArbiNet Funding Arbitrage — Post-Mortem Analysis
**Generated:** 2026-04-30  
**Trades analyzed:** 57 (all closed)  
**Period:** February – March 2026

---

## 1. Strategy Understanding

### Core thesis
ArbiNet enters a delta-neutral hedged position: long on the "buy exchange" where the funding rate is high and short on the "sell exchange" where the funding rate is low (or negative). The goal is to receive net funding payments at the next settlement event while the position's net directional exposure cancels. Entry requires the projected funding differential — after all fees and estimated slippage — to exceed `minFundingProfitPercent` (0.20% in production).

### Two entry modes (variants)
| Variant | Condition | Entry window | Projected holding |
|---------|-----------|-------------|-------------------|
| **SYNC** | Both exchanges settle at identical timestamps | 60 s → 5 s before next funding | ~1 funding event (~1 h) |
| **ASYNC** | Exchanges settle at different times | Same window, but counts events only until next sync point | 1 – multiple events |

### Entry filter chain (order matters)
1. Orderbook age ≤ 2 000 ms and confidence score ≥ 0.70 (freshness 40%, spread quality 35%, health 25%)
2. Cross-exchange spread < 10% anomaly guard
3. Order amount tolerance 60%–140% of $20 target
4. **Temporal persistence**: opportunity must persist for ≥ 1 000 ms with ≥ 3 consecutive snapshots per exchange
5. **Strategy window**: 60 s → 5 s before next funding
6. **Profit validation**: `fundingDiff% - costs% ≥ 0.20%` AND `estimatedProfit% ≥ 0.00%`

### Exit modes (all conditional on being after `targetFundingTimestamp`)
| Exit type | Window | Condition |
|-----------|--------|-----------|
| **Convergence** | 120 s → 5 s before *next* funding event | Current funding diff < 0.01% |
| **Take-profit** | 30 s after *previous* funding → 30 s before *next* funding | `(entrySpread - currentSpread) + fundingProjected - fees > 0.20%` |
| **Spread-widening** | Either window | Current spread > entrySpread + 5.0% |
| **Timeout** | Any | Hold time > 365 days (effectively disabled) |

### Fee structure (round-trip, taker-only)
| Exchange pair | Round-trip fees |
|--------------|----------------|
| Binance + OKX | 0.20% |
| Binance + Bybit / Binance + Bitget | 0.30% |
| Bybit + Bitget / OKX + Bitget | 0.30–0.40% |
| Bitget + Bybit | **0.40%** (highest) |

### Leverage
4× on all positions. Trade sizes are small (~$20 notional), so absolute dollar P&L is modest but percentage P&L is meaningful for risk assessment.

---

## 2. Diagnosis — What the Data Reveals

### 2.1 Summary statistics (57 closed trades)

| Metric | Value |
|--------|-------|
| Total P&L | **-$3.73** |
| Win rate | **47.4%** (27 wins / 30 losses) |
| Average win | +$0.093 |
| Average loss | -$0.208 |
| Win/Loss ratio | 0.45 |
| Profit factor | **0.40** (< 1 = system destroys value) |
| Average P&L per trade | -$0.065 |
| Average P&L % | **-0.35%** |

### 2.2 P&L decomposition (57 trades)

| Component | Total USD | Avg per trade | Avg % per trade |
|-----------|-----------|--------------|-----------------|
| Funding payments received | **+$8.64** | +$0.152 | **+0.75%** |
| Delta (price movement) P&L | **-$9.04** | -$0.159 | **-0.80%** |
| Fees paid | **-$3.33** | -$0.058 | **-0.30%** |
| Slippage | +$0.26 | +$0.005 | +0.03% |
| **Net P&L** | **-$3.73** | -$0.065 | **-0.35%** |

**Core finding: The strategy successfully collects funding (+$8.64) but loses more on directional price movement (-$9.04). Fees (-$3.33) then eliminate any residual. The hedge is not working.**

### 2.3 Exit reason breakdown

| Exit reason | Count | Total P&L | Avg P&L | Win rate |
|-------------|-------|-----------|---------|----------|
| Take-profit | 20 | +$1.39 | +$0.069 | 65% |
| Convergence | 34 | -$2.38 | -$0.070 | 41% |
| Spread-widening | 3 | -$2.74 | -$0.915 | 0% |

Convergence exits account for 60% of all trades and 64% of total losses. Spread-widening exits are rare (3) but catastrophic, accounting for 73% of total dollar losses alone.

### 2.4 The hedge is broken: spread divergence, not convergence

The theoretical premise is that a high-funding-rate spread will converge toward zero as the funding payment occurs and attracting arbitrageurs closes the gap. The data shows the opposite:

| Metric | Value |
|--------|-------|
| Average entry spread | +0.944% |
| Average exit spread | +1.735% |
| Average spread movement | **+0.791% (widening)** |
| % of trades where spread WIDENED | **77.2% (44 of 57)** |

Only 22.8% of trades saw the spread narrow between entry and exit. The model's assumption of convergence is empirically false for this dataset.

Average net delta per trade: **-0.80%** — meaning the buy leg (long) lost more than the sell leg (short) gained, in percentage terms. The strategy is systematically long a spread that widens against it.

### 2.5 Exchange pair performance

| Exchange pair (buy→sell) | Count | Total P&L | Win rate | Notes |
|--------------------------|-------|-----------|----------|-------|
| Binance → OKX | 12 | **-$2.09** | 42% | Worst pair by total loss |
| Bitget → Bybit | 11 | **-$1.37** | 36% | Highest fees (0.40%), worst win rate |
| Binance → Bybit | 16 | -$0.47 | 38% | Largest trade count |
| OKX → Bybit | 6 | -$0.24 | 33% | |
| Bybit → OKX | 2 | -$0.02 | 50% | |
| **Bitget → OKX** | 5 | +$0.007 | **80%** | Break-even, good win rate |
| **OKX → Bitget** | 2 | +$0.07 | **100%** | |
| **Binance → Bitget** | 3 | **+$0.39** | **100%** | Best pair |

Binance → Bitget (3 trades, 100% win, avg +$0.131): All async, all take-profit exits, all held < 2 minutes. These trades share a structural difference — the spread was slightly negative at entry (buy price slightly above sell price), meaning funding alone was the only source of profit, and exits were fast before the spread could widen.

### 2.6 Symbol performance

Worst offenders (chronic spread wideners):
| Symbol | Trades | Total P&L | Avg spread widening |
|--------|--------|-----------|---------------------|
| SOPH/USDT:USDT | 3 | **-$1.72** | +3.29% |
| ATH/USDT:USDT | 3 | **-$1.33** | +2.45% |
| ORCA/USDT:USDT | 1 | -$0.34 | +2.03% |
| ENSO/USDT:USDT | 5 | -$0.29 | +1.14% |
| BARD/USDT:USDT | 5 | -$0.49 | +0.83% |

Best performers (spread either stable or narrows):
| Symbol | Trades | Total P&L | Avg spread movement |
|--------|--------|-----------|---------------------|
| ESP/USDT:USDT | 6 | +$0.57 | -0.17% (narrows) |
| JTO/USDT:USDT | 2 | +$0.33 | -0.28% (narrows) |
| SAHARA/USDT:USDT | 2 | +$0.18 | -0.09% (narrows) |

The losing symbols share a pattern: low-liquidity, high-spread assets where the bid-ask spread across exchanges is structurally wide and volatile, not a true arbitrage opportunity.

### 2.7 Hold duration analysis

| Duration | Count | Total P&L | Avg P&L | Win rate |
|----------|-------|-----------|---------|----------|
| < 5 min | 12 | -$0.10 | -$0.008 | 75% |
| 5–30 min | 7 | -$0.25 | -$0.036 | 43% |
| **30–120 min** | 32 | **-$3.10** | **-$0.097** | **34%** |
| > 120 min | 6 | -$0.28 | -$0.046 | 67% |

The 30–120 minute window (one full funding cycle held to convergence exit) is the worst bucket with only 34% win rate. Short-duration trades (< 5 min, mostly take-profit) perform best with 75% win rate.

### 2.8 Entry timing

Trades entered < 20 seconds before the funding event: 3 trades, total **-$1.49** (100% loss rate). These entered too late — the position barely exists through the funding event and gets caught on the wrong side of post-settlement spread movement.

### 2.9 Funding capture effectiveness

The funding service is working correctly: actual funding captured was 113% of projected (funding rates slightly increased after entry in many cases). The problem is entirely on the delta/spread side, not the funding measurement.

### 2.10 Inverse direction hypothesis

If every trade had been taken in the opposite direction (short the high-rate exchange, long the low-rate exchange), total P&L would have been **-$2.92** versus the current **-$3.73** — slightly less bad, but still negative. The inverse is not the solution. The problem is structural (spread divergence + fees) not directional.

---

## 3. Ranked Recommendations

### Recommendation 1: Raise `minFundingProfitPercent` to 1.0% (currently 0.20%)

**Evidence:**
| Funding threshold | Eligible trades | Total P&L | Win rate |
|-------------------|----------------|-----------|----------|
| ≥ 0.2% (current) | 54 | -$3.69 | 50% |
| ≥ 0.3% | 49 | -$3.61 | 51% |
| ≥ 0.6% | 35 | -$2.27 | 49% |
| ≥ 0.8% | 21 | -$0.39 | 52% |
| **≥ 1.0%** | **11** | **+$0.49** | **64%** |

At a 1.0% funding threshold, the strategy turns profitable. The current 0.20% threshold is far too low — it admits trades where the funding premium is not large enough to absorb the chronic spread divergence of ~0.79% plus the fee hurdle of ~0.30–0.40%.

**Estimated impact:** Filter reduces trade count by ~81% but converts total P&L from -$3.73 to +$0.49 over the same sample period.

**Implementation:** Change `minFundingProfitPercent: 0.20` → `1.00` in `funding.production.yaml`.

**Overfitting risk:** Moderate. The 1.0% threshold was derived from a sample of 57 trades across ~6 weeks. The true optimal may shift as market conditions change. Validate on the next 4 weeks before committing to this as the permanent threshold.

---

### Recommendation 2: Ban convergence exits entirely — use take-profit only (or raise convergence hold period)

**Evidence:**

| Exit type | Count | Total P&L | Avg P&L | Win rate |
|-----------|-------|-----------|---------|----------|
| Take-profit | 20 | +$1.39 | +$0.069 | 65% |
| Convergence | 34 | -$2.38 | -$0.070 | 41% |

Convergence exits assume the spread will narrow before the next funding event. In 27 of 34 cases (79%), the spread WIDENED during the convergence-exit holding period. The convergence exit logic is being triggered by the *funding rate* dropping below 0.01% — which is a correct signal that the funding edge is gone — but exiting at that point is often done at a *worse* spread than entry.

The take-profit mechanism exits as soon as the accumulated P&L target is met, which means it exits into favorable spreads when they occur and doesn't wait for the spread to deteriorate.

**Implementation:**
- Increase `convergenceThresholdPercent: 0.01` to a higher value (e.g., 0.05% or 0.10%) to reduce premature convergence triggers; OR
- Increase `takeProfitTargetPercent: 0.20` threshold sensitivity by lowering to 0.10% so take-profit fires earlier, before spread widening sets in.
- Set `exitWindowStartTakeProfitStopLoss` to fire sooner after funding settlement (e.g., 5 seconds after previous funding rather than 30 seconds).

**Estimated impact:** If convergence exits had been replaced by take-profit (using the 6 trades with fund ≥ 1.0% that would pass Rec. 1 and exit take-profit): 100% win rate, +$0.80 total P&L.

**Overfitting risk:** Low. The data consistently shows take-profit outperforms convergence across all sub-groups analyzed.

---

### Recommendation 3: Blacklist chronic spread-divergence symbols

**Evidence:** Five symbols account for disproportionate losses through systematic and persistent spread widening:

| Symbol | Trades | P&L | Avg spread widening per trade |
|--------|--------|-----|-------------------------------|
| SOPH/USDT:USDT | 3 | -$1.72 | +3.29% |
| ATH/USDT:USDT | 3 | -$1.33 | +2.45% |
| ORCA/USDT:USDT | 1 | -$0.34 | +2.03% |
| ENSO/USDT:USDT | 5 | -$0.29 | +1.14% |
| BARD/USDT:USDT | 5 | -$0.49 | +0.83% |

These five symbols account for **-$4.17 USD** — more than the total portfolio loss. The remaining 40 trades on other symbols actually sum to **+$0.44 USD** positive P&L.

The pattern: these are low-liquidity altcoins where the cross-exchange bid-ask spread is architecturally wide (structural illiquidity premium) rather than a temporary funding-driven divergence. The spread widens because one exchange's market maker repositions aggressively after funding, and the strategy is left holding a position through that repositioning.

**Implementation:** Add to `blacklistPairs` in `funding.production.yaml`:
```
SOPH/USDT:USDT, ATH/USDT:USDT, ORCA/USDT:USDT, ENSO/USDT:USDT, BARD/USDT:USDT
```
Or add a dynamic filter: reject any symbol where the average cross-exchange bid-ask spread exceeds 1.5% at entry (current `maxMarketSpreadPercent: 0.3` applies to intra-exchange spread only; extend this logic to cross-exchange spread).

**Estimated impact:** Removing these 17 trades from the sample improves total P&L by +$4.17 on those specific trades. Combined with Rec. 1 (funding ≥ 1%), total P&L on remaining eligible trades = +$0.69.

**Overfitting risk:** Moderate. Explicitly blacklisting symbols that happened to lose is textbook data-snooping. The better approach is the cross-exchange spread filter (which is rule-based, not symbol-specific): reject entries where cross-exchange spread > X% at entry.

---

### Recommendation 4: Restrict active exchange pairs to Binance→Bitget and OKX→Bitget; deprioritize Binance→OKX and Bitget→Bybit

**Evidence:**

| Pair | Trades | P&L | Fees |
|------|--------|-----|------|
| Binance → Bitget | 3 | +$0.39 | 0.30% |
| OKX → Bitget | 2 | +$0.07 | 0.30% |
| **Bitget → Bybit** | **11** | **-$1.37** | **0.40%** |
| **Binance → OKX** | **12** | **-$2.09** | **0.20%** |

Binance → OKX has the lowest fees (0.20% round-trip) but the worst total loss (-$2.09), primarily because SOPH and ATH are traded on this pair. Bitget → Bybit has the highest fee (0.40% round-trip) and the second-worst total loss.

The Binance → Bitget success is not primarily about fees. It is about the symbols involved (RPL, SKR, STEEM) and the nature of the trades: small spreads at entry (often slightly negative), high funding rates (>1%), and very short hold times (<2 min). These are fundamentally different from the 1-hour convergence trades that dominate the losses.

**Implementation:** Increase `maxMarketSpreadPercent` and fee floor requirements for high-fee pairs, or deprioritize Bitget/Bybit pair selection.

**Overfitting risk:** High for the exchange-pair-specific version. Apply the rule-based filters (Recs 1, 2, 3) first — those may be sufficient to exclude the bad trades organically.

---

### Recommendation 5: Add a maximum entry cross-exchange spread filter

**Evidence:** The worst trades all entered with large cross-exchange spreads (3–4%) that then widened further to 5–8%. The only trades where spread was positive and profitable were ones where the spread was already near its local maximum and happened to be stable.

Looking at the data:
- Entry spread ≥ 2.0%: 10 trades, total P&L = +$0.13, win rate 70%
- Entry spread ≥ 2.0% AND funding ≥ 0.5%: same 10 trades

BUT the SOPH, ATH, ENSO spread-widening disasters also entered with large spreads and had larger losses. So large spread entry alone is not sufficient.

More useful is a **maximum allowable cross-exchange spread at entry** (e.g., reject if current spread > 3.0%) combined with the 1% funding threshold. The catastrophic trades entered with spreads of 3.2% (ENSO spread-widening), 0.8% that then went to 5.7% (SOPH), and −0.16% that went to 6.9% (ATH). These are not mean-reverting spreads; they are one-directional moves in illiquid markets.

**Implementation:** Add `maxCrossExchangeSpreadAtEntryPercent: 2.5` parameter to arbitrage config and enforce it in `checkDirection()`.

**Estimated impact:** Would have filtered the three spread-widening trades (total -$2.74), improving P&L by +$2.74. But identifying this requires post-hoc analysis; the parameter needs to be validated prospectively.

**Overfitting risk:** Moderate. The specific 2.5% number is data-derived. Use 2.0% to be conservative.

---

### Recommendation 6: Reduce order size to $10 for the first 100 trades after any config change

**Rationale:** The current $20 order size with 4× leverage means each trade controls ~$80 in futures notional. Given the spread-widening risk on illiquid tokens (SOPH moved 5% against, costing $0.92 on a $20 position), the dollar risk per trade is asymmetrically large compared to the expected funding profit of ~$0.15. A $10 order size would reduce maximum loss per trade to ~$0.46 while keeping a meaningful live signal.

**Implementation:** `orderAmountUsd: 10` in trading config during validation period.

---

## 4. Risks of Each Recommendation

| Rec | Main Risk | Mitigation |
|-----|-----------|------------|
| 1: Fund ≥ 1.0% | Opportunities become too rare; capital sits idle | Monitor opportunity rate; can walk threshold down from 1.0% to 0.7% if frequency drops below 1 trade/week |
| 2: No convergence exits | Positions held too long if take-profit never fires | Add a tighter max hold time (e.g., 6 hours) as backstop; or reduce takeProfitTargetPercent from 0.20% to 0.10% to fire sooner |
| 3: Blacklist symbols | Good opportunities on those symbols permanently excluded | Use cross-exchange spread filter (rule-based) instead of symbol blacklist |
| 4: Restrict exchange pairs | Miss opportunities on Bybit/OKX | Apply selectively via per-pair confidence weighting rather than hard exclusion |
| 5: Max spread filter | May reject some profitable large-spread trades | Set threshold based on 95th percentile of profitable entry spreads, not maximum observed loss |
| 6: Reduce size | Lower absolute profit even when strategy works | Re-scale after 50+ profitable trades confirm the filters work |

**General overfitting risk:** 57 trades is a small sample. Any threshold derived from this data (especially 1.0% funding) has wide confidence intervals. Treat all thresholds as starting hypotheses, not final parameters. The goal is to validate on 30+ live trades before treating them as settled.

---

## 5. Suggested Next Steps Before Redeploying Capital

### Immediate (before next deployment)
1. **Apply Recommendation 3** (blacklist SOPH, ATH, ORCA, ENSO, BARD) — this is the highest-confidence recommendation because it targets structurally broken symbols, not parameter tuning.
2. **Apply Recommendation 1** — raise `minFundingProfitPercent` to 1.0%. This is also high-confidence based on the monotonic improvement in P&L as the threshold increases.
3. **Reduce order size to $10** during validation.

### First 2 weeks after redeployment
4. Monitor the **entry rate**: if opportunities with 1.0%+ funding occur less than once per day, the strategy is effectively off. In that case, validate at 0.7% threshold and re-examine.
5. Track **spread behavior per trade**: instrument the average spread change during the hold period. If the spread continues widening on ≥ 60% of trades even with the new filters, this is a structural market problem that no parameter change will fix.
6. Log which **exchange pairs** are providing the 1.0%+ opportunities. If they are concentrated on Bitget→Bybit (0.40% fees), the fee structure eats the premium.

### After 50 trades
7. Re-run this analysis with the new trade sample to validate that:
   - Win rate has improved to ≥ 60%
   - Average spread at exit is ≤ average spread at entry
   - Funding capture rate remains ≥ 100% (it is currently fine)
8. If profitable, **scale order size back to $20** and evaluate leverage reduction from 4× to 2× for risk management.

### Deeper investigation (parallel to live trading)
9. **Investigate WHY the spread widens**: is it a systematic post-funding settlement behavior on certain exchanges, or is it attributable to specific market makers withdrawing liquidity? If the former, there may be a timing-based entry adjustment (enter earlier in the window, not at T-60s but at T-180s to avoid the pre-settlement spread compression that reverses after funding).
10. **Validate the ASYNC mode separately**: async trades have a 50% win rate vs 46% for sync, but the sample is small. Async is theoretically riskier (holding through multiple non-simultaneous funding events) but the funding amounts can be larger. Test with explicit per-variant tracking.
11. **Consider adding the `maxCrossExchangeSpreadAtEntryPercent` filter** once 20+ trades have accumulated under the new regime, to determine whether large-spread entries are systematically worse.

---

## Appendix: Key Numbers Summary

| Metric | Value |
|--------|-------|
| Total P&L (all 57 trades) | -$3.73 |
| Funding collected | +$8.64 |
| Delta losses | -$9.04 |
| Fees paid | -$3.33 |
| % of trades where spread widened | 77% |
| Avg spread widening per trade | +0.79% |
| Best exchange pair | Binance → Bitget (+$0.39, 100% win, 3 trades) |
| Worst exchange pair | Binance → OKX (-$2.09, 42% win, 12 trades) |
| Worst 5 symbols combined P&L | -$4.17 |
| Remaining 40 trades P&L (excl. worst 5 symbols) | +$0.44 |
| P&L at fund ≥ 1.0% filter | +$0.49 (11 trades, 64% win rate) |
| P&L at fund ≥ 1.0% + take-profit only | +$0.80 (6 trades, 100% win rate) |
