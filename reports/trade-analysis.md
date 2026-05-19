# Funding Arbitrage Strategy Analysis & Profitability Optimization

## Context

This repository contains an **algorithmic trading strategy** designed to profit from differences in **funding rates and spreads** of the same symbols across different exchanges — an **inter-exchange funding arbitrage strategy**.

The strategy has been running **live with real money** using the configuration in `config/funding.production.yaml`, and **all executed trades have been tracked and stored** in `./redis-dump/`.

**The problem:** The current configuration has been **unprofitable** — total results are in the loss.

---

## Your Task

Act as an **experienced quantitative algorithmic trader** and conduct a deep, multi-angle analysis to identify concrete changes that would make this strategy profitable.

---

## Phase 1 — Understand the Strategy (do this first, thoroughly)

Before proposing anything, build a complete mental model of the system. Analyze the codebase, documentation, and especially `config/funding.production.yaml`. Specifically explain:

1. **The strategy** — what edge is it theoretically capturing?
2. **How it works** — the underlying market mechanics (funding rates, cross-exchange spreads, convergence assumptions).
3. **How it executes** — entry logic, exit logic, position sizing, hedging legs, order routing, exchange pairs.
4. **How it makes profits** — where P&L is supposed to come from (funding payments, spread mean-reversion, both?).
5. **What the risks are** — funding flips, basis blowouts, execution slippage, fees, correlation breakdowns.

Walk through every meaningful parameter in `config/funding.production.yaml` and explain what it controls and how it shapes behavior.

**Do not move to Phase 2 until you have a complete and accurate understanding of the strategy.**

---

## Phase 2 — Analyze the Live Trade History

Load and analyze every trade from `./redis-dump/`. Treat this as a forensic post-mortem of a real, losing book. Produce:

### Quantitative breakdown
- Total P&L, win rate, average win vs average loss, profit factor, Sharpe-like metrics.
- P&L decomposition: how much came from **funding payments** vs **spread movement** vs **fees** vs **slippage**?
- Distribution of trade outcomes — are losses concentrated in a few catastrophic trades, or is the edge simply absent?
- Per-symbol, per-exchange-pair, per-time-of-day, per-holding-duration performance.
- Behavior at entry vs exit: did spreads/funding actually converge as the strategy assumed, or did they diverge?

### Pattern discovery
- **Which trades worked, which didn't, and why?** Look for systematic patterns, not anecdotes.
- Is the bleed coming from funding/spread/fees costs exceeding the captured edge?

---

## Phase 3 — Generate Hypotheses to Restore Profitability

Think like a trader who has just inherited a losing book and has to fix it. Consider angles such as:

1. **Invert the thesis.** The strategy bets on convergence of spreads and funding rates. **What if the data shows divergence is the dominant regime?** Quantify what P&L would have been if every trade had been taken in the **opposite direction**. If the inverted strategy is profitable, that's a major signal.

2. **Parameter regime.** Are entry thresholds too tight/loose?
   
3. **Selection filtering.** Are there symbols, exchange pairs, or market/funding/spread regimes where the strategy *does* work? Could it become profitable simply by trading a filtered subset?

4. **Anything else the data suggests.** Be open — let the trades tell you what edge actually exists in this market structure, even if it's not what the original strategy was designed to capture.

For each hypothesis: **back it with numbers from the actual trade history.** Show what the P&L would have looked like under the proposed change (counterfactual / what-if analysis), not just intuition.

---

## Deliverable

A structured report containing:

1. **Diagnosis** — what the trade data reveals about *why* it's losing, with supporting numbers.
2. **Ranked recommendations** — concrete, actionable changes (parameter values, logic changes, direction inversion, filters, etc.), each justified with quantitative evidence from the historical trades and an estimate of the expected P&L impact.
3. **Risks of each proposed change** — including overfitting risk, since you are reasoning from a single historical sample.
4. **Suggested next steps** — what to validate, paper-trade, or A/B test before redeploying capital.

Be rigorous, quantitative, and skeptical. Don't accept the original thesis at face value — let the data dictate the conclusion.