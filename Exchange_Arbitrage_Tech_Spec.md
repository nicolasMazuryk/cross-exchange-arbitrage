# 🔧 Technical Specification Document

## Project: Exchange-Arbitrage - Automated Spatial Crypto Arbitrage System

---

## 1. Overview

This document details the technical implementation of the exchange-arbitrage high-frequency system. It includes module design, data structures, interfaces, algorithms, error handling strategies, and deployment considerations.

---

## 2. System Architecture

### 2.1 Architecture Style
- **Service-Oriented Modular Architecture**
- **Stateless core services**
- **Event-driven via internal message queue (optional)**

### 2.2 Primary Components
1. **Exchange Adapter Layer**  
2. **Orderbook Manager**  
3. **Arbitrage Engine**  
4. **Trade Execution Engine**  
5. **Trade Monitor**  
6. **Risk Manager**  
7. **Config & Secrets Manager**  
8. **Logger & Metrics Layer**

---

## 3. Data Flow

1. Adapters connect to WebSockets for USDT perpetual futures markets.
2. Incoming messages (snapshot + delta) are normalized and sent to Orderbook Manager.
3. Orderbook Manager maintains real-time books and emits top-of-book changes.
4. Arbitrage Engine scans every possible cross-exchange pair and scores them.
5. If a profitable opportunity is found, Trade Execution is triggered.
6. Trade Execution executes orders and notifies Trade Monitor.
7. Trade Monitor oversees trade health and triggers exit logic if needed.

---

## 4. Component Design

### 4.1 Exchange Adapter
**Responsibilities:**
- Connect to WebSocket API and subscribe to orderbook streams
- Reconnect and re-subscribe logic
- Maintain REST API client for order placement, balance checks
- Rate limit-aware request scheduler

**Structure:**
- `src/adapters/websocket/{exchangeName}.ts`
- `src/adapters/rest/{exchangeName}.ts`

**Interfaces:**
```ts
interface ExchangeAdapter {
  subscribeOrderBook(pair: string): void;
  getBalance(asset: string): Promise<number>;
  placeOrder(params: TradeParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
}
```

**NPM Libraries for WebSocket Handling:**
- Binance: https://www.npmjs.com/package/binance → `npm i binance`
- Bybit: https://www.npmjs.com/package/bybit-api → `npm i bybit-api`
- OKX: https://www.npmjs.com/package/okx-api → `npm i okx-api`
- Bitget: https://www.npmjs.com/package/bitget-api → `npm i bitget-api`
- Gate.io: https://www.npmjs.com/package/gateio-api → `npm i gateio-api`

**NPM Library for REST API Calls:**
- CCXT (multi-exchange unified client): https://www.npmjs.com/package/ccxt → `npm i ccxt`

### 4.2 Orderbook Manager
**Responsibilities:**
- Maintain in-memory books per exchange/pair
- Process snapshot + delta
- Emit changes on top-of-book
- Resync logic on checksum mismatch

**Structure:**
- `src/core/orderbook/orderbookManager.ts`

**Data Structures:**
```ts
interface OrderBookLevel {
  price: number;
  quantity: number;
  amount: number;
}

interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastUpdateId: number;
}
```

### 4.3 Arbitrage Engine
**Responsibilities:**
- Compare top-of-book across exchanges
- Apply fees, slippage models, latency buffers
- Score opportunities based on configurable thresholds

**Structure:**
- `src/core/arbitrage/arbitrageEngine.ts`

**Algorithm:**
1. For every `(pair, exchA, exchB)`
2. Compare `bid(exchA) - ask(exchB)` and vice versa
3. Subtract fees/slippage
4. If profit > threshold, create signal

### 4.4 Trade Execution Engine
**Responsibilities:**
- Execute paired trades across exchanges
- Validate balances, volumes, rate limits
- Retry logic on failure

**Structure:**
- `src/core/trading/tradeExecutor.ts`

**Flow:**
1. Check balance and margin availability on both sides
2. Place market or limit order depending on config
3. If one leg fails, trigger fallback (hedge or cancel)
4. Record results and send to Trade Monitor

### 4.5 Trade Monitor
**Responsibilities:**
- Track lifecycle of trade pairs
- Compute live and realized PnL
- Trigger exit logic if conditions are met

**Structure:**
- `src/core/trading/tradeMonitor.ts`

**Exit Conditions:**
- Target reached
- Reverse arbitrage opportunity appears
- Max hold time exceeded

---

## 5. Risk Management

### 5.1 Pre-Trade Validation
- Account balance
- Open position limits
- Per-trade volume cap
- Expected slippage vs depth

### 5.2 Execution Safety
- Stop-loss fallback on incomplete fills
- Market rescue orders if order stuck
- Per-exchange cooldowns after failures

### 5.3 Post-Trade Monitoring
- Watchdog timers for stale positions
- Auto-cancel orphaned orders
- Funding fee estimation (for long holds)

---

## 6. Configuration & Secrets

**Structure:**
- `config/{env}.yaml` for parameters
- `.env` for API keys, secrets

---

## 7. Logging & Metrics

**Logging:**
- Winston-based structured logger
- Log levels: debug/info/warn/error

**Metrics:**
- Prometheus: order latency, WS uptime, trades executed, error rates
- Grafana dashboards for:
  - PnL/time
  - Trade latency
  - Missed opportunities
  - System health

---

## 8. Testing Strategy

### Unit Tests:
- Adapters, parsing, trade calc logic (Jest)

### Integration Tests:
- Simulated trade loop with fake orderbook
- WebSocket mock server

---

## 9. Deployment

### Runtime:
- Node.js v20+
- Docker containerized

### Orchestration:
- PM2

### Environment:
- dev / prod config separation

---

This document enables engineering teams to confidently implement the system with clarity on each module’s responsibility, interconnection, failure handling, and extensibility.