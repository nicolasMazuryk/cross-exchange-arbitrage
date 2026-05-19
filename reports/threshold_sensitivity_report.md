# Threshold Sensitivity Analysis

**Total trades in dataset:** 57  |  **Base P&L (no filter):** $-3.7307

---

## Analysis 1 — `minFundingProfitPercent` Sweep (0.20% → 2.00%)

> Each row shows results for trades where the **estimated funding profit at entry** ≥ threshold.
> Trades below the threshold would have been **filtered out** (not taken).
> The dataset's maximum `fundingProfitPercent` is 1.3984%, so thresholds ≥ 1.4% yield 0 trades.

| Threshold | Trades | Excluded | Win Rate | Total P&L | Avg Win | Avg Loss | Profit Factor | Funding P&L | Delta P&L | Fees Paid |
|-----------|--------|----------|----------|-----------|---------|----------|---------------|-------------|-----------|-----------|
| ≥ 0.2% | 54 | 3 | 50% (27W/27L) | **$-3.6858** | $+0.0926 | $-0.2291 | 0.40 | $+8.5576 | $-9.0318 | $3.2116 |
| ≥ 0.3% | 49 | 8 | 51% (25W/24L) | **$-3.6054** | $+0.0955 | $-0.2498 | 0.40 | $+8.1850 | $-8.8676 | $2.9229 |
| ≥ 0.4% | 47 | 10 | 53% (25W/22L) | **$-3.5342** | $+0.0955 | $-0.2692 | 0.40 | $+7.9681 | $-8.7201 | $2.7823 |
| ≥ 0.5% | 44 | 13 | 52% (23W/21L) | **$-3.3654** | $+0.1019 | $-0.2718 | 0.41 | $+7.6863 | $-8.4298 | $2.6220 |
| ≥ 0.6% | 35 | 22 | 49% (17W/18L) | **$-2.2726** | $+0.0995 | $-0.2202 | 0.43 | $+6.6404 | $-6.7410 | $2.1720 |
| ≥ 0.7% | 28 | 29 | 50% (14W/14L) | **$-2.0064** | $+0.0921 | $-0.2354 | 0.39 | $+5.7603 | $-6.0120 | $1.7546 |
| ≥ 0.8% | 21 | 36 | 52% (11W/10L) | **$-0.3922** | $+0.1010 | $-0.1503 | 0.74 | $+4.3912 | $-3.4295 | $1.3539 |
| ≥ 0.9% | 15 | 42 | 53% (8W/7L) | **$-0.0109** | $+0.1227 | $-0.1418 | 0.99 | $+3.3895 | $-2.4445 | $0.9558 |
| ≥ 1.0% | 11 | 46 | 64% (7W/4L) | **$+0.4875** | $+0.1377 | $-0.1192 | 2.02 | $+2.6783 | $-1.5144 | $0.6765 |
| ≥ 1.1% | 7 | 50 | 86% (6W/1L) | **$+0.3827** | $+0.1268 | $-0.3782 | 2.01 | $+1.6847 | $-0.8417 | $0.4603 |
| ≥ 1.2% | 4 | 53 | 100% (4W/0L) | **$+0.4446** | $+0.1111 | — | ∞ | $+1.0345 | $-0.3317 | $0.2582 |
| ≥ 1.3% | 3 | 54 | 100% (3W/0L) | **$+0.3763** | $+0.1254 | — | ∞ | $+0.7915 | $-0.2172 | $0.1980 |
| ≥ 1.4% – 2.0% | 0 | 57 | — | — | — | — | — | — | — | — |

### Key observations

- **Breakeven at ≥ 1.0%**: P&L first turns positive at `1.0%` (11 trades, 64% win rate, **$+0.4875**)
- **Best profit factor at ≥ 1.2%–1.3%**: 100% win rate on 4 and 3 trades respectively — but with n<5 these are statistically meaningless
- **No trades exist above 1.3984%**: the current market regime does not produce higher funding differentials in this sample
- **Incremental P&L change per step (effect of raising threshold by 0.1%):**

  | From → To | Trades Removed | Removed Trade P&L | Running Total P&L |
  |-----------|----------------|-------------------|-------------------|
  | 0.2% → 0.3% | 5 removed | $-0.0804 | **$-3.6054** |
  | 0.3% → 0.4% | 2 removed | $-0.0712 | **$-3.5342** |
  | 0.4% → 0.5% | 3 removed | $-0.1688 | **$-3.3654** |
  | 0.5% → 0.6% | 9 removed | $-1.0928 | **$-2.2726** |
  | 0.6% → 0.7% | 7 removed | $-0.2662 | **$-2.0064** |
  | 0.7% → 0.8% | 7 removed | $-1.6142 | **$-0.3922** |
  | 0.8% → 0.9% | 6 removed | $-0.3813 | **$-0.0109** |
  | 0.9% → 1.0% | 4 removed | $-0.4983 | **$+0.4875** |
  | 1.0% → 1.1% | 4 removed | $+0.1048 | **$+0.3827** |
  | 1.1% → 1.2% | 3 removed | $-0.0619 | **$+0.4446** |
  | 1.2% → 1.3% | 1 removed | $+0.0683 | **$+0.3763** |
  | 1.3% → 1.4% | 3 removed | $+0.3763 | **$0 (no trades)** |

### Avg entry characteristics among filtered-in trades

| Threshold | Trades | Avg Funding% at Entry | Avg EstProfit% at Entry |
|-----------|--------|----------------------|------------------------|
| ≥ 0.2% | 54 | 0.7345% | 1.3359% |
| ≥ 0.3% | 49 | 0.7858% | 1.3971% |
| ≥ 0.4% | 47 | 0.8044% | 1.4159% |
| ≥ 0.5% | 44 | 0.8280% | 1.4709% |
| ≥ 0.6% | 35 | 0.9023% | 1.5188% |
| ≥ 0.7% | 28 | 0.9688% | 1.5680% |
| ≥ 0.8% | 21 | 1.0394% | 1.6614% |
| ≥ 0.9% | 15 | 1.1157% | 1.8851% |
| ≥ 1.0% | 11 | 1.1761% | 2.2456% |
| ≥ 1.1% | 7 | 1.2497% | 2.1943% |
| ≥ 1.2% | 4 | 1.3168% | 2.6372% |
| ≥ 1.3% | 3 | 1.3534% | 3.3051% |

---

## Analysis 2 — `minTotalProfitPercent` Sweep (0.00% → 1.00%)

> Each row shows results for trades where the **estimated total profit at entry** ≥ threshold.
> `estimatedProfitPercent = fundingProfitPercent − costsPercent` (funding minus fees + spread cost).
> This is the net estimated edge at the time of entry.

| Threshold | Trades | Excluded | Win Rate | Total P&L | Avg Win | Avg Loss | Profit Factor | Funding P&L | Delta P&L | Fees Paid |
|-----------|--------|----------|----------|-----------|---------|----------|---------------|-------------|-----------|-----------|
| ≥ 0.0% | 57 | 0 | 47% (27W/30L) | **$-3.7307** | $+0.0926 | $-0.2077 | 0.40 | $+8.6356 | $-9.0413 | $3.3250 |
| ≥ 0.1% | 51 | 6 | 47% (24W/27L) | **$-2.3325** | $+0.0996 | $-0.1749 | 0.51 | $+7.8758 | $-7.2404 | $2.9679 |
| ≥ 0.2% | 47 | 10 | 51% (24W/23L) | **$-2.0801** | $+0.0996 | $-0.1943 | 0.53 | $+7.4469 | $-6.7839 | $2.7432 |
| ≥ 0.3% | 46 | 11 | 50% (23W/23L) | **$-2.2087** | $+0.0983 | $-0.1943 | 0.51 | $+7.2297 | $-6.7554 | $2.6830 |
| ≥ 0.4% | 44 | 13 | 52% (23W/21L) | **$-2.1514** | $+0.0983 | $-0.2101 | 0.51 | $+7.0649 | $-6.6394 | $2.5769 |
| ≥ 0.5% | 43 | 14 | 53% (23W/20L) | **$-2.1260** | $+0.0983 | $-0.2194 | 0.52 | $+7.0247 | $-6.6334 | $2.5173 |
| ≥ 0.6% | 41 | 16 | 56% (23W/18L) | **$-1.9454** | $+0.0983 | $-0.2337 | 0.54 | $+6.7107 | $-6.2771 | $2.3790 |
| ≥ 0.7% | 37 | 20 | 54% (20W/17L) | **$-2.0641** | $+0.0967 | $-0.2351 | 0.48 | $+5.9432 | $-5.8871 | $2.1202 |
| ≥ 0.8% | 32 | 25 | 50% (16W/16L) | **$-1.9258** | $+0.1108 | $-0.2312 | 0.48 | $+5.4792 | $-5.5336 | $1.8714 |
| ≥ 0.9% | 31 | 26 | 52% (16W/15L) | **$-1.6366** | $+0.1108 | $-0.2273 | 0.52 | $+5.0452 | $-4.8693 | $1.8126 |
| ≥ 1.0% | 29 | 28 | 55% (16W/13L) | **$-1.5525** | $+0.1108 | $-0.2558 | 0.53 | $+4.7916 | $-4.6521 | $1.6920 |

### Key observations

- **Incremental P&L change per step (effect of raising threshold by 0.1%):**

  | From → To | Trades Removed | Removed Trade P&L | Running Total P&L |
  |-----------|----------------|-------------------|-------------------|
  | 0.0% → 0.1% | 6 trade(s) removed | $-1.3981 | **$-2.3325** |
  | 0.1% → 0.2% | 4 trade(s) removed | $-0.2524 | **$-2.0801** |
  | 0.2% → 0.3% | 1 trade(s) removed | $+0.1286 | **$-2.2087** |
  | 0.3% → 0.4% | 2 trade(s) removed | $-0.0573 | **$-2.1514** |
  | 0.4% → 0.5% | 1 trade(s) removed | $-0.0254 | **$-2.1260** |
  | 0.5% → 0.6% | 2 trade(s) removed | $-0.1806 | **$-1.9454** |
  | 0.6% → 0.7% | 4 trade(s) removed | $+0.1187 | **$-2.0641** |
  | 0.7% → 0.8% | 5 trade(s) removed | $-0.1382 | **$-1.9258** |
  | 0.8% → 0.9% | 1 trade(s) removed | $-0.2892 | **$-1.6366** |
  | 0.9% → 1.0% | 2 trade(s) removed | $-0.0841 | **$-1.5525** |

### Avg entry characteristics among filtered-in trades

| Threshold | Avg Funding% at Entry | Avg EstProfit% at Entry | Avg Order Size |
|-----------|----------------------|------------------------|----------------|
| ≥ 0.0% | 0.7042% | 1.2826% | $19.65 |
| ≥ 0.1% | 0.7120% | 1.4270% | $19.61 |
| ≥ 0.2% | 0.7325% | 1.5346% | $19.72 |
| ≥ 0.3% | 0.7236% | 1.5615% | $19.71 |
| ≥ 0.4% | 0.7453% | 1.6164% | $19.85 |
| ≥ 0.5% | 0.7581% | 1.6431% | $19.84 |
| ≥ 0.6% | 0.7565% | 1.6964% | $19.83 |
| ≥ 0.7% | 0.7344% | 1.8098% | $19.81 |
| ≥ 0.8% | 0.7883% | 1.9733% | $20.08 |
| ≥ 0.9% | 0.7890% | 2.0086% | $20.08 |
| ≥ 1.0% | 0.7990% | 2.0825% | $20.08 |

---

## Comparative Summary

| Filter | Threshold | Trades | Win Rate | Total P&L | Profit Factor |
|--------|-----------|--------|----------|-----------|---------------|
| None (baseline) | — | 57 | 47% | $-3.7307 | 0.40 |
| minFundingProfitPercent | ≥ 1.0% | 11 | 64% | **$+0.4875** | 2.02 |
| minFundingProfitPercent | ≥ 1.1% | 7 | 86% | **$+0.3827** | 2.01 |
| minFundingProfitPercent | ≥ 1.2% | 4 | 100% | **$+0.4446** | ∞ |
| minFundingProfitPercent | ≥ 1.3% | 3 | 100% | **$+0.3763** | ∞ |

> **Note on sample size:** The entire dataset contains only 57 trades. Results at high
> thresholds (≤15 trades) have very wide confidence intervals and should be treated
> as directional signals, not reliable estimates. Do not over-optimize on this sample.

---

*Generated from 57 live trades in `redis-dump/`. Analysis date: 2026-04-30.*