import { EventEmitter } from 'events'
import { OrderbookManager, OrderBook, TopOfBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ExchangeMeta } from '../../types/exchange'
import { FundingService } from '../funding/fundingService'
import { ParsedFunding } from '../funding/types'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import config, { StrategyType } from '../../utils/config'

const logger = new Logger('arbitrage-engine')

// Core interfaces
interface FeeModel {
  maker: number
  taker: number
}

interface DepthSimulationResult {
  avgExecutionPrice: number
  avgNormalizedExecutionPrice: number
  slippagePercent: number
  hasError: boolean
}

interface OpportunityScore {
  estimatedProfitUsd: number
  estimatedProfitPercent: number
  spreadProfitUsd: number
  spreadProfitPercent: number
  fundingProfitUsd: number
  fundingProfitPercent: number
  costs: number
  costsPercent: number
  latencyPenalty: number
  confidenceScore: number
}

// Funding timeline interfaces
interface FundingEvent {
  timestamp: number
  time: Date
  buyExchangeFundingRate: number
  sellExchangeFundingRate: number
  netFundingRate: number
  cumulativeFundingRate: number
}

interface FundingProjection {
  timeline: FundingEvent[]
  totalProjectedFundingRate: number
  maxDrawdownFundingRate: number
  averageHourlyFundingRate: number
}

// Temporal Persistence Validation interfaces
interface ArbitrageCandidate {
  id: string
  normalizedPair: string
  buyExchange: string
  sellExchange: string
  buyExchangeSymbol: string
  sellExchangeSymbol: string
  firstDetectedAt: number
  lastDetectedAt: number
  buyExchangeConsecutiveSnapshots: number
  sellExchangeConsecutiveSnapshots: number
  avgBuyNormalizedExecutionPrice: number
  avgSellNormalizedExecutionPrice: number
  spreadProfitPercent: number
  fundingProfitPercent: number
  estimatedProfitPercent: number
  crossExchangePriceSpreadPercent: number
}

interface PersistenceValidationResult {
  isValid: boolean
  reason?: string
  candidate?: ArbitrageCandidate
}

export interface ArbitrageOpportunity {
  id: string
  normalizedPair: string
  buyExchangeSymbol: string
  sellExchangeSymbol: string
  buyExchange: string
  sellExchange: string
  avgBuyNormalizedExecutionPrice: number
  avgSellNormalizedExecutionPrice: number
  normalizedVolume: number
  buyExchangeVolume: number
  sellExchangeVolume: number
  orderAmountUsd: number
  
  confidenceScore: number
  traceId: string
  orderbookUpdateTimestamp: number
  // Strategy type
  strategy: StrategyType
  // Funding tracking
  buyExchangeNextFundingTimestamp: number
  sellExchangeNextFundingTimestamp: number
  targetFundingTimestamp: number
  // Profitability metrics
  costs: number
  costsPercent: number
  spreadProfitUsd: number
  spreadProfitPercent: number
  fundingProfitUsd: number
  fundingProfitPercent: number
  estimatedProfitUsd: number
  estimatedProfitPercent: number
}

export class ArbitrageEngine extends EventEmitter {
  private readonly blacklistPairs: string[]
  private readonly exchangeConfigs: Map<string, ExchangeMeta>
  private readonly feeModels: Map<string, FeeModel>
  private readonly orderbookManager: OrderbookManager
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly fundingService: FundingService
  private readonly orderAmountUsd: number
  private readonly minConfidenceScore: number
  private readonly maxMarketSpreadPercent: number
  private readonly maxAnomalySpreadThresholdPercent: number
  private readonly maxOrderbookAge: number
  private readonly orderAmountToleranceMinPercent: number
  private readonly orderAmountToleranceMaxPercent: number
  // Temporal Persistence Validation
  private readonly minPersistenceMs: number
  private readonly minConsecutiveSnapshots: number
  private readonly candidateCleanupMs: number
  private readonly candidates: Map<string, ArbitrageCandidate>
  private lastCleanupTime: number
  // Funding arbitrage configuration
  private readonly projectionHours: number
  // Strategy configuration
  private readonly fundingStrategyEnabled: boolean
  private readonly fundingStrategyEntryWindowStart: number
  private readonly fundingStrategyEntryWindowEnd: number
  private readonly fundingMinFundingProfitPercent: number
  private readonly fundingMinTotalProfitPercent: number
  private readonly spreadStrategyEnabled: boolean
  private readonly spreadStrategyEntryWindowStart: number
  private readonly spreadStrategyEntryWindowEnd: number
  private readonly spreadMinSpreadProfitPercent: number
  private readonly spreadMinTotalProfitPercent: number
  private readonly spreadNegativeFundingMultiplier: number
  // Anti-spam logging configuration
  private antiSpamLogTime: number

  constructor(
    orderbookManager: OrderbookManager,
    blacklistPairs: string[],
    exchangeConfigs: ExchangeMeta[],
    marketMetadataServices: Map<string, MarketMetadataService>,
    fundingService: FundingService
  ) {
    super()
    this.orderbookManager = orderbookManager
    this.blacklistPairs = blacklistPairs
    this.exchangeConfigs = new Map(exchangeConfigs.map(config => [config.name, config]))
    this.marketMetadataServices = marketMetadataServices
    this.fundingService = fundingService
    this.feeModels = new Map()
    this.orderAmountUsd = config.trading.orderAmountUsd
    this.minConfidenceScore = config.arbitrage.minConfidenceScore
    this.maxMarketSpreadPercent = config.arbitrage.maxMarketSpreadPercent
    this.maxAnomalySpreadThresholdPercent = config.arbitrage.maxAnomalySpreadThresholdPercent
    this.maxOrderbookAge = config.arbitrage.maxOrderbookAge
    this.orderAmountToleranceMinPercent = config.arbitrage.orderAmountToleranceMinPercent
    this.orderAmountToleranceMaxPercent = config.arbitrage.orderAmountToleranceMaxPercent
    // Temporal Persistence Validation
    this.minPersistenceMs = config.arbitrage.minPersistenceMs
    this.minConsecutiveSnapshots = config.arbitrage.minConsecutiveSnapshots
    this.candidateCleanupMs = config.arbitrage.candidateCleanupMs
    this.candidates = new Map()
    this.lastCleanupTime = Date.now()
    // Funding arbitrage configuration
    this.projectionHours = config.funding.projectionHours
    // Strategy configuration
    this.fundingStrategyEnabled = config.strategy.funding.enabled
    this.fundingStrategyEntryWindowStart = config.strategy.funding.entryWindowStart
    this.fundingStrategyEntryWindowEnd = config.strategy.funding.entryWindowEnd
    this.fundingMinFundingProfitPercent = config.strategy.funding.minFundingProfitPercent
    this.fundingMinTotalProfitPercent = config.strategy.funding.minTotalProfitPercent
    this.spreadStrategyEnabled = config.strategy.spread.enabled
    this.spreadStrategyEntryWindowStart = config.strategy.spread.entryWindowStart
    this.spreadStrategyEntryWindowEnd = config.strategy.spread.entryWindowEnd
    this.spreadMinSpreadProfitPercent = config.strategy.spread.minSpreadProfitPercent
    this.spreadMinTotalProfitPercent = config.strategy.spread.minTotalProfitPercent
    this.spreadNegativeFundingMultiplier = config.strategy.spread.negativeFundingMultiplier
    // Anti-spam logging configuration
    this.antiSpamLogTime = 0
    this.initializeModels()
    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Listen for top of book updates
    this.orderbookManager.on('topOfBookUpdate', (topOfBook: TopOfBook) => {
      try {
        TraceContext.runWithExistingTrace(topOfBook.traceId, 'arbitrage-scan', () => {
          this.scanOpportunities(topOfBook)
        })
      } catch (error) {
        logger.error({
          msg: 'Error scanning opportunities from orderbook update',
          function: 'ArbitrageEngine.setupEventListeners',
          exchange: topOfBook.exchange,
          symbol: topOfBook.symbol,
          error,
        })
      }
    })
  }

  private initializeModels(): void {
    // Initialize fee models for each exchange
    for (const [exchange, config] of this.exchangeConfigs) {
      this.feeModels.set(exchange, {
        maker: config.feeModel.maker,
        taker: config.feeModel.taker,
      })
    }
  }

  private simulateSlippage(
    orderbookSide: OrderBookLevel[],
    exchangeVolume: number,
    isBuy: boolean,
    exchange: string,
    exchangeSymbol: string,
    metadataService: MarketMetadataService
  ): DepthSimulationResult {
    let remainingVolume = exchangeVolume
    let weightedPrice = 0
    let hasError = false
    const basePrice = orderbookSide[0].price

    for (const level of orderbookSide) {
      const fillVolume = Math.min(remainingVolume, level.quantity)

      weightedPrice += level.price * fillVolume
      remainingVolume -= fillVolume

      if (remainingVolume <= 0) break
    }

    if (remainingVolume > 0) {
      hasError = true
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.warn({
          msg: 'Orderbook cannot fully fill requested volume',
          function: 'ArbitrageEngine.simulateSlippage',
          exchange,
          symbol: exchangeSymbol,
          side: isBuy ? 'BUY' : 'SELL',
          remainingVolume,
          requestedVolume: exchangeVolume,
          basePrice,
          remainingUsd: remainingVolume * basePrice,
          requestedUsd: exchangeVolume * basePrice,
        })
        this.antiSpamLogTime = Date.now()
      }
    }

    const avgExecutionPrice = weightedPrice / exchangeVolume
    const slippagePercent = isBuy
      ? ((avgExecutionPrice - basePrice) / basePrice) * 100
      : ((basePrice - avgExecutionPrice) / basePrice) * 100

    return {
      avgExecutionPrice,
      avgNormalizedExecutionPrice: metadataService.normalizePrice(avgExecutionPrice, exchangeSymbol),
      slippagePercent,
      hasError,
    }
  }

  private calculateConfidenceScore(
    orderbook: OrderBook,
    exchange: string,
    volume: number,
    marketSpreadPercent: number
  ): number {
    const config = this.exchangeConfigs.get(exchange)
    if (!config) return 0

    // Freshness score: How recent is the orderbook data
    const ageMs = Date.now() - orderbook.timestamp
    const freshnessScore = Math.max(0, 1 - ageMs / this.maxOrderbookAge)

    // Market spread score: Tighter spreads indicate better market quality
    // Normalize spread to a 0-1 score where 0 is MAX_MARKET_SPREAD and 1 is 0 spread
    const spreadScore = Math.max(0, 1 - marketSpreadPercent / this.maxMarketSpreadPercent)

    // Health score: Is the exchange operating normally
    const healthScore = config.isHealthy ? 1 : 0

    // Weighted average of all factors
    // Freshness is most important (40%), followed by spread (35%) and health (25%)
    return freshnessScore * 0.4 + spreadScore * 0.35 + healthScore * 0.25
  }

  private estimateProfit(
    normalizedBuyPrice: number,
    normalizedSellPrice: number,
    normalizedVolume: number,
    buyExchangeVolume: number,
    sellExchangeVolume: number,
    orderAmountUsd: number,
    buyExchange: string,
    sellExchange: string,
    buyExchangeSymbol: string,
    sellExchangeSymbol: string,
    buyBook: OrderBook,
    sellBook: OrderBook,
    buyMetadataService: MarketMetadataService,
    sellMetadataService: MarketMetadataService,
    entryBuySimulation: DepthSimulationResult,
    entrySellSimulation: DepthSimulationResult,
    exitBuySimulation: DepthSimulationResult,
    exitSellSimulation: DepthSimulationResult,
    fundingProjection: FundingProjection
  ): OpportunityScore {
    const buyFeeModel = this.feeModels.get(buyExchange)
    const sellFeeModel = this.feeModels.get(sellExchange)

    if (!buyFeeModel || !sellFeeModel) {
      logger.error({
        msg: 'Fee models not found for exchange',
        function: 'ArbitrageEngine.estimateProfit',
        buyExchange,
        sellExchange,
      })
      throw new Error(`Fee models not found for exchange: ${!buyFeeModel ? buyExchange : sellExchange}`)
    }

    // === COST BREAKDOWN ===

    // 1. TRADING FEES (Entry + Exit)
    const entryBuyFeeCosts =
      entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (buyFeeModel.taker / 100)
    const entrySellFeeCosts =
      entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (sellFeeModel.taker / 100)
    const exitBuyFeeCosts = exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (buyFeeModel.taker / 100)
    const exitSellFeeCosts =
      exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (sellFeeModel.taker / 100)

    const totalTradingFeesCosts = entryBuyFeeCosts + entrySellFeeCosts + exitBuyFeeCosts + exitSellFeeCosts

    // 2. SLIPPAGE COSTS (Entry + Exit)
    const entryBuySlippageCosts =
      entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (entryBuySimulation.slippagePercent / 100)
    const entrySellSlippageCosts =
      entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (entrySellSimulation.slippagePercent / 100)
    const exitBuySlippageCosts =
      exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (exitBuySimulation.slippagePercent / 100)
    const exitSellSlippageCosts =
      exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (exitSellSimulation.slippagePercent / 100)

    const totalSlippageCosts =
      entryBuySlippageCosts + entrySellSlippageCosts + exitBuySlippageCosts + exitSellSlippageCosts

    // 3. BUY/SELL SPREADS (Market Spreads)
    // When buying, we pay the ask price, so spread cost should be based on ask
    // When selling, we receive the bid price, so spread cost should be based on bid
    const buyMarketSpreadPercent = ((buyBook.asks[0].price - buyBook.bids[0].price) / buyBook.asks[0].price) * 100
    const sellMarketSpreadPercent = ((sellBook.asks[0].price - sellBook.bids[0].price) / sellBook.bids[0].price) * 100

    const buyMarketSpreadCosts =
      normalizedVolume *
      buyMetadataService.normalizePrice(buyBook.asks[0].price, buyExchangeSymbol) *
      (buyMarketSpreadPercent / 100)
    const sellMarketSpreadCosts =
      normalizedVolume *
      sellMetadataService.normalizePrice(sellBook.bids[0].price, sellExchangeSymbol) *
      (sellMarketSpreadPercent / 100)

    const totalSpreadCosts = buyMarketSpreadCosts + sellMarketSpreadCosts

    // 4. TOTAL COSTS
    const totalCosts = totalTradingFeesCosts + totalSlippageCosts + totalSpreadCosts
    const totalCostsPercent = (totalCosts / orderAmountUsd) * 100

    // === SPREAD PROFIT CALCULATION ===
    const spreadProfitUsd = (normalizedSellPrice - normalizedBuyPrice) * normalizedVolume
    const spreadProfitPercent = (spreadProfitUsd / orderAmountUsd) * 100

    // === FUNDING PROFIT CALCULATION ===
    const fundingProfitUsd = fundingProjection.timeline[0].netFundingRate * orderAmountUsd
    const fundingProfitPercent = fundingProjection.timeline[0].netFundingRate * 100

    // === COMBINED PROFIT CALCULATION ===
    const estimatedProfitUsd = fundingProfitUsd + spreadProfitUsd - totalCosts
    const estimatedProfitPercent = fundingProfitPercent + spreadProfitPercent - totalCostsPercent

    const latencyPenalty = this.calculateLatencyPenalty()

    const confidenceScore = Math.min(
      this.calculateConfidenceScore(buyBook, buyExchange, normalizedVolume, buyMarketSpreadPercent),
      this.calculateConfidenceScore(sellBook, sellExchange, normalizedVolume, sellMarketSpreadPercent)
    )
    
    return {
      estimatedProfitUsd,
      estimatedProfitPercent,
      spreadProfitUsd,
      spreadProfitPercent,
      fundingProfitUsd,
      fundingProfitPercent,
      costs: totalCosts,
      costsPercent: totalCostsPercent,
      latencyPenalty,
      confidenceScore,
    }
  }

  private calculateLatencyPenalty(): number {
    // TODO: exchange execution latency score
    return 0
  }

  /**
   * Calculate funding profitability projection over time
   */
  private calculateFundingProjection(buyFunding: ParsedFunding, sellFunding: ParsedFunding): FundingProjection {
    const timeline: FundingEvent[] = []
    let cumulativeFundingRate = 0
    let maxDrawdownFundingRate = 0
    let minCumulativeFundingRate = 0

    // Generate funding events for the projection period
    const fundingEvents = this.fundingService.generateFundingEvents(buyFunding, sellFunding, this.projectionHours)

    for (const event of fundingEvents) {
      // Calculate funding impact for this event
      // BUY position: positive funding rate = we pay (loss), negative = we receive (profit)
      // SELL position: positive funding rate = we receive (profit), negative = we pay (loss)
      const buyFundingImpactRate = -event.buyExchangeFundingRate // Negative because we're long on buy exchange
      const sellFundingImpactRate = event.sellExchangeFundingRate // Positive because we're short on sell exchange
      const netFundingRate = buyFundingImpactRate + sellFundingImpactRate // Combined funding impact

      cumulativeFundingRate += netFundingRate
      minCumulativeFundingRate = Math.min(minCumulativeFundingRate, cumulativeFundingRate)
      maxDrawdownFundingRate = Math.max(maxDrawdownFundingRate, cumulativeFundingRate - minCumulativeFundingRate)

      timeline.push({
        timestamp: event.timestamp,
        time: new Date(event.timestamp),
        buyExchangeFundingRate: event.buyExchangeFundingRate,
        sellExchangeFundingRate: event.sellExchangeFundingRate,
        netFundingRate: netFundingRate,
        cumulativeFundingRate: cumulativeFundingRate,
      })
    }

    return {
      timeline,
      totalProjectedFundingRate: cumulativeFundingRate,
      maxDrawdownFundingRate,
      averageHourlyFundingRate: cumulativeFundingRate / this.projectionHours,
    }
  }

  /**
   * Check if current time is within funding strategy execution window
   */
  private isWithinFundingWindow(nextFundingTimestamp: number): boolean {
    const now = Date.now()
    const timeUntilNextFunding = nextFundingTimestamp - now
    const timeUntilNextFundingSec = timeUntilNextFunding / 1000

    // Within window if time until funding is between entryWindowStart and entryWindowEnd (in seconds)
    return (
      timeUntilNextFundingSec <= this.fundingStrategyEntryWindowStart && timeUntilNextFundingSec >= this.fundingStrategyEntryWindowEnd
    )
  }

  /**
   * Check if current time is within spread strategy execution window
   */
  private isWithinSpreadWindow(previousFundingTimestamp: number, nextFundingTimestamp: number): boolean {
    const now = Date.now()
    const timeSincePreviousFunding = now - previousFundingTimestamp
    const timeSincePreviousFundingSec = timeSincePreviousFunding / 1000
    const timeUntilNextFunding = nextFundingTimestamp - now
    const timeUntilNextFundingSec = timeUntilNextFunding / 1000

    // Within window if time since previous funding > entryWindowStart AND time until next > entryWindowEnd
    return (
      timeSincePreviousFundingSec >= this.spreadStrategyEntryWindowStart &&
      timeUntilNextFundingSec >= this.spreadStrategyEntryWindowEnd
    )
  }

  /**
   * Validate funding arbitrage entry conditions (SYNC mode)
   */
  private validateFundingSyncEntry(fundingRateDifferencePercent: number, profitEstimate: OpportunityScore): boolean {
    return (
      fundingRateDifferencePercent - profitEstimate.costsPercent >= this.fundingMinFundingProfitPercent &&
      profitEstimate.estimatedProfitPercent >= this.fundingMinTotalProfitPercent
    )
  }

  /**
   * Validate funding arbitrage entry conditions (ASYNC mode)
   */
  private validateFundingAsyncEntry(
    buyFunding: ParsedFunding,
    sellFunding: ParsedFunding,
    profitEstimate: OpportunityScore,
    fundingEvents: Array<{ timestamp: number; buyExchangeFundingRate: number; sellExchangeFundingRate: number }>
  ): boolean {
    // Find the next sync timestamp
    const nextSyncTimestamp = this.fundingService.findNextSyncTimestamp(buyFunding, sellFunding)

    // Calculate cumulative funding rate until next sync (excluding the sync event itself)
    const cumulativeFundingRate = this.fundingService.calculateCumulativeFundingRate(nextSyncTimestamp, fundingEvents)

    // Check if cumulative funding profit meets minimum threshold
    return (
      cumulativeFundingRate * 100 - profitEstimate.costsPercent >= this.fundingMinFundingProfitPercent &&
      profitEstimate.estimatedProfitPercent >= this.fundingMinTotalProfitPercent
    )
  }

  /**
   * Validate spread arbitrage entry conditions
   */
  private validateSpreadEntry(fundingRateDifferencePercent: number, profitEstimate: OpportunityScore): boolean {
    // Case 1: Neutral or positive funding
    if (fundingRateDifferencePercent >= 0) {
      return (
        profitEstimate.spreadProfitPercent - profitEstimate.costsPercent >= this.spreadMinSpreadProfitPercent &&
        profitEstimate.estimatedProfitPercent >= this.spreadMinTotalProfitPercent
      )
    }

    // Case 2: Negative funding - apply multiplier to adjust for risk
    return (
      profitEstimate.spreadProfitPercent -
        profitEstimate.costsPercent +
        fundingRateDifferencePercent * this.spreadNegativeFundingMultiplier >=
        this.spreadMinSpreadProfitPercent && profitEstimate.estimatedProfitPercent >= this.spreadMinTotalProfitPercent
    )
  }

  /**
   * Determine and validate strategy type for an opportunity
   */
  private determineStrategy(
    buyFundingData: ParsedFunding,
    sellFundingData: ParsedFunding,
    profitEstimate: OpportunityScore
  ): { strategy: StrategyType | null; reason?: string } {
    const now = Date.now()

    // Validate funding data is not outdated
    if (buyFundingData.nextFundingTimestamp < now || sellFundingData.nextFundingTimestamp < now) {
      return { strategy: null, reason: 'Outdated funding data (nextFundingTimestamp < now)' }
    }

    const isSynchronized = this.fundingService.isFundingSynchronizedEntry(buyFundingData, sellFundingData)

    // Use the nearest funding timestamp (min of both exchanges)
    const nextFundingTimestamp = Math.min(buyFundingData.nextFundingTimestamp, sellFundingData.nextFundingTimestamp)
    const nextFundingInterval = Math.min(buyFundingData.fundingInterval, sellFundingData.fundingInterval)

    // Calculate previous funding timestamp based on funding interval
    const fundingIntervalMs = nextFundingInterval * 60 * 60 * 1000
    const previousFundingTimestamp = nextFundingTimestamp - fundingIntervalMs

    const withinFundingWindow = this.isWithinFundingWindow(nextFundingTimestamp)
    const withinSpreadWindow = this.isWithinSpreadWindow(previousFundingTimestamp, nextFundingTimestamp)

    // Calculate funding difference
    const fundingEvents = this.fundingService.generateFundingEvents(
      buyFundingData,
      sellFundingData,
      this.projectionHours
    )
    const fundingRateDifferencePercent =
      (-fundingEvents[0].buyExchangeFundingRate + fundingEvents[0].sellExchangeFundingRate) * 100

    // TEMPORARY FOR DEBUGGING
    if (fundingRateDifferencePercent !== profitEstimate.fundingProfitPercent) {
      console.log('fundingRateDifferencePercent === profitEstimate.fundingProfitPercent')
    }

    // Try funding strategy first if within window and enabled
    if (this.fundingStrategyEnabled && withinFundingWindow) {
      if (isSynchronized) {
        if (this.validateFundingSyncEntry(fundingRateDifferencePercent, profitEstimate)) {
          return { strategy: 'funding' }
        }
        if (fundingRateDifferencePercent > 0.3) {
          if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
            logger.info({
              msg: 'Funding strategy (SYNC) entry validation failed, BUT funding rate difference is HIGH',
              function: 'ArbitrageEngine.determineStrategy',
              buyExchange: buyFundingData.exchange,
              sellExchange: sellFundingData.exchange,
              symbol: buyFundingData.symbol,
              fundingRateDifferencePercent: fundingRateDifferencePercent.toFixed(3),
              fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
              estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
            })
            this.antiSpamLogTime = Date.now()
          }
        }
        return { strategy: null, reason: 'Funding window (SYNC) but validation failed' }
      } else {
        if (this.validateFundingAsyncEntry(buyFundingData, sellFundingData, profitEstimate, fundingEvents)) {
          return { strategy: 'funding' }
        }
        if (fundingRateDifferencePercent > 0.3) {
          if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
            logger.info({
              msg: 'Funding strategy (ASYNC) entry validation failed, BUT funding rate difference is HIGH',
              function: 'ArbitrageEngine.determineStrategy',
              buyExchange: buyFundingData.exchange,
              sellExchange: sellFundingData.exchange,
              symbol: buyFundingData.symbol,
              fundingRateDifferencePercent: fundingRateDifferencePercent.toFixed(3),
              fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
              estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
            })
            this.antiSpamLogTime = Date.now()
          }
        }
        return { strategy: null, reason: 'Funding window (ASYNC) but validation failed' }
      }
    }

    // Try spread strategy if within window, not in funding window, and enabled
    if (this.spreadStrategyEnabled && withinSpreadWindow && !(this.fundingStrategyEnabled && withinFundingWindow)) {
      if (this.validateSpreadEntry(fundingRateDifferencePercent, profitEstimate)) {
        return { strategy: 'spread' }
      }
      return { strategy: null, reason: 'Spread window but validation failed' }
    }

    // Not within any valid strategy window or strategies disabled
    return { strategy: null, reason: 'Not within any valid strategy execution window' }
  }

  // Temporal Persistence Validation Methods
  private generateCandidateKey(normalizedPair: string, buyExchange: string, sellExchange: string): string {
    return `${normalizedPair}::${buyExchange}::${sellExchange}`
  }

  private cleanupStaleCandidates(): void {
    const now = Date.now()
    if (now - this.lastCleanupTime < this.candidateCleanupMs) return

    const staleThreshold = now - this.candidateCleanupMs
    const keysToRemove: string[] = []

    for (const [key, candidate] of this.candidates) {
      if (candidate.lastDetectedAt < staleThreshold) {
        keysToRemove.push(key)
      }
    }

    for (const key of keysToRemove) {
      this.candidates.delete(key)
      logger.trace({
        msg: `Cleaned up stale candidate`,
        function: 'ArbitrageEngine.cleanupStaleCandidates',
        candidateKey: key,
      })
    }

    this.lastCleanupTime = now
  }

  private validatePersistence(
    normalizedPair: string,
    buyExchange: string,
    sellExchange: string,
    avgBuyNormalizedExecutionPrice: number,
    avgSellNormalizedExecutionPrice: number,
    profitEstimate: OpportunityScore,
    crossExchangePriceSpreadPercent: number,
    updatingExchange: string
  ): PersistenceValidationResult {
    const candidateKey = this.generateCandidateKey(normalizedPair, buyExchange, sellExchange)
    const now = Date.now()

    // Clean up stale candidates
    this.cleanupStaleCandidates()

    // Check if this is a new candidate or existing one
    const existingCandidate = this.candidates.get(candidateKey)

    if (!existingCandidate) {
      // New candidate - create and track
      const newCandidate: ArbitrageCandidate = {
        id: `${normalizedPair}:${buyExchange}:${sellExchange}:${(Date.now() % 1_000_000).toString().padStart(6, '0')}`,
        normalizedPair,
        buyExchange,
        sellExchange,
        buyExchangeSymbol: '', // Will be set in the calling method
        sellExchangeSymbol: '', // Will be set in the calling method
        firstDetectedAt: now,
        lastDetectedAt: now,
        buyExchangeConsecutiveSnapshots: updatingExchange === buyExchange ? 1 : 0,
        sellExchangeConsecutiveSnapshots: updatingExchange === sellExchange ? 1 : 0,
        avgBuyNormalizedExecutionPrice,
        avgSellNormalizedExecutionPrice,
        spreadProfitPercent: profitEstimate.spreadProfitPercent,
        fundingProfitPercent: profitEstimate.fundingProfitPercent,
        estimatedProfitPercent: profitEstimate.estimatedProfitPercent,
        crossExchangePriceSpreadPercent: crossExchangePriceSpreadPercent,
      }
      this.candidates.set(candidateKey, newCandidate)

      logger.trace({
        msg: 'New arbitrage candidate detected',
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
        candidateId: newCandidate.id,
        crossExchangePriceSpreadPercent: crossExchangePriceSpreadPercent.toFixed(3),
        spreadProfitPercent: profitEstimate.spreadProfitPercent.toFixed(3),
        fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
        estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
      })
      return { isValid: false, reason: 'New candidate - waiting for persistence', candidate: newCandidate }
    }

    // Existing candidate - check if spread is still valid using execution prices
    const crossExchangeSpreadChangeRatio =
      (crossExchangePriceSpreadPercent - existingCandidate.crossExchangePriceSpreadPercent) /
      existingCandidate.crossExchangePriceSpreadPercent
    const fundingProfitChangeRatio =
      (profitEstimate.fundingProfitPercent - existingCandidate.fundingProfitPercent) /
      existingCandidate.fundingProfitPercent
    const buyPriceChangeRatio =
      Math.abs(avgBuyNormalizedExecutionPrice - existingCandidate.avgBuyNormalizedExecutionPrice) /
      existingCandidate.avgBuyNormalizedExecutionPrice
    const sellPriceChangeRatio =
      Math.abs(avgSellNormalizedExecutionPrice - existingCandidate.avgSellNormalizedExecutionPrice) /
      existingCandidate.avgSellNormalizedExecutionPrice

    if (crossExchangeSpreadChangeRatio < -0.2) {
      logger.trace({
        msg: `Candidate ${candidateKey} spread decreased, resetting`,
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
      })
      this.candidates.delete(candidateKey)
      return { isValid: false, reason: 'Spread decreased significantly' }
    }
    if (fundingProfitChangeRatio < -0.2) {
      logger.trace({
        msg: `Candidate ${candidateKey} funding profit decreased, resetting`,
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
      })
      this.candidates.delete(candidateKey)
      return { isValid: false, reason: 'Funding profit decreased significantly' }
    }
    if (buyPriceChangeRatio > 0.01 || sellPriceChangeRatio > 0.01) {
      logger.trace({
        msg: `Candidate ${candidateKey} price changed, resetting`,
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
      })
      this.candidates.delete(candidateKey)
      return { isValid: false, reason: 'Price changed significantly' }
    }

    // Update existing candidate
    existingCandidate.lastDetectedAt = now

    // Update snapshots based on which exchange is updating
    if (updatingExchange === buyExchange) {
      existingCandidate.buyExchangeConsecutiveSnapshots++
    }
    if (updatingExchange === sellExchange) {
      existingCandidate.sellExchangeConsecutiveSnapshots++
    }

    existingCandidate.avgBuyNormalizedExecutionPrice = avgBuyNormalizedExecutionPrice
    existingCandidate.avgSellNormalizedExecutionPrice = avgSellNormalizedExecutionPrice
    existingCandidate.spreadProfitPercent = profitEstimate.spreadProfitPercent
    existingCandidate.fundingProfitPercent = profitEstimate.fundingProfitPercent
    existingCandidate.estimatedProfitPercent = profitEstimate.estimatedProfitPercent
    existingCandidate.crossExchangePriceSpreadPercent = crossExchangePriceSpreadPercent

    // Check persistence conditions
    const persistenceDuration = existingCandidate.lastDetectedAt - existingCandidate.firstDetectedAt
    const hasMinDuration = persistenceDuration >= this.minPersistenceMs
    const hasMinSnapshots =
      existingCandidate.buyExchangeConsecutiveSnapshots >= this.minConsecutiveSnapshots &&
      existingCandidate.sellExchangeConsecutiveSnapshots >= this.minConsecutiveSnapshots

    if (hasMinDuration && hasMinSnapshots) {
      logger.debug({
        msg: 'Arbitrage opportunity validated',
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
        candidateId: existingCandidate.id,
        persistenceDuration,
        buySnapshots: existingCandidate.buyExchangeConsecutiveSnapshots,
        sellSnapshots: existingCandidate.sellExchangeConsecutiveSnapshots,
        spreadProfitPercent: profitEstimate.spreadProfitPercent.toFixed(3),
        fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
        estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
      })
      this.candidates.delete(candidateKey) // Remove after validation
      return { isValid: true, candidate: existingCandidate }
    }

    logger.trace({
      msg: 'Candidate still building persistence',
      function: 'ArbitrageEngine.validatePersistence',
      candidateKey,
      candidateId: existingCandidate.id,
      persistenceDuration,
      buySnapshots: existingCandidate.buyExchangeConsecutiveSnapshots,
      sellSnapshots: existingCandidate.sellExchangeConsecutiveSnapshots,
    })
    return { isValid: false, reason: 'Building persistence', candidate: existingCandidate }
  }

  // Optimized: scan only the updated symbol across all exchanges to improve latency and CPU usage
  private scanOpportunities(topOfBook: TopOfBook): void {
    try {
      const allOrderbooks = this.orderbookManager.getAllOrderbooks()
      // const opportunities = this.scanAllOrderbooks(allOrderbooks)
      const opportunities = this.scanOrderbooksForSymbol(
        topOfBook.exchange,
        topOfBook.symbol,
        allOrderbooks,
        topOfBook.timestamp,
        topOfBook.traceId
      )

      if (opportunities.length > 0) {
        this.emit('opportunities', opportunities)
      }
    } catch (error) {
      logger.error({
        msg: 'Error scanning opportunities',
        function: 'ArbitrageEngine.scanOpportunities',
        exchange: topOfBook.exchange,
        symbol: topOfBook.symbol,
        error,
      })
    }
  }

  private scanOrderbooksForSymbol(
    updatingExchange: string,
    symbol: string,
    allOrderbooks: Map<string, Map<string, OrderBook>>,
    orderbookUpdateTimestamp: number,
    traceId: string
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = []

    try {
      const exchanges = Array.from(allOrderbooks.keys())

      const updatingExchangeMetadataService = this.marketMetadataServices.get(updatingExchange)
      if (!updatingExchangeMetadataService) return []

      const normalizedSymbol = updatingExchangeMetadataService.normalizeSymbol(symbol)
      if (!normalizedSymbol) return []

      // Get exchange-specific symbols
      const exchangeSymbols = new Map<string, string>()

      // Find the normalized pair and exchange-specific symbols
      for (const exchange of exchanges) {
        const metadataService = this.marketMetadataServices.get(exchange)
        if (!metadataService) continue

        const exchangeSymbol = metadataService.denormalizeSymbol(normalizedSymbol)
        if (exchangeSymbol) {
          exchangeSymbols.set(exchange, exchangeSymbol)
        }
      }

      if (!normalizedSymbol || this.blacklistPairs.includes(normalizedSymbol)) return []

      // Check all exchange pairs for this specific symbol
      for (let i = 0; i < exchanges.length; i++) {
        for (let j = i + 1; j < exchanges.length; j++) {
          const exchangeA = exchanges[i]
          const exchangeB = exchanges[j]

          const exchangeSymbolA = exchangeSymbols.get(exchangeA)
          const exchangeSymbolB = exchangeSymbols.get(exchangeB)

          if (!exchangeSymbolA || !exchangeSymbolB) continue

          const orderbookA = allOrderbooks.get(exchangeA)?.get(exchangeSymbolA)
          const orderbookB = allOrderbooks.get(exchangeB)?.get(exchangeSymbolB)

          if (!orderbookA || !orderbookB) continue

          // Get metadata services for denormalization
          const metadataServiceA = this.marketMetadataServices.get(exchangeA)
          const metadataServiceB = this.marketMetadataServices.get(exchangeB)

          if (!metadataServiceA || !metadataServiceB) continue

          // Get funding data for both exchanges
          const fundingDataA = this.fundingService.getSymbolFundingData(exchangeA, exchangeSymbolA)
          const fundingDataB = this.fundingService.getSymbolFundingData(exchangeB, exchangeSymbolB)

          if (!fundingDataA || !fundingDataB) continue

          // Check both directions with error handling
          try {
            this.checkDirection(
              normalizedSymbol,
              exchangeA,
              exchangeB,
              orderbookA,
              orderbookB,
              exchangeSymbolA,
              exchangeSymbolB,
              metadataServiceA,
              metadataServiceB,
              opportunities,
              fundingDataA,
              fundingDataB,
              updatingExchange,
              orderbookUpdateTimestamp,
              traceId
            )
          } catch (error) {
            logger.error({
              msg: 'Error checking direction',
              event: 'arbitrage_check_direction_failed',
              function: 'ArbitrageEngine.scanOrderbooksForSymbol',
              normalizedSymbol,
              buyExchange: exchangeA,
              sellExchange: exchangeB,
              error,
            })
          }

          try {
            this.checkDirection(
              normalizedSymbol,
              exchangeB,
              exchangeA,
              orderbookB,
              orderbookA,
              exchangeSymbolB,
              exchangeSymbolA,
              metadataServiceB,
              metadataServiceA,
              opportunities,
              fundingDataB,
              fundingDataA,
              updatingExchange,
              orderbookUpdateTimestamp,
              traceId
            )
          } catch (error) {
            logger.error({
              msg: 'Error checking direction',
              event: 'arbitrage_check_direction_failed',
              function: 'ArbitrageEngine.scanOrderbooksForSymbol',
              normalizedSymbol,
              buyExchange: exchangeB,
              sellExchange: exchangeA,
              error,
            })
          }
        }
      }

      return opportunities
    } catch (error) {
      logger.error({
        msg: 'Error scanning orderbooks for symbol',
        function: 'ArbitrageEngine.scanOrderbooksForSymbol',
        updatingExchange,
        symbol,
        error,
      })
      return opportunities
    }
  }

  private checkDirection(
    normalizedPair: string,
    buyExchange: string,
    sellExchange: string,
    buyBook: OrderBook,
    sellBook: OrderBook,
    buyExchangeSymbol: string,
    sellExchangeSymbol: string,
    buyMetadataService: MarketMetadataService,
    sellMetadataService: MarketMetadataService,
    opportunities: ArbitrageOpportunity[],
    buyFundingData: ParsedFunding,
    sellFundingData: ParsedFunding,
    updatingExchange: string,
    orderbookUpdateTimestamp: number,
    traceId: string
  ): void {
    // === PRICE NORMALIZATION ===
    // Use the new normalization functions to handle price scales and contract sizes
    const normalizedBuyPrice = buyMetadataService.normalizePrice(buyBook.asks[0].price, buyExchangeSymbol)
    const normalizedSellPrice = sellMetadataService.normalizePrice(sellBook.bids[0].price, sellExchangeSymbol)

    // === INITIAL SPREAD VALIDATION ===
    const crossExchangePriceSpreadPercent = ((normalizedSellPrice - normalizedBuyPrice) / normalizedBuyPrice) * 100

    if (crossExchangePriceSpreadPercent > this.maxAnomalySpreadThresholdPercent) return

    // === VOLUME CALCULATION ===
    // Calculate target normalized volume (base asset volume) based on order amount
    const targetNormalizedVolume = this.orderAmountUsd / normalizedBuyPrice

    // Convert normalized volume to exchange-specific contract amounts
    const buyExchangeVolume = buyMetadataService.denormalizeAmount(targetNormalizedVolume, buyExchangeSymbol)
    const sellExchangeVolume = sellMetadataService.denormalizeAmount(targetNormalizedVolume, sellExchangeSymbol)

    // Verify that both exchanges will have the same normalized volume
    const buyNormalizedVolume = buyMetadataService.normalizeAmount(buyExchangeVolume, buyExchangeSymbol)
    const sellNormalizedVolume = sellMetadataService.normalizeAmount(sellExchangeVolume, sellExchangeSymbol)

    // Use the smaller of the two to ensure both exchanges can handle the volume
    const minNormalizedVolume = Math.min(buyNormalizedVolume, sellNormalizedVolume)
    const maxNormalizedVolume = Math.max(buyNormalizedVolume, sellNormalizedVolume)

    // Recalculate exchange-specific volumes based on the actual normalized volume
    const minActualBuyExchangeVolume = buyMetadataService.denormalizeAmount(minNormalizedVolume, buyExchangeSymbol)
    const minActualSellExchangeVolume = sellMetadataService.denormalizeAmount(minNormalizedVolume, sellExchangeSymbol)
    const minActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(
      minActualBuyExchangeVolume,
      buyExchangeSymbol
    )
    const minActualSellNormalizedVolume = sellMetadataService.normalizeAmount(
      minActualSellExchangeVolume,
      sellExchangeSymbol
    )

    const maxActualBuyExchangeVolume = buyMetadataService.denormalizeAmount(maxNormalizedVolume, buyExchangeSymbol)
    const maxActualSellExchangeVolume = sellMetadataService.denormalizeAmount(maxNormalizedVolume, sellExchangeSymbol)
    const maxActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(
      maxActualBuyExchangeVolume,
      buyExchangeSymbol
    )
    const maxActualSellNormalizedVolume = sellMetadataService.normalizeAmount(
      maxActualSellExchangeVolume,
      sellExchangeSymbol
    )

    // === VOLUME VALIDATION ===
    let finalNormalizedVolume: number
    let finalBuyExchangeVolume: number
    let finalSellExchangeVolume: number

    // Check if min normalized volumes are equal
    if (Math.abs(minActualBuyNormalizedVolume - minActualSellNormalizedVolume) < 1e-10) {
      // Use min volumes
      finalNormalizedVolume = minNormalizedVolume
      finalBuyExchangeVolume = minActualBuyExchangeVolume
      finalSellExchangeVolume = minActualSellExchangeVolume
    } else if (Math.abs(maxActualBuyNormalizedVolume - maxActualSellNormalizedVolume) < 1e-10) {
      // Use max volumes
      finalNormalizedVolume = maxNormalizedVolume
      finalBuyExchangeVolume = maxActualBuyExchangeVolume
      finalSellExchangeVolume = maxActualSellExchangeVolume
    } else {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        // Neither min nor max volumes are equal - this indicates a problem with normalization
        logger.warn({
          msg: 'Volume normalization failed: either MIN or MAX normalized volumes are not equal for BUY and SELL',
          function: 'ArbitrageEngine.checkDirection',
          normalizedPair,
          minActualBuyNormalizedVolume,
          minActualSellNormalizedVolume,
          maxActualBuyNormalizedVolume,
          maxActualSellNormalizedVolume,
        })
        this.antiSpamLogTime = Date.now()
      }

      return
    }

    // Validate minimum contract amounts
    const buyMetadata = buyMetadataService.getMetadata(buyExchangeSymbol)
    const sellMetadata = sellMetadataService.getMetadata(sellExchangeSymbol)

    if (buyMetadata && finalBuyExchangeVolume < buyMetadata.minAmount!) {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.warn({
          msg: 'Buy volume below minimum',
          function: 'ArbitrageEngine.checkDirection',
          exchange: buyExchange,
          symbol: buyExchangeSymbol,
          volume: finalBuyExchangeVolume,
          minAmount: buyMetadata.minAmount,
        })
        this.antiSpamLogTime = Date.now()
      }
      return
    }

    if (sellMetadata && finalSellExchangeVolume < sellMetadata.minAmount!) {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.warn({
          msg: 'Sell volume below minimum',
          function: 'ArbitrageEngine.checkDirection',
          exchange: sellExchange,
          symbol: sellExchangeSymbol,
          volume: finalSellExchangeVolume,
          minAmount: sellMetadata.minAmount,
        })
        this.antiSpamLogTime = Date.now()
      }
      return
    }

    // Validate order amount tolerance using normalized price
    const orderAmountUsd = finalNormalizedVolume * normalizedBuyPrice
    if (
      orderAmountUsd < (this.orderAmountUsd * this.orderAmountToleranceMinPercent) / 100 ||
      orderAmountUsd > (this.orderAmountUsd * this.orderAmountToleranceMaxPercent) / 100
    ) {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.warn({
          msg: 'Normalized volume is outside order amount tolerance range',
          function: 'ArbitrageEngine.checkDirection',
          exchange: buyExchange,
          symbol: buyExchangeSymbol,
          orderAmountUsd,
          minAllowed: (this.orderAmountUsd * this.orderAmountToleranceMinPercent) / 100,
          maxAllowed: (this.orderAmountUsd * this.orderAmountToleranceMaxPercent) / 100,
        })
        this.antiSpamLogTime = Date.now()
      }
      return
    }

    // Simulate slippage for both entry legs using the actual exchange-specific volumes
    const entryBuySimulation = this.simulateSlippage(
      buyBook.asks,
      finalBuyExchangeVolume,
      true,
      buyExchange,
      buyExchangeSymbol,
      buyMetadataService
    )
    const entrySellSimulation = this.simulateSlippage(
      sellBook.bids,
      finalSellExchangeVolume,
      false,
      sellExchange,
      sellExchangeSymbol,
      sellMetadataService
    )

    // === EXIT SLIPPAGE SIMULATION ===
    // Simulate exit slippage for both exchanges using the actual exchange-specific volumes
    const exitBuySimulation = this.simulateSlippage(
      buyBook.bids,
      finalBuyExchangeVolume,
      false,
      buyExchange,
      buyExchangeSymbol,
      buyMetadataService
    )
    const exitSellSimulation = this.simulateSlippage(
      sellBook.asks,
      finalSellExchangeVolume,
      true,
      sellExchange,
      sellExchangeSymbol,
      sellMetadataService
    )

    if (entryBuySimulation.hasError || entrySellSimulation.hasError || exitBuySimulation.hasError || exitSellSimulation.hasError) {
      return
    }

    // === FUNDING PROJECTION ===
    const orderAmountAfterSlippageUsd = entryBuySimulation.avgNormalizedExecutionPrice * finalNormalizedVolume

    const targetFundingTimestamp = Math.min(buyFundingData.nextFundingTimestamp, sellFundingData.nextFundingTimestamp)

    const fundingProjection = this.calculateFundingProjection(buyFundingData, sellFundingData)

    // === PROFIT ESTIMATION ===
    const profitEstimate = this.estimateProfit(
      normalizedBuyPrice,
      normalizedSellPrice,
      finalNormalizedVolume,
      finalBuyExchangeVolume,
      finalSellExchangeVolume,
      orderAmountAfterSlippageUsd,
      buyExchange,
      sellExchange,
      buyExchangeSymbol,
      sellExchangeSymbol,
      buyBook,
      sellBook,
      buyMetadataService,
      sellMetadataService,
      entryBuySimulation,
      entrySellSimulation,
      exitBuySimulation,
      exitSellSimulation,
      fundingProjection
    )

    // === CONFIDENCE VALIDATION ===
    if (profitEstimate.confidenceScore < this.minConfidenceScore) return

    // === STRATEGY VALIDATION ===
    // Determine which strategy this opportunity belongs to and validate entry conditions
    const strategyResult = this.determineStrategy(buyFundingData, sellFundingData, profitEstimate)

    // Reject opportunity if no valid strategy
    if (!strategyResult.strategy) {
      logger.debug({
        msg: 'Opportunity rejected',
        function: 'ArbitrageEngine.checkDirection',
        normalizedPair,
        buyExchange,
        sellExchange,
        reason: strategyResult.reason,
      })
      return
    }

    logger.debug({
      msg: 'Strategy validated',
      function: 'ArbitrageEngine.checkDirection',
      normalizedPair,
      buyExchange,
      sellExchange,
      strategy: strategyResult.strategy,
    })

    // Use the validated opportunity from the persistence check
    const persistenceResult = this.validatePersistence(
      normalizedPair,
      buyExchange,
      sellExchange,
      entryBuySimulation.avgNormalizedExecutionPrice,
      entrySellSimulation.avgNormalizedExecutionPrice,
      profitEstimate,
      crossExchangePriceSpreadPercent,
      updatingExchange // Use provided updating exchange
    )

    if (!persistenceResult.isValid) {
      logger.debug({
        msg: 'Opportunity not persisted',
        function: 'ArbitrageEngine.checkDirection',
        normalizedPair,
        buyExchange,
        sellExchange,
        reason: persistenceResult.reason,
      })
      return // Opportunity hasn't met persistence requirements yet
    }

    // === OPPORTUNITY CREATION ===
    // Calculate volumeUSDT as the maximum between buy and sell sides
    const orderAmountMaxSideUsd = Math.max(
      finalNormalizedVolume * entryBuySimulation.avgNormalizedExecutionPrice,
      finalNormalizedVolume * entrySellSimulation.avgNormalizedExecutionPrice
    )

    // Create the final opportunity object with funding-aware data and strategy annotation
    opportunities.push({
      id: persistenceResult.candidate!.id,
      strategy: strategyResult.strategy,
      buyExchange,
      sellExchange,
      normalizedPair,
      normalizedVolume: finalNormalizedVolume,
      orderAmountUsd: orderAmountMaxSideUsd,
      avgBuyNormalizedExecutionPrice: entryBuySimulation.avgNormalizedExecutionPrice,
      avgSellNormalizedExecutionPrice: entrySellSimulation.avgNormalizedExecutionPrice,
      buyExchangeSymbol,
      sellExchangeSymbol,
      buyExchangeVolume: finalBuyExchangeVolume,
      sellExchangeVolume: finalSellExchangeVolume,
      // Additional properties
      confidenceScore: profitEstimate.confidenceScore,
      orderbookUpdateTimestamp,
      traceId,
      // Funding tracking
      buyExchangeNextFundingTimestamp: buyFundingData.nextFundingTimestamp,
      sellExchangeNextFundingTimestamp: sellFundingData.nextFundingTimestamp,
      targetFundingTimestamp,
      // Profitability metrics
      costs: profitEstimate.costs,
      costsPercent: profitEstimate.costsPercent,
      spreadProfitUsd: profitEstimate.spreadProfitUsd,
      spreadProfitPercent: profitEstimate.spreadProfitPercent,
      fundingProfitUsd: profitEstimate.fundingProfitUsd,
      fundingProfitPercent: profitEstimate.fundingProfitPercent,
      estimatedProfitUsd: profitEstimate.estimatedProfitUsd, // Use combined profit as the main metric
      estimatedProfitPercent: profitEstimate.estimatedProfitPercent, // Use combined profit percent as the main metric
    })
  }

  private getCommonPairs(orderbooks: Map<string, Map<string, OrderBook>>): string[] {
    // Get normalized symbols for each exchange
    const normalizedPairSets = Array.from(orderbooks.entries()).map(([exchangeId, orderbook]) => {
      const metadataService = this.marketMetadataServices.get(exchangeId)
      if (!metadataService) return new Set<string>()

      // Convert exchange-specific symbols to normalized symbols
      const normalizedPairs = new Set<string>()
      for (const symbol of orderbook.keys()) {
        const normalizedSymbol = metadataService.normalizeSymbol(symbol)
        normalizedPairs.add(normalizedSymbol)
      }
      return normalizedPairs
    })

    // Find common normalized symbols across all exchanges
    return Array.from(
      normalizedPairSets.reduce((common, pairs) => {
        if (common.size === 0) return pairs
        return new Set([...common].filter(pair => pairs.has(pair)))
      }, new Set<string>())
    )
  }
}
