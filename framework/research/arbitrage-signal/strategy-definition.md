# Crypto Arbitrage Strategy Definitions

## SPOT-SPOT: Cross-Exchange Spot Arbitrage

### Variant 1: Buy → Transfer → Sell

- **What to trade:** Same spot asset (e.g., ETH/USDT) priced differently on two exchanges. Buy on the cheap venue, withdraw, deposit on the expensive venue, sell.
- **Entry:** When the buyExchangeAsk - sellExchangeBid > total round-trip costs + hedge costs.
- **Exit:** Sell immediately upon deposit confirmation on the destination venue; the trade is complete once inventory is converted back to quote currency.
- **Costs:** Taker fees on both legs, on-chain round-trip withdrawal fees (in both directions, including transfer back to exchangeA), slippage on both legs + hedge costs (buy/sell taker fees + bid/ask spread cost, funding fees, spot-perp basis)
- **Risks:** spot-perp hedge price diverge, negative hedge funding fees, withdrawal suspensions, deposit delays, chain congestion.
- **Hedge:** Short an equal quantity of the asset's perp (on any venue) at the same moment the spot buy fills, and close the short when the spot sell executes on the destination venue. This converts the transfer-window exposure from directional to basis risk. Hedge cost = perp buy/sell fees + funding for the holding period; size the perp leg to the exact spot quantity and account for the hedge cost in the entry threshold.

### Variant 2: Pre-positioned Inventory on Both Venues

- **What to trade:** Same pair on two venues, holding both base asset and quote currency on each side in advance.
- **Entry:** When spread (buyExchangeAsk - sellExchangeBid) > fees + slippage, simultaneously sell on the rich venue and buy on the cheap venue — no transfer needed, so execution is near-instant and market-neutral.
- **Exit:** Both legs fill simultaneously; the "exit" is periodic inventory rebalancing (transferring assets back when one side depletes), ideally done when spreads are flat or via netting against opposite-direction signals.
- **Costs:** Taker fees on both legs, slippage, rebalancing transfer fees, hedge costs (buy/sell taker fees + bid/ask spread cost, funding fees, spot-perp basis) and the opportunity cost of idle capital parked on multiple venues.
- **Risks:** inventory imbalance forcing costly rebalances, spread inversion before rebalancing. Capital-inefficient: you need ~2x notional deployed.
- **Hedge:** Short a quantity of the asset's perp (on any venue) equal to the sum of the base asset on both venues. Base assets on both sides must be hedged to avoid directional exposure.

## SPOT-PERP

### Spread (Basis) Arbitrage

- **What to trade:** Spot asset vs. its perpetual future (same or different venue). Classic "cash and carry": long spot, short perp when the perp trades at a premium.
- **Entry:** When the basis (perp price − spot price) is wide relative to its historical range and exceeds entry/exit costs plus expected funding carry.
- **Exit:** When the basis converges toward zero (or your target), close both legs simultaneously; or hold to capture funding while the basis remains favorable.
- **Costs:** Round-trip trading fees on both legs, entry/exit slippage on both sides, bid/ask spread cost on both sides, funding payments if positioned on the paying side.
- **Risks:** Basis can widen further before converging (mark-to-market drawdowns), liquidation on the perp leg during sharp moves, funding flipping against you.

### Funding-Rate Arbitrage

- **What to trade:** Long spot + short perp on the same asset to harvest positive funding (shorts receive when funding > 0). Delta-neutral carry trade.
- **Entry:** When funding (current + predicted) comfortably exceeds total costs and you expect the regime to persist — typically during bullish/levered-long markets where perps trade rich.
- **Exit:** When funding turns negative or compresses below your cost-of-capital hurdle for a sustained period; unwind both legs together.
- **Costs:** Round-trip trading fees on both legs, entry/exit slippage on both sides, bid/ask spread cost on both sides, basis may diverge unfavourably.
- **Risks:** Funding regime flips (you start paying), liquidation risk on the short perp, ADL (auto-deleveraging), basis blowout temporarily marking the position underwater.

## PERP-PERP

### Perp-Perp Spread Arbitrage

- **What to trade:** The same perpetual contract listed on two venues (e.g., ETH-PERP on Exchange A vs. B). Short the rich venue, long the cheap venue.
- **Entry:** When the price spread between the two perps deviates beyond its normal band (mean-reversion signal) by more than fees + slippage.
- **Exit:** When the spread reverts to its mean; close both legs simultaneously.
- **Costs:** Fees and slippage on four executions (two in, two out), bid/ask spread cost on both sides, funding differential while holding.
- **Risks:** Spread persistence or further divergence (especially around listings or liquidation cascades), liquidation on either leg, funding differential eroding the edge.

### Perp-Perp Funding-Rate Arbitrage

- **What to trade:** Same perp on two venues with persistently different funding rates: long on the venue where longs are paid (or pay less), short where shorts are paid (or pay less). Delta-neutral.
- **Entry:** When the funding-rate differential between venues, exceeds total cost of carry and shows persistence (not a one-print anomaly).
- **Exit:** When the differential compresses below hurdle or flips; unwind both legs together, ideally when the price spread between venues is near zero.
- **Costs:** Fees/slippage on both legs at entry and exit, bid/ask spread cost on both sides, and any adverse basis move between the two perps at entry/exit.
- **Risks:** Funding differentials are noisy and mean-revert quickly; both legs carry liquidation risk; price spread between the two perps can move against you while holding; ADL on either side breaking your neutrality.

---

**Cross-cutting note:** Every strategy above lives or dies on execution quality (latency, fill rates), accurate all-in cost modeling, - sizing per venue, withdrawal limits, and stress scenarios matter as much as the signal itself.