# Account State Synchronization System

This module provides a real-time, unified resilient account state synchronization system that keeps balances, positions, and active orders up to date across all exchanges.

## 🏗️ Architecture Overview

The system consists of several key components:

### Core Components

1. **AccountStateManager** - Central state store that maintains unified account data
2. **AccountSyncService** - High-level service that orchestrates WebSocket streams and REST snapshots
3. **BasePrivateWebSocketClient** - Abstract base class for exchange-specific WebSocket clients
4. **Exchange-specific WebSocket Clients** - Implementations for Binance, Bybit, OKX, and Bitget

### Data Flow

```
Exchange APIs (WebSocket + REST)
    ↓
Exchange-specific Adapters
    ↓
AccountStateManager (Unified State Store)
    ↓
Arbitrage Engine / Trade Executor
```

## 📊 Data Models

### Unified Interfaces

```typescript
interface BalanceInfo {
  asset: string
  total: number
  available: number
}

interface PositionInfo {
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number
  leverage: number
  unrealizedPnL: number
}

interface OrderInfo {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'limit' | 'market'
  price: number
  quantity: number
  status: OrderStatus
  timestamp: number
}
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { AccountSyncService } from '../core/state'
import { WebSocketConfig, ExchangeConfig } from '../adapters'

// Configure exchanges
const exchangeConfigs = [
  {
    exchangeId: 'binance',
    wsConfig: {
      apiKey: 'your-api-key',
      apiSecret: 'your-api-secret',
      maxStreamsPerConnection: 10,
      reconnectInterval: 5000
    },
    restConfig: {
      apiKey: 'your-api-key',
      apiSecret: 'your-api-secret'
    }
  }
]

// Initialize service
const accountSyncService = new AccountSyncService()

// Listen for updates
accountSyncService.on('accountUpdate', (update) => {
  console.log(`${update.exchange} ${update.type} updated`)
})

// Start synchronization
await accountSyncService.initialize(exchangeConfigs)

// Access state
const stateManager = accountSyncService.getAccountStateManager()
const balances = stateManager.getBalances('binance')
const positions = stateManager.getPositions('binance')
const orders = stateManager.getOrders('binance')
```

### Advanced Usage

```typescript
// Get specific data
const usdtBalance = stateManager.getAvailableBalance('binance', 'USDT')
const btcPosition = stateManager.getPosition('binance', 'BTCUSDT')
const activeOrders = stateManager.getActiveOrders('binance')

// Check state freshness
const isFresh = stateManager.isExchangeStateFresh('binance')

// Manual refresh
await accountSyncService.refreshExchangeState('binance')
await accountSyncService.refreshAllStates()

// Get summary
const summary = accountSyncService.getStateSummary()
```

## 🔧 Configuration

### WebSocket Configuration

```typescript
interface WebSocketConfig {
  apiKey?: string
  apiSecret?: string
  apiPass?: string
  wsUrl?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
  options?: Record<string, any>
}
```

### Exchange Configuration

```typescript
interface ExchangeConfig {
  apiKey: string
  apiSecret: string
  apiPass?: string
  options?: Record<string, any>
}
```

## 📡 Supported Exchanges

### Currently Supported
- **Binance** - Full WebSocket and REST support
- **Bybit** - Full WebSocket and REST support  
- **OKX** - Full WebSocket and REST support
- **Bitget** - Full WebSocket and REST support

### Adding New Exchanges

To add a new exchange:

1. Create WebSocket client in `src/adapters/websocket/private/{exchange}.ts`
2. Extend `BasePrivateWebSocketClient`
3. Implement message parser for the exchange's data format
4. Add REST client in `src/adapters/rest/{exchange}.ts`
5. Update `AccountSyncService` to support the new exchange

## 🔄 Synchronization Strategy

### Real-time Updates
- WebSocket streams provide real-time balance, position, and order updates
- Automatic reconnection on connection loss
- Event-driven architecture for immediate state updates

### Fallback Mechanism
- REST snapshots performed on initialization
- Periodic REST snapshots every 5 minutes as fallback
- Manual refresh capabilities for data recovery

### Data Normalization
- All exchange-specific statuses normalized to unified enums
- Consistent data structures across all exchanges
- Timestamp tracking for data freshness

## 🛡️ Error Handling

### Connection Resilience
- Automatic WebSocket reconnection with exponential backoff
- Graceful degradation to REST-only mode if WebSocket fails
- Connection health monitoring

### Data Validation
- Type checking for all incoming data
- Fallback values for missing fields
- Error logging with context

## 📈 Performance Considerations

### Memory Usage
- In-memory state store for fast access
- Configurable data retention policies
- Efficient data structures for high-frequency updates

### Network Optimization
- Connection pooling for WebSocket streams
- Rate limiting awareness
- Efficient message parsing

## 🔍 Monitoring & Debugging

### Logging
- Structured logging with exchange context
- Different log levels for development/production
- Performance metrics tracking

### State Inspection
```typescript
// Get connection status
const isConnected = accountSyncService.isExchangeConnected('binance')

// Get last update times
const lastUpdate = stateManager.getLastUpdateTime('binance', 'balances')

// Get state summary
const summary = accountSyncService.getStateSummary()
```

## 🧪 Testing

### Unit Tests
- Test individual components in isolation
- Mock exchange APIs for consistent testing
- Validate data normalization logic

### Integration Tests
- Test full synchronization flow
- Validate real-time update handling
- Test error recovery scenarios

## 🔮 Future Enhancements

### Planned Features
- Database persistence for historical data
- Advanced filtering and querying capabilities
- Real-time analytics and alerts
- Multi-account support per exchange

### Performance Improvements
- WebSocket connection multiplexing
- Intelligent snapshot scheduling
- Caching layer for frequently accessed data

## 📚 API Reference

### AccountStateManager

#### Methods
- `getBalances(exchange: string): BalanceInfo[]`
- `getPositions(exchange: string): PositionInfo[]`
- `getOrders(exchange: string): OrderInfo[]`
- `updateBalances(exchange: string, balances: BalanceInfo[]): void`
- `updatePositions(exchange: string, positions: PositionInfo[]): void`
- `updateOrders(exchange: string, orders: OrderInfo[]): void`
- `getAvailableBalance(exchange: string, asset: string): number`
- `getPosition(exchange: string, symbol: string): PositionInfo | null`
- `getActiveOrders(exchange: string): OrderInfo[]`

### AccountSyncService

#### Methods
- `initialize(configs: ExchangeAccountConfig[]): Promise<void>`
- `getAccountStateManager(): AccountStateManager`
- `refreshExchangeState(exchangeId: string): Promise<void>`
- `refreshAllStates(): Promise<void>`
- `shutdown(): Promise<void>`

#### Events
- `accountUpdate` - Emitted when account data is updated

## 🤝 Contributing

When contributing to this module:

1. Follow the existing code structure and patterns
2. Add comprehensive error handling
3. Include unit tests for new functionality
4. Update documentation for new features
5. Ensure backward compatibility

## 📄 License

This module is part of the ArbiNet system and follows the same licensing terms. 