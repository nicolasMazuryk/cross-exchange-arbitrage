# Risk Management

## Overview

ArbiNet implements comprehensive risk management to protect capital and ensure safe trading operations. Risk controls are applied at multiple levels: opportunity detection, trade validation, execution monitoring, and position management.

## Risk Management Layers

### Layer 1: Opportunity Validation

**Pre-Detection Filters:**
- Blacklist pairs (configurable)
- Orderbook age limits
- Market spread validation
- Confidence scoring

**Persistence Validation:**
- Temporal persistence checks
- Price stability validation
- Multi-exchange confirmation

### Layer 2: Pre-Trade Validation

**Account State Checks:**
- Balance validation
- Position limits
- Active order checks
- Opposite position detection

**Trade Parameter Validation:**
- Order amount limits
- Position size limits
- Exchange state freshness

### Layer 3: Execution Safeguards

**Order Execution:**
- Parallel order placement
- Order confirmation monitoring
- Timeout handling
- Error recovery

**Pair Locking:**
- Prevents duplicate trades for same pair
- Race condition prevention
- Concurrent execution protection

### Layer 4: Position Management

**Position Limits:**
- Maximum position size per exchange
- Total position limits
- Leverage controls

**Monitoring:**
- Real-time position tracking
- PnL calculation
- Exit condition monitoring

## Pre-Trade Validation

### Balance Validation

**Required Balance Calculation:**
```typescript
requiredBalance = orderAmountUsd * (1 + minBalanceBufferPercent / 100)
```

**Validation:**
- Checks available USDT balance on both exchanges
- Requires balance on buy exchange (for buying)
- Requires balance on sell exchange (for selling)
- Includes buffer percentage for safety margin

**Example:**
- Order amount: $20 USD
- Buffer: 10%
- Required: $20 * 1.10 = $22 USD per exchange

**Failure Handling:**
- Trade rejected if insufficient balance
- Warning logged with available vs required
- No partial execution

### Position Limit Validation

**Maximum Position Size:**
- Configurable limit: `maxPositionAmountUsd` (default: $30 USD)
- Applied per exchange, per symbol
- Calculates position size after trade execution

**Position Calculation:**
```typescript
// For existing position
existingPositionUsd = abs(position.size) * position.entryPrice
positionAfterTradeUsd = existingPositionUsd + orderAmountUsd

// Validation
if (positionAfterTradeUsd > maxPositionAmountUsd) {
  rejectTrade()
}
```

**Validation Points:**
- Buy exchange: Checks LONG position limit
- Sell exchange: Checks SHORT position limit
- Accounts for existing positions
- Prevents position size violations

### Active Order Validation

**Purpose**: Prevents conflicts with existing orders

**Checks:**
- No active orders for same symbol on buy exchange
- No active orders for same symbol on sell exchange
- Prevents order queue conflicts
- Ensures clean execution

**Active Order Detection:**
```typescript
const activeOrders = accountStateManager.getActiveOrders(exchange)
  .filter(order => order.symbol === symbol && order.status !== 'FILLED')
  
if (activeOrders.length > 0) {
  rejectTrade()
}
```

### Opposite Position Validation

**Purpose**: Prevents opening conflicting positions

**Buy Exchange Check:**
- Cannot open LONG if SHORT position exists
- Prevents position conflicts
- Ensures consistent position direction

**Sell Exchange Check:**
- Cannot open SHORT if LONG position exists
- Prevents position conflicts
- Ensures consistent position direction

**Example:**
```
Buy Exchange: Has SHORT position for BTCUSDT
→ Cannot open LONG position (rejected)

Sell Exchange: Has LONG position for BTCUSDT
→ Cannot open SHORT position (rejected)
```

### Account State Freshness

**State Age Tracking:**
- Tracks last update timestamp per data type
- Configurable maximum age: `maxStateAgeMs` (default: 30 seconds)
- Validates state freshness before trades

**Note**: Currently commented out in code but available for activation

**Validation:**
```typescript
if (!accountStateManager.isExchangeStateFresh(exchange)) {
  // State is stale, reject trade
}
```

## Opportunity Validation

### Blacklist Pairs

**Purpose**: Exclude problematic trading pairs

**Configuration:**
- Configurable list: `blacklistPairs`
- Applied during opportunity scanning
- Prevents trading on known problematic pairs

**Example:**
```yaml
arbitrage:
  blacklistPairs: 
    - 'BTC/USDT:USDT'
    - 'ETH/USDT:USDT'
    - 'SUI/USDT:USDT'
```

### Orderbook Age Validation

**Maximum Age:**
- Configurable: `maxOrderbookAge` (default: 2000ms)
- Rejects opportunities with stale orderbook data
- Ensures data freshness

**Age Calculation:**
```typescript
const ageMs = Date.now() - orderbook.timestamp
if (ageMs > maxOrderbookAge) {
  rejectOpportunity()
}
```

### Market Spread Validation

**Maximum Market Spread:**
- Configurable: `maxMarketSpreadPercent` (default: 0.3%)
- Validates bid-ask spread within exchange
- Rejects opportunities with wide spreads (low liquidity)

**Spread Calculation:**
```typescript
const marketSpreadPercent = ((ask - bid) / ask) * 100
if (marketSpreadPercent > maxMarketSpreadPercent) {
  rejectOpportunity()
}
```

### Anomaly Detection

**Maximum Anomaly Threshold:**
- Configurable: `maxAnomalySpreadThresholdPercent` (default: 10.0%)
- Detects unrealistic profit opportunities
- Prevents trading on data errors or anomalies

**Validation:**
```typescript
if (estimatedProfitPercent > maxAnomalySpreadThresholdPercent) {
  rejectOpportunity() // Likely data error
}
```

### Confidence Scoring

**Minimum Confidence:**
- Configurable: `minConfidenceScore` (default: 0.7)
- Composite score based on multiple factors
- Rejects low-confidence opportunities

**Confidence Factors:**
- Freshness (40%): Orderbook data age
- Spread (35%): Market spread quality
- Health (25%): Exchange operational status

**Validation:**
```typescript
if (confidenceScore < minConfidenceScore) {
  rejectOpportunity()
}
```

## Temporal Persistence Validation

### Purpose

Ensures opportunities are real and persistent, not transient market spikes or data errors.

### Validation Criteria

**Minimum Duration:**
- Opportunity must persist for `minPersistenceMs` (default: 1000ms)
- Prevents trading on fleeting opportunities
- Ensures market stability

**Consecutive Snapshots:**
- Both exchanges must show opportunity in `minConsecutiveSnapshots` (default: 3) consecutive updates
- Independent tracking per exchange
- Prevents false positives from single update

**Stability Checks:**
- Spread must not decrease >20%
- Funding profit must not decrease >20%
- Prices must not change >1%
- Resets candidate if conditions change significantly

### Persistence Tracking

**Candidate Management:**
- Tracks candidates per exchange pair
- Updates on each orderbook update
- Validates both exchanges independently
- Cleans up stale candidates

**Validation Flow:**
```
1. New opportunity detected → Create candidate
2. Subsequent updates → Update candidate metrics
3. Check stability → Reset if unstable
4. Check persistence → Validate if criteria met
5. Cleanup → Remove stale candidates
```

## Execution Safeguards

### Pair Locking

**Purpose**: Prevents duplicate trades for the same trading pair

**Implementation:**
```typescript
if (isPairProcessing(normalizedPair)) {
  rejectTrade() // Pair already being processed
}

processingPairs.add(normalizedPair)
try {
  executeTrade()
} finally {
  processingPairs.delete(normalizedPair)
}
```

**Benefits:**
- Prevents race conditions
- Ensures single trade per pair
- Prevents duplicate positions

### Order Confirmation Monitoring

**Timeout:**
- Configurable: `orderConfirmationTimeoutMs` (default: 10000ms)
- Monitors order status until FILLED
- Handles timeout scenarios

**Monitoring:**
- Polls account state for order updates
- Tracks order status changes
- Calculates execution latency

**Failure Handling:**
- Timeout: Order not confirmed within timeout
- Error: Order failed or rejected
- Partial fill: Handled based on exchange behavior

### Parallel Execution Protection

**Race Condition Prevention:**
- Trade processing locks per trade ID
- Prevents concurrent exit processing
- Ensures atomic operations

**Implementation:**
```typescript
if (processingTrades.has(tradeId)) {
  skipProcessing() // Already being processed
}

processingTrades.add(tradeId)
try {
  processExit()
} finally {
  processingTrades.delete(tradeId)
}
```

## Position Management

### Position Size Limits

**Maximum Position:**
- Per exchange, per symbol: `maxPositionAmountUsd` (default: $30 USD)
- Calculated as: `abs(position.size) * entryPrice`
- Includes existing positions in calculation

**Validation:**
- Checks position size before trade
- Accounts for existing positions
- Prevents exceeding limits

### Leverage Controls

**Leverage Setting:**
- Configurable: `leverage` (default: 4x)
- Set before order placement
- Exchange-specific handling

**Leverage Management:**
- Some exchanges require separate leverage setting
- Others include in order parameters
- Handled per exchange adapter

### Position Tracking

**Real-Time Monitoring:**
- Tracks all open positions
- Updates on account state changes
- Calculates unrealized PnL

**Position Validation:**
- Validates position direction
- Checks for opposite positions
- Monitors position size

## Exit Risk Management

### Exit Persistence Validation

**Purpose**: Ensures exit conditions are real and persistent

**Validation Criteria:**
- Exit condition must persist for `exitMinPersistenceMs` (default: 1000ms)
- Both exchanges must show exit condition in `exitMinConsecutiveSnapshots` (default: 3) consecutive updates
- Convergence/spread must remain stable

**Exit Types Validated:**
- Convergence exits
- Spread-widening exits
- Timeout exits (no validation needed)
- Manual exits (no validation needed)

### Exit Slippage Simulation

**Purpose**: Estimates exit costs before execution

**Simulation:**
- Uses current orderbook depth
- Simulates reverse trade execution
- Calculates expected slippage
- Updates PnL with simulated exit

**Validation:**
- Ensures exit is still profitable after costs
- Accounts for slippage and fees
- Prevents unprofitable exits

## Risk Limits Configuration

**Note**: Default values shown are from `config/development.yaml`. Production and other environment configurations may use different values.

### Trading Limits

| Parameter | Description | Default | Purpose |
|-----------|-------------|---------|---------|
| `orderAmountUsd` | Default order size | $20 | Controls trade size |
| `maxPositionAmountUsd` | Maximum position size | $30 | Limits exposure |
| `minBalanceBufferPercent` | Balance buffer | 10% | Safety margin |
| `orderConfirmationTimeoutMs` | Order timeout | 10000ms | Prevents hanging |

### Arbitrage Limits

| Parameter | Description | Default | Purpose |
|-----------|-------------|---------|---------|
| `blacklistPairs` | Excluded pairs | [] | Risk exclusion |
| `minConfidenceScore` | Minimum confidence | 0.7 | Quality filter |
| `maxMarketSpreadPercent` | Max market spread | 0.3% | Liquidity filter |
| `maxAnomalySpreadThresholdPercent` | Anomaly threshold | 10.0% | Error detection |
| `maxOrderbookAge` | Max orderbook age | 2000ms | Data freshness |
| `minPersistenceMs` | Min persistence | 1000ms | Stability check |
| `minConsecutiveSnapshots` | Min snapshots | 3 | Confirmation |

### Monitoring Limits

| Parameter | Description | Default | Purpose |
|-----------|-------------|---------|---------|
| `maxHoldTimeMs` | Maximum hold time | 365 days | Timeout protection |
| `checkIntervalMs` | Check interval | 5000ms | Monitoring frequency |
| `exitMinPersistenceMs` | Exit persistence | 1000ms | Exit validation |
| `exitMinConsecutiveSnapshots` | Exit snapshots | 3 | Exit confirmation |

## Error Handling

### Trade Execution Errors

**Network Errors:**
- Automatic retry (if applicable)
- Error logging
- Trade rejection

**Exchange Errors:**
- API error handling
- Rate limit handling
- Invalid parameter errors

**State Errors:**
- Missing account state
- Stale data handling
- Recovery procedures

### Recovery Mechanisms

**State Recovery:**
- Redis state restoration
- Trade state validation
- Orphaned trade handling

**Error State Handling:**
- Trade marked as 'error'
- Position cleanup
- Logging and alerting

## Risk Monitoring

### Real-Time Monitoring

**Position Tracking:**
- All open positions monitored
- Real-time PnL calculation
- Exit condition checking

**Account State:**
- Balance monitoring
- Position monitoring
- Order monitoring

### Alerts and Warnings

**Balance Warnings:**
- Insufficient balance alerts
- Low balance warnings
- Balance threshold monitoring

**Position Warnings:**
- Position limit approaching
- Large position alerts
- Unusual position patterns

**Execution Warnings:**
- Order confirmation delays
- Execution failures
- Slippage warnings

## Best Practices

### Risk Management Principles

1. **Defense in Depth**: Multiple validation layers
2. **Fail Safe**: Reject trades when uncertain
3. **Position Limits**: Strict size controls
4. **State Validation**: Always verify account state
5. **Persistence Checks**: Ensure opportunity stability

### Configuration Guidelines

**Conservative Settings:**
- Higher confidence thresholds
- Stricter persistence requirements
- Lower position limits
- Wider safety margins

**Aggressive Settings:**
- Lower confidence thresholds
- Faster persistence validation
- Higher position limits
- Tighter safety margins

### Monitoring Recommendations

**Key Metrics:**
- Rejection rate (validation failures)
- Execution success rate
- Average slippage
- Position utilization
- Error rates

**Alert Thresholds:**
- High rejection rate (>50%)
- Low execution success (<90%)
- High slippage (>1%)
- Position limit approaching (>80%)

## Related Documentation

- [Trading Strategies](./trading-strategies.md) - Strategy logic and validation
- [Data Models](./data-models.md) - Risk-related data structures
- [Architecture](./architecture.md) - System architecture
- [API Contracts](./api-contracts.md) - Exchange integration

