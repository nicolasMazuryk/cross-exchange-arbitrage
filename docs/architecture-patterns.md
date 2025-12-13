# Architecture Patterns

## Overview

ArbiNet implements a **Service-Oriented Architecture** with **Adapter Pattern** for exchange integrations, designed for high-frequency trading operations.

## Architectural Style

### Primary Pattern: Service-Oriented Architecture (SOA)

The application is organized into discrete, loosely-coupled services that communicate through well-defined interfaces:

- **Orchestration Service**: Coordinates all other services
- **Arbitrage Engine**: Detects trading opportunities
- **Orderbook Manager**: Manages real-time market data
- **Trading Services**: Execute and monitor trades
- **State Services**: Manage account and application state
- **Funding Services**: Collect and analyze funding rates

### Secondary Pattern: Adapter Pattern

Exchange integrations use the Adapter Pattern to provide a unified interface across multiple exchanges:

- **Base Classes**: Common functionality (`BaseExchange`, `BasePublicWebSocketClient`)
- **Exchange-Specific Implementations**: Handle exchange-specific protocols
- **Interface Contracts**: Ensure consistent behavior across adapters

## Component Architecture

### Layer Structure

```
┌─────────────────────────────────────────┐
│         Application Entry Point         │
│              (main.ts)                   │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│         Orchestration Layer             │
│        (orchestrator.ts)                │
│  - Coordinates all services             │
│  - Manages lifecycle                    │
│  - Handles graceful shutdown           │
└──────┬──────────────────────────────────┘
       │
       ├─────────────────┬─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│   Adapter   │  │ Core Services│  │   Utilities  │
│    Layer    │  │    Layer     │  │    Layer     │
│             │  │              │  │              │
│ REST/WS     │  │ Arbitrage    │  │ Config       │
│ Clients     │  │ Engine       │  │ Logger       │
│             │  │ Trading      │  │ Browser      │
│ Exchange    │  │ State        │  │ Utils        │
│ Specific    │  │ Funding      │  │              │
└─────────────┘  └──────────────┘  └──────────────┘
```

## Design Patterns Used

### 1. Event-Driven Architecture
- **Implementation**: Node.js `EventEmitter`
- **Purpose**: Decouple services and enable reactive programming
- **Usage**: 
  - Orderbook updates trigger arbitrage analysis
  - Account updates trigger state synchronization
  - Trade events trigger monitoring

### 2. Adapter Pattern
- **Implementation**: Base classes with exchange-specific subclasses
- **Purpose**: Unified interface for multiple exchange APIs
- **Benefits**:
  - Code reusability
  - Easy addition of new exchanges
  - Consistent error handling

### 3. Strategy Pattern
- **Implementation**: Strategy configuration in YAML
- **Purpose**: Enable different trading strategies (funding, spread)
- **Usage**: Strategy-specific entry/exit conditions

### 4. Observer Pattern
- **Implementation**: EventEmitter-based subscriptions
- **Purpose**: Real-time data propagation
- **Usage**: WebSocket message handlers, service state changes

### 5. Singleton Pattern (Implicit)
- **Implementation**: Service instances managed by Orchestrator
- **Purpose**: Single instance of critical services
- **Usage**: OrderbookManager, ArbitrageEngine, State services

## Data Flow Architecture

### Market Data Flow
```
Exchange WebSocket
    ↓
WebSocket Adapter
    ↓
Orderbook Manager
    ↓
Arbitrage Engine
    ↓
Trading Services
```

### State Management Flow
```
Exchange Account WebSocket
    ↓
Private WebSocket Adapter
    ↓
Account Sync Service
    ↓
Account State Manager
    ↓
Redis (Persistence)
```

### Trade Execution Flow
```
Arbitrage Opportunity
    ↓
Trade Executor
    ↓
REST Adapter
    ↓
Exchange API
    ↓
Trade Monitor
```

## Concurrency Model

- **Asynchronous Operations**: All I/O operations use async/await
- **Event Loop**: Node.js single-threaded event loop
- **Parallel Processing**: Multiple WebSocket connections per exchange
- **Distributed Locks**: Redlock for critical sections across instances

## State Management

- **In-Memory State**: Fast access for real-time operations
- **Redis Persistence**: Distributed state across instances
- **State Recovery**: Restore open trades on restart
- **Snapshot Intervals**: Periodic state snapshots

## Error Handling Strategy

- **Structured Logging**: Pino for all error logging
- **Graceful Degradation**: Continue operation on non-critical errors
- **Reconnection Logic**: Automatic WebSocket reconnection
- **Error Propagation**: Errors bubble up through service layers

## Scalability Considerations

- **Redis Distribution**: Shared state across instances
- **Connection Pooling**: Efficient WebSocket connection management
- **Batch Processing**: Group operations for efficiency

## Security Architecture

- **API Key Management**: Environment variables for sensitive data
- **Secure WebSocket**: WSS connections for private channels
- **Rate Limiting**: Respect exchange rate limits
- **Input Validation**: Validate all trading parameters

