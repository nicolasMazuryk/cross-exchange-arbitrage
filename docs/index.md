# ArbiNet - Project Documentation Index

## Project Overview

**Name**: ArbiNet  
**Type**: Backend - Automated Spatial Crypto Arbitrage System  
**Architecture**: Monolith - Service-Oriented Architecture  
**Primary Language**: TypeScript/Node.js  
**Version**: 1.0.0

## Quick Reference

- **Tech Stack**: TypeScript 5.3.3, Node.js 22.12, Redis, Docker
- **Architecture Pattern**: Service-Oriented Architecture with Adapter Pattern
- **Entry Point**: `src/main.ts`
- **Build Output**: `dist/main.js`
- **Configuration**: `config/development.yaml`, `config/{strategy}.production.yaml`

## Generated Documentation

### Core Documentation

#### [Project Overview](./project-overview.md)
Executive summary, quick reference, and project information.

#### [Architecture](./architecture.md)
Complete system architecture documentation including:
- System overview and purpose
- Technology stack summary
- Architecture patterns
- Component architecture
- Data architecture
- API design
- Component responsibilities
- Deployment architecture
- Performance considerations
- Security architecture

#### [Technology Stack](./technology-stack.md)
Detailed technology analysis:
- Runtime and language details
- Core dependencies
- Development dependencies
- Architecture pattern
- Key architectural decisions
- Configuration management
- Deployment and infrastructure
- Testing strategy
- Build and development

#### [Architecture Patterns](./architecture-patterns.md)
Design patterns and architectural decisions:
- Service-Oriented Architecture
- Adapter Pattern
- Event-Driven Architecture
- Component architecture
- Data flow architecture
- Concurrency model
- State management
- Error handling strategy
- Scalability considerations
- Security architecture

### API and Data Documentation

#### [API Contracts](./api-contracts.md)
Complete API documentation:
- Exchange support
- REST API interface
- API endpoints (market data, trading, account, funding)
- WebSocket API (public and private)
- Exchange-specific details
- Error handling
- Rate limiting
- Authentication

#### [Data Models](./data-models.md)
Comprehensive data model documentation:
- Account models (BalanceInfo, PositionInfo, OrderInfo, AccountState)
- Trading models (TradeParams, TradeResult, TrackedTrade)
- Market data models (OrderBook, OrderBookUpdate, TopOfBook, MarketMetadata)
- Arbitrage models (ArbitrageOpportunity)
- Funding models (ParsedFunding, FundingRateHistory, FundingFeeHistory)
- State models (AppState, ExchangeState)
- Type enums and definitions
- Data relationships
- Data persistence
- Data validation

### Development and Operations

#### [Development Guide](./development-guide.md)
Complete development setup and workflow:
- Prerequisites and environment setup
- Local development instructions
- Building and testing
- Code quality tools
- Development workflow
- Common development tasks
- Debugging
- Troubleshooting
- IDE setup

#### [Deployment Guide](./deployment-guide.md)
Production deployment procedures:
- Deployment architecture
- Build process
- Infrastructure deployment (Terraform)
- Application deployment
- Configuration
- Monitoring
- Scaling
- Security
- Backup and recovery
- Troubleshooting
- Maintenance
- Rollback procedures

### Trading and Risk Management

#### [Trading Strategies](./trading-strategies.md)
Comprehensive trading strategy documentation:
- Funding arbitrage strategy (SYNC and ASYNC modes)
- Spread arbitrage strategy
- Opportunity detection process
- Entry and exit conditions
- Profitability calculations
- Strategy selection logic
- Configuration parameters

#### [Risk Management](./risk-management.md)
Complete risk management documentation:
- Pre-trade validation
- Opportunity validation
- Temporal persistence validation
- Execution safeguards
- Position management
- Risk limits configuration
- Error handling
- Risk monitoring

### Analysis and Structure

#### [Source Tree Analysis](./source-tree-analysis.md)
Annotated directory structure:
- Project root structure
- Source code structure (`src/`)
- Critical folders summary
- Integration points
- Service dependencies
- Data flow
- File organization principles
- Entry points
- Build output
- Configuration files

#### [Comprehensive Analysis](./comprehensive-analysis.md)
Detailed system analysis:
- State management patterns
- Async/event patterns
- Configuration management
- Security architecture
- Deployment configuration
- CI/CD patterns
- Monitoring and observability
- Error handling patterns
- Performance optimizations
- Scalability considerations

### Supporting Documentation

#### [Existing Documentation Inventory](./existing-documentation-inventory.md)
Catalog of existing documentation found before automated generation.

#### [User Provided Context](./user-provided-context.md)
User-provided context and focus areas.

## Project Structure

### Repository Type
**Monolith** - Single cohesive codebase

### Parts
1. **Main Application** (backend)
   - Type: Backend
   - Root: Project root
   - Tech: TypeScript/Node.js

## Key Components

### Core Services

1. **Orchestrator** (`src/core/orchestration/orchestrator.ts`)
   - Coordinates all services
   - Manages application lifecycle
   - Handles graceful shutdown

2. **Arbitrage Engine** (`src/core/arbitrage/arbitrageEngine.ts`)
   - Detects trading opportunities
   - Calculates profitability
   - Validates opportunities

3. **Trade Executor** (`src/core/trading/tradeExecutor.ts`)
   - Executes trades
   - Validates trade parameters
   - Monitors execution

4. **Trade Monitor** (`src/core/trading/tradeMonitor.ts`)
   - Monitors open trades
   - Manages exits
   - Calculates PnL

5. **Orderbook Manager** (`src/core/orderbook/orderbookManager.ts`)
   - Manages real-time orderbook state
   - Processes updates
   - Calculates top-of-book

6. **Account Sync Service** (`src/core/state/accountSyncService.ts`)
   - Synchronizes account state
   - WebSocket and REST updates
   - State freshness tracking

7. **Funding Service** (`src/core/funding/fundingService.ts`)
   - Collects funding rates
   - Browser automation
   - Funding data management

### Adapters

- **REST Adapters** (`src/adapters/rest/`)
  - Binance, Bybit, OKX, Bitget
  - Unified REST interface
  - Exchange-specific implementations

- **WebSocket Adapters** (`src/adapters/websocket/`)
  - Public WebSocket for market data
  - Private WebSocket for account updates
  - Automatic reconnection

## Exchange Support

| Exchange | REST | WebSocket | Private WS | Funding |
|----------|------|-----------|------------|---------|
| Binance | ✅ | ✅ | ✅ | ✅ |
| Bybit | ✅ | ✅ | ✅ | ✅ |
| OKX | ✅ | ✅ | ✅ | ✅ |
| Bitget | ✅ | ✅ | ✅ | ✅ |

## Trading Strategies

### Funding Arbitrage
- Exploits funding rate differences
- Synchronous and asynchronous modes
- Entry/exit windows
- Profit threshold validation

### Spread Arbitrage
- Exploits price spread differences
- Real-time detection
- Slippage estimation
- Risk adjustments

## Configuration Files

### Application Config
- `config/development.yaml` - Development environment
- `config/funding.production.yaml` - Production (funding strategy)
- `config/spread.production.yaml` - Production (spread strategy)

### Build Config
- `tsconfig.json` - TypeScript configuration
- `package.json` - Dependencies and scripts
- `jest.config.js` - Test configuration

### Infrastructure Config
- `terraform/` - Infrastructure as Code
- `docker-compose.yml` - Local development
- `docker/Dockerfile.*` - Container definitions

## Getting Started

### For Developers
1. Read [Development Guide](./development-guide.md)
2. Review [Architecture](./architecture.md)
3. Explore [Source Tree Analysis](./source-tree-analysis.md)
4. Check [API Contracts](./api-contracts.md) for integration details

### For Operators
1. Read [Deployment Guide](./deployment-guide.md)
2. Review [Architecture](./architecture.md) for system understanding
3. Check [Comprehensive Analysis](./comprehensive-analysis.md) for operational details

### For Architects
1. Read [Architecture](./architecture.md)
2. Review [Architecture Patterns](./architecture-patterns.md)
3. Study [Technology Stack](./technology-stack.md)
4. Analyze [Comprehensive Analysis](./comprehensive-analysis.md)

## Documentation Status

**Generated**: 2025-01-27  
**Scan Level**: Exhaustive  
**Mode**: Initial Scan  
**Project Type**: Backend

## File Inventory

### Generated Documentation Files

- ✅ `index.md` - Master index (this file)
- ✅ `project-overview.md` - Executive summary
- ✅ `architecture.md` - System architecture
- ✅ `technology-stack.md` - Technology analysis
- ✅ `architecture-patterns.md` - Design patterns
- ✅ `api-contracts.md` - API documentation
- ✅ `data-models.md` - Data model documentation
- ✅ `trading-strategies.md` - Trading strategy details
- ✅ `risk-management.md` - Risk management documentation
- ✅ `source-tree-analysis.md` - Code structure
- ✅ `development-guide.md` - Development setup
- ✅ `deployment-guide.md` - Deployment procedures
- ✅ `comprehensive-analysis.md` - Detailed analysis
- ✅ `existing-documentation-inventory.md` - Existing docs catalog
- ✅ `user-provided-context.md` - User context

### Supporting Files

- ✅ `project-scan-report.json` - Workflow state file

## Existing Documentation

The following documentation was found in the project:

- `README.md` - Project overview (basic)
- `terraform/LOGGING_FLOW.md` - Logging architecture

## Next Steps

### For New Features
When planning new features, reference:
- [Architecture](./architecture.md) for system design
- [API Contracts](./api-contracts.md) for exchange integration
- [Data Models](./data-models.md) for data structures
- [Development Guide](./development-guide.md) for development workflow

### For Brownfield PRD
This documentation index serves as the primary input for brownfield PRD workflows. Reference this index when:
- Planning new features
- Understanding existing system
- Analyzing impact of changes
- Documenting system behavior

## Documentation Standards

All documentation follows:
- CommonMark specification
- Task-oriented writing
- Active voice
- Clear structure
- Code examples where applicable

## Maintenance

This documentation is generated by the BMAD document-project workflow. To update:
1. Run the document-project workflow
2. Review generated documentation
3. Validate against checklist
4. Commit updates

---

**Last Updated**: 2025-01-27  
**Workflow Version**: 1.2.0  
**Scan Level**: Exhaustive

