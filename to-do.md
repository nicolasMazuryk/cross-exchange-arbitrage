- [ ] add actualFundingDate on both exchnges: buyExchangeActualFundingDate and sellExchangeActualFundingDate

- IDEA: currently, ASYNC funding is validated by cumulative profit. Validate just by first funding event.
- IDEA: disable Persistance Validation for FUNDING strategy, keep only for SPREAD strategy.

- CONFIG IDEAS:
  - reduce entry window time from 2 min to 1min->30sec->15sec
  - reduce spreadWideningThresholdPercent to 0.1% -> 0.05% -> 0.00%
  - increase minFundingProfitPercent to 0.2% -> 0.3% -> 0.4%

- [ ] Testing:
  - Bybit Left to test EVERYTHING (all flow)
  - Funding Fee Collection: multiple order position split (proportional)

- [ ] minor: currently, spreadWidening is calculated from trade.opportunity.spreadProfitPercent. Calculate from the entry actuals, which is: opportunity.spreadProfitPercent - entry slippage. This is more correct values.
  - also, calculate spreadAtEntryPercent = trade.opportunity.spreadProfitPercent - slippageEntry

### PLAN
+ 1. Funding + Spread Strategies Entry + Exit
+ 2. State Management, stop/start (redis)
+ 3. Error Handling
+ 4. Logging (trigger -> traces)
+ 5. Long running process testing
+ 6. Deployment
+ 7. Alerting
+ 8. Funding Accruals collection (both Rates & Fees). Fees - may be 2 simultaneous orders. Better Rates
+ 8.5 New Algorithm
9. Trade Analytics
	- + trade lifecycle, clean structure by stages, collect all data needed for analytics
	- per trade analytics
    	- ROI % per side (no leverage) ~ $10
		- ROI % on total invested amount (no leverage) ~ $20
    	- ROI % on capital (fixed capital or floating wallet balnace???) ~ $400
	- overall analytics
10. Exchange <> system data accuracy
	- Reconciliation checks
    	- Research: Binance, Bybit, etc MCP servers. Agent has access to exchange API. Agent do the Reconciliation checks and compare data from the trackedTrade with data on exchange. And investigate what is the reason of discrepancy.
  + research useful data to fetch from exchanges
11. Market Analytics
    - Spread Collection (timeseries database)
    - Spread Visualization (Trading View)
        - Build similar charts to visually see the divergence/convergence between pairs: https://apcrypto.accelsite.io/spreadvision
    - Analyze Opportunities with DataSpell (or research alternatives) https://www.jetbrains.com/dataspell/ or https://www.jetbrains.com/datalore/

- [ ] BUILD STATISTICAL MODULE: https://chatgpt.com/share/68d971b0-8460-8013-8096-3a1b4daf4001
	- calculate mean, EMA and Z-Score for SPREAD only
	- instead of a fixed spread and funding entry rule (e.g., “enter if spread > 0.3%”), make it statistically-adjusted (e.g., enter trades only if Z-Score > 1.5 and stable for 30 sec)
	- build volatility-adjusted spread monitor to avoid temporary spikes
	- Note: treat Spread Arbitrage similar to Pair Trading (divergence - convergence, measured by Z-Score) 






1.  Market Management
    1.  simple solution: just periodicaly re-loadMarkets()
    - Track Delistings (and new Listings) on all exchanges
    - exit trade BEFORE delisting (otherwise 1 leg open exposure)
    - add/remove markets from marketMetadata (keep fresh markets)
    - add/remove websockets subscription
    - IF websocket fails for the symbol - check if it is available in MarketMetadata and unsubscribe.
    - move to utils: create function to find symbol matches between exchanges. Identify whether all symbol matches correctly

2.  Risk Management (Scaling) 
	- (trackedTrade: instead of single orders - handle positions which consist of multiple orders)
    	- research how positions are handled on exchanges UI
	- move to "hedge" mode and allow opening positions in opposite directions (also remove this check from trade entry validation)
    	- once "hedge" mode is enabled - handle funding fee collection for both position direction in calculateProportionalFunding()

3.  API
    - Positions (Open and Closed)
      - Trades
    - Balances (Wallet and P&L)
    - v2 Opportunities

4.  Scaling
	- onboard 6 new exchanges
	- sort best 5 opportunities on all markets
	- transfer funds (withdraw/deposit) to exchanges to allocate money on best opportunities




14. Monitoring (Graphana, Prometheus, etc)
15. Performance profiling
16. Opportunities Historical Analytics



- [ ] Save Closed Positions to JSON
	- Store Historical Orders and Positions as separate array.


- [ ] review logging message JSON structure:
	- do I need logger "module"?
	- do I need "function" field




- approach: you make money over time
•	Rule of thumb: carry until net yield < your opportunity cost.

- ChatGPT: Funding Flip Risk: check market skew, OI.

- List of CEX & DEX with API to integrate: https://arbitragescanner.io/exchanges-review
- Research: Арбитраж на листингах и лаунчпадах 30-40% на сделку



- Research: OS optimization for HFT. Managing 5,000 active sockets is heavy for:
	•	Epoll event loops
	•	TCP kernel buffers
	•	Connection churn
	You must ensure:
	•	ulimit > 10,000
	•	net.ipv4.tcp_rmem/wmem correctly tuned
	•	net.core.somaxconn >= 4096
	•	net.ipv4.tcp_tw_reuse=1

************
- [ ] Execution latency (websocket orders) - high-frequency and low-latency (Bybit). Useful when every millisecond counts in competing for fill priority

- [ ] Position scaling - increase the profitThreshold with each new trade (0.2%, 0.3%, 0.4%, 0.5% etc) - variable positionScalingProfitThresholdIncrement
************

- [ ] BUG: ArbitrageEngine: maxActualBuyExchangeVolume = 150 and maxActualSellExchangeVolume = 200, which are not equal. 

- [ ] Closed Position in logs doesn't match PnL on Exchanges UI.

- [ ] Analyze all entry-exit prices + fees + funding AND compare that with EXCHANGE to find the mistake

ChatGPT:
2 !!!
3
6
8 !!! FOK
9
10


- [ ] try FOK (Fill-Or-Kill). Enter "flicker" leg first with FOK - if executed - then enter other leg.
	•	Definition: Order must be completely filled immediately at your limit price or better — otherwise it is canceled in full. It prevents your arbitrage bot from chasing price flickers and suffering uncontrolled slippage.
	•	Benefit: Eliminates exposure from partial fills.
	•	Risk: Very strict — you may miss real opportunities if the book can’t instantly fill the entire requested size.
	Use FOK when:
	•	Symmetry is critical (e.g., no leftover exposure allowed).
	•	Spreads are thin and fleeting, but you want certainty or nothing.
-----------------------------------

- [ ] Penalize "exchange:symbol" if orderbook slippage


Validation of ALL inputs
- handle and log all cases (0, null, etc)
Alerting
- track warnings in cloudwatch


- [ ] Rename buyExchange/sellExchange to longExchange/shortExchange

- [ ] implement global graceful shotdown - close all positions

- [ ] handle tradeExecutor rollback scenarios (if cancel failed -> try close position, if partially_filled -> cancel remaining and close remaining)
Possible order states (just ask Cursor to handle these scenarios):
- live -> filled
- live -> partially_filled -> ... -> filled
- live -> canceled
- live -> partially_filled -> canceled

- [ ] implement retry for CCXT REST orders placement (already implemented in other strategies)

- [ ] Multiple orders enter and exit (position scaling) - errors with reduceOnly orders. (hedge mode)
- [ ] Both LONG & SHORT positions open on the same symbol

----------------------------------

1. accountStateManager.isExchangeStateFresh() - some exchanges do not update consistenly. Update every 1 min
2. validateTrade() - add test cases for conflicting Active Open Orders

- [ ] accountStateManager -> updateOrders, updatePosition. 
    1. Handle item removal for different exchanges: Bybit/Bitget return position with size=0, OKX simply do not return the position.

--------------------



----- https://kiro.dev/docs/specs/ - Spec-Driven Development Guide







Improvements:
- [ ] do not convert strings to number on websocket orderbook event received from exhcange. Convert to numbers only for TopOfBook and once calculating the Slippage before execution.

- [ ] re-loadMarkets() every hour -> compare pairs -> find new/deleted pairs -> subscribe/unsubscribe to Websockets, so you can trade newly added pairs. (extend task with broader Market management lifecycle)

- migrate to performant uWebSockets.js that is 10x more performant then "ws" (requries to build exchange ws handling yourself)

Questions:
- what is the most effective and performant data structure for orderbook per exchange per symbol? BTCUSDT: { binance: { ask, bid }, bybit: { ask, bid } } or other?

Refactor:
- REST client are initialized in both: orchestrator and accountSyncService

- Add Sentry for error tracking

===========
Trade Execution Improvements

1. Atomicity Between Two Legs (Entry and Exit)
Problem: If one leg executes and the other fails (due to slippage, balance, latency), you’re exposed.
What to add:
	•	Conditional execution control:
	•	Only execute leg B if leg A succeeds
	•	Use order ACK + FILL status on first leg before firing second

10. Concurrency Control

Problem: Race conditions from multiple overlapping trades on same asset

What to add:
	•	Lock per (exchange, symbol) during trade execution
	•	Prevent overlapping execution on same pair


- use circuits brackers: https://www.npmjs.com/package/opossum
	- Automatically disables bad dependencies and restores when healthy.
			breaker.on('open', () => console.warn('Circuit opened - exchange API unstable'));
			breaker.on('halfOpen', () => console.info('Circuit half-open - retrying'));
			breaker.on('close', () => console.info('Circuit closed - system stable again'));
- or even better fault-handling library Retry, Circuit Breaker, Timeout, Bulkhead Isolation, and Fallback: https://www.npmjs.com/package/cockatiel
- just simple axios-retry library: https://www.npmjs.com/package/axios-retry

- Ensure atomic updates across systems (Distributed Locks): https://www.npmjs.com/package/redlock

********************************************************************************
********************************************************************************
********************************************************************************

Binance Funding Rates:
CCXT: FundingRate + FundingDatetime
Interval: https://www.binance.com/bapi/futures/v1/public/future/common/get-funding-info
Funding Rates: stream: "!markPrice@arr"

Bybit Funding Rates: 
FundingRate + FundingDatetime + Interval
https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=LinearPerpetual

OKX:
FundingRate + FundingDatetime + Interval
https://www.okx.com/priapi/v5/public/funding-rate-all?ccyType=USDT

Bitget:
FundingRate + FundingDatetime + Interval
https://www.bitget.com/v1/mcp/contract/symbols?businessLine=10

Gate:
FundingRate + FundingDatetime + Interval
https://www.gate.com/apiw/v2/futures/usdt/contracts


MEXC:
https://futures.mexc.com/api/v1/contract/funding_rate

HYPERLIQUID positive funding, hourly
https://app.hyperliquid.xyz/fundingComparison

curl 'https://api-ui.hyperliquid.xyz/info' \
  -H 'Content-Type: application/json' \
  --data-raw '{"type":"predictedFundings"}'





====================================
FAST MARKETS HANDLING

- [ ] calculate and track Fast Markets Coeficient
	•	High order book churn
	Best bid/ask prices and sizes update dozens of times per second, sometimes hundreds on very active pairs.
	•	Depth instability
	Liquidity providers cancel and repost aggressively; top-of-book liquidity may “flash” and disappear before it can be hit.
	•	Price gapping
	Quotes can jump multiple ticks without intermediate trades, causing your expected fill price to differ dramatically from the executed one.
	•	Wide spreads
	Market makers protect themselves by widening spreads or reducing quote size, meaning entry costs are higher.
	•	Latency sensitivity
	A 50–100ms delay can turn a +20 bps arbitrage spread into a –10 bps loss.


⚠️ Why Fast Markets Are Dangerous for Arbitrage
	1.	False arbitrage signals
	•	Spreads appear wide but vanish before execution → you chase ghosts.
	2.	High slippage
	•	Even if you send orders, fills may sweep into worse price levels.
	3.	Increased latency
	•	Exchanges throttle order because of the lot of number of orders

🛠 Strategies to Handle Fast Markets

1. Market State Detection
	•	Measure quote churn rate (how often best bid/ask changes).
	•	Compute short-horizon volatility (variance of midprice over 100–300ms).
	•	Tag “fast state” if thresholds are exceeded, then suspend new entries.

2. Dynamic Spread Thresholds
	•	In fast markets, increase minSpread requirement before entering trades.
Example:
	•	Normal regime → min spread = 20 bps
	•	Fast regime → min spread = 35–40 bps

3. Trade Size Scaling
	•	Cut position size during fast regimes to reduce slippage impact.
	•	E.g., trade at 25–50% of normal size.

4. Latency-Aware Filters
	•	Track your round-trip latency per exchange.
	•	If RTT > X ms while churn is high, block trades (because you’ll always be “too late”).

5. Kill Switches
	•	Global pause if:
	•	N consecutive failed trades within Y seconds
	•	Order rejection rate > X%
	•	Book desync > threshold (missed WS updates)

3.	Order Flow Imbalance Filters
Don’t enter trades when order flow is violently imbalanced (fast markets).

2.	Microprice Tracking
Use microprice. Gives a better sense of directional pressure:

microPrice = (askPrice * bidSize + bidPrice * askSize) / (bidSize + askSize)

	•	If microprice > midprice → book is bid-heavy (buy pressure).
	•	If microprice < midprice → book is ask-heavy (sell pressure).

5. Liquidity Taking Speed
	•	How quickly the queue at best bid/ask is consumed.
	•	Faster taker activity → higher volatility, spreads may flicker.

5.	Latency Benchmarking
	•	Continuously measure round-trip time (RTT) to each exchange.
	•	Apply a latency-adjusted profit threshold. Reject if adjProfit < 0
adjProfit = rawSpread - latencyPenalty



🛠 How to Use Order Flow Dynamics in Your Engine
	1.	Filter False Spreads
	•	Only trust spreads if Order Flow Imbalance is stable (not oscillating buy/sell every few ms).
	•	Require persistence across multiple snapshots.

	2.	PnL Adjustment
	•	Deduct a penalty from expected profit if microprice is against your trade.
	•	Example: If buying on an exchange where microprice < midprice → likely to lose.
	
	3.	Volatility Gate
	•	Reject trades if quote churn > X changes/sec (fast market detection).

📊 Practical Example

Imagine PEPEUSDT:
	•	Normal state: best bid/ask updates ~10 times per second.
	•	Fast market: ~100–200 updates per second, midprice variance spikes 5–10x.
If your engine doesn’t adapt, you’ll keep firing into flickers, getting partial fills and bad exits. With volatility filters + persistence checks, you’d hold fire until the book stabilizes.

✅ Summary:
Fast markets = chaotic states with extreme quote churn and high volatility.
They are dangerous for arbitrage because signals are less reliable and fills are worse.
The right approach is detect, adapt, or pause: monitor churn/volatility, raise thresholds, scale down size, and block entries until the book stabilizes.
----
Would you like me to design a Cursor prompt that adds a MarketRegimeDetector module into your engine to classify regimes (normal, fast, halted) and enforce adaptive thresholds automatically?





---------------
LATENCY IMPROVEMENT

- RESEARCH: ultra-low-latency VPS near exchange servers
- Host near matching engines: If you can’t colocate, pick VPS in Tokyo (Binance/Bybit/OKX)
    - A practical approach is to measure API latency from candidate regions (e.g., Tokyo, Singapore, Hong Kong) using test pings or fetchTicker calls, then choose the fastest node.
- Switch to direct feeds: Where possible, use official low-latency feeds (some exchanges offer binary protocols).
- Upgrade order types: Replace pure market orders with IOC/FOK marketable limits to protect from slippage.

- Contact Sales - get pricing: https://axon.trade/