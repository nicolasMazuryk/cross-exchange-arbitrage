# Trading Module

This module provides the core trading functionality for the ArbiNet arbitrage system, including trade execution and monitoring.

## Components

### TradeExecutor

The `TradeExecutor` class handles safe trade execution with comprehensive validation and error handling.

**Key Features:**
- Pre-trade validation (balances, positions, account state)
- Paired trade execution across exchanges
- Retry logic with exponential backoff
- Rollback mechanism for failed trades
- Comprehensive error handling and logging

**Usage:**
```typescript
import { TradeExecutor, TradeParams } from './tradeExecutor'

const tradeExecutor = new TradeExecutor(accountStateManager, restClients)

const tradeParams: TradeParams = {
  pair: 'BTCUSDT',
  buyExchange: 'binance',
  sellExchange: 'bybit',
  volume: 100,
  side: 'buy',
  expectedProfitPercent: 0.5,
  confidenceScore: 0.8,
  timestamp: Date.now()
}

const result = await tradeExecutor.executeTrade(tradeParams)
```

### TradeMonitor

The `TradeMonitor` class tracks trade lifecycle and manages exit conditions.

**Key Features:**
- Real-time PnL monitoring
- Configurable exit conditions (take profit, stop loss, timeout)
- Automatic trade closure based on conditions
- Manual trade management
- Comprehensive statistics and reporting

**Usage:**
```typescript
import { TradeMonitor } from './tradeMonitor'

const tradeMonitor = new TradeMonitor(accountStateManager, restClients, {
  maxHoldTimeMs: 300000, // 5 minutes
  takeProfitPercent: 0.5, // 0.5%
  stopLossPercent: -2.0, // -2%
  checkIntervalMs: 5000, // 5 seconds
  maxUnrealizedLoss: -100 // $100
})

// Start monitoring
tradeMonitor.start()

// Add trade to monitoring
tradeMonitor.addTrade(tradeResult)

// Get statistics
const stats = tradeMonitor.getStats()
```

## Integration with ArbitrageEngine

To integrate with the existing arbitrage system:

```typescript
import { ArbitrageEngine } from '../arbitrage/arbitrageEngine'
import { TradeExecutor } from './tradeExecutor'
import { TradeMonitor } from './tradeMonitor'

// Initialize components
const tradeExecutor = new TradeExecutor(accountStateManager, restClients)
const tradeMonitor = new TradeMonitor(accountStateManager, restClients)

// Start monitoring
tradeMonitor.start()

// Listen for arbitrage opportunities
arbitrageEngine.on('opportunities', async (opportunities) => {
  for (const opportunity of opportunities) {
    // Convert opportunity to trade params
    const tradeParams: TradeParams = {
      pair: opportunity.pair,
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      volume: opportunity.fillableVolume,
      volumeUSDT: opportunity.volumeUSDT,
      expectedProfitPercent: opportunity.estimatedProfitPercent,
      confidenceScore: opportunity.confidenceScore,
      timestamp: Date.now()
    }

    // Execute trade
    const result = await tradeExecutor.executeTrade(tradeParams)
    
    // Add to monitoring if successful
    if (result.success) {
      tradeMonitor.addTrade(result)
    }
  }
})

// Listen for trade completion
tradeExecutor.on('tradeCompleted', (result) => {
  logger.info(`Trade completed: ${result.id}`, {
    success: result.success,
    pnl: result.pnl,
    latencyMs: result.latencyMs
  })
})

// Listen for trade closure
tradeMonitor.on('tradeClosed', (trade) => {
  logger.info(`Trade closed: ${trade.id}`, {
    exitReason: trade.exitReason,
    pnl: trade.pnl
  })
})
```

## Configuration

The trading module can be configured via the YAML configuration file:

```yaml
trading:
  orderAmount: 100  # Default order size in USDT
  monitor:
    maxHoldTimeMs: 300000  # 5 minutes max hold time
    takeProfitPercent: 0.5  # 0.5% take profit
    stopLossPercent: -2.0  # -2% stop loss
    checkIntervalMs: 5000  # 5 seconds check interval
    maxUnrealizedLoss: -100  # $100 max unrealized loss
```

## Safety Features

### Pre-Trade Validation
- Account balance verification
- Position limit checks
- Account state freshness validation
- Conflicting order detection

### Execution Safety
- Retry logic with exponential backoff
- Rollback mechanism for failed trades
- Unique client order IDs for tracking
- Comprehensive error handling

### Post-Trade Monitoring
- Real-time PnL calculation
- Configurable exit conditions
- Automatic trade closure
- Manual override capabilities

## Error Handling

The trading module implements comprehensive error handling:

1. **Validation Errors**: Pre-trade checks prevent invalid trades
2. **Execution Errors**: Retry logic and rollback for failed orders
3. **Monitoring Errors**: Graceful handling of monitoring failures
4. **Network Errors**: Automatic retry with exponential backoff

## Logging

All trading operations are logged with structured logging:

- Trade execution events
- Validation results
- Error details with context
- Performance metrics
- PnL calculations

## Performance Considerations

- Asynchronous trade execution
- Non-blocking monitoring checks
- Efficient trade tracking with Map data structures
- Configurable check intervals to balance responsiveness and performance 