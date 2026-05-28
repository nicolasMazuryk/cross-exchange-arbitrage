# CLAUDE.md — ArbiNet Codebase Guide

IMPORTANT: Always read: [Agent Workflow](./agent-workflow.md)

## Project Overview

ArbiNet is an automated spatial cryptocurrency arbitrage system. It monitors real-time orderbooks across multiple exchanges via WebSocket, detects profitable arbitrage opportunities (funding rate or spread-based), and executes hedged trades (buy on one exchange, sell on another). State is persisted in Redis for recovery across restarts.

**Two deployment strategies:**
- **Funding Arbitrage** — Exploits funding rate differentials between exchanges with time-windowed entry/exit around funding events
- **Spread Arbitrage** — Exploits price spread differences between exchanges

Strategy is selected via the `STRATEGY` environment variable and corresponding YAML config.

## Tech Stack

- **Runtime:** Node.js v22.12, TypeScript 5.3 (strict mode, ES2020 target, CommonJS)
- **Exchange API:** CCXT v4.4 (unified REST layer) + native exchange SDKs (binance, bybit-api, okx-api, bitget-api)
- **State:** Redis via ioredis v5.8 (AOF persistence)
- **Logging:** Pino v10 (structured JSON, pino-pretty in dev)
- **Scheduling:** Cron v4.3 (funding fee collection)
- **Browser automation:** Playwright v1.55 (funding rate fetching)
- **Config:** YAML files + dotenv for environment variables
- **Infrastructure:** Docker, Terraform (AWS EC2, ECR, VPC)

## Repository Structure

```
├── src/
│   ├── main.ts                          # Entry point
│   ├── adapters/
│   │   ├── rest/                        # Exchange REST adapters (CCXT-based)
│   │   │   ├── base.ts                  # Abstract BaseExchange class
│   │   │   ├── binance.ts, bybit.ts, okx.ts, bitget.ts
│   │   │   ├── types.ts                 # RestClientInterface, ExchangeConfig
│   │   │   └── index.ts                 # Barrel exports
│   │   └── websocket/
│   │       ├── public/                  # Orderbook streaming per exchange
│   │       │   ├── base.ts              # Abstract base WS client
│   │       │   └── binance.ts, bybit.ts, okx.ts, bitget.ts
│   │       ├── private/                 # Account update streams per exchange
│   │       │   ├── base.ts
│   │       │   └── binance.ts, bybit.ts, okx.ts, bitget.ts
│   │       ├── types.ts                 # WebSocketConfig
│   │       └── index.ts
│   ├── core/
│   │   ├── orchestration/
│   │   │   └── orchestrator.ts          # Central service coordinator (10-stage init)
│   │   ├── arbitrage/
│   │   │   └── arbitrageEngine.ts       # Opportunity detection & scoring
│   │   ├── trading/
│   │   │   ├── tradeExecutor.ts         # Order placement on exchanges
│   │   │   ├── tradeMonitor.ts          # Position monitoring & exit logic
│   │   │   └── utils.ts                 # Trading utilities
│   │   ├── orderbook/
│   │   │   └── orderbookManager.ts      # Real-time orderbook aggregation
│   │   ├── state/
│   │   │   ├── stateService.ts          # Redis persistence layer
│   │   │   ├── accountStateManager.ts   # In-memory account state
│   │   │   └── accountSyncService.ts    # Exchange account sync snapshots
│   │   ├── funding/
│   │   │   ├── fundingService.ts        # Funding rate data & projections
│   │   │   ├── fundingFeeCollector.ts   # Cron-based fee history collection
│   │   │   └── types.ts                 # ParsedFunding, FundingRateHistory
│   │   └── markets/
│   │       └── marketMetadataService.ts # Market metadata management
│   ├── types/
│   │   ├── exchange.ts                  # OrderSide, OrderType, MarketType, etc.
│   │   └── account.ts                   # BalanceInfo, PositionInfo, OrderInfo
│   └── utils/
│       ├── config.ts                    # YAML + env config loader (typed Config interface)
│       ├── logger.ts                    # Pino Logger class with trace context injection
│       ├── traceContext.ts              # AsyncLocalStorage-based distributed tracing
│       ├── browser.ts                   # Playwright browser automation helpers
│       ├── browser.types.ts             # Browser-related types
│       └── utils.ts                     # General utilities
├── config/
│   ├── development.yaml                 # Dev environment config
│   ├── spread.production.yaml           # Spread strategy production config
│   └── funding.production.yaml          # Funding strategy production config
├── docker/
│   ├── Dockerfile.funding_arbitrage_bot # Funding bot Docker image (ARM64)
│   ├── Dockerfile.spread_arbitrage_bot  # Spread bot Docker image (ARM64)
│   ├── push-to-ecr.sh                  # AWS ECR push script
│   └── deploy.sh                       # Deployment script
├── terraform/                           # AWS infrastructure (EC2, VPC, ECR, security groups)
├── scripts/
│   ├── analyze_trades_metrics.ts        # Trade performance analysis
│   └── dump_redis.ts                    # Redis state dump utility
├── docs/                                # Architecture & design documentation
├── .bmad/                               # BMAD agent framework configuration
└── reports/                             # Trade metrics and analysis outputs
```

## Commands

```bash
# Development
npm start                 # Run app with ts-node (uses config/development.yaml)
npm run debug             # Compile to dist/ and launch with Node Inspector paused at entry (port 9229)
npm run build             # Compile TypeScript to dist/
npm run lint              # ESLint check
npm run format            # Prettier auto-format src/**/*.ts
npm test                  # Jest (configured but no tests yet)

# Infrastructure
npm run docker:up         # Start Redis container (docker-compose)
npm run docker:down       # Stop containers
npm run terraform         # Deploy AWS infrastructure
npm run push:ecr          # Push Docker images to AWS ECR
```

**Local development requires:**
1. Redis running (`npm run docker:up`)
2. Exchange API keys in `.env` file (see environment variables below)
3. `npm start` to run

## Runtime Debugging (mcp-debugger MCP server)

**When to use it.** Reach for `mcp__mcp-debugger__*` whenever the question is *"what is the runtime value of X?"* and reading the source can't answer it: in-memory orderbook snapshots, account-state Maps, closure variables in async chains, the actual error chain when a catch re-throws, any runtime state. The source tells you the shape; the debugger tells you the value.

**Agent workflow:**

1. Start `npm run debug` in the background (use your background-tool).
2. Create a session and attach to the inspector:
   ```
   create_debug_session({ language: 'javascript' })
   attach_to_process({ sessionId, host: '127.0.0.1', port: 9229 })
   ```
3. While paused at entry, set breakpoints against `.ts` source — sourcemaps translate them:
   ```
   set_breakpoint({ sessionId, file: '<repo>/src/core/.../foo.ts', line: 42 })
   ```
4. `continue_execution`. Poll `list_debug_sessions` until `state` flips `running` → `paused`. Orchestrator init takes ~15–25s, so non-init breakpoints don't fire instantly.
5. Inspect: `get_stack_trace`, `get_local_variables`, `get_variables`, `evaluate_expression`. Use `evaluate_expression` to JSON-stringify nested Maps/Sets that `get_variables` truncates.
6. `continue_execution`, `close_debug_session`, kill the background process.

**Tool capabilities to explore** (call schemas via `ToolSearch` when needed): `set_breakpoint`, `list_threads`, `get_stack_trace`, `get_scopes`, `get_variables`, `get_local_variables`, `evaluate_expression`, `get_source_context`, `step_over`, `step_into`, `step_out`, `pause_execution`, `continue_execution`, `redefine_classes`.

**If breakpoints stay unbound:** `dist/` is stale relative to `src/`. Re-run `npm run debug` after any `.ts` edit — line numbers in the sourcemap must match current source.

## Architecture Patterns

### Service-Oriented with Central Orchestrator
The `Orchestrator` class (`src/core/orchestration/orchestrator.ts`) extends `EventEmitter` and manages all services through a 10-stage initialization pipeline:
1. REST clients → 2. Funding service → 3. Core services (orderbook, arbitrage engine) → 4. State service (Redis) → 5. Account sync → 6. Trading services → 7. WebSocket clients → 8. Funding fee collector → 9. Shutdown handlers → 10. State restoration

### Adapter Pattern (Exchange Integration)
- `BaseExchange` (abstract) wraps CCXT, implements `RestClientInterface`
- Each exchange (Binance, Bybit, OKX, Bitget) extends `BaseExchange` with exchange-specific overrides
- WebSocket adapters follow the same pattern: abstract base → exchange-specific implementations
- Public WS = orderbook streams; Private WS = account update streams

### Distributed Tracing
- `TraceContext` uses Node.js `AsyncLocalStorage` to propagate trace/span IDs
- Every `Logger` instance auto-injects `traceId`, `spanId`, `trigger` into all log entries
- Use `TraceContext.runWithTrace('trigger', callback)` to start a new trace
- Use `TraceContext.runWithSpan(callback)` for child spans within existing traces

### Configuration Loading
- YAML config files in `config/` are loaded based on `NODE_ENV`
  - `development` → `config/development.yaml`
  - `production` → `config/${STRATEGY}.production.yaml`
- Environment variables override API keys (never stored in YAML)
- Typed via `Config` interface in `src/utils/config.ts`

## Code Conventions

### TypeScript
- **Strict mode** enabled — all strict checks apply
- `@typescript-eslint/no-explicit-any: off` — `any` is permitted (used for exchange API responses)
- `@typescript-eslint/no-var-requires: off` — dynamic requires allowed

### Formatting (Prettier)
- No semicolons
- Single quotes
- Trailing commas (ES5 style)
- Print width: 120 chars
- 2-space indentation (no tabs)
- Arrow parens: avoid when possible
- LF line endings

### Naming
- **PascalCase:** Classes, interfaces, type aliases, enums (`BaseExchange`, `TradeExecutor`, `OrderSide`)
- **camelCase:** Variables, functions, methods, properties (`orderbookManager`, `fetchFundingData`)
- **UPPERCASE:** Enum values (`MarketType.SPOT`, `'BUY'`, `'SELL'`)
- **lowercase:** Exchange names used as keys (`'binance'`, `'bybit'`, `'okx'`, `'bitget'`)

### Logging
- Instantiate per module: `const logger = new Logger('module-name')`
- Always pass structured objects: `logger.info({ msg: 'Description', function: 'ClassName.methodName', ...context })`
- Include `function` field for traceability
- Use appropriate log levels: `fatal` > `error` > `warn` > `info` > `debug` > `trace`
- Error logs include the full error object in the `error` field

### Error Handling
- Try-catch in all async operations
- Log error with full context before re-throwing
- Graceful shutdown via `SIGINT`/`SIGTERM` handlers in orchestrator
- State recovery from Redis on restart

### File Organization
- One primary class/service per file
- Barrel `index.ts` files in adapter directories for clean imports
- Types co-located with their domain (`core/funding/types.ts`, `adapters/rest/types.ts`) or in `src/types/` for shared types

## Environment Variables

Exchange API credentials (loaded from `.env` in development, from Docker/system env in production):

```
NODE_ENV=development|production
STRATEGY=funding|spread              # Production only: selects config file

BINANCE_API_KEY=
BINANCE_API_SECRET=
BYBIT_API_KEY=
BYBIT_API_SECRET=
OKX_API_KEY=
OKX_API_SECRET=
OKX_API_PASS=
BITGET_API_KEY=
BITGET_API_SECRET=
BITGET_API_PASS=
```

## Supported Exchanges

| Exchange | REST Adapter | Public WS | Private WS | Max Streams/Conn |
|----------|-------------|-----------|------------|-----------------|
| Binance  | Yes         | Yes       | Yes        | 1000            |
| Bybit    | Yes         | Yes       | Yes        | 50              |
| OKX      | Yes         | Yes       | Yes        | 100             |
| Bitget   | Yes         | Yes       | Yes        | 500             |

Gateio is listed in config but does not have adapter implementations.

## Key Domain Concepts

- **Spatial arbitrage:** Profiting from price/rate differences of the same asset across different exchanges
- **Funding rate arbitrage:** Opening hedged positions (long on one exchange, short on another) to capture funding rate differentials
- **Spread arbitrage:** Opening hedged positions when bid-ask spread between exchanges exceeds threshold
- **Temporal persistence validation:** Opportunities must persist for `minPersistenceMs` across `minConsecutiveSnapshots` before execution
- **Confidence scoring:** Opportunities are scored 0-1 based on spread size, orderbook depth, persistence, and other factors
- **Take-profit exits:** Positions can be closed when accumulated profit exceeds `takeProfitTargetPercent`
- **Multi-market trading:** Bot trades SPOT, USDT-M perpetual futures (linear), and COIN-M perpetual futures (inverse). Each exchange adapter must route per-symbol to the correct market endpoint.

## Testing

Jest is configured (`jest.config.js`) but no test files exist yet. When adding tests:
- Place test files in `__tests__/` directories or use `.test.ts`/`.spec.ts` suffix
- Tests run with: `npm test`
- Coverage collects from `src/**/*.ts` (excluding `.d.ts`)
- Use `ts-jest` preset for TypeScript support

## Adding a New Exchange

1. Create REST adapter in `src/adapters/rest/<exchange>.ts` extending `BaseExchange`
2. Implement `fetchFundingData()` and override `getExchangeOrderParams()` if needed
3. Create public WS adapter in `src/adapters/websocket/public/<exchange>.ts`
4. Create private WS adapter in `src/adapters/websocket/private/<exchange>.ts`
5. Add exchange config to YAML files (`config/*.yaml`) and `Config` interface in `src/utils/config.ts`
6. Register in orchestrator's initialization pipeline
7. Export from barrel `index.ts` files
