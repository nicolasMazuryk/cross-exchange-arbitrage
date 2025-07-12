# 🎯 ArbiNet Orchestrator

The Orchestrator is the centralized system initialization and lifecycle management component for the ArbiNet crypto arbitrage system. It consolidates all startup logic, dependency injection, and graceful shutdown handling into a single, extensible entry point.

## 🏗️ Architecture

The Orchestrator follows a **staged initialization pattern** with clearly separated concerns:

```
Stage 1: REST Client Initialization  
Stage 2: Core Services Initialization
Stage 3: WebSocket Client Initialization
Stage 4: Account Sync Service Initialization
Stage 5: Service Connection & Data Flow
Stage 6: Graceful Shutdown Setup
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { createOrchestrator } from './core/orchestration'

async function main() {
  // Initialize with all services enabled
  const orchestrator = await createOrchestrator()
  
  orchestrator.on('arbitrageOpportunities', (opportunities) => {
    console.log('💰 Found opportunities:', opportunities)
  })
}
```

## 🔧 Service Access

The Orchestrator provides access to all initialized services:

```typescript
// Get core services
const orderbookManager = orchestrator.getOrderbookManager()
const arbitrageEngine = orchestrator.getArbitrageEngine()
const accountSyncService = orchestrator.getAccountSyncService()

// Get exchange services
const exchangeServices = orchestrator.getExchangeServices()
for (const [exchangeId, services] of exchangeServices.entries()) {
  console.log(`${exchangeId}: REST=${!!services.rest}, WS=${!!services.ws}`)
}

// Check initialization status
const isReady = orchestrator.isServiceInitialized()
```

## 📡 Event System

The Orchestrator emits events for system state changes:

```typescript

// Arbitrage opportunities
orchestrator.on('arbitrageOpportunities', (opportunities) => {
  opportunities.forEach(opp => {
    console.log(`Opportunity: ${opp.pair} on ${opp.exchangeA} → ${opp.exchangeB}`)
  })
})

// Account state updates
orchestrator.on('accountUpdate', (update) => {
  console.log(`Account update: ${update.exchangeId} - ${update.type}`)
})
```

## 🛡️ Graceful Shutdown

The Orchestrator handles graceful shutdown automatically:

```typescript
// Manual shutdown
await orchestrator.shutdown()

// Automatic shutdown on process signals (SIGINT, SIGTERM)
// Automatic shutdown on uncaught exceptions
// Automatic shutdown on unhandled promise rejections
```

## 🔄 Lifecycle Management

### Initialization Stages

1. **REST Client Initialization**: Initializes exchange REST API clients
2. **Core Services**: Initializes OrderbookManager and ArbitrageEngine
3. **WebSocket Clients**: Initializes real-time data streams
4. **Account Sync**: Initializes account state synchronization
5. **Service Connection**: Connects all services and starts data flow
6. **Shutdown Setup**: Configures graceful shutdown handlers

### Shutdown Stages

1. **Account Sync Service**: Stops account synchronization
2. **WebSocket Clients**: Closes all WebSocket connections
3. **Core Services**: Cleans up core service resources
4. **REST Clients**: Closes REST API connections

## 🧪 Testing & Development

### Service Injection for Testing

```typescript
// Access services for testing
const orderbookManager = orchestrator.getOrderbookManager()
const arbitrageEngine = orchestrator.getArbitrageEngine()

// Mock or replace services as needed
// orderbookManager.updateOrderbook(mockData)
```

## 📊 Monitoring & Observability

The Orchestrator provides comprehensive logging and event emission:

- **Initialization Progress**: Detailed stage-by-stage logging
- **Service Health**: Status updates for each service
- **Error Handling**: Comprehensive error logging and recovery
- **Performance Metrics**: Timing information for initialization stages

## 🔮 Future Extensions

The Orchestrator is designed for easy extension:

### Adding New Services

```typescript
// In orchestrator.ts
private tradeExecutionService?: TradeExecutionService

private async initializeTradeExecution(): Promise<void> {
  this.tradeExecutionService = new TradeExecutionService()
  await this.tradeExecutionService.initialize()
}
```

### Adding New Exchanges

```typescript
// Add to exchange initialization arrays
{
  id: 'newExchange',
  client: new NewExchangeClient(config)
}
```

## 🚨 Error Handling

The Orchestrator implements comprehensive error handling:

- **Initialization Errors**: Service-specific initialization failures
- **Runtime Errors**: Uncaught exceptions and promise rejections
- **Shutdown Errors**: Graceful shutdown failures

All errors are logged with context and the system attempts graceful recovery where possible.

## 📝 Examples

See `src/examples/orchestratorExample.ts` for comprehensive usage examples including:

- Full system initialization
- Event handling patterns
- Service access patterns
- Graceful shutdown demonstration 