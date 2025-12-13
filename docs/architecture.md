# Architecture Documentation

## Executive Summary

ArbiNet is an automated spatial crypto arbitrage trading system that monitors multiple cryptocurrency exchanges in real-time, detects arbitrage opportunities, and executes trades automatically. The system is built with TypeScript/Node.js using a service-oriented architecture with adapter patterns for exchange integrations.

## System Overview

### Purpose

ArbiNet exploits price differences and funding rate differences across multiple cryptocurrency exchanges to generate profit through:
- **Funding Arbitrage**: Exploiting funding rate differences between exchanges
- **Spread Arbitrage**: Exploiting price spread differences between exchanges

### Key Capabilities

- Real-time orderbook monitoring across 4+ exchanges
- Automated opportunity detection with confidence scoring
- Risk-managed trade execution
- Trade monitoring and automated exit management
- State persistence and recovery
- Multi-strategy support (funding, spread)

## Technology Stack

See [Technology Stack](./technology-stack.md) for detailed information.

**Summary:**
- **Runtime**: Node.js 22.12
- **Language**: TypeScript 5.3.3
- **Architecture**: Service-Oriented with Adapter Pattern
- **State**: Redis for persistence
- **Logging**: Pino structured logging
- **Deployment**: Docker containers on AWS EC2

## Architecture Pattern

### Service-Oriented Architecture (SOA)

The application is organized into discrete, loosely-coupled services:

1. **Orchestration Service**: Coordinates all services
2. **Arbitrage Engine**: Detects trading opportunities
3. **Orderbook Manager**: Manages real-time market data
4. **Trading Services**: Execute and monitor trades
5. **State Services**: Manage account and application state
6. **Funding Services**: Collect and analyze funding rates

### Adapter Pattern

Exchange integrations use adapters to provide unified interfaces:
- **REST Adapters**: Unified REST API interface
- **WebSocket Adapters**: Unified WebSocket interface
- **Private WebSocket Adapters**: Account update streams

See [Architecture Patterns](./architecture-patterns.md) for detailed patterns.

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Orchestrator │  │ Arbitrage    │  │ Trading      │     │
│  │              │  │ Engine       │  │ Services     │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│  ┌──────▼──────────────────▼──────────────────▼──────┐     │
│  │         Orderbook Manager & State Services         │     │
│  └──────┬───────────────────────────────────────┬────┘     │
└─────────┼───────────────────────────────────────┼──────────┘
          │                                         │
┌─────────▼───────────────────────────────────────▼──────────┐
│                    Adapter Layer                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Binance  │  │ Bybit    │  │ OKX      │  │ Bitget   │  │
│  │ REST/WS │  │ REST/WS  │  │ REST/WS  │  │ REST/WS  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
└───────┼──────────────┼──────────────┼────────────┼─────────┘
        │              │              │            │
┌───────▼──────────────▼──────────────▼────────────▼─────────┐
│              Exchange APIs (External)                      │
│  Binance  │  Bybit  │  OKX  │  Bitget                      │
└────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Infrastructure Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Redis        │  │ CloudWatch   │  │ Docker       │     │
│  │ (State)      │  │ (Logging)    │  │ (Deployment) │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Component Architecture

See [Source Tree Analysis](./source-tree-analysis.md) for detailed structure.

**Core Components:**
- **Orchestrator**: Main coordinator, initializes all services
- **ArbitrageEngine**: Opportunity detection algorithm
- **OrderbookManager**: Real-time orderbook state management
- **TradeExecutor**: Trade execution with validation
- **TradeMonitor**: Trade lifecycle management
- **AccountSyncService**: Account state synchronization
- **FundingService**: Funding rate collection
- **State Service**: Redis persistence

## Data Architecture

### Data Flow

**Market Data Flow:**
```
Exchange WebSocket → WebSocket Adapter → OrderbookManager → ArbitrageEngine
```

**Account State Flow:**
```
Exchange Private WS → Private WS Adapter → AccountSyncService → AccountStateManager
Exchange REST API → REST Adapter → AccountSyncService → AccountStateManager
```

**Trade Execution Flow:**
```
ArbitrageEngine → TradeExecutor → REST Adapters → Exchange API
TradeExecutor → TradeMonitor → State (Redis)
```

### State Management

**In-Memory State:**
- Orderbook state (per exchange, per symbol)
- Account state (balances, positions, orders)
- Tracked trades
- Market metadata

**Persistent State (Redis):**
- Tracked trades (for recovery)
- Application state snapshots

See [Data Models](./data-models.md) for detailed data structures.

## API Design

### Exchange Integration

**REST API:**
- Market data loading
- Order creation and cancellation
- Account snapshots
- Funding rate history

**WebSocket API:**
- Real-time orderbook updates
- Account state updates
- Automatic reconnection

See [API Contracts](./api-contracts.md) for detailed API documentation.

## Component Overview

### Orchestrator

**Responsibilities:**
- Service initialization and coordination
- Lifecycle management
- Graceful shutdown
- Error handling

**Initialization Order:**
1. REST clients
2. Funding service
3. Core services
4. State service
5. Account sync service
6. Trading services
7. WebSocket clients
8. Funding fee collector

### Arbitrage Engine

**Responsibilities:**
- Real-time opportunity detection
- Confidence scoring
- Profitability calculations
- Strategy filtering (funding/spread)
- Temporal persistence validation

**Key Algorithms:**
- Orderbook depth simulation
- Slippage estimation
- Fee calculation
- Funding rate projection
- Opportunity scoring

### Trade Executor

**Responsibilities:**
- Trade validation
- Order placement
- Execution monitoring
- Fee and slippage tracking
- Error handling

**Execution Flow:**
1. Validate trade parameters
2. Check account state
3. Place buy order
4. Place sell order
5. Monitor execution
6. Calculate results

### Trade Monitor

**Responsibilities:**
- Track open trades
- Monitor exit conditions
- Execute exits
- Calculate PnL
- State persistence

**Exit Conditions:**
- Convergence (spread/funding)
- Spread widening
- Timeout
- Manual
- Error

### Orderbook Manager

**Responsibilities:**
- Real-time orderbook updates
- Snapshot and delta processing
- Top-of-book calculations
- Orderbook age tracking

### Account Sync Service

**Responsibilities:**
- WebSocket account updates
- Periodic REST snapshots
- State synchronization
- Reconnection handling

## Development Workflow

See [Development Guide](./development-guide.md) for setup and development.

**Key Points:**
- TypeScript for type safety
- Structured logging
- Trace context for correlation

## Deployment Architecture

See [Deployment Guide](./deployment-guide.md) for deployment details.

**Infrastructure:**
- AWS EC2
- Redis for state
- CloudWatch for logging
- Docker containers

**Deployment Flow:**
- Build Docker image
- Push to ECR
- Deploy via Terraform
- Monitor via CloudWatch

## Testing Strategy

**Current:**
- Jest for unit/integration tests
- TypeScript for type checking
- Manual testing in development

**Recommended:**
- Unit tests for core logic
- Integration tests for adapters
- End-to-end tests for workflows
- Performance tests

## Performance Considerations

### Optimization Strategies

**Connection Management:**
- Multiple WebSocket connections per exchange
- Batch symbol subscriptions
- Connection pooling

**State Management:**
- In-memory caching
- Efficient data structures
- State cleanup

**Processing:**
- Async I/O operations
- Worker threads for heavy tasks
- Batch processing

### Scalability

**Horizontal Scaling:**
- Stateless services (except Redis state)
- Distributed locks (Redlock)
- Shared Redis state

**Resource Management:**
- Memory-efficient algorithms
- Garbage collection awareness
- Connection limits

## Security Architecture

### Authentication

- API key + secret for exchanges
- Signature-based authentication
- Secure WebSocket (WSS)

### Data Protection

- Environment variables for secrets
- No sensitive data in logs
- Secure network communication

### Access Control

- IAM roles with least privilege
- Security groups for network access
- No admin permissions

## Monitoring and Observability

### Logging

- Structured JSON logs
- Trace context injection
- Multiple log levels
- CloudWatch integration

### Metrics (Planned)

- Event loop metrics
- GC metrics
- WebSocket metrics
- Trading metrics

## Error Handling

### Error Propagation

- Errors bubble through service layers
- Structured error logging
- Context preservation

### Recovery

- Automatic reconnection
- State recovery on restart
- Orphaned trade handling

## Future Enhancements

### Recommended Improvements

- CI/CD pipelines
- Automated testing
- Performance metrics
- Alerting system
- Dashboard for monitoring
- Additional exchanges
- Strategy optimizations

## Related Documentation

- [Technology Stack](./technology-stack.md)
- [Architecture Patterns](./architecture-patterns.md)
- [API Contracts](./api-contracts.md)
- [Data Models](./data-models.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [Development Guide](./development-guide.md)
- [Deployment Guide](./deployment-guide.md)
- [Comprehensive Analysis](./comprehensive-analysis.md)

