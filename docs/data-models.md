# Data Models

## Overview

This document describes the data models and type definitions used throughout the ArbiNet system. All models are defined in TypeScript and represent the core entities for trading operations, account management, and market data.

## Account Models

### BalanceInfo

Represents account balance for a specific asset.

```typescript
interface BalanceInfo {
  asset: string      // Currency code (e.g., "USDT", "BTC")
  total: number      // Total balance including locked funds
  available: number  // Available balance (not locked in orders)
}
```

**Usage:**
- Account state snapshots
- Balance validation before trades
- Available balance calculations

### PositionInfo

Represents an open position on an exchange.

```typescript
interface PositionInfo {
  id: string                    // Position identifier
  symbol: string                // Trading pair symbol
  side: PositionSide            // "LONG" | "SHORT"
  size: number                  // Position size (contracts)
  entryPrice: number            // Average entry price
  leverage: number               // Leverage multiplier
  unrealizedPnL: number         // Unrealized profit/loss
  timestamp: number              // Last update timestamp (ms)
  date: Date                     // Last update date
}
```

**Usage:**
- Position tracking
- PnL calculations
- Risk management

### OrderInfo

Represents an order (open, filled, or cancelled).

```typescript
interface OrderInfo {
  id: string                    // Exchange-assigned order ID
  clientOrderId: string          // Client-specified order ID
  exchange: string               // Exchange name
  symbol: string                // Trading pair symbol
  orderSide: OrderSide          // "BUY" | "SELL"
  positionSide: PositionSide    // "LONG" | "SHORT"
  type: OrderType               // "MARKET" | "LIMIT"
  price: number                 // Order price
  averagePrice: number          // Average fill price
  quantity: number              // Order quantity
  status: OrderStatus           // Order status
  timestamp: number             // Order timestamp (ms)
  date: Date                    // Order date
  expectedPrice?: number        // Expected execution price
  leverage?: number             // Leverage used
  latencyMs?: number           // Order execution latency
  feesUsd?: number              // Fees paid in USD
  slippagePercent?: number      // Slippage percentage
}
```

**OrderStatus Values:**
- `NEW`: Order placed, not yet filled
- `PARTIALLY_FILLED`: Partially executed
- `FILLED`: Fully executed
- `CANCELED`: Cancelled by user or system
- `FAILED`: Order failed
- `UNKNOWN`: Status unknown

**Usage:**
- Order tracking
- Execution monitoring
- Performance analysis

### AccountState

Complete account state for an exchange.

```typescript
interface AccountState {
  balances: BalanceInfo[]       // All account balances
  positions: PositionInfo[]     // All open positions
  orders: OrderInfo[]          // All open orders
}
```

**Usage:**
- Account state snapshots
- State synchronization
- Trade validation

### AccountStateUpdate

Real-time account state update event.

```typescript
interface AccountStateUpdate {
  exchange: string              // Exchange name
  type: 'balance' | 'position' | 'order'
  data: BalanceInfo[] | PositionInfo[] | OrderInfo[]
  timestamp: number            // Update timestamp (ms)
  traceId: string              // Trace ID for correlation
}
```

**Usage:**
- WebSocket account updates
- State synchronization
- Event-driven updates

## Trading Models

### TradeParams

Parameters for executing a trade.

```typescript
interface TradeParams {
  opportunity: ArbitrageOpportunity  // Arbitrage opportunity details
  timestamp: number                   // Trade initiation timestamp
}
```

### TradeResult

Result of a trade execution.

```typescript
interface TradeResult {
  id: string                  // Trade ID
  success: boolean            // Whether trade succeeded
  latencyMs: number           // Total execution latency
  buyOrder: OrderInfo | null  // Buy order result
  sellOrder: OrderInfo | null // Sell order result
  feesUsd: number             // Total fees in USD
  feesPercent: number         // Fees as percentage
  slippageUsd: number         // Total slippage in USD
  slippagePercent: number    // Slippage as percentage
}
```

**Usage:**
- Trade execution results
- Performance tracking
- PnL calculations

### TradeValidationResult

Result of trade validation.

```typescript
interface TradeValidationResult {
  isValid: boolean            // Whether trade is valid
  availableBalance: number    // Available balance
  requiredBalance: number    // Required balance for trade
}
```

### TrackedTrade

Complete tracked trade with entry and exit information.

```typescript
interface TrackedTrade {
  id: string                              // Trade ID
  status: 'open' | 'closed' | 'error'     // Trade status
  strategy: StrategyType                   // "funding" | "spread"
  exitReason?: 'convergence' | 'spread-widening' | 'timeout' | 'manual' | 'error'
  entryDate: string                       // Entry date (ISO string)
  exitDate?: string                       // Exit date (ISO string)
  entryTimestamp: number                  // Entry timestamp (ms)
  exitTimestamp?: number                  // Exit timestamp (ms)
  opportunity: ArbitrageOpportunity       // Original opportunity
  entryTrade: TradeResult                 // Entry trade result
  exitTrade?: TradeResult                 // Exit trade result
  spreadAtExitPercent?: number            // Spread at exit
  lastUpdateTimestamp: number             // Last update timestamp
  // Funding tracking
  buyExchangeNextFundingTimestamp?: number
  sellExchangeNextFundingTimestamp?: number
  fundingEvents?: FundingFeeCollectedEvent[]
  // PnL calculations
  feesUsd: { entry: number; exit: number; total: number }
  slippageUsd: { entry: number; exit: number; total: number }
  fundingUsd?: { buyExchange: number; sellExchange: number; net: number }
  deltaUsd: { buyExchange: number; sellExchange: number; net: number }
  feesPercent: { entry: number; exit: number; total: number }
  slippagePercent: { entry: number; exit: number; total: number }
  fundingPercent?: { buyExchange: number; sellExchange: number; net: number }
  deltaPercent: { buyExchange: number; sellExchange: number; net: number }
  deltaProfitUsd: number                  // Delta profit in USD
  deltaProfitPercent: number              // Delta profit percentage
  fundingProfitUsd: number                // Funding profit in USD
  fundingProfitPercent: number            // Funding profit percentage
  pnlUsd: number                          // Total PnL in USD
  pnlPercent: number                     // Total PnL percentage
}
```

**Usage:**
- Trade lifecycle tracking
- PnL calculations
- Performance analysis
- State persistence

## Market Data Models

### OrderBookLevel

Single level in an order book.

```typescript
interface OrderBookLevel {
  price: number      // Price level
  quantity: number   // Quantity at this price
  amount: number    // Total amount (price * quantity)
}
```

### OrderBook

Complete order book snapshot.

```typescript
interface OrderBook {
  bids: OrderBookLevel[]        // Buy orders (sorted descending)
  asks: OrderBookLevel[]        // Sell orders (sorted ascending)
  finalUpdateId: number         // Last update ID
  timestamp: number             // Snapshot timestamp (ms)
}
```

### OrderBookUpdate

Real-time order book update.

```typescript
interface OrderBookUpdate {
  type: 'snapshot' | 'delta'    // Update type
  exchange: string               // Exchange name
  symbol: string                // Trading pair symbol
  bids: OrderBookLevel[]        // Updated bid levels
  asks: OrderBookLevel[]        // Updated ask levels
  timestamp: number              // Update timestamp (ms)
  firstUpdateId?: number         // First update ID (for delta)
  finalUpdateId: number         // Final update ID
  sequence?: number             // Sequence number
  prevFinalUpdateId?: number     // Previous final update ID
  traceId: string               // Trace ID for correlation
}
```

### TopOfBook

Best bid and ask prices.

```typescript
interface TopOfBook {
  exchange: string              // Exchange name
  symbol: string                // Trading pair symbol
  bestBid: OrderBookLevel       // Best bid price
  bestAsk: OrderBookLevel        // Best ask price
  spreadPercent: number         // Spread percentage
  timestamp: number             // Timestamp (ms)
  traceId: string               // Trace ID
}
```

### MarketMetadata

Market metadata and constraints.

```typescript
interface MarketMetadata {
  symbol: string                // Exchange-specific symbol
  normalizedSymbol: string      // Cross-exchange normalized symbol
  contractSize: number          // Contract size multiplier
  pricePrecision: number        // Price precision (step size)
  amountPrecision: number       // Amount precision (step size)
  minPrice?: number             // Minimum price
  maxPrice?: number             // Maximum price
  minAmount?: number            // Minimum order amount
  maxAmount?: number            // Maximum order amount
  minCost?: number              // Minimum order cost
}
```

**Usage:**
- Order validation
- Price/amount normalization
- Symbol mapping across exchanges

## Arbitrage Models

### ArbitrageOpportunity

Detected arbitrage opportunity.

```typescript
interface ArbitrageOpportunity {
  id: string                              // Opportunity ID
  normalizedPair: string                  // Normalized trading pair
  buyExchangeSymbol: string               // Buy exchange symbol
  sellExchangeSymbol: string             // Sell exchange symbol
  buyExchange: string                     // Buy exchange name
  sellExchange: string                   // Sell exchange name
  avgBuyNormalizedExecutionPrice: number // Average buy execution price
  avgSellNormalizedExecutionPrice: number // Average sell execution price
  normalizedVolume: number                // Normalized volume
  buyExchangeVolume: number               // Buy exchange volume
  sellExchangeVolume: number              // Sell exchange volume
  orderAmountUsd: number                  // Order amount in USD
  confidenceScore: number                 // Confidence score (0-1)
  traceId: string                         // Trace ID
  orderbookUpdateTimestamp: number        // Orderbook update timestamp
  strategy: StrategyType                   // "funding" | "spread"
  // Funding tracking
  buyExchangeNextFundingTimestamp: number
  sellExchangeNextFundingTimestamp: number
  targetFundingTimestamp: number
  // Profitability metrics
  costs: number                            // Total costs
  costsPercent: number                     // Costs as percentage
  spreadProfitUsd: number                  // Spread profit in USD
  spreadProfitPercent: number              // Spread profit percentage
  fundingProfitUsd: number                 // Funding profit in USD
  fundingProfitPercent: number             // Funding profit percentage
  estimatedProfitUsd: number               // Estimated total profit
  estimatedProfitPercent: number           // Estimated profit percentage
}
```

**Usage:**
- Opportunity detection
- Trade execution
- Performance analysis

## Funding Models

### RawFundingRate

Raw funding rate data from exchange.

```typescript
interface RawFundingRate {
  symbol: string                // Exchange-native symbol
  fundingRate?: number           // Funding rate (decimal)
  fundingIntervalHours?: number // Funding interval in hours
  nextFundingTime?: number      // Next funding timestamp (ms)
  timestamp?: number            // Data fetch timestamp (ms)
}
```

### ParsedFunding

Normalized funding rate data.

```typescript
interface ParsedFunding {
  exchange: string               // Exchange name
  symbol: string                // Trading pair symbol
  fundingRate: number           // Funding rate (decimal, e.g., 0.0001)
  fundingRatePercent: number    // Funding rate percentage (e.g., 0.01%)
  fundingInterval: number       // Funding interval in hours (1, 2, 4, 8)
  nextFundingTimestamp: number  // Next funding timestamp (ms)
  nextFundingDatetime: Date    // Next funding datetime
}
```

**Usage:**
- Funding rate tracking
- Funding arbitrage calculations
- Profit projections

### FundingRateHistory

Historical funding rate record.

```typescript
interface FundingRateHistory {
  symbol: string                // Trading pair symbol
  fundingRate: number           // Funding rate (decimal)
  actualTimestamp: number       // Actual funding timestamp (ms)
  timestamp: number             // Record timestamp (ms)
  datetime: string              // ISO datetime string
  info?: any                    // Exchange-specific data
}
```

### FundingFeeHistory

Historical funding fee payment record.

```typescript
interface FundingFeeHistory {
  symbol: string                // Trading pair symbol
  amount: number                // Fee amount
  id: string                    // Fee record ID
  code: string                  // Currency code
  actualTimestamp: number       // Actual fee timestamp (ms)
  timestamp: number             // Record timestamp (ms)
  datetime: string              // ISO datetime string
  info?: any                    // Exchange-specific data
}
```

### FundingFeeCollectedEvent

Funding fee collection event for a tracked trade.

```typescript
interface FundingFeeCollectedEvent {
  netFundingRatePercent: number           // Net funding rate percentage
  buyExchangeFundingRatePercent: number   // Buy exchange funding rate
  sellExchangeFundingRatePercent: number  // Sell exchange funding rate
  netFundingFeeUsd: number                // Net funding fee in USD
  buyExchangeFundingFeeUsd: number         // Buy exchange fee
  sellExchangeFundingFeeUsd: number        // Sell exchange fee
  buyExchangeActualFundingDate: string    // Buy exchange funding date
  sellExchangeActualFundingDate: string   // Sell exchange funding date
  fundingTimestamp: number                 // Funding timestamp (ms)
  fundingDate: string                      // Funding date (ISO string)
}
```

**Usage:**
- Funding fee tracking
- PnL calculations
- Trade performance analysis

## State Models

### AppState

Application state persisted in Redis.

```typescript
interface AppState {
  trackedTrades: TrackedTrade[]  // All tracked trades
  lastUpdateTimestamp: number    // Last update timestamp (ms)
}
```

**Usage:**
- State persistence
- State recovery on restart
- Multi-instance coordination

### ExchangeState

Per-exchange account state.

```typescript
interface ExchangeState {
  balances: BalanceInfo[]        // Account balances
  positions: PositionInfo[]      // Open positions
  orders: OrderInfo[]           // Open orders
  lastUpdate: {
    balances: number             // Last balance update timestamp
    positions: number           // Last position update timestamp
    orders: number              // Last order update timestamp
  }
}
```

**Usage:**
- Account state management
- State freshness tracking
- Trade validation

## Type Enums

### OrderSide
```typescript
type OrderSide = 'BUY' | 'SELL'
```

### OrderType
```typescript
type OrderType = 'MARKET' | 'LIMIT'
```

### OrderStatus
```typescript
type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'FAILED' | 'UNKNOWN'
```

### PositionSide
```typescript
type PositionSide = 'LONG' | 'SHORT'
```

### StrategyType
```typescript
type StrategyType = 'funding' | 'spread'
```

### MarketType
```typescript
enum MarketType {
  SPOT = 'spot',
  FUTURES = 'futures'
}
```

## Exchange Models

### ExchangeMeta

Exchange metadata.

```typescript
interface ExchangeMeta {
  name: string           // Exchange name
  isHealthy: boolean      // Health status
  feeModel: FeeModel     // Fee structure
}
```

### FeeModel

Exchange fee structure.

```typescript
interface FeeModel {
  maker: number          // Maker fee percentage (e.g., 0.02 for 0.02%)
  taker: number          // Taker fee percentage (e.g., 0.05 for 0.05%)
}
```

## Data Relationships

### Trade Lifecycle

```
ArbitrageOpportunity
    ↓
TradeParams
    ↓
TradeResult (entry)
    ↓
TrackedTrade (open)
    ↓
FundingFeeCollectedEvent[] (periodic)
    ↓
TradeResult (exit)
    ↓
TrackedTrade (closed)
```

### Account State Hierarchy

```
ExchangeState
    ├── BalanceInfo[]
    ├── PositionInfo[]
    └── OrderInfo[]
```

### Market Data Flow

```
OrderBookUpdate (WebSocket)
    ↓
OrderBook (in-memory)
    ↓
TopOfBook (calculated)
    ↓
ArbitrageOpportunity (detected)
```

## Data Persistence

### Redis Keys

- `{prefix}tracked-trades`: JSON array of `TrackedTrade[]`
- Exchange-specific keys for account state (if needed)

### Data Serialization

- All data stored as JSON strings in Redis
- Timestamps stored as Unix milliseconds
- Dates stored as ISO strings in JSON

## Data Validation

### Required Fields

Most models have required fields that must be present:
- IDs: Always required
- Timestamps: Always required for temporal data
- Exchange names: Required for multi-exchange operations

### Optional Fields

Optional fields are marked with `?` in TypeScript:
- `expectedPrice?`: May not be available for market orders
- `exitDate?`: Only present for closed trades
- `fundingUsd?`: Only present for funding strategy trades

