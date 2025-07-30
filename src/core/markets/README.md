# Markets Module

The Markets module provides a `MarketMetadataService` class that handles symbol normalization, precision management, and contract size conversions across different cryptocurrency exchanges.

## Overview

The `MarketMetadataService` is essential for the arbitrage system as it ensures:

- **Symbol Normalization**: Handles variations like `1000PEPEUSDT` → `PEPEUSDT`
- **Precision Management**: Rounds prices and amounts to valid exchange precision
- **Contract Size Conversion**: Converts base asset volumes to exchange-specific contracts
- **Order Validation**: Validates orders against exchange limits before placement

## Key Features

### Symbol Normalization
Different exchanges use different symbol formats for the same asset:
- Binance: `PEPEUSDT`
- Bitget: `1000PEPEUSDT` (scaled by contract size)

The service normalizes these to a common format for cross-exchange comparison.

### Contract Size Handling
Futures contracts often have different contract sizes:
- Standard: 1 contract = 1 unit of base asset
- Scaled: 1 contract = 1000 units of base asset (e.g., `1000PEPEUSDT`)

The service automatically converts between base volumes and contracts.

### Precision Management
Each exchange has specific precision requirements for prices and amounts. The service ensures orders are formatted correctly to avoid rejection.

## Usage

### Basic Setup

```typescript
import { MarketMetadataService } from './marketMetadataService'
import * as ccxt from 'ccxt'

// Initialize exchange
const exchange = new ccxt.binance()
const markets = await exchange.loadMarkets()

// Create metadata service
const metadataService = new MarketMetadataService('binance', Object.values(markets))
```

### Order Preparation

```typescript
// Convert base volume to contracts
const baseVolume = 1000
const contracts = metadataService.calculateContracts(baseVolume, 'PEPEUSDT')

// Round to valid precision
const price = metadataService.roundPrice(0.123456789, 'PEPEUSDT')
const amount = metadataService.roundAmount(contracts, 'PEPEUSDT')

// Validate order
const isValid = metadataService.validateOrder('PEPEUSDT', price, amount)
```

### Cross-Exchange Handling

```typescript
// Both services normalize to the same symbol
const binanceSymbol = binanceService.normalizeSymbol('PEPEUSDT')      // 'PEPEUSDT'
const bitgetSymbol = bitgetService.normalizeSymbol('1000PEPEUSDT')    // 'PEPEUSDT'

// Same base volume, different contracts
const baseVolume = 1000
const binanceContracts = binanceService.calculateContracts(baseVolume, 'PEPEUSDT')     // 1000
const bitgetContracts = bitgetService.calculateContracts(baseVolume, '1000PEPEUSDT')   // 1
```

## API Reference

### MarketMetadataService

#### Constructor
```typescript
constructor(exchangeId: string, markets: ccxt.Market[])
```

#### Methods

- `getMetadata(symbol: string): MarketMetadata | undefined`
- `normalizeSymbol(displaySymbol: string): string`
- `calculateContracts(volume: number, symbol: string): number`
- `roundPrice(price: number, symbol: string): number`
- `roundAmount(amount: number, symbol: string): number`
- `validateOrder(symbol: string, price: number, amount: number): boolean`
- `getAvailableSymbols(): string[]`
- `getNormalizedSymbols(): string[]`
- `getExchangeSymbol(normalizedSymbol: string): string | undefined`
- `hasSymbol(symbol: string): boolean`
- `getContractSize(symbol: string): number`
- `getPricePrecision(symbol: string): number`
- `getAmountPrecision(symbol: string): number`

### MarketMetadata Interface

```typescript
interface MarketMetadata {
  symbol: string              // Exchange-specific symbol (e.g., 1000PEPEUSDT)
  normalizedSymbol: string    // Cross-exchange normalized symbol (e.g., PEPEUSDT)
  contractSize: number
  pricePrecision: number
  amountPrecision: number
  minPrice?: number
  maxPrice?: number
  minAmount?: number
  maxAmount?: number
  minCost?: number
}
```

## Testing

Run the test suite to validate functionality:

```bash
npm test src/core/markets/marketMetadataService.test.ts
```

The tests cover:
- Symbol normalization across different formats
- Contract size conversion accuracy
- Precision rounding for prices and amounts
- Order validation against exchange limits
- Cross-exchange symbol mapping

## Integration with Arbitrage System

The `MarketMetadataService` integrates with:

1. **Trade Executor**: Ensures correct order formatting before placement
2. **Arbitrage Engine**: Normalizes symbols for cross-exchange comparison
3. **Order Validator**: Validates orders against exchange limits
4. **Risk Manager**: Provides precision and limit information

## Supported Exchanges

The service is designed to work with any exchange that provides CCXT-compatible market data, including:

- Binance
- Bybit
- OKX
- Bitget
- Gate.io

## Error Handling

The service throws descriptive errors for:
- Unknown symbols
- Invalid precision calculations
- Missing market metadata

All errors include the exchange ID and symbol for debugging. 