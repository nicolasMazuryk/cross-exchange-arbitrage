# CLAUDE.md — ArbiNet Codebase Guide

IMPORTANT: Always read: [Agent Workflow](./agent-workflow.md)

## Project Overview

ArbiNet = automated crypto arbitrage system. Monitors real-time orderbooks across exchanges via WebSocket, detects profitable arbitrage (spread-based or funding rate), executes hedged trades (buy one exchange, sell another).

**Two deployment strategies:**
- **Spread Arbitrage** — exploits price spread differences between exchanges
- **Funding Arbitrage** — exploits funding rate differentials between exchanges, time-windowed entry/exit around funding events


## Tech Stack

- **Runtime:** Node.js v22.12, TypeScript 5.3 (strict, ES2020, CommonJS)
- **Exchange API:** CCXT v4.4 (unified REST) + native SDKs (binance, bybit-api, okx-api, bitget-api)
- **Config:** YAML + dotenv for env vars
- **Infrastructure:** Docker, Terraform

## Commands

```bash
# Development
npm start                 # Run app with ts-node (uses config/development.yaml)
npm run debug             # Compile to dist/ and launch with Node Inspector paused at entry (port 9229)
npm run build             # Compile TypeScript to dist/
npm run lint              # ESLint check
npm run format            # Prettier auto-format src/**/*.ts

# Infrastructure
npm run docker:up         # Start Redis container (docker-compose)
npm run docker:down       # Stop containers
npm run terraform         # Deploy AWS infrastructure
npm run push:ecr          # Push Docker images to AWS ECR
```

**Local dev needs:**
1. Redis running (`npm run docker:up`)
2. Exchange API keys in `.env` (see env vars below)
3. `npm start` to run


## Architecture Patterns

### Service-Oriented with Central Orchestrator
`Orchestrator` class (`src/core/orchestration/orchestrator.ts`) extends `EventEmitter`, manages all services via 10-stage init pipeline:
1. REST clients → 2. Funding service → 3. Core services (orderbook, arbitrage engine) → 4. State service (Redis) → 5. Account sync → 6. Trading services → 7. WebSocket clients → 8. Funding fee collector → 9. Shutdown handlers → 10. State restoration

### Adapter Pattern (Exchange Integration)
- `BaseExchange` (abstract) wraps CCXT, implements `RestClientInterface`
- Each exchange (Binance, Bybit, OKX, Bitget) extends `BaseExchange` with exchange-specific overrides
- WebSocket adapters same pattern: abstract base → exchange-specific impls
- Public WS = orderbook streams; Private WS = account update streams

### Configuration Loading
- YAML configs in `config/` loaded by `NODE_ENV`
  - `development` → `config/development.yaml`
  - `production` → `config/${STRATEGY}.production.yaml`
- Env vars override API keys (never in YAML)
- Typed via `Config` interface in `src/utils/config.ts`

## Code Conventions

### TypeScript
- **Strict mode** on — all strict checks apply
- `@typescript-eslint/no-explicit-any: off` — `any` allowed (exchange API responses)
- `@typescript-eslint/no-var-requires: off` — dynamic requires allowed

### Naming
- **PascalCase:** classes, interfaces, type aliases, enums (`BaseExchange`, `TradeExecutor`, `OrderSide`)
- **camelCase:** variables, functions, methods, properties (`orderbookManager`, `fetchFundingData`)
- **UPPERCASE:** enum values (`MarketType.SPOT`, `'BUY'`, `'SELL'`)
- **lowercase:** exchange names as keys (`'binance'`, `'bybit'`, `'okx'`, `'bitget'`)

### Logging
- Per module: `const logger = new Logger('module-name')`
- Always structured objects: `logger.info({ msg: 'Description', function: 'ClassName.methodName', ...context })`
- Include `function` field for traceability
- Levels: `fatal` > `error` > `warn` > `info` > `debug` > `trace`
- Error logs include full error in `error` field

### Error Handling
- Try-catch all async ops
- Log error with full context before re-throwing
- Graceful shutdown via `SIGINT`/`SIGTERM` handlers in orchestrator
- State recovery from Redis on restart

### File Organization
- One primary class/service per file
- Barrel `index.ts` in adapter dirs for clean imports
- Types co-located with domain (`core/funding/types.ts`, `adapters/rest/types.ts`) or `src/types/` for shared

## Environment Variables

Exchange API creds (from `.env` in dev, Docker/system env in prod):

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

## Runtime Verification Protocol

Task NOT complete when code written. Do not claim something works until you have observed it working with your own instrumentation. Print the actual values, don't assume them. Complete when OBSERVED behaving correctly at runtime. Follow loop for every change:

1. IDENTIFY observable behavior. What happens at runtime? Inputs, outputs, side effects, state transitions?

2. ENUMERATE input space before testing:
   - Happy path values
   - Boundary values (0, -1, empty, max, off-by-one neighbors)
   - Null/undefined/NaN/empty-string
   - Malformed or unexpected types
   - Concurrent / out-of-order conditions where relevant
   Write these as list before running anything.

3. INSTRUMENTS:
- Add temp logging that prints REAL values (not guesses) at every decision point and state mutation. Prefix temp logs with `// TEMP-VERIFY` for easy grep/remove. 
- Use Runtime Debugging via mcp-debugger MCP server (`mcp__mcp-debugger__*` — see **Runtime Debugging** below) to set breakpoints, inspect live variables, mutate state mid-execution without editing source.
- Logpoints in VS Code emit locals without pausing — ideal for loops and async where stopping distorts timing. Pair with conditional breakpoints that fire only on a suspicious value.

4. EXECUTE against every case from step 2. Capture real output.

5. COMPARE observed vs expected. If differ, code wrong OR mental model wrong — investigate which before changing.

6. CLEAN UP all `// TEMP-VERIFY` instrumentation once verified, then state which cases ran and what observed.

Never write "this should work" — write "I ran X, observed Y, matches Z".


## Failure Path Testing

Exercise the failure paths. This is where Node.js code breaks most, because the happy path always looks fine.

Make dependencies misbehave: `vi.mock` stubs to throw or return partial data; `nock` and MSW to intercept HTTP and return 500s, malformed JSON, or hung sockets; `toxiproxy` (`toxiproxy-node-client`) for real latency, bandwidth limits, and dropped connections.

Cases to force in this codebase:
- Exchange REST: 5xx, 429 rate limit, malformed JSON body, socket hang up mid-response, request timeout.
- WebSocket: disconnect mid-stream, out-of-order seq numbers, missing snapshot before delta, duplicate messages, ping/pong stall.
- Orderbook: empty bids/asks side, crossed book, zero-size level, NaN price from upstream.
- Trade exec: partial fill, immediate cancel, leg-1 fills + leg-2 rejected (hedge break).

Verify the catch path, not just that catch exists: log fields populated, state rolled back, no orphan resources, retries bounded.


## Runtime Debugging (mcp-debugger MCP server)

**When to use runtime debugging (mcp-debugger MCP server).** Reach for `mcp__mcp-debugger__*` whenever question is *"what is runtime value of X?"* and source can't answer: in-memory orderbook snapshots, account-state Maps, closure variables in async chains, actual error chain when catch re-throws, any runtime state. Source tells shape; debugger tells value. Use to verify code works at runtime:

- see real variable values
- identify all possible values and edge cases derived downstream
- change variable values and continue execution to emulate/simulate/trigger downstream workflows — verify specific cases (status changes, failure paths, etc.)

**Agent workflow:**

1. Start `npm run debug` in background (use background-tool).
2. Create session, attach to inspector:
   ```
   create_debug_session({ language: 'javascript' })
   attach_to_process({ sessionId, host: '127.0.0.1', port: 9229 })
   ```
3. While paused at entry, set breakpoints against `.ts` source — sourcemaps translate:
   ```
   set_breakpoint({ sessionId, file: '<repo>/src/core/.../foo.ts', line: 42 })
   ```
4. `continue_execution`. Poll `list_debug_sessions` until `state` flips `running` → `paused`. Orchestrator init takes ~15–25s, so non-init breakpoints don't fire instantly.
5. Inspect: `get_stack_trace`, `get_local_variables`, `get_variables`, `evaluate_expression`. Use `evaluate_expression` to JSON-stringify nested Maps/Sets that `get_variables` truncates.
6. `continue_execution`, `close_debug_session`, kill background process.

**Tool capabilities to explore** (call schemas via `ToolSearch` when needed): `set_breakpoint`, `list_threads`, `get_stack_trace`, `get_scopes`, `get_variables`, `get_local_variables`, `evaluate_expression`, `get_source_context`, `step_over`, `step_into`, `step_out`, `pause_execution`, `continue_execution`, `redefine_classes`.

**If breakpoints stay unbound:** `dist/` stale relative to `src/`. Re-run `npm run debug` after any `.ts` edit — sourcemap line numbers must match current source.