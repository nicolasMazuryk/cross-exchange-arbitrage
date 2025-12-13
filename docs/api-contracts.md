# API Contracts

## Overview

ArbiNet integrates with multiple cryptocurrency exchanges through REST and WebSocket APIs. This document describes the API contracts used for trading operations, market data, and account management.

## Exchange Support

The system supports the following exchanges:
- **Binance** - Binance Futures
- **Bybit** - Bybit Derivatives
- **OKX** - OKX Perpetual Futures
- **Bitget** - Bitget Perpetual Futures

## REST API Interface

### Base Interface: `RestClientInterface`

All exchange adapters implement the `RestClientInterface` which provides a unified API contract:

```typescript
interface RestClientInterface {
  // Market data
  loadMarkets(): Promise<Dictionary<Market>>
  getTradingMarkets(): Dictionary<Market>

  // Trading
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    reduceOnly?: boolean,
    clientOrderId?: string
  ): Promise<Order>
  cancelOrder(id: string, symbol: string): Promise<Order>

  // Account
  fetchBalancesSnapshot?(): Promise<BalanceInfo[]>
  fetchPositionsSnapshot?(): Promise<PositionInfo[]>
  fetchOrdersSnapshot?(symbol?: string): Promise<OrderInfo[]>

  // Funding
  fetchFundingData?(): Promise<Map<string, ParsedFunding>>
  fetchFundingRateHistory(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: any
  ): Promise<FundingRateHistory[]>
  fetchFundingFeeHistory(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: any
  ): Promise<FundingFeeHistory[]>

  // Utility
  getExchangeId(): string
}
```

## API Endpoints

### Market Data Endpoints

#### `loadMarkets()`
Loads all available markets from the exchange.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required (API key)

**Response:**
- Type: `Promise<Dictionary<Market>>`
- Description: Dictionary of market objects keyed by symbol

**Example:**
```typescript
const markets = await exchange.loadMarkets()
```

#### `getTradingMarkets()`
Returns filtered USDT perpetual futures markets available for trading.

**Request:**
- Method: Local filtering
- Parameters: None

**Response:**
- Type: `Dictionary<Market>`
- Description: Filtered markets (USDT perpetual futures, excluding ignored markets)

**Filters Applied:**
- Quote currency: USDT
- Market type: Perpetual swap
- Active status: true
- Excludes inverse markets
- Excludes markets in `ignoredMarkets` config

### Trading Endpoints

#### `createOrder()`
Creates a new order on the exchange.

**Request:**
- Method: `POST` (via CCXT)
- Authentication: Required (API key + secret)
- Parameters:
  - `symbol` (string): Trading pair symbol (e.g., "BTCUSDT", "BTC/USDT:USDT")
  - `type` (string): Order type - "MARKET" or "LIMIT"
  - `side` (string): Order side - "BUY" or "SELL"
  - `amount` (number): Order quantity
  - `price` (number, optional): Limit price (required for LIMIT orders)
  - `reduceOnly` (boolean, optional): Reduce-only flag for closing positions
  - `clientOrderId` (string, optional): Client-specified order ID

**Response:**
- Type: `Promise<Order>`
- Description: Order object with exchange-assigned ID and status

**Exchange-Specific Behavior:**
- **Binance**: Sets leverage before order creation
- **Bybit**: Leverage set separately (not in order params)
- **OKX**: Uses `tdMode` parameter for margin mode
- **Bitget**: Uses `marginMode` parameter

**Example:**
```typescript
const order = await exchange.createOrder(
  'BTCUSDT',
  'MARKET',
  'BUY',
  0.001,
  undefined, // price not needed for market orders
  false,
  'client-order-123'
)
```

#### `cancelOrder()`
Cancels an existing order.

**Request:**
- Method: `DELETE` (via CCXT)
- Authentication: Required
- Parameters:
  - `id` (string): Exchange-assigned order ID
  - `symbol` (string): Trading pair symbol

**Response:**
- Type: `Promise<Order>`
- Description: Cancelled order object with updated status

**Example:**
```typescript
const cancelledOrder = await exchange.cancelOrder('12345', 'BTCUSDT')
```

### Account Endpoints

#### `fetchBalancesSnapshot()`
Fetches current account balances.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required

**Response:**
- Type: `Promise<BalanceInfo[]>`
- Description: Array of balance objects

**BalanceInfo Structure:**
```typescript
interface BalanceInfo {
  asset: string      // Currency code (e.g., "USDT")
  total: number      // Total balance
  available: number  // Available balance (not in open orders)
}
```

#### `fetchPositionsSnapshot()`
Fetches current open positions.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required

**Response:**
- Type: `Promise<PositionInfo[]>`
- Description: Array of position objects

**PositionInfo Structure:**
```typescript
interface PositionInfo {
  id: string
  symbol: string
  side: PositionSide      // "LONG" | "SHORT"
  size: number
  entryPrice: number
  leverage: number
  unrealizedPnL: number
  timestamp: number
  date: Date
}
```

#### `fetchOrdersSnapshot()`
Fetches current open orders.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required
- Parameters:
  - `symbol` (string, optional): Filter by symbol

**Response:**
- Type: `Promise<OrderInfo[]>`
- Description: Array of order objects

**OrderInfo Structure:**
```typescript
interface OrderInfo {
  id: string
  clientOrderId: string
  exchange: string
  symbol: string
  orderSide: OrderSide      // "BUY" | "SELL"
  positionSide: PositionSide // "LONG" | "SHORT"
  type: OrderType           // "MARKET" | "LIMIT"
  price: number
  averagePrice: number
  quantity: number
  status: OrderStatus
  timestamp: number
  date: Date
  expectedPrice?: number
  leverage?: number
  latencyMs?: number
  feesUsd?: number
  slippagePercent?: number
}
```

### Funding Endpoints

#### `fetchFundingData()`
Fetches current funding rates for all symbols (optional method).

**Request:**
- Method: Exchange-specific (browser automation for some exchanges)
- Authentication: Not required (public data)

**Response:**
- Type: `Promise<Map<string, ParsedFunding>>`
- Description: Map of symbol to parsed funding data

**ParsedFunding Structure:**
```typescript
interface ParsedFunding {
  exchange: string
  symbol: string
  fundingRate: number              // Decimal rate (e.g., 0.0001)
  fundingRatePercent: number       // Percentage (e.g., 0.01%)
  fundingInterval: number          // Hours (1, 2, 4, 8)
  nextFundingTimestamp: number    // Unix timestamp (ms)
  nextFundingDatetime: Date
}
```

#### `fetchFundingRateHistory()`
Fetches historical funding rate data.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required
- Parameters:
  - `symbol` (string, optional): Trading pair symbol
  - `since` (number, optional): Start timestamp (ms)
  - `limit` (number, optional): Number of records
  - `params` (any, optional): Exchange-specific parameters

**Response:**
- Type: `Promise<FundingRateHistory[]>`
- Description: Array of historical funding rate records

#### `fetchFundingFeeHistory()`
Fetches historical funding fee payments.

**Request:**
- Method: Exchange-specific (via CCXT)
- Authentication: Required
- Parameters: Same as `fetchFundingRateHistory()`

**Response:**
- Type: `Promise<FundingFeeHistory[]>`
- Description: Array of historical funding fee records

## WebSocket API

### Public WebSocket Interface

Public WebSocket connections are used for real-time market data (orderbooks, trades).

**Base Interface:** `PublicWebSocketClientInterface`

```typescript
interface PublicWebSocketClientInterface {
  initialize(markets: Dictionary<Market>): Promise<void>
  subscribe(symbols: string[]): Promise<void>
  unsubscribe(symbols: string[]): Promise<void>
  close(): Promise<void>
}
```

**Events Emitted:**
- `orderbook-update`: Real-time orderbook updates
- `error`: Connection or parsing errors
- `reconnect`: Reconnection events

**Connection Management:**
- Automatic reconnection on disconnect
- Batch subscription management (respects exchange limits)
- Multiple connections per exchange for high symbol counts

### Private WebSocket Interface

Private WebSocket connections are used for account updates (balances, positions, orders).

**Base Interface:** `PrivateWebSocketClientInterface`

```typescript
interface PrivateWebSocketClientInterface {
  initialize(): Promise<void>
  subscribe(): Promise<void>
  close(): Promise<void>
}
```

**Events Emitted:**
- `account-update`: Account state changes
- `error`: Connection or authentication errors
- `reconnect`: Reconnection events

**Authentication:**
- API key + secret required
- Exchange-specific authentication methods (API key, signature, timestamp)

## Exchange-Specific Details

### Binance
- **REST Base**: Uses CCXT `binance` exchange
- **WebSocket**: Binance Futures WebSocket API
- **Max Streams**: 1024 streams per connection
- **Funding**: Browser automation required for funding rate fetching

### Bybit
- **REST Base**: Uses CCXT `bybit` exchange
- **WebSocket**: Bybit V5 WebSocket API
- **Max Streams**: 60 streams per connection
- **Leverage**: Set separately, not in order params

### OKX
- **REST Base**: Uses CCXT `okx` exchange
- **WebSocket**: OKX V5 WebSocket API
- **Max Streams**: 100 streams per connection
- **Order Params**: Requires `tdMode` (margin mode) parameter

### Bitget
- **REST Base**: Uses CCXT `bitget` exchange
- **WebSocket**: Bitget WebSocket API
- **Max Streams**: 1000 streams per connection
- **Order Params**: Requires `marginMode` parameter

## Error Handling

All API methods throw errors on failure:
- Network errors: Connection timeouts, network failures
- API errors: Invalid parameters, rate limits, authentication failures
- Exchange errors: Exchange-specific error responses

**Error Response Format:**
- Structured logging with error details
- Error propagation through service layers
- Automatic retry logic for transient failures

## Rate Limiting

Each exchange has rate limits:
- **Binance**: 1200 requests per minute (weighted)
- **Bybit**: 120 requests per second
- **OKX**: 20 requests per 2 seconds
- **Bitget**: 10 requests per second

The system respects these limits through:
- Request queuing
- Exponential backoff on rate limit errors
- Connection pooling

## Authentication

All authenticated endpoints require:
- **API Key**: Provided via environment variables
- **API Secret**: Provided via environment variables
- **API Passphrase** (OKX/Bitget): Provided via environment variables

**Security:**
- Credentials stored in environment variables only
- Never logged or exposed in code
- Signature-based authentication for WebSocket connections

