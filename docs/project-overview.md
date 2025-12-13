# Project Overview

## Project Information

**Name**: ArbiNet  
**Version**: 1.0.0  
**Description**: Automated Spatial Crypto Arbitrage System  
**Type**: Backend - Trading System  
**Architecture**: Monolith - Service-Oriented Architecture

## Executive Summary

ArbiNet is a high-frequency trading system designed to detect and execute arbitrage opportunities across multiple cryptocurrency exchanges. The system monitors real-time market data, identifies profitable trading opportunities, and automatically executes trades with risk management.

### Key Features

- **Multi-Exchange Support**: Binance, Bybit, OKX, Bitget
- **Real-Time Monitoring**: WebSocket-based orderbook updates
- **Automated Trading**: Fully automated trade execution
- **Risk Management**: Balance validation, position limits, slippage tracking
- **Multiple Strategies**: Funding arbitrage and spread arbitrage
- **State Persistence**: Redis-based state management
- **Comprehensive Logging**: Structured logging with trace context

## Technology Stack Summary

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js 22.12 |
| **Language** | TypeScript 5.3.3 |
| **Architecture** | Service-Oriented with Adapter Pattern |
| **State** | Redis (ioredis) |
| **Logging** | Pino |
| **Exchange APIs** | CCXT, exchange-specific clients |
| **Browser Automation** | Playwright |
| **Deployment** | Docker, AWS ECS |

## Architecture Type

**Repository Type**: Monolith  
**Architecture Pattern**: Service-Oriented Architecture  
**Design Patterns**: Adapter Pattern, Event-Driven Architecture, Observer Pattern

## Project Structure

```
exchange-arbitrage/
├── src/                    # Source code
│   ├── adapters/          # Exchange adapters
│   ├── core/              # Core business logic
│   ├── types/             # Type definitions
│   └── utils/             # Utilities
├── config/                # Configuration files
├── docker/                # Docker files
├── terraform/             # Infrastructure as Code
└── docs/                  # Documentation
```

## Quick Reference

### Entry Point
- **Main File**: `src/main.ts`
- **Build Output**: `dist/main.js`

### Key Services
- **Orchestrator**: Service coordination
- **ArbitrageEngine**: Opportunity detection
- **TradeExecutor**: Trade execution
- **TradeMonitor**: Trade monitoring
- **OrderbookManager**: Market data management

### Configuration
- **Development**: `config/development.yaml`
- **Production**: `config/{strategy}.production.yaml`
- **Environment**: `.env` file for API keys

### State Management
- **In-Memory**: Account state, orderbooks
- **Persistent**: Redis for tracked trades

## Getting Started

### Prerequisites
- Node.js 22.12+
- Docker (for Redis)
- Exchange API keys

### Quick Start
```bash
# Install dependencies
npm install

# Start Redis
docker-compose up -d redis

# Run application
npm run dev
```

See [Development Guide](./development-guide.md) for detailed setup.

## Documentation Index

### Core Documentation
- [Architecture](./architecture.md) - System architecture
- [Technology Stack](./technology-stack.md) - Technology details
- [API Contracts](./api-contracts.md) - Exchange API interfaces
- [Data Models](./data-models.md) - Data structures

### Guides
- [Development Guide](./development-guide.md) - Setup and development
- [Deployment Guide](./deployment-guide.md) - Production deployment

### Analysis
- [Source Tree Analysis](./source-tree-analysis.md) - Code structure
- [Architecture Patterns](./architecture-patterns.md) - Design patterns
- [Comprehensive Analysis](./comprehensive-analysis.md) - Detailed analysis

## Trading Strategies

### Funding Arbitrage
Exploits funding rate differences between exchanges for perpetual futures contracts.

**Key Features:**
- Synchronous and asynchronous modes
- Funding rate projection
- Entry/exit windows
- Profit threshold validation

### Spread Arbitrage
Exploits price spread differences between exchanges.

**Key Features:**
- Real-time spread detection
- Slippage estimation
- Entry/exit conditions
- Risk adjustments

## Exchange Support

| Exchange | REST | WebSocket | Private WS | Funding Data |
|----------|------|-----------|------------|--------------|
| Binance | ✅ | ✅ | ✅ | Browser |
| Bybit | ✅ | ✅ | ✅ | Browser |
| OKX | ✅ | ✅ | ✅ | Browser |
| Bitget | ✅ | ✅ | ✅ | Browser |

## Development Status

**Current Version**: 1.0.0  
**Status**: Production-ready  
**Last Updated**: 2025-01-27

## Related Documentation

For detailed information, see:
- [README.md](../README.md) - Project overview
- [Development Guide](./development-guide.md) - Development setup
- [Deployment Guide](./deployment-guide.md) - Deployment procedures
- [Architecture](./architecture.md) - System architecture

