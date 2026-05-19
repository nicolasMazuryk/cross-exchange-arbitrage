# ArbiNet — Async-Only Strategy Filter Analysis

**Generated:** 2026-04-30
**Scope:** Counterfactual where the strategy admits ONLY `strategyVariant === "async"` trades.
**Sample:** 20 of 57 closed trades (period 2026-02-16 → 2026-03-02)

---

## 1. Headline Result

Filtering to async-only **does not, by itself, fix the strategy**.

| Metric | All trades (57) | Async only (20) |
|---|---|---|
| Total P&L | -$3.73 | **-$1.23** |
| Avg P&L / trade | -$0.065 | -$0.061 |
| Avg P&L % | -0.35% | **-0.30%** |
| Win rate | 47.4% | **50.0%** |
| Profit factor | 0.40 | **0.40** |
| Avg win | +$0.093 | +$0.081 |
| Avg loss | -$0.208 | -$0.204 |

Async trades have a **slightly better win rate (50% vs 47%)** but **identical profit factor (0.40)** — wins are still half the size of losses, so the system still destroys value. The total dollar loss is smaller mostly because the sample is smaller (20 vs 57), not because the per-trade economics are meaningfully different.

**Conclusion:** "Trade async only" is *not* a profitable filter on its own. But — async trades respond very strongly to a funding-rate threshold and a take-profit-only exit policy, and become decisively profitable when those are layered on (see §5).

---

## 2. P&L Decomposition — Async Only

| Component | Total | Per trade |
|---|---|---|
| Funding payments | **+$2.80** | +$0.140 |
| Delta (price movement) | **-$2.86** | -$0.143 |
| Fees | **-$1.16** | -$0.058 |
| Slippage | **+$0.73** | +$0.036 |
| **Net** | **-$1.23** | **-$0.061** |

The **same structural disease as the full sample**: funding is collected (+$2.80) but offset penny-for-penny by adverse spread movement (-$2.86), and fees finish the job. Spread widened against the position on **16 / 20 (80%)** of async trades. Average entry cross-exchange spread −0.67% → exit +1.40% (≈ +2.07% adverse move).

Notable async-specific quirk: slippage is **positive +$0.73** (vs +$0.26 across all 57). On a per-trade basis, async legs are catching favorable execution — not the leak.

---

## 3. Exit Reasons — Async Only

| Exit reason | n | Total P&L | Avg | Win rate | Avg hold |
|---|---|---|---|---|---|
| take-profit | 14 | **+$0.52** | +$0.037 | 50% | **18.5 min** |
| convergence | 5 | -$0.30 | -$0.060 | 60% | 191.0 min |
| spread-widening | 1 | **-$1.44** | -$1.44 | 0% | 3.8 min |

Async is *dominated* by take-profit exits (70% of trades vs 35% in the full sample) — this is structural: async trades have a longer projected horizon and the take-profit window is wider, so it usually fires before convergence.

**One trade (ATH/USDT, binance→okx) accounts for -$1.44** — the entire net loss of the async book. Without it, async P&L is **+$0.21** across 19 trades. Single-trade dominance means we should not over-interpret the rest of the numbers.

---

## 4. Exchange Pairs & Symbols (async)

### Pairs
| Pair | n | P&L | Win % |
|---|---|---|---|
| binance→bitget | 3 | **+$0.39** | 100% |
| bitget→okx | 2 | +$0.11 | 100% |
| bitget→bybit | 4 | -$0.01 | 50% |
| binance→bybit | 8 | -$0.26 | 38% |
| **binance→okx** | **3** | **-$1.46** | **0%** |

binance→okx in the async subset is **0% win, -$1.46** — entirely driven by ATH (-$1.44) plus two small losers. Async never produced a Bybit↔OKX trade.

### Symbols
Best async: POWER (+$0.20, 3), SKR (+$0.19, 1), RPL (+$0.13, 1), ESP (+$0.09, 4), DUSK (+$0.07, 2)
Worst async: **ATH (-$1.44, 1)**, STEEM (-$0.44, 6 — 17% win rate), BARD (-$0.06, 1)

STEEM is a **systematic underperformer in async** (1 win in 6) — strongest single-symbol case for blacklisting in this regime.

---

## 5. Filter Stacking on Async — This Is Where It Becomes Profitable

### Funding-rate threshold sweep (async only)
| Min fundingProfit% | n | P&L | Win % |
|---|---|---|---|
| ≥ 0.0% | 20 | -$1.23 | 50% |
| ≥ 0.2% | 17 | -$1.18 | 59% |
| ≥ 0.4% | 10 | -$1.03 | 80% |
| ≥ 0.6% | 7 | **+$0.38** | 86% |
| ≥ 0.8% | 5 | **+$0.59** | **100%** |
| ≥ 1.0% | 5 | +$0.59 | 100% |
| ≥ 1.2% | 3 | +$0.28 | 100% |

The 0.6% threshold flips the book positive on async; 0.8%+ produces **100% win rate** across 5 trades.

### Combined: async + funding ≥ X + take-profit-only
| Filter | n | P&L |
|---|---|---|
| async + take-profit (any funding) | 14 | +$0.52 |
| async + funding ≥ 0.4% + take-profit | **7** | **+$0.70** |
| async + funding ≥ 0.6% + take-profit | 6 | +$0.67 |
| async + funding ≥ 0.8% + take-profit | 5 | +$0.59 |

**Best in-sample combination: async + funding ≥ 0.4% + take-profit-only → +$0.70 over 7 trades**, vs +$0.80 over 6 trades for the all-variant equivalent at funding ≥ 1.0%. The async + 0.4% filter is **looser** (more trades) for nearly the same dollar P&L.

---

## 6. Hold Duration (async)

| Bucket | n | P&L | Win % |
|---|---|---|---|
| < 5 min | 7 | -$0.95 | 57% |
| 5–30 min | 6 | +$0.13 | 50% |
| 30–120 min | 2 | -$0.10 | 0% |
| > 120 min | 5 | -$0.30 | 60% |

The < 5-minute bucket is dominated by the ATH spread-widening loss (-$1.44, exited at 3.8 min). Excluding it: < 5 min → +$0.49, 67% win. The async "fast take-profit" archetype works when the trade does *not* explode immediately on entry.

---

## 7. Diagnosis

1. **Async is not directionally better than sync** at the 50/50 level — same profit factor (0.40), same broken hedge (spread widens 80% of the time), same dollar loss when fees are layered.
2. **Async amplifies the take-profit advantage**: 70% of async trades exit on take-profit vs 35% across all trades, and take-profit is the only positive exit type. Async naturally lives in the regime that works.
3. **Async is materially more sensitive to a funding-rate threshold**: at funding ≥ 0.4% the async win rate is 80% (vs 53% for the all-variant book at the same threshold). The async edge concentrates in higher-funding trades much earlier.
4. **One blowup (ATH, -$1.44) is the entire async loss.** A pre-trade cross-exchange spread cap (~2.0%) would likely have screened it out.
5. **STEEM is the only chronic async underperformer** (1W/5L, -$0.44). Six attempts is enough to take the signal seriously.

---

## 8. Recommendations (if going async-only)

Ranked by expected impact:

### R1 — Don't deploy "async only" as a standalone filter
In-sample dollar P&L is still negative (-$1.23) and profit factor identical to the full book. As a standalone change, this fails.

### R2 — Async + minFundingProfitPercent ≥ 0.6% (or ≥ 0.4% with take-profit-only)
- async + funding ≥ 0.6%: 7 trades, +$0.38, 86% win
- async + funding ≥ 0.4% + take-profit-only: 7 trades, +$0.70, ~85% win
This is the most attractive in-sample combo — meaningfully more frequent than the all-variant 1.0% filter (5–7 trades vs 11) for similar dollar P&L.

### R3 — Drop convergence exits in async mode (or widen the convergence threshold)
Convergence exits in async hold an average of **191 minutes** (3.2 h) — long enough for the cross-exchange spread to drift far from entry. Take-profit exits hold 18.5 min average and produce all the positive P&L. Either:
- Raise `convergenceThresholdPercent` from 0.01% to ~0.10% so convergence fires earlier, or
- Disable convergence entirely for async and rely on take-profit + spread-widening + a hard max-hold (e.g., 4 h).

### R4 — Cross-exchange spread cap at entry (~2.0%)
The ATH trade (-$1.44, 78% of async losses) entered with a wide pre-trade spread that promptly blew out. A rule-based maxCrossExchangeSpreadAtEntry filter would screen it without overfitting to symbol names.

### R5 — Blacklist STEEM in async mode
1 win in 6 attempts, -$0.44. Either blacklist or require funding ≥ 1.0% specifically for STEEM.

### R6 — Avoid binance→okx in async until investigated
0/3, -$1.46 (ATH-dominated but the 2 non-ATH trades were also negative). Sample is tiny but signal direction is consistent with the full-book finding (binance→okx is the worst pair overall).

---

## 9. Risks & Caveats

- **Sample size: 20 trades**. All thresholds derived here have *very* wide confidence intervals. The "100% win rate at funding ≥ 0.8%" is 5 trades — do not interpret as expectancy.
- **Single-trade dominance**: ATH alone accounts for the entire async net loss. The async book is not robustly bad; it is one tail event away from break-even.
- **Selection bias**: async trades were generated under a config that *also* admitted sync. The async opportunities surviving the live filter chain may not represent what an async-only strategy would actually trade — the engine might shift behavior if sync candidates were rejected.
- **Overfit risk on the 0.4% / 0.6% / 0.8% thresholds**: monotonic improvement in P&L as the threshold rises is encouraging, but each step throws away half the trades.
- The data covers ~2 weeks of async (last async trade 2026-03-02). Regime persistence beyond this window is unverified.

---

## 10. Suggested Next Steps

1. **Don't ship async-only as a single change.** It is approximately neutral, not positive.
2. **A/B it as `async + funding ≥ 0.4% + take-profit-only`** — that is the in-sample-best filter combo and the highest-conviction async-specific recommendation here.
3. **Add the cross-exchange entry-spread cap (~2.0%)** before re-deploying — it is rule-based and addresses the ATH-style tail loss without symbol-specific overfitting.
4. **Instrument `spreadAtEntryPercent` and `holdDurationMin`** on every trade so the next post-mortem can analyze convergence-vs-take-profit regime change directly.
5. **Validate on 30+ async live trades** before treating any threshold here as a final parameter. The 20-trade sample is the floor of statistical usefulness.

---

## Appendix: Headline Numbers

| | Value |
|---|---|
| Async trades | 20 |
| Net P&L | -$1.23 |
| Funding collected | +$2.80 |
| Delta loss | -$2.86 |
| Fees | -$1.16 |
| Slippage | +$0.73 |
| Win rate | 50% |
| Profit factor | 0.40 |
| Spread widened in | 16/20 (80%) |
| Best in-sample filter | async + funding ≥ 0.4% + take-profit → +$0.70, n=7 |
| Single largest loss | ATH binance→okx, -$1.44 (spread-widening) |
