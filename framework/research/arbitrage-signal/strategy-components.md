
===================

## Pair/venue screening process:
- A repeatable filter (volume, spread stability, listing age) rather than hand-picked symbols, so the universe refreshes as markets change.

## Data quality & synchronization:
- Cross-venue timestamp alignment — arbitrage signals are differences, so unsynchronized data fabricates fake edge.

## Signal Definition
- Precise mathematical definition: The exact formula for the spread/funding signal, which fees are netted in, and annualization conventions.
- Exact spread/basis formula
- Named variables
- Developer specification

## Entry Logic
- Trigger conditions: Threshold net of all costs plus a margin of safety, in bps. Adaptive, dynamic thretholds.
- Entry throttles: Max entries per interval, cooldowns after fills or rejects, blackout windows (funding timestamps, exchange maintenance, major news).

## Exit Logic
- Profit-taking conditions: Spread convergence target, funding flip, or time-based decay of expected edge.
- Stop conditions: Spread divergence limit, max holding time, margin utilization ceiling.
- Forced-exit scenarios: Delisting announcements, funding regime change, venue degradation — exits that override the normal logic.

## Cost Model (the strategy lives or dies here)
- Explicit costs: taker fees per venue and tier, funding paid/received, withdrawal/network fees.
- Implicit costs: Slippage model (depth-dependent, not fixed bps), spread crossing.
- Capital costs: Opportunity cost of inventory parked on venues.
- Cost validation loop: Realized vs. modeled costs tracked per trade in production, with the model recalibrated on live fills.
- Spread paid on entry/exit if crossing
- A single "all-in cost per round trip" number, per route
- Transfer costs: network fees, withdrawal fees, chain congestion scenarios


## Position Sizing & Capital Allocation
- Per-trade sizing: Function of book depth (e.g., % of top-N levels), expected edge size, and current inventory.
- Position sizing per signal: fixed, depth-proportional, Kelly-fraction, edge-proportional
- Per-pair / per-venue caps: Concentration limits independent of signal strength.
- Portfolio-level allocation: Capital split across venues, buffer capital for margin calls and rebalancing, and how idle capital is treated in return calculations.
- Leverage policy: Target and maximum leverage per leg, with liquidation distance as the binding constraint, not margin requirement.

## Risk Management
- Market risk: Net delta limits, basis blowout scenarios (spreads widening 10x before converging), correlation breaks during volatility spikes.
- Liquidation risk: Distance-to-liquidation monitoring per leg, auto-deleveraging (ADL) exposure, margin top-up automation, isolated vs. cross margin choice.
- Funding risk: Funding rate flipping against you, predicted vs. realized funding divergence, clustering of funding payments.
- Kill switches: Automated halt conditions (loss limits, anomaly detection, data staleness) and a manual flatten-everything procedure tested in advance.
- Drawdown policy: Daily/weekly loss limits
- Concentration limits across correlated spreads
- Kill-switch conditions: global and per-strategy circuit breakers
- symbol delistings
- Fat-finger / runaway-algo protections (max order rate, max notional per minute)
- Cross-strategy interaction: If you run multiple strategies on the same venue, prevent them from trading against each other.
- Leg risk management: abort logic if leg 2 fails

## Failure Modes & Reliability, Risk Management, de-risking, kill-switches and re-enable protocol, success criteria
- de-risking (reduce size, halts entries, or flattens the book)
- kill-switches
3. **Failure-mode catalog & automated controls** — An enumerated catalog of the ways each strategy loses money or capital outside the model, each entry specified as: mechanism → detection metric + threshold → automated response → residual risk. Detection must be machine-checkable; responses must be pre-committed, not discretionary.
4. **Drawdown governance & success criteria** — Loss limits at the trade, day, strategy, and book level; the de-risking ladder between limits; kill-switch conditions and the re-enable protocol; and the monitoring criteria that define whether the strategy is performing to model (realized vs. modeled win rate, holding time, slippage, and cost) with statistical tests and review cadence.

## Entry Rules Research
## Exit Rules Research

## Signal, Entry, Exit - Detailed specs (variables, formulas, ets)
## Position Sizing & Capital Allocation - Detailed specs (variables, formulas, ets)

## Finate State Machines
- ...

## Inventory & Capital Logistics (crypto-specific)
- Rebalancing policy: When inventory skews (buy venue drains quote currency, sell venue accumulates base), the triggers, routes, and costs of rebalancing.
- Transfer model: Withdrawal processing times per venue, network confirmation times, congestion scenarios, fee spikes — and the inventory you must hold to avoid transferring during a trade.
- Idle inventory cost (opportunity cost)

## Accounting
- Bookkeeping: cost basis tracking across venues and chains

## Market Universe
- dynamic update (listings/delistings, existing markets changes)

## Funding Rates 
- periodically pull funding rates info

----------------------

## Persistance & Restart recovery
## Crash recovery & persistence
## Cold Start
- Save application state & recover from shutting down
- statistics model recovery

## Visualisation UI 
- website
- spread history

## Configuration
- hot config reload

## API Rate Limits

## Testing & Verification Framework and Architecture
- integration, end-to-end, etc
- Testing: Exchange mock-simulation, chaos testing.



## Infrastructure & Engineering
- Logging & replayability: Every decision logged with the inputs that produced it, sufficient to replay any trade.
- Logging and audit trail for every decision and order
- Testing: Exchange mock-simulation, chaos testing.

## Monitoring & Live Operations
- Real-time dashboards: Net exposure, margin health, inventory skew, realized vs. expected spread capture, funding accrual.
- Trade-level attribution: Every trade's PnL decomposed into spread capture, funding, fees, slippage — so degradation is diagnosable, not just visible.
- Real-time dashboards: spreads, positions, funding accruals, margin ratios, transfer statuses

## Performance Evaluation & Success Criteria
- Metrics: Net Sharpe/Sortino, return on allocated capital (including idle buffers), max drawdown, average edge captured per trade in bps
- Net bps per trade, PnL per unit of leg risk
- Sharpe/Sortino, max drawdown, drawdown duration
- Return on deployed capital vs return on total capital 

## Strategy Lifecycle & Decay
- Recalibration policy: What gets re-fit, how often, and what counts as a "new strategy" requiring full re-validation vs. a parameter refresh.
- Post-mortem culture: Every loss limit hit and every operational incident produces a written analysis and a spec change.



