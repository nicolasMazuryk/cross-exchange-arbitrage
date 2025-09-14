/**
 * Funding-Aware Arbitrage Example
 * 
 * This example demonstrates how the enhanced ArbitrageEngine now integrates
 * funding data to provide comprehensive profitability projections that account
 * for both spread differences and time-based funding impacts.
 */

import { ArbitrageEngine } from '../core/arbitrage/arbitrageEngine'
import { OrderbookManager } from '../core/orderbook/orderbookManager'
import { MarketMetadataService } from '../core/markets/marketMetadataService'
import { FundingService } from '../core/funding/fundingService'
import { ExchangeMeta } from '../types/exchange'
import { ParsedFunding } from '../core/funding/types'
import logger from '../utils/logger'

/**
 * Example demonstrating funding-aware arbitrage opportunities
 */
export class FundingArbitrageExample {
  private arbitrageEngine: ArbitrageEngine
  private fundingService: FundingService

  constructor() {
    // Initialize services (this would normally be done by the orchestrator)
    this.initializeServices()
  }

  private initializeServices(): void {
    // Mock initialization - in real usage, these would be properly configured
    const orderbookManager = new OrderbookManager()
    const blacklistPairs: string[] = []
    const exchangeConfigs: ExchangeMeta[] = []
    const marketMetadataServices = new Map<string, MarketMetadataService>()
    this.fundingService = new FundingService(
      new Map(), // exchangeAdapters
      marketMetadataServices,
      {
        fetchIntervalMs: 60000,
        maxDataAgeMs: 120000,
        minFundingDifferential: 0.002,
        supportedExchanges: ['binance', 'bybit', 'okx', 'bitget'],
        projectionHours: 20,
        minProjectedProfitPercent: 0.001,
        maxFundingRateDeviation: 0.01
      }
    )

    this.arbitrageEngine = new ArbitrageEngine(
      orderbookManager,
      blacklistPairs,
      exchangeConfigs,
      marketMetadataServices,
      this.fundingService
    )

    // Set up event listeners
    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Listen for funding-aware arbitrage opportunities
    this.arbitrageEngine.on('opportunities', (opportunities) => {
      this.handleOpportunities(opportunities)
    })

    // Listen for funding data updates
    this.fundingService.on('fundingDataUpdated', (fundingData) => {
      this.handleFundingDataUpdate(fundingData)
    })
  }

  private handleOpportunities(opportunities: any[]): void {
    logger.info(`\n=== FUNDING-AWARE ARBITRAGE OPPORTUNITIES ===`)
    logger.info(`Found ${opportunities.length} opportunities\n`)

    opportunities.forEach((opportunity, index) => {
      logger.info(`Opportunity ${index + 1}:`)
      logger.info(`  Pair: ${opportunity.normalizedPair}`)
      logger.info(`  Exchanges: ${opportunity.buyExchange} → ${opportunity.sellExchange}`)
      logger.info(`  Volume: ${opportunity.normalizedVolume.toFixed(6)} ${opportunity.normalizedPair.split('USDT')[0]}`)
      logger.info(`  Volume USDT: $${opportunity.volumeUSDT.toFixed(2)}`)
      
      // Spread-based profitability
      logger.info(`  Spread Profit: $${opportunity.spreadProfit.toFixed(4)} (${(opportunity.spreadProfitPercent * 100).toFixed(3)}%)`)
      
      // Funding-based profitability
      if (opportunity.fundingProjection) {
        logger.info(`  Funding Profit: $${opportunity.fundingProfit.toFixed(4)} (${(opportunity.fundingProfitPercent * 100).toFixed(3)}%)`)
        logger.info(`  Max Drawdown: ${(opportunity.fundingProjection.maxDrawdownPercent * 100).toFixed(3)}%`)
        logger.info(`  Avg Hourly Return: ${(opportunity.fundingProjection.averageHourlyReturn * 100).toFixed(4)}%`)
        logger.info(`  Projection Hours: ${opportunity.fundingProjection.timeline.length} events`)
        
        // Show first few funding events
        logger.info(`  Funding Timeline (first 5 events):`)
        opportunity.fundingProjection.timeline.slice(0, 5).forEach((event, i) => {
          const date = new Date(event.timestamp).toISOString()
          logger.info(`    ${i + 1}. ${date}: Net=${event.netFunding.toFixed(4)}, Cumulative=${(event.cumulativeProfitPercent * 100).toFixed(3)}%`)
        })
      } else {
        logger.info(`  Funding Data: Not available`)
      }
      
      // Combined profitability
      logger.info(`  Combined Profit: $${opportunity.combinedProfit.toFixed(4)} (${(opportunity.combinedProfitPercent * 100).toFixed(3)}%)`)
      logger.info(`  Confidence: ${(opportunity.confidenceScore * 100).toFixed(1)}%`)
      logger.info('')
    })
  }

  private handleFundingDataUpdate(fundingData: Map<string, Map<string, ParsedFunding>>): void {
    logger.info('=== FUNDING DATA UPDATED ===')
    
    for (const [exchange, symbols] of fundingData) {
      logger.info(`[${exchange}] ${symbols.size} funding rates updated`)
      
      // Show a few examples
      let count = 0
      for (const [symbol, funding] of symbols) {
        if (count < 3) { // Show first 3 symbols
          logger.info(`  ${symbol}: ${(funding.fundingRatePercent * 100).toFixed(4)}% (next: ${funding.nextFundingDatetime.toISOString()})`)
          count++
        }
      }
    }
    logger.info('')
  }

  /**
   * Demonstrate different funding arbitrage scenarios
   */
  public demonstrateScenarios(): void {
    logger.info('=== FUNDING ARBITRAGE SCENARIOS ===\n')

    // Scenario 1: Inter-exchange spread shows profitability, funding rates show losses
    this.demonstrateScenario1()
    
    // Scenario 2: Inter-exchange spread shows losses, funding rates show profitability
    this.demonstrateScenario2()
    
    // Scenario 3: Both spread and funding show losses
    this.demonstrateScenario3()
    
    // Scenario 4: Both spread and funding show profitability
    this.demonstrateScenario4()
  }

  private demonstrateScenario1(): void {
    logger.info('Scenario 1: Spread profitable, funding unprofitable')
    logger.info('  - Buy on Exchange A: $50,000 (funding rate: -0.01%)')
    logger.info('  - Sell on Exchange B: $50,100 (funding rate: -0.05%)')
    logger.info('  - Spread profit: $100 (0.2%)')
    logger.info('  - Funding cost: -$40 over 20h (net funding rate difference)')
    logger.info('  - Combined result: $60 profit (0.12%)')
    logger.info('  - Decision: Execute if combined profit > threshold\n')
  }

  private demonstrateScenario2(): void {
    logger.info('Scenario 2: Spread unprofitable, funding profitable')
    logger.info('  - Buy on Exchange A: $50,000 (funding rate: 0.01%)')
    logger.info('  - Sell on Exchange B: $49,950 (funding rate: -0.01%)')
    logger.info('  - Spread loss: -$50 (-0.1%)')
    logger.info('  - Funding profit: +$20 over 20h (net funding rate difference)')
    logger.info('  - Combined result: -$30 loss (-0.06%)')
    logger.info('  - Decision: Skip due to net loss\n')
  }

  private demonstrateScenario3(): void {
    logger.info('Scenario 3: Both spread and funding unprofitable')
    logger.info('  - Buy on Exchange A: $50,000 (funding rate: -0.01%)')
    logger.info('  - Sell on Exchange B: $49,900 (funding rate: -0.02%)')
    logger.info('  - Spread loss: -$100 (-0.2%)')
    logger.info('  - Funding cost: -$10 over 20h (net funding rate difference)')
    logger.info('  - Combined result: -$110 loss (-0.22%)')
    logger.info('  - Decision: Skip due to net loss\n')
  }

  private demonstrateScenario4(): void {
    logger.info('Scenario 4: Both spread and funding profitable')
    logger.info('  - Buy on Exchange A: $50,000 (funding rate: 0.01%)')
    logger.info('  - Sell on Exchange B: $50,150 (funding rate: -0.01%)')
    logger.info('  - Spread profit: $150 (0.3%)')
    logger.info('  - Funding profit: +$20 over 20h (net funding rate difference)')
    logger.info('  - Combined result: $170 profit (0.34%)')
    logger.info('  - Decision: Execute - excellent opportunity\n')
  }

  /**
   * Start the funding arbitrage example
   */
  public async start(): Promise<void> {
    logger.info('Starting Funding-Aware Arbitrage Example...\n')
    
    // Demonstrate scenarios
    this.demonstrateScenarios()
    
    // Start the funding service
    this.fundingService.start()
    
    logger.info('Funding service started. Waiting for opportunities...\n')
    logger.info('The system will now:')
    logger.info('1. Monitor orderbook updates across exchanges')
    logger.info('2. Calculate spread-based arbitrage opportunities')
    logger.info('3. Integrate funding rate data for time-based projections')
    logger.info('4. Provide combined profitability analysis')
    logger.info('5. Handle asynchronous funding schedules')
    logger.info('6. Project profitability over the next 20 hours\n')
  }

  /**
   * Stop the example
   */
  public stop(): void {
    logger.info('Stopping Funding-Aware Arbitrage Example...')
    this.fundingService.stop()
  }
}

// Example usage
if (require.main === module) {
  const example = new FundingArbitrageExample()
  
  example.start().catch((error) => {
    logger.error('Error in funding arbitrage example:', error)
    process.exit(1)
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...')
    example.stop()
    process.exit(0)
  })
}
