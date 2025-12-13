# Development Guide

## Overview

This guide provides instructions for setting up, building, testing, and running the ArbiNet application in a development environment.

## Prerequisites

### Required Software

- **Node.js**: v22.12 or higher
- **npm**: Comes with Node.js (or use yarn)
- **TypeScript**: v5.3.3 (installed as dependency)
- **Docker**: For Redis and containerized development
- **Docker Compose**: For local development environment

### Optional Software

- **Redis**: For local state management (or use Docker)
- **Cursor (VS Code)**: Recommended IDE with TypeScript support
- **Git**: For version control

## Environment Setup

### 1. Clone Repository

```bash
git clone <repository-url>
cd exchange-arbitrage
```

### 2. Install Dependencies

```bash
npm install
```

This installs all production and development dependencies including:
- TypeScript and type definitions
- Testing framework (Jest)
- Linting tools (ESLint)
- Code formatting (Prettier)
- Exchange API clients
- Logging libraries
- Browser automation (Playwright)

### 3. Install Playwright Browsers

Playwright is required for funding rate data collection:

```bash
npx playwright install --with-deps chromium
```

### 4. Configure Environment

Create a `.env` file in the project root (not committed to git):

```env
# Node Environment
NODE_ENV=development

# Exchange API Keys (required for trading operations)
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret

BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret

OKX_API_KEY=your_okx_api_key
OKX_API_SECRET=your_okx_api_secret
OKX_API_PASS=your_okx_api_passphrase

BITGET_API_KEY=your_bitget_api_key
BITGET_API_SECRET=your_bitget_api_secret
BITGET_API_PASS=your_bitget_api_passphrase
```

**Note**: For development, you can use testnet API keys if available.

### 5. Configure Application

Edit `config/development.yaml` to match your development setup:

```yaml
app:
  name: "ArbiNet"
  version: "1.0.0"
  logLevel: "debug"  # Use "debug" for development

redis:
  url: "redis://localhost:6379"
  keyPrefix: "dev:"

# ... rest of configuration
```

## Local Development

### Start Redis (Docker)

```bash
docker-compose up -d redis
```

This starts Redis in a Docker container on port 6379.

### Run Application

**Development Mode:**
```bash
npm run start
```

**Production Mode:**
```bash
npm run build
node ./dist/main.js
```

**Direct TypeScript Execution:**
```bash
npm start  # Uses ts-node to run TypeScript directly
```

### Application Startup

The application will:
1. Load configuration from `config/development.yaml`
2. Connect to Redis
3. Initialize exchange adapters (REST and WebSocket)
4. Start core services (OrderbookManager, ArbitrageEngine, etc.)
5. Begin monitoring markets and detecting opportunities

### View Logs

**Console Output:**
- Development: Pretty-printed logs in console
- Production: JSON structured logs

**Log Files:**
- `logs/combined.log`: All logs
- `logs/error.log`: Error logs only

**Tail Logs:**
```bash
tail -f logs/combined.log
tail -f logs/error.log
```

## Building

### TypeScript Compilation

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

**Build Output:**
- Source: `src/**/*.ts`
- Output: `dist/**/*.js`
- Source maps: Generated for debugging
- Declaration files: Generated for type definitions

### Build Configuration

See `tsconfig.json` for compiler options:
- Target: ES2020
- Module: CommonJS
- Strict mode: Enabled
- Source maps: Enabled

## Testing

### Run Tests

```bash
npm test
```

### Test Configuration

- Framework: Jest
- Test files: `**/*.test.ts`, `**/*.spec.ts`
- Coverage: Collected from `src/**/*.ts`
- Environment: Node.js

### Writing Tests

Create test files next to source files:
```typescript
// src/core/arbitrage/arbitrageEngine.test.ts
import { ArbitrageEngine } from './arbitrageEngine'

describe('ArbitrageEngine', () => {
  // Test cases
})
```

## Code Quality

### Linting

```bash
npm run lint
```

**Linter**: ESLint with TypeScript support
**Configuration**: `.eslintrc` (if exists) or package.json

### Code Formatting

```bash
npm run format
```

**Formatter**: Prettier
**Configuration**: `.prettierrc` (if exists) or package.json

### Type Checking

TypeScript compiler performs type checking:
```bash
npx tsc --noEmit
```

## Development Workflow

### 1. Make Changes

Edit source files in `src/`:
- Follow TypeScript best practices
- Use async/await for async operations
- Use structured logging
- Add trace context for operations

### 2. Test Locally

```bash
npm run dev  # Start with hot reload
```

### 3. Run Tests

```bash
npm test
```

### 4. Check Code Quality

```bash
npm run lint
npm run format
```

### 5. Build

```bash
npm run build
```

### 6. Test Production Build

```bash
npm start  # Uses compiled JavaScript
```

## Common Development Tasks

### Adding a New Exchange

1. Create REST adapter: `src/adapters/rest/{exchange}.ts`
2. Create WebSocket adapter: `src/adapters/websocket/{exchange}.ts`
3. Create private WebSocket adapter: `src/adapters/websocket/private/{exchange}.ts`
4. Add to orchestrator initialization
5. Update configuration files

### Modifying Trading Logic

1. Edit `src/core/arbitrage/arbitrageEngine.ts` for opportunity detection
2. Edit `src/core/trading/tradeExecutor.ts` for execution logic
3. Edit `src/core/trading/tradeMonitor.ts` for monitoring and exits
4. Test with development environment
5. Monitor logs for behavior

### Debugging

**Enable Debug Logging:**
```yaml
# config/development.yaml
app:
  logLevel: "debug"
```

**Use Trace Context:**
All operations include trace IDs for correlation:
```typescript
TraceContext.runWithTrace('operation-name', async () => {
  // Your code
})
```

**Check Redis State:**
```bash
redis-cli
> KEYS dev:*
> GET dev:tracked-trades
```

### Monitoring Development

**Watch Logs:**
```bash
tail -f logs/combined.log | grep "arbitrage\|trade\|error"
```

**Check Redis:**
```bash
redis-cli MONITOR
```

**Check WebSocket Connections:**
Logs show WebSocket connection status and reconnections.

## Troubleshooting

### Redis Connection Issues

**Error**: "Redis not connected"
**Solution**: 
```bash
docker-compose up -d redis
# Or start Redis manually
redis-server
```

### Playwright Browser Issues

**Error**: "Browser not found"
**Solution**:
```bash
npx playwright install --with-deps chromium
```

### TypeScript Compilation Errors

**Error**: Type errors
**Solution**:
```bash
npm run build  # See detailed error messages
# Fix type errors in source files
```

### Exchange API Errors

**Error**: "Failed to load markets"
**Solution**:
- Check API keys in `.env`
- Verify API key permissions
- Check network connectivity
- Review exchange API status

### Port Conflicts

**Error**: "Port already in use"
**Solution**:
- Check if another instance is running
- Change Redis port in `docker-compose.yml`
- Kill process using the port

## Development Best Practices

### Code Organization

- Keep services focused and single-purpose
- Use dependency injection where possible
- Follow existing patterns for new code
- Maintain type safety

### Logging

- Use structured logging with context
- Include trace IDs for correlation
- Log at appropriate levels (debug for dev, info for production)
- Never log sensitive data (API keys, secrets)

### Error Handling

- Use try-catch for async operations
- Log errors with context
- Propagate errors appropriately
- Handle edge cases

### Testing

- Write tests for critical logic
- Test error cases
- Mock external dependencies
- Maintain test coverage

## IDE Setup

### VS Code

**Recommended Extensions:**
- ESLint
- Prettier
- TypeScript and JavaScript Language Features
- Jest Runner

**Settings** (`.vscode/settings.json`):
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

### Debugging Configuration

Create `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug ArbiNet",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

## Next Steps

After setting up development environment:
1. Review architecture documentation
2. Understand trading strategies
3. Explore codebase structure
4. Run application and observe behavior
5. Make small changes and test
6. Read API contracts and data models

