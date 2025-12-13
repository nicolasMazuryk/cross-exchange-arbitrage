# Technology Stack Analysis

## Overview

ArbiNet is a TypeScript/Node.js backend application implementing an automated spatial crypto arbitrage trading system.

## Technology Stack Table

| Category | Technology | Version | Justification |
|----------|-----------|---------|---------------|
| **Runtime** | Node.js | 22.12 | High-performance runtime for real-time trading operations |
| **Language** | TypeScript | 5.3.3 | Type safety for financial calculations and exchange integrations |
| **Module System** | CommonJS | - | Node.js standard module system |
| **Target ES Version** | ES2020 | - | Modern JavaScript features with broad compatibility |

## Core Dependencies

### Exchange Integration
- **ccxt** (^4.4.88) - Unified cryptocurrency exchange trading library
- **binance** (^2.15.21) - Binance exchange API client
- **bitget-api** (^2.3.5) - Bitget exchange API client
- **bybit-api** (^4.1.10) - Bybit exchange API client
- **okx-api** (^2.0.5) - OKX exchange API client

### State Management & Caching
- **ioredis** (^5.8.2) - Redis client for state persistence and caching
- **redlock** (^5.0.0-beta.2) - Distributed lock implementation for Redis

### Scheduling & Automation
- **cron** (^4.3.4) - Cron job scheduling for periodic tasks
- **playwright** (^1.55.0) - Browser automation for funding rate data collection

### Logging & Monitoring
- **pino** (^10.1.0) - High-performance structured logging
- **pino-pretty** (^13.1.2) - Pretty printer for Pino logs in development

### Configuration & Utilities
- **dotenv** (^16.4.5) - Environment variable management
- **yaml** (^2.4.0) - YAML configuration file parsing

### Development Tools
- **@hyperdrive-eng/mcp-nodejs-debugger** (^0.2.2) - Node.js debugging tools

## Development Dependencies

### Testing
- **jest** (^29.7.0) - Testing framework
- **ts-jest** (^29.1.2) - TypeScript preprocessor for Jest
- **@types/jest** (^29.5.12) - TypeScript definitions for Jest

### Code Quality
- **eslint** (^8.57.0) - Linting tool
- **@typescript-eslint/eslint-plugin** (^7.1.0) - TypeScript ESLint plugin
- **@typescript-eslint/parser** (^7.1.0) - TypeScript parser for ESLint
- **prettier** (^3.2.5) - Code formatter

### Type Definitions
- **@types/node** (^20.11.24) - Node.js type definitions
- **@types/ws** (^8.18.1) - WebSocket type definitions
- **@types/cron** (^2.0.1) - Cron type definitions

### Build Tools
- **typescript** (^5.3.3) - TypeScript compiler
- **ts-node** (^10.9.2) - TypeScript execution environment
- **ts-node-dev** (^2.0.0) - Development server with hot reload

## Architecture Pattern

**Service-Oriented Architecture with Adapter Pattern**

The application follows a layered architecture:

1. **Adapter Layer** (`src/adapters/`)
   - REST adapters for exchange API communication
   - WebSocket adapters for real-time market data
   - Private WebSocket adapters for account updates
   - Base classes providing common functionality

2. **Core Services Layer** (`src/core/`)
   - **Orchestration**: Main application coordinator
   - **Arbitrage Engine**: Opportunity detection and analysis
   - **Orderbook Manager**: Real-time orderbook state management
   - **Trading Services**: Trade execution and monitoring
   - **State Management**: Account state synchronization
   - **Funding Services**: Funding rate collection and analysis
   - **Market Metadata**: Market information services

3. **Utilities Layer** (`src/utils/`)
   - Configuration management
   - Logging infrastructure
   - Trace context management
   - Browser automation utilities
   - General utilities

4. **Types Layer** (`src/types/`)
   - Type definitions for accounts
   - Exchange type definitions

## Key Architectural Decisions

### Event-Driven Architecture
- Uses Node.js `EventEmitter` for inter-service communication
- Enables loose coupling between components
- Supports real-time event propagation

### Adapter Pattern
- Unified interface for multiple exchange APIs
- Base classes reduce code duplication
- Exchange-specific implementations handle differences

### State Persistence
- Redis for distributed state management
- Supports multi-instance deployments
- Enables state recovery after restarts

### Real-Time Data Processing
- WebSocket connections for low-latency market data
- Orderbook delta updates for efficiency
- Batch processing for high-volume streams

## Configuration Management

- **YAML-based configuration** (`config/*.yaml`)
- Environment-specific configs (development, production)
- Strategy-specific production configs (funding, spread)
- Environment variables for sensitive data (API keys)

## Deployment & Infrastructure

- **Docker**: Containerized deployment
- **Docker Compose**: Local development environment
- **Terraform**: Infrastructure as Code (AWS EC2)
- **Redis**: State persistence and caching
- **CloudWatch**: Logging and monitoring (production)

## Testing Strategy

- **Jest** for unit and integration testing
- TypeScript test files (`.test.ts`, `.spec.ts`)
- Test coverage collection configured
- Node.js test environment

## Build & Development

- **TypeScript compilation** to `dist/` directory
- **Source maps** enabled for debugging
- **Declaration files** generated for type definitions
- **Development mode** with `ts-node`
- **Production mode** with compiled JavaScript

