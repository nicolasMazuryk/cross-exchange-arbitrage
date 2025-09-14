# Funding-Aware Arbitrage System

## Overview

The enhanced ArbitrageEngine now integrates funding data to provide comprehensive profitability projections that account for both spread differences and time-based funding impacts. This system addresses the four key scenarios in funding arbitrage and provides detailed timeline projections.

## Key Features

### 1. Combined Profitability Analysis
- **Spread Profit**: Immediate profit/loss from price differences between exchanges
- **Funding Profit**: Time-based profit/loss from funding rate differentials
- **Combined Profit**: Total projected profitability over the holding period

### 2. Time-Based Projections
- Projects profitability over configurable time periods (default: 20 hours)
- Handles asynchronous funding schedules across exchanges
- Calculates cumulative profit/loss at each funding event
- Tracks maximum drawdown and average hourly returns

### 3. Funding Schedule Alignment
- **Synchronous**: Both exchanges fund at the same UTC hour
- **Asynchronous**: Exchanges fund at different times (e.g., 1h vs 4h intervals)
- Handles interim funding effects when schedules don't align

## Configuration

```yaml
funding:
  # Existing funding configuration
  fetchIntervalMs: 60000
  maxDataAgeMs: 120000
  minFundingDifferential: 0.002
  supportedExchanges: ["binance", "bybit", "okx", "bitget"]
  
  # New funding arbitrage settings
  projectionHours: 20                    # Hours to project funding profitability
  minProjectedProfitPercent: 0.001       # Minimum projected profit (0.1%)
  maxFundingRateDeviation: 0.01          # Maximum funding rate deviation (1%)
```

## Data Structures

### FundingEvent
```typescript
interface FundingEvent {
  timestamp: number              // When the funding event occurs
  buyExchangeFunding: number     // Funding rate for buy exchange
  sellExchangeFunding: number    // Funding rate for sell exchange
  netFunding: number            // Net funding impact (positive = profit)
  cumulativeProfit: number      // Cumulative profit up to this point
  cumulativeProfitPercent: number // Cumulative profit as percentage
}
```

### FundingProjection
```typescript
interface FundingProjection {
  timeline: FundingEvent[]      // Array of funding events over time
  totalProjectedProfit: number  // Total projected profit over period
  totalProjectedProfitPercent: number // Total profit as percentage
  maxDrawdown: number          // Maximum drawdown in absolute terms
  maxDrawdownPercent: number   // Maximum drawdown as percentage
  averageHourlyReturn: number  // Average return per hour
  isProfitable: boolean        // Whether the projection is profitable
}
```

### Enhanced ArbitrageOpportunity
```typescript
interface ArbitrageOpportunity {
  // Existing fields...
  estimatedProfit: number
  estimatedProfitPercent: number
  
  // New funding-aware fields
  fundingProjection?: FundingProjection
  spreadProfit: number
  spreadProfitPercent: number
  fundingProfit: number
  fundingProfitPercent: number
  combinedProfit: number
  combinedProfitPercent: number
}
```

## Four Key Scenarios

### Scenario 1: Spread Profitable, Funding Unprofitable
- **Example**: Buy $50,000 (funding: -0.01%), Sell $50,100 (funding: -0.05%)
- **Spread Profit**: $100 (0.2%)
- **Funding Cost**: -$40 over 20h
- **Combined Result**: $60 profit (0.12%)
- **Decision**: Execute if combined profit > threshold

### Scenario 2: Spread Unprofitable, Funding Profitable
- **Example**: Buy $50,000 (funding: 0.01%), Sell $49,950 (funding: -0.01%)
- **Spread Loss**: -$50 (-0.1%)
- **Funding Profit**: +$20 over 20h
- **Combined Result**: -$30 loss (-0.06%)
- **Decision**: Skip due to net loss

### Scenario 3: Both Unprofitable
- **Example**: Buy $50,000 (funding: -0.01%), Sell $49,900 (funding: -0.02%)
- **Spread Loss**: -$100 (-0.2%)
- **Funding Cost**: -$10 over 20h
- **Combined Result**: -$110 loss (-0.22%)
- **Decision**: Skip due to net loss

### Scenario 4: Both Profitable
- **Example**: Buy $50,000 (funding: 0.01%), Sell $50,150 (funding: -0.01%)
- **Spread Profit**: $150 (0.3%)
- **Funding Profit**: +$20 over 20h
- **Combined Result**: $170 profit (0.34%)
- **Decision**: Execute - excellent opportunity

## Algorithm Details

### 1. Funding Event Generation
```typescript
private generateFundingEvents(
  buyFunding: ParsedFunding,
  sellFunding: ParsedFunding,
  startTime: number,
  projectionHours: number
): Array<{ timestamp: number, buyExchangeFunding: number, sellExchangeFunding: number }>
```

- Generates funding events for both exchanges over the projection period
- Handles different funding intervals (1h, 2h, 4h, 8h)
- Merges events from both exchanges and sorts by timestamp
- Accounts for asynchronous funding schedules

### 2. Profitability Projection
```typescript
private calculateFundingProjection(
  buyExchange: string,
  sellExchange: string,
  buyExchangeSymbol: string,
  sellExchangeSymbol: string,
  normalizedVolume: number,
  positionValue: number
): FundingProjection | null
```

- Retrieves funding data for both exchanges
- Validates funding rate deviation limits
- Calculates cumulative profit/loss over time
- Tracks maximum drawdown and average returns
- Returns null if funding data is unavailable or invalid

### 3. Combined Profit Calculation
```typescript
// In checkDirection method
const spreadProfit = profitEstimate.estimatedProfit
const fundingProfit = fundingProjection?.totalProjectedProfit || 0
const combinedProfit = spreadProfit + fundingProfit
```

- Combines immediate spread profit with projected funding profit
- Uses combined profit as the primary sorting and filtering metric
- Maintains separate tracking of spread vs funding components

## Usage Example

```typescript
// Listen for funding-aware opportunities
arbitrageEngine.on('opportunities', (opportunities) => {
  opportunities.forEach(opportunity => {
    console.log(`Pair: ${opportunity.normalizedPair}`)
    console.log(`Spread Profit: ${(opportunity.spreadProfitPercent * 100).toFixed(3)}%`)
    console.log(`Funding Profit: ${(opportunity.fundingProfitPercent * 100).toFixed(3)}%`)
    console.log(`Combined Profit: ${(opportunity.combinedProfitPercent * 100).toFixed(3)}%`)
    
    if (opportunity.fundingProjection) {
      console.log(`Max Drawdown: ${(opportunity.fundingProjection.maxDrawdownPercent * 100).toFixed(3)}%`)
      console.log(`Timeline Events: ${opportunity.fundingProjection.timeline.length}`)
    }
  })
})
```

## Benefits

1. **Comprehensive Analysis**: Considers both immediate and time-based profitability
2. **Risk Management**: Tracks maximum drawdown and funding schedule misalignment
3. **Informed Decisions**: Provides detailed projections for better opportunity evaluation
4. **Flexible Configuration**: Adjustable projection periods and profit thresholds
5. **Real-time Updates**: Integrates with live funding rate data

## Monitoring and Logging

The system provides detailed logging for:
- Funding data updates and availability
- Opportunity detection with spread vs funding breakdown
- Funding projection calculations and timeline events
- Combined profitability analysis and decision rationale

## Future Enhancements

1. **Dynamic Funding Rate Updates**: Real-time funding rate adjustments during position holding
2. **Risk-Adjusted Returns**: Incorporate volatility and correlation metrics
3. **Position Sizing**: Optimize position sizes based on funding projections
4. **Exit Strategies**: Automated exit based on funding timeline milestones
5. **Cross-Asset Funding**: Extend to funding arbitrage across different assets
