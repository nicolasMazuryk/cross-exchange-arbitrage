# Trading Strategies

## Overview

ArbiNet implements two automated trading strategies for exploiting arbitrage opportunities across cryptocurrency exchanges:

1. **Funding Arbitrage**: Exploits funding rate differences between exchanges
2. **Spread Arbitrage**: Exploits price spread differences between exchanges

Both strategies operate on perpetual futures contracts and use sophisticated validation, persistence checks, and exit management to maximize profitability while managing risk.

## Strategy Architecture

### Opportunity Detection Flow

```
Orderbook Update → ArbitrageEngine → Opportunity Detection → Strategy Validation → Persistence Check → Trade Execution
```

### Key Components

- **ArbitrageEngine**: Detects opportunities and validates strategy conditions
- **TradeExecutor**: Executes validated trades
- **TradeMonitor**: Monitors open trades and manages exits
- **FundingService**: Provides funding rate data for strategy decisions

## Funding Arbitrage Strategy

### Overview

Funding arbitrage exploits differences in funding rates between exchanges for the same perpetual futures contract. The strategy opens positions when funding rates differ significantly and closes them when rates converge or other exit conditions are met.

### Strategy Modes

#### Synchronous (SYNC) Mode

**When**: Both exchanges have aligned funding times (e.g., both 1-hour intervals at :00)

**Entry Conditions:**
- Current time is within funding entry window (between `entryWindowStart` and `entryWindowEnd` seconds before next funding event)
- Funding rate difference ≥ `minFundingProfitPercent` (e.g., 0.10%)
- Estimated total profit ≥ `minTotalProfitPercent` (e.g., 0.00%)
- Both exchanges' funding events occur within the same timestamp window

**Entry Window Example:**
- `entryWindowStart`: 120 seconds (2 minutes before funding)
- `entryWindowEnd`: 5 seconds before funding
- Valid entry time: Between 2 minutes and 5 seconds before funding event

**Exit Conditions:**
- Funding rates converge below `convergenceThresholdPercent` (e.g., 0.01%)
- Spread widens beyond `spreadWideningThresholdPercent` (e.g., 0.2% above entry spread)
- Timeout (max hold time exceeded)
- Within exit window (between `exitWindowStart` and `exitWindowEnd`)

**Exit Window Example:**
- `exitWindowStart`: 15 seconds after previous funding event
- `exitWindowEnd`: 5 seconds before next funding event

#### Asynchronous (ASYNC) Mode

**When**: Exchanges have different funding intervals (e.g., 1-hour vs 4-hour) or misaligned times

**Entry Conditions:**
- Current time is within funding entry window
- Cumulative funding profit until next synchronization ≥ `minFundingProfitPercent`
- Estimated total profit ≥ `minTotalProfitPercent`
- Funding intervals differ between exchanges

**Cumulative Funding Calculation:**
- Projects funding rates until next synchronization point
- Sums all funding events between now and sync
- Accounts for different funding intervals

**Exit Conditions:**
- **ASYNC-ASYNC**: Cumulative funding rate drops below threshold before sync
- **ASYNC-SYNC**: Cumulative funding rate for next+1 sync ≥ `minFundingProfitAsyncSyncExitPercent` (e.g., 0.10%)
- Spread widens beyond threshold
- Timeout

### Funding Profit Calculation

**Funding Impact:**
- **LONG position (buy exchange)**: Positive funding rate = we pay (loss), negative = we receive (profit)
- **SHORT position (sell exchange)**: Positive funding rate = we receive (profit), negative = we pay (loss)

**Net Funding Rate:**
```
netFundingRate = -buyExchangeFundingRate + sellExchangeFundingRate
```

**Funding Projection:**
- Projects funding rates for `projectionHours` (default: 10 hours)
- Generates timeline of funding events
- Calculates cumulative funding rate
- Tracks maximum drawdown

**Example:**
- Buy exchange funding: 0.01% (we pay)
- Sell exchange funding: 0.05% (we receive)
- Net funding: -0.01% + 0.05% = 0.04% profit per funding interval

### Entry Validation

**Funding Sync Entry:**
```typescript
fundingRateDifferencePercent - costsPercent >= minFundingProfitPercent
AND
estimatedProfitPercent >= minTotalProfitPercent
```

**Funding Async Entry:**
```typescript
cumulativeFundingRate * 100 - costsPercent >= minFundingProfitPercent
AND
estimatedProfitPercent >= minTotalProfitPercent
```

### Exit Logic

**SYNC Mode Exits:**
1. **Convergence**: Funding difference drops below `convergenceThresholdPercent`
2. **Spread Widening**: Spread exceeds entry spread + `spreadWideningThresholdPercent`
3. **Timeout**: Maximum hold time exceeded

**ASYNC Mode Exits:**
1. **ASYNC-ASYNC**: Cumulative funding becomes negative before sync
2. **ASYNC-SYNC**: Next+1 sync cumulative funding meets threshold
3. **Spread Widening**: Same as SYNC mode
4. **Timeout**: Maximum hold time exceeded

## Spread Arbitrage Strategy

### Overview

Spread arbitrage exploits price differences between exchanges for the same trading pair. The strategy opens positions when spreads are favorable and closes them when spreads converge or widen unfavorably.

### Entry Conditions

**Window Requirements:**
- Current time is within spread entry window
- Window starts `entryWindowStart` seconds after previous funding event
- Window ends `entryWindowEnd` seconds before next funding event

**Window Example:**
- `entryWindowStart`: 300 seconds (5 minutes after funding)
- `entryWindowEnd`: 60 seconds before next funding
- Valid entry time: Between 5 minutes after funding and 1 minute before next funding

**Profit Requirements:**
- **Case 1 (Neutral/Positive Funding):**
  ```
  spreadProfitPercent - costsPercent >= minSpreadProfitPercent
  AND
  estimatedProfitPercent >= minTotalProfitPercent
  ```

- **Case 2 (Negative Funding):**
  ```
  spreadProfitPercent - costsPercent + (fundingRateDifference * negativeFundingMultiplier) >= minSpreadProfitPercent
  AND
  estimatedProfitPercent >= minTotalProfitPercent
  ```

**Negative Funding Adjustment:**
- When funding difference is negative, reduces exposure
- Applies `negativeFundingMultiplier` (e.g., 2.0) to funding difference
- Example: If funding is -0.05% and multiplier is 2.0, subtracts 0.10% from spread profit

### Exit Conditions

**Window Requirements:**
- Must be within spread exit window (same as entry window)

**Exit Triggers:**
1. **Convergence**: Spread converges below `convergenceThresholdPercent` (e.g., 0.0%)
2. **Spread Widening**: Spread widens beyond `spreadWideningThresholdPercent` (e.g., 2.0% above entry)
3. **Timeout**: Maximum hold time exceeded

### Spread Profit Calculation

**Spread Profit:**
```
spreadProfitUsd = (normalizedSellPrice - normalizedBuyPrice) * normalizedVolume
spreadProfitPercent = (spreadProfitUsd / orderAmountUsd) * 100
```

**Costs Included:**
- Trading fees (maker/taker)
- Slippage (entry and exit)
- Market spreads (bid-ask spreads)

## Opportunity Detection Process

### Step 1: Orderbook Scanning

**Trigger**: Real-time orderbook updates from WebSocket streams

**Process:**
1. Receive `TopOfBook` update for a symbol on an exchange
2. Scan all other exchanges for the same normalized symbol
3. Compare prices across all exchange pairs
4. Calculate potential profitability

### Step 2: Slippage Simulation

**Entry Slippage:**
- Simulates order execution using orderbook depth
- Calculates average execution price considering orderbook levels
- Estimates slippage percentage

**Exit Slippage:**
- Simulates reverse trade execution
- Uses current orderbook state
- Accounts for liquidity at exit time

**Simulation Method:**
```typescript
// Walk through orderbook levels
for (const level of orderbookSide) {
  const fillVolume = Math.min(remainingVolume, level.quantity)
  weightedPrice += level.price * fillVolume
  remainingVolume -= fillVolume
  if (remainingVolume <= 0) break
}
avgExecutionPrice = weightedPrice / totalVolume
```

### Step 3: Profit Estimation

**Cost Breakdown:**
1. **Trading Fees**: Taker fees for entry and exit (4 total fees)
2. **Slippage Costs**: Entry and exit slippage
3. **Market Spreads**: Bid-ask spreads on both exchanges

**Profit Components:**
1. **Spread Profit**: Price difference between exchanges
2. **Funding Profit**: Funding rate differences (for funding strategy)

**Total Profit:**
```
estimatedProfitUsd = spreadProfitUsd + fundingProfitUsd - totalCosts
estimatedProfitPercent = spreadProfitPercent + fundingProfitPercent - costsPercent
```

### Step 4: Confidence Scoring

**Confidence Factors:**
- **Freshness Score** (40% weight): How recent is the orderbook data
- **Spread Score** (35% weight): Market spread quality (tighter = better)
- **Health Score** (25% weight): Exchange operational status

**Confidence Calculation:**
```typescript
freshnessScore = Math.max(0, 1 - ageMs / maxOrderbookAge)
spreadScore = Math.max(0, 1 - marketSpreadPercent / maxMarketSpreadPercent)
healthScore = exchange.isHealthy ? 1 : 0

confidenceScore = freshnessScore * 0.4 + spreadScore * 0.35 + healthScore * 0.25
```

**Minimum Confidence**: Must exceed `minConfidenceScore` (default: 0.7)

### Step 5: Strategy Determination

**Process:**
1. Check if within funding window → Try funding strategy
2. Check if within spread window → Try spread strategy
3. Validate strategy-specific entry conditions
4. Assign strategy type to opportunity

**Strategy Priority:**
- Funding strategy takes precedence if both windows are valid
- Spread strategy only if not in funding window

### Step 6: Temporal Persistence Validation

**Purpose**: Ensure opportunity is real and persistent, not a transient spike

**Validation Criteria:**
1. **Minimum Duration**: Opportunity must persist for `minPersistenceMs` (default: 1000ms)
2. **Consecutive Snapshots**: Both exchanges must show opportunity in `minConsecutiveSnapshots` (default: 3) consecutive updates
3. **Stability Checks**: Prices and spreads must remain stable (within thresholds)

**Persistence Tracking:**
- Tracks candidates per exchange pair
- Updates on each orderbook update
- Validates both exchanges independently
- Cleans up stale candidates

**Validation Logic:**
```typescript
// New candidate: Start tracking
if (!existingCandidate) {
  createCandidate()
  return { isValid: false, reason: 'Building persistence' }
}

// Existing candidate: Check stability
if (spreadDecreased > 20% || priceChanged > 1%) {
  resetCandidate()
  return { isValid: false, reason: 'Opportunity unstable' }
}

// Update persistence metrics
if (persistenceDuration >= minPersistenceMs 
    && buySnapshots >= minConsecutiveSnapshots
    && sellSnapshots >= minConsecutiveSnapshots) {
  return { isValid: true, candidate }
}
```

## Trade Execution

### Entry Execution

**Process:**
1. Validate trade parameters (balance, positions, limits)
2. Place buy order on buy exchange (MARKET order)
3. Place sell order on sell exchange (MARKET order)
4. Monitor order confirmation via account state
5. Calculate actual execution prices and fees
6. Create tracked trade record

**Parallel Execution:**
- Both orders placed simultaneously
- Reduces execution latency
- Minimizes price movement risk

**Order Monitoring:**
- Waits for order confirmation via account state updates
- Tracks order status until FILLED
- Calculates execution latency

### Exit Execution

**Process:**
1. Detect exit condition (convergence, spread-widening, timeout)
2. Validate exit persistence (for convergence/spread-widening)
3. Simulate exit slippage
4. Calculate exit PnL
5. Place reverse orders (buy on sell exchange, sell on buy exchange)
6. Monitor exit order confirmation
7. Calculate final PnL

**Exit Persistence Validation:**
- Similar to entry persistence
- Ensures exit condition is real and persistent
- Prevents premature exits from transient conditions

## Profitability Metrics

### Entry Metrics

**Spread Profit:**
- Price difference between exchanges
- Calculated using normalized prices
- Accounts for contract size differences

**Funding Profit:**
- Funding rate difference
- Projected over holding period
- Cumulative for async mode

**Costs:**
- Trading fees (4 fees: entry buy, entry sell, exit buy, exit sell)
- Slippage (entry and exit)
- Market spreads

**Net Profit:**
```
netProfit = spreadProfit + fundingProfit - totalCosts
```

### Exit Metrics

**Delta Profit:**
- Price movement profit/loss
- Calculated from entry to exit prices
- Separate for buy and sell legs

**Funding Profit:**
- Actual funding fees collected
- Tracked per funding event
- Cumulative over holding period

**Final PnL:**
```
pnlUsd = deltaProfitUsd + fundingProfitUsd - feesUsd.total
pnlPercent = deltaProfitPercent + fundingProfitPercent - feesPercent.total
```

## Configuration Parameters

**Note**: Configuration values shown are examples from `config/development.yaml`. Production and other environment configurations may use different values. See actual config files for current values.

### Funding Strategy

| Parameter | Description | Example |
|-----------|-------------|---------|
| `enabled` | Enable/disable strategy | `true` |
| `entryWindowStart` | Start of entry window (seconds before funding) | `120` (2 min) |
| `entryWindowEnd` | End of entry window (seconds before funding) | `5` |
| `exitWindowStart` | Start of exit window (seconds after funding) | `15` |
| `exitWindowEnd` | End of exit window (seconds before funding) | `5` |
| `minFundingProfitPercent` | Minimum funding profit after costs | `0.10%` |
| `minTotalProfitPercent` | Minimum total profit after all costs | `0.00%` |
| `convergenceThresholdPercent` | Exit when funding converges below this | `0.01%` |
| `minFundingProfitAsyncSyncExitPercent` | Minimum for ASYNC-SYNC exit | `0.10%` |
| `spreadWideningThresholdPercent` | Exit if spread widens beyond this | `0.2%` |

### Spread Strategy

| Parameter | Description | Example |
|-----------|-------------|---------|
| `enabled` | Enable/disable strategy | `false` |
| `entryWindowStart` | Start of entry window (seconds after funding) | `300` (5 min) |
| `entryWindowEnd` | End of entry window (seconds before funding) | `60` (1 min) |
| `exitWindowStart` | Start of exit window (seconds after funding) | `300` |
| `exitWindowEnd` | End of exit window (seconds before funding) | `60` |
| `minSpreadProfitPercent` | Minimum spread profit after costs | `0.8%` |
| `minTotalProfitPercent` | Minimum total profit after all costs | `-0.1%` |
| `negativeFundingMultiplier` | Multiplier for negative funding adjustment | `2.0` |
| `convergenceThresholdPercent` | Exit when spread converges below this | `0.0%` |
| `spreadWideningThresholdPercent` | Exit if spread widens beyond this | `2.0%` |

## Strategy Selection Logic

### Window-Based Selection

**Funding Window Priority:**
- If within funding window → Try funding strategy first
- If funding strategy validation fails → Don't try spread strategy
- If not in funding window → Try spread strategy

**Window Overlap:**
- Funding and spread windows can overlap
- Funding strategy takes precedence
- Spread strategy only if funding window not active

### Validation Flow

```
1. Check funding window → Validate funding entry → If valid, assign 'funding'
2. If not funding, check spread window → Validate spread entry → If valid, assign 'spread'
3. If neither valid → Reject opportunity
```

## Performance Considerations

### Optimization Strategies

**Symbol-Specific Scanning:**
- Only scans updated symbol across exchanges
- Reduces CPU usage
- Improves latency

**Persistence Validation:**
- Prevents false positives
- Reduces unnecessary trades
- Improves profitability

**Parallel Order Execution:**
- Simultaneous order placement
- Minimizes execution latency
- Reduces price movement risk

### Monitoring

**Real-Time Monitoring:**
- Orderbook updates trigger exit condition checks
- Immediate response to market changes
- Continuous PnL calculation

**State Persistence:**
- Trades tracked in Redis
- Recovery on restart
- Historical analysis

## Related Documentation

- [Risk Management](./risk-management.md) - Risk validation and safeguards
- [Data Models](./data-models.md) - Strategy data structures
- [API Contracts](./api-contracts.md) - Exchange integration
- [Architecture](./architecture.md) - System architecture

