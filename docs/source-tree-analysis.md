# Source Tree Analysis

## Overview

This document provides a comprehensive annotated directory tree of the ArbiNet project, highlighting critical folders, entry points, and key file locations.

## Project Root Structure

```
exchange-arbitrage/
├── config/                          # Configuration files
│   ├── development.yaml             # Development environment config
│   ├── funding.production.yaml      # Production config for funding strategy
│   └── spread.production.yaml       # Production config for spread strategy
│
├── docker/                          # Docker deployment files
│   ├── commands.txt                 # Docker commands reference
│   ├── deploy.sh                    # Deployment script
│   ├── Dockerfile.funding_arbitrage_bot  # Funding bot Dockerfile
│   ├── Dockerfile.spread_arbitrage_bot   # Spread bot Dockerfile
│   └── push-to-ecr.sh               # ECR push script
│
├── docs/                            # Generated documentation (output folder)
│   ├── project-scan-report.json     # Workflow state file
│   ├── existing-documentation-inventory.md
│   ├── user-provided-context.md
│   ├── technology-stack.md
│   ├── architecture-patterns.md
│   ├── api-contracts.md
│   ├── data-models.md
│   ├── comprehensive-analysis.md
│   └── source-tree-analysis.md      # This file
│
├── logs/                            # Application logs
│   ├── combined.log                 # All logs
│   └── error.log                    # Error logs only
│
├── redis-data/                      # Redis persistence data
│   └── appendonlydir/               # Redis AOF files
│
├── redis-dump/                      # Redis dump files
│   └── *.json                       # Trade state dumps
│
├── scripts/                         # Utility scripts
│   └── dump_redis.ts                # Redis dump utility
│
├── src/                             # Source code (main directory)
│   ├── adapters/                    # Exchange adapter layer
│   ├── core/                        # Core business logic
│   ├── main.ts                      # Application entry point ⭐
│   ├── types/                       # TypeScript type definitions
│   └── utils/                       # Utility functions
│
├── terraform/                       # Infrastructure as Code
│   ├── ecs-on-ec2/                  # ECS-specific configs
│   ├── main.tf                      # Main Terraform config
│   ├── variables.tf                  # Variable definitions
│   ├── outputs.tf                   # Output values
│   └── LOGGING_FLOW.md              # Logging architecture docs
│
├── xxxxxx/                          # Working/scratch directory
│   ├── artifacts/                   # Trade artifacts
│   ├── notes/                       # Strategy notes and docs
│   └── rules/                       # Trading rules
│
├── docker-compose.yml               # Local development setup
├── jest.config.js                   # Jest test configuration
├── package.json                     # Node.js dependencies and scripts
├── package-lock.json                # Dependency lock file
├── README.md                        # Project overview
└── tsconfig.json                    # TypeScript configuration
```

## Source Code Structure (`src/`)

### Entry Point

**`src/main.ts`** ⭐
- Application entry point
- Initializes orchestrator
- Sets up trace context
- Handles graceful shutdown
- Error handling and logging

### Adapters Layer (`src/adapters/`)

Exchange integration adapters providing unified interfaces.

```
src/adapters/
├── rest/                            # REST API adapters
│   ├── base.ts                      # Base REST exchange class
│   ├── binance.ts                   # Binance REST adapter
│   ├── bitget.ts                    # Bitget REST adapter
│   ├── bybit.ts                     # Bybit REST adapter
│   ├── okx.ts                       # OKX REST adapter
│   ├── index.ts                     # Adapter exports
│   └── types.ts                     # REST interface definitions
│
└── websocket/                       # WebSocket adapters
    ├── base.ts                      # Base WebSocket client
    ├── binance.ts                   # Binance WebSocket
    ├── bitget.ts                    # Bitget WebSocket
    ├── bybit.ts                     # Bybit WebSocket
    ├── okx.ts                       # OKX WebSocket
    ├── index.ts                     # WebSocket exports
    ├── types.ts                     # WebSocket type definitions
    └── private/                      # Private WebSocket adapters
        ├── base.ts                  # Base private WebSocket
        ├── binance.ts               # Binance private WebSocket
        ├── bitget.ts                # Bitget private WebSocket
        ├── bybit.ts                 # Bybit private WebSocket
        ├── okx.ts                   # OKX private WebSocket
        └── index.ts                 # Private adapter exports
```

**Purpose:**
- Unified interface across exchanges
- Exchange-specific protocol handling
- REST and WebSocket communication
- Authentication and connection management

### Core Services Layer (`src/core/`)

Core business logic and services.

```
src/core/
├── arbitrage/                       # Arbitrage detection engine
│   └── arbitrageEngine.ts          # Main arbitrage logic ⭐
│
├── funding/                         # Funding rate services
│   ├── fundingFeeCollector.ts      # Funding fee collection
│   ├── fundingService.ts           # Funding rate fetching
│   ├── index.ts                    # Funding exports
│   └── types.ts                    # Funding type definitions
│
├── markets/                         # Market metadata services
│   ├── marketMetadataService.ts    # Market data normalization
│   └── index.ts                    # Market exports
│
├── orchestration/                   # Application orchestration
│   ├── orchestrator.ts             # Main orchestrator ⭐
│   └── index.ts                    # Orchestration exports
│
├── orderbook/                       # Orderbook management
│   └── orderbookManager.ts         # Real-time orderbook state
│
├── state/                           # State management
│   ├── accountStateManager.ts      # In-memory account state
│   ├── accountSyncService.ts       # Account synchronization
│   ├── stateService.ts             # Redis state service
│   └── index.ts                    # State exports
│
└── trading/                         # Trading execution and monitoring
    ├── tradeExecutor.ts            # Trade execution logic ⭐
    ├── tradeMonitor.ts             # Trade monitoring and exit logic ⭐
    ├── utils.ts                    # Trading utilities
    └── index.ts                    # Trading exports
```

**Key Services:**
- **Orchestrator**: Coordinates all services, manages lifecycle
- **ArbitrageEngine**: Detects trading opportunities
- **TradeExecutor**: Executes trades
- **TradeMonitor**: Monitors open trades and manages exits
- **OrderbookManager**: Manages real-time market data
- **AccountSyncService**: Synchronizes account state

### Types (`src/types/`)

TypeScript type definitions.

```
src/types/
├── account.ts                       # Account-related types
│   └── BalanceInfo, PositionInfo, OrderInfo, AccountState
│
└── exchange.ts                      # Exchange-related types
    └── OrderSide, OrderType, OrderStatus, PositionSide, FeeModel
```

### Utilities (`src/utils/`)

Utility functions and helpers.

```
src/utils/
├── browser.ts                       # Browser automation (Playwright)
├── browser.types.ts                # Browser worker types
├── browser.worker.ts               # Browser worker thread
├── config.ts                       # Configuration loader ⭐
├── logger.ts                       # Logging infrastructure ⭐
├── traceContext.ts                 # Distributed tracing context
└── utils.ts                        # General utilities
```

**Key Utilities:**
- **config.ts**: Loads and validates configuration
- **logger.ts**: Structured logging with Pino
- **browser.ts**: Playwright-based browser automation for funding data
- **traceContext.ts**: Trace ID management for distributed tracing

## Critical Folders Summary

### 1. `src/core/orchestration/`
**Purpose**: Application lifecycle and service coordination
**Key File**: `orchestrator.ts`
**Critical**: Yes - Main application coordinator

### 2. `src/core/arbitrage/`
**Purpose**: Arbitrage opportunity detection
**Key File**: `arbitrageEngine.ts`
**Critical**: Yes - Core trading logic

### 3. `src/core/trading/`
**Purpose**: Trade execution and monitoring
**Key Files**: `tradeExecutor.ts`, `tradeMonitor.ts`
**Critical**: Yes - Trade execution logic

### 4. `src/adapters/`
**Purpose**: Exchange API integration
**Key Files**: All adapter implementations
**Critical**: Yes - Required for all exchange operations

### 5. `src/core/state/`
**Purpose**: State management and synchronization
**Key Files**: `accountStateManager.ts`, `accountSyncService.ts`, `stateService.ts`
**Critical**: Yes - Required for account state and trade tracking

### 6. `src/core/orderbook/`
**Purpose**: Real-time market data management
**Key File**: `orderbookManager.ts`
**Critical**: Yes - Required for opportunity detection

### 7. `config/`
**Purpose**: Application configuration
**Key Files**: YAML config files
**Critical**: Yes - Required for application operation

### 8. `src/utils/config.ts`
**Purpose**: Configuration loading and validation
**Critical**: Yes - Loaded at startup

### 9. `src/utils/logger.ts`
**Purpose**: Logging infrastructure
**Critical**: Yes - Used throughout application

### 10. `src/main.ts`
**Purpose**: Application entry point
**Critical**: Yes - Application startup

## Integration Points

### Service Dependencies

```
main.ts
  └── Orchestrator
      ├── REST Adapters (all exchanges)
      ├── WebSocket Adapters (all exchanges)
      ├── OrderbookManager
      ├── ArbitrageEngine
      │   ├── OrderbookManager
      │   ├── MarketMetadataService
      │   └── FundingService
      ├── AccountSyncService
      │   ├── AccountStateManager
      │   ├── REST Adapters
      │   └── Private WebSocket Adapters
      ├── TradeExecutor
      │   ├── AccountStateManager
      │   ├── REST Adapters
      │   ├── OrderbookManager
      │   └── MarketMetadataService
      ├── TradeMonitor
      │   ├── AccountStateManager
      │   ├── REST Adapters
      │   ├── OrderbookManager
      │   ├── MarketMetadataService
      │   ├── FundingService
      │   └── State (Redis)
      ├── FundingService
      │   ├── REST Adapters
      │   └── MarketMetadataService
      ├── FundingFeeCollector
      │   ├── REST Adapters
      │   ├── FundingService
      │   └── State (Redis)
      └── State (Redis)
```

### Data Flow

**Market Data Flow:**
```
Exchange WebSocket → WebSocket Adapter → OrderbookManager → ArbitrageEngine
```

**Account State Flow:**
```
Exchange Private WebSocket → Private WebSocket Adapter → AccountSyncService → AccountStateManager
Exchange REST API → REST Adapter → AccountSyncService → AccountStateManager
```

**Trade Execution Flow:**
```
ArbitrageEngine → TradeExecutor → REST Adapters → Exchange API
TradeExecutor → TradeMonitor → State (Redis)
```

## File Organization Principles

### Separation of Concerns
- **Adapters**: Exchange-specific protocol handling
- **Core**: Business logic and services
- **Types**: Type definitions
- **Utils**: Shared utilities

### Dependency Direction
- Adapters depend on types and utils
- Core services depend on adapters, types, and utils
- Main depends on core services
- No circular dependencies

### Module Exports
- Each directory has an `index.ts` for clean imports
- Public APIs clearly defined
- Internal implementation details hidden

## Entry Points

### Application Entry
- **`src/main.ts`**: Main application entry point

### Service Initialization
- **`src/core/orchestration/orchestrator.ts`**: Service initialization and coordination

### Configuration Loading
- **`src/utils/config.ts`**: Configuration loading at startup

## Build Output

**TypeScript Compilation:**
- Source: `src/`
- Output: `dist/`
- Entry: `dist/main.js`

**Excluded from Build:**
- `node_modules/`
- `dist/`
- `**/*.test.ts`

## Test Files

**Test Configuration:**
- Framework: Jest
- Config: `jest.config.js`
- Test files: `**/*.test.ts`, `**/*.spec.ts`
- Test directory: `src/` (same as source)

## Configuration Files

**Application Config:**
- `config/development.yaml`: Development environment
- `config/funding.production.yaml`: Production (funding strategy)
- `config/spread.production.yaml`: Production (spread strategy)

**Build Config:**
- `tsconfig.json`: TypeScript compiler options
- `package.json`: Dependencies and scripts
- `jest.config.js`: Test configuration

**Infrastructure Config:**
- `terraform/`: Infrastructure as Code
- `docker-compose.yml`: Local development
- `docker/Dockerfile.*`: Container definitions

