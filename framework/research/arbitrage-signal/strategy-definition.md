# Crypto Arbitrage Strategy Definitions


### Strategy Group A — Spread Mean-Reversion Strategies

**Members:** Spot-Spot Variant 1 (Buy → Transfer → Sell), Spot-Spot Variant 2 (Pre-positioned Inventory), Spot-Perp Basis Arbitrage, Perp-Perp Spread Arbitrage.

**Common logic (define once):**

- **Signal:** Cost-adjusted executable spread between the two instruments/venues, tracked against its rolling distribution (rolling mean and σ over a stated lookback window; specify window length and sampling rate). Signal strength expressed as both absolute net bps (`E_net`) and a z-score of the raw spread.
- **Entry:** Trigger when `E_net > entryThreshold` (in bps, stated per strategy) AND the persistence filter passes. Both legs (or the leg + hedge) must be submitted simultaneously; specify the maximum acceptable leg-fill latency, in case one leg is not filled - the open leg must be closed.
- **Exit:** Spread convergence to a stated target (e.g., z-score ≤ 0, or net spread ≤ exitThreshold), OR a time stop (maximum holding period, stated), OR a forced unwind on divergence beyond a stop band (stated in σ or bps).
- **Cost model:** Instantiate the base cost model with: taker fees on both legs in and out (state each venue's fee tier in bps), expected slippage on both legs in and out at the intended clip size, and bid/ask crossing cost on both sides. Per-strategy additions (transfers, hedges, funding) are itemized in the deltas below. State the resulting break-even spread in bps; the entry threshold must sit above it by the stated safety margin.

**Per-strategy deltas (specify only what differs):**

### Spot-Spot Variant 1: Buy → Transfer → Sell
- **Signal delta:** Signal must ingest chain-congestion and venue wallet-status data: estimated confirmation time and withdrawal/deposit availability on both venues are signal inputs, not afterthoughts. The funding component of the hedge cost is forecast over the *estimated transfer window*, so transfer-time estimates feed directly into `C_total`.
- **Cost model delta:** Add to the base model: round-trip on-chain withdrawal/deposit fees in **both** directions (including the eventual transfer back to the source venue), and the full hedge cost — perp taker fees both ways, expected slippage in and out, bid/ask crossing cost, expected funding for the transfer window, and the spot-perp basis cost at hedge entry/exit. State each in bps at the intended clip size; the break-even spread for this variant is typically the widest of all six strategies and must be stated explicitly.
- **Entry delta:** Trigger only if `E_net > 0` after hedge costs AND withdrawals are open on the source venue AND deposits are open on the destination AND estimated transfer time is below a stated maximum. At trigger: buy spot and short an equal quantity of the asset's perp in the same instant.
- **Exit delta:** No convergence condition — the exit is mechanical: sell spot immediately upon deposit confirmation on the destination venue and close the perp hedge at the same moment. Define a transfer time-out escalation (e.g., transfer exceeds X× the estimate → alert; the hedge stays on until inventory lands).

### Spot-Spot Variant 2: Pre-positioned Inventory
- **Signal delta:** Signal must track per-venue inventory levels — available base and quote on each side are entry inputs.
- **Cost model delta:** No transfer costs on the trade itself. Instead: amortize expected rebalancing transfer costs into the break-even spread (state the amortization assumption, e.g., expected trades per rebalance cycle), include the hedge's funding carry on the perp short covering total base inventory, and state the opportunity cost of capital parked on both venues as an annualized hurdle the strategy's realized bps must clear (informational — it shapes the entry threshold, not sizing).
- **Entry delta:** Trigger only if both venues hold sufficient inventory for the clip (base on the rich venue to sell, quote on the cheap venue to buy). Simultaneous execution of both legs; near-zero leg risk is the point of this variant.
- **Exit delta:** Both legs fill at entry — the trade-level exit is immediate. Define the **rebalancing exit** instead: rebalance when either side's inventory falls below a stated floor (e.g., < 25% of target), executed preferentially by netting against opposite-direction signals, otherwise via transfer when the spread is within a stated flat band.

### Spot-Perp Basis Arbitrage
- **Signal delta:** Spread = perp price − spot price (the basis), tracked against its historical distribution. Add expected funding carry over the intended holding period to the edge calculation: when short the perp at a premium, positive funding accrues to the position and can be added to `E_net`; state the funding forecast method (e.g., current rate + predicted rate from premium index).
- **Cost model delta:** Round-trip fees and slippage on both the spot and perp legs (four executions). Funding enters with its sign: expected funding *received* is a negative cost (credit) in `C_total`; if positioned on the paying side at any point, it flips to a cost. State the break-even both excluding and including the funding credit, so the convergence edge and carry edge are separable.
- **Entry delta:** Trigger when basis z-score > stated threshold AND `E_net` (including expected funding carry) > entry threshold. Long spot + short perp simultaneously.
- **Exit delta:** Close both legs when the basis converges to the target band; alternatively hold while funding remains favorable — define the hold-vs-close decision rule explicitly (e.g., remain in position while expected funding per period > expected convergence capture from closing now). Forced unwind if the basis widens beyond a stated stop or funding flips negative for a stated number of consecutive periods.

### Perp-Perp Spread Arbitrage
- **Signal delta:** Spread = perp price on Venue A − perp price on Venue B for the same contract, tracked as a z-score against its rolling band. The expected funding differential over the holding period may be positive or negative edge — sign it explicitly in the signal.
- **Cost model delta:** Fees and slippage on four executions (two in, two out) plus bid/ask crossing on both venues. Add the expected funding differential over the holding period with its sign (credit if the position receives net funding, cost if it pays). Break-even spread stated for the full four-leg round trip.
- **Entry delta:** Trigger when |z-score| > stated threshold AND `E_net` (after the four-leg cost and funding differential) > entry threshold. Short the rich venue, long the cheap venue, simultaneously.
- **Exit delta:** Close both legs when the spread reverts to its mean (z-score within a stated exit band). Time stop at a stated maximum holding period (this spread can persist around listings/liquidation cascades). Forced unwind if the funding differential turns against the position by more than a stated bps/period for a stated duration, or the spread diverges beyond a stop band.

---

## Strategy Group B — Funding Carry Strategies

**Members:** Spot-Perp Funding-Rate Arbitrage, Perp-Perp Funding-Rate Arbitrage.

**Common logic (define once):**

- **Signal:** The funding rate (or funding-rate differential), annualized, combined with a prediction of next-period funding from the premium index. Track persistence: rolling mean and sign-consistency of funding over a stated lookback (e.g., fraction of the last K funding periods with favorable sign). The carry signal is `expectedCarry(annualized) − C_total(annualized over expected holding period)`.
- **Entry:** Trigger when expected net carry exceeds a stated hurdle rate (annualized bps) AND the persistence condition passes (no entry on a one-print funding anomaly). Both legs entered simultaneously, delta-neutral by construction; specify maximum acceptable basis/spread level at entry so you don't pay a wide basis to capture thin carry.
- **Exit:** Unwind both legs together when expected net carry falls below the hurdle for a stated number of consecutive funding periods, or the funding sign flips against the position for a stated number of periods. Time the unwind: prefer to exit when the basis/price-spread between the legs is near zero (state the band) rather than at the moment the carry signal dies, subject to a maximum grace window.
- **Cost model:** Instantiate the base cost model with: round-trip fees and slippage on both legs at entry and exit, bid/ask crossing on both sides, and the basis/spread paid at entry as an explicit cost component (entering at an adverse basis is a real, quantifiable cost — state it in bps). Annualize `C_total` over the expected holding period so it is directly comparable to the annualized carry signal; the hurdle rate is `C_total(annualized) + safety margin`. State the minimum holding period at which the trade breaks even given current funding.

**Per-strategy deltas:**

### Spot-Perp Funding-Rate Arbitrage
- **Signal delta:** Single-venue (or cross-venue) funding on one perp; position is long spot + short perp, so the favorable regime is funding > 0 (shorts receive). Spot-perp basis at entry is a signal input: entering when the perp is rich adds convergence edge; entering when the perp is cheap subtracts it.
- **Cost model delta:** Two legs (spot + perp), so four executions round trip (fee and slippage) and bid/ask crossing cost on both sides. Funding received is the revenue line, not a cost — keep it out of `C_total` and compare carry-vs-cost explicitly.
- **Entry delta:** Funding (current + predicted) > hurdle AND persistence passes AND basis at entry within the stated acceptable band (or favorable).
- **Exit delta:** Standard group exit. Additionally define a basis-blowout interim rule: a temporarily diverging basis is a mark-to-market event, not an exit signal, unless it breaches a stated extreme band — distinguish these two cases explicitly in the spec.

### Perp-Perp Funding-Rate Arbitrage
- **Signal delta:** Funding **differential** between the same perp on two venues: `Δf = funding(short venue, received) − funding(long venue, paid)`, annualized. Differentials are noisier and mean-revert faster than single-venue funding — use a shorter persistence lookback but a stricter sign-consistency requirement (state both). The price spread between the two perps at entry is a signal input, same logic as basis above.
- **Cost model delta:** Four perp executions round trip across two venues with potentially different fee tiers — itemize per venue. Because the differential mean-reverts quickly, the expected holding period is shorter: annualizing `C_total` over an optimistic holding period understates the hurdle, so state the break-even holding period conservatively and require the persistence-adjusted expected differential to clear it.
- **Entry delta:** `Δf` (current + predicted) > hurdle AND persistence passes AND inter-venue price spread within the stated entry band. Long the venue where longs are paid (or pay less); short where shorts are paid (or pay less).
- **Exit delta:** Standard group exit on differential compression or flip. Additionally: exit preferentially when the inter-venue price spread is near zero; define the maximum time the position may wait for a favorable spread after the carry signal dies before forcing the unwind anyway.

---