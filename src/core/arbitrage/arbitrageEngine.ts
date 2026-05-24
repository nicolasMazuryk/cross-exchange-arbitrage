import { EventEmitter } from 'events'
import { OrderbookManager, OrderBook, TopOfBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ExchangeMeta, MarketType } from '../../types/exchange'
import { FundingService } from '../funding/fundingService'
import { ParsedFunding } from '../funding/types'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import config, { getFees, StrategyType, StrategyVariant } from '../../utils/config'
import { quotesAreCompatible } from '../../utils/utils'

const logger = new Logger('arbitrage-engine')

// Core interfaces
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
  costsUsd: number
  costsPercent: number
  tradingFeesUsd: number
  tradingFeesPercent: number
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
  crossLegsPriceSpreadPercent: number
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
  buyMarketType: MarketType
  sellMarketType: MarketType
  bothLegsArePerp: boolean
  isSpotSpot: boolean
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
  strategyVariant: StrategyVariant
  // Funding tracking
  buyExchangeNextFundingTimestamp: number
  sellExchangeNextFundingTimestamp: number
  targetFundingTimestamp: number
  // Profitability metrics
  costsUsd: number
  costsPercent: number
  tradingFeesUsd: number
  tradingFeesPercent: number
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
  private readonly spreadFundingProfitEnabled: boolean
  private readonly sellSpotBuyPerpEnabled: boolean
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
    this.spreadFundingProfitEnabled = config.strategy.spread.fundingProfitEnabled
    this.sellSpotBuyPerpEnabled = config.arbitrage.sellSpotBuyPerpEnabled
    // Anti-spam logging configuration
    this.antiSpamLogTime = 0
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
    fundingProjection: FundingProjection,
    buyMarketType: MarketType,
    sellMarketType: MarketType,
    isSpotSpot: boolean
  ): OpportunityScore {
    const buyFee = getFees(buyExchange, buyMarketType)
    const sellFee = getFees(sellExchange, sellMarketType)

    // === COST BREAKDOWN ===

    // 1. TRADING FEES (Entry + Exit)
    const entryBuyFeeCosts =
      entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (buyFee.taker / 100)
    const entrySellFeeCosts =
      entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (sellFee.taker / 100)
    const exitBuyFeeCosts = isSpotSpot ? 0 : exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (buyFee.taker / 100)
    const exitSellFeeCosts = isSpotSpot
      ? 0
      : exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (sellFee.taker / 100)

    const totalTradingFeesCostsUsd = entryBuyFeeCosts + entrySellFeeCosts + exitBuyFeeCosts + exitSellFeeCosts
    const totalTradingFeesCostsPercent = (totalTradingFeesCostsUsd / orderAmountUsd) * 100

    // 2. SLIPPAGE COSTS (Entry + Exit)
    const entryBuySlippageCosts =
      entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (entryBuySimulation.slippagePercent / 100)
    const entrySellSlippageCosts =
      entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (entrySellSimulation.slippagePercent / 100)
    const exitBuySlippageCosts = isSpotSpot
      ? 0
      : exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * (exitBuySimulation.slippagePercent / 100)
    const exitSellSlippageCosts = isSpotSpot
      ? 0
      : exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * (exitSellSimulation.slippagePercent / 100)

    const totalSlippageCosts =
      entryBuySlippageCosts + entrySellSlippageCosts + exitBuySlippageCosts + exitSellSlippageCosts

    // 3. BUY/SELL SPREADS (Market Spreads)
    // When buying, we pay the ask price, so spread cost should be based on ask
    // When selling, we receive the bid price, so spread cost should be based on bid
    const buyMarketSpreadPercent = ((buyBook.asks[0].price - buyBook.bids[0].price) / buyBook.asks[0].price) * 100
    const sellMarketSpreadPercent = ((sellBook.asks[0].price - sellBook.bids[0].price) / sellBook.bids[0].price) * 100

    const buyMarketSpreadCosts = isSpotSpot
      ? 0
      : normalizedVolume *
        buyMetadataService.normalizePrice(buyBook.asks[0].price, buyExchangeSymbol) *
        (buyMarketSpreadPercent / 100)
    const sellMarketSpreadCosts = isSpotSpot
      ? 0
      : normalizedVolume *
        sellMetadataService.normalizePrice(sellBook.bids[0].price, sellExchangeSymbol) *
        (sellMarketSpreadPercent / 100)

    const totalSpreadCosts = buyMarketSpreadCosts + sellMarketSpreadCosts

    // 4. TOTAL COSTS
    const totalCostsUsd = totalTradingFeesCostsUsd + totalSlippageCosts + totalSpreadCosts
    const totalCostsPercent = (totalCostsUsd / orderAmountUsd) * 100

    // === SPREAD PROFIT CALCULATION ===
    const spreadProfitUsd = (normalizedSellPrice - normalizedBuyPrice) * normalizedVolume
    const spreadProfitPercent = (spreadProfitUsd / orderAmountUsd) * 100

    // === FUNDING PROFIT CALCULATION ===
    const firstEvent = fundingProjection.timeline[0]
    const fundingProfitUsd = (isSpotSpot || !this.spreadFundingProfitEnabled) ? 0 : (firstEvent ? firstEvent.netFundingRate * orderAmountUsd : 0)
    const fundingProfitPercent = (isSpotSpot || !this.spreadFundingProfitEnabled) ? 0 : (firstEvent ? firstEvent.netFundingRate * 100 : 0)

    // === COMBINED PROFIT CALCULATION ===
    const estimatedProfitUsd = fundingProfitUsd + spreadProfitUsd - totalCostsUsd
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
      costsUsd: totalCostsUsd,
      costsPercent: totalCostsPercent,
      tradingFeesUsd: totalTradingFeesCostsUsd,
      tradingFeesPercent: totalTradingFeesCostsPercent,
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
  private calculateFundingProjection(
    buyFunding: ParsedFunding | undefined,
    sellFunding: ParsedFunding | undefined
  ): FundingProjection {
    // spot+spot: no funding contribution from either leg
    if (!buyFunding && !sellFunding) {
      return { timeline: [], totalProjectedFundingRate: 0, maxDrawdownFundingRate: 0, averageHourlyFundingRate: 0 }
    }

    const timeline: FundingEvent[] = []
    let cumulativeFundingRate = 0
    let maxDrawdownFundingRate = 0
    let minCumulativeFundingRate = 0

    if (buyFunding && sellFunding) {
      // perp+perp: dual-impact logic
      const fundingEvents = this.fundingService.generateFundingEvents(buyFunding, sellFunding, this.projectionHours)

      for (const event of fundingEvents) {
        const netFundingRate = -event.buyExchangeFundingRate + event.sellExchangeFundingRate

        cumulativeFundingRate += netFundingRate
        minCumulativeFundingRate = Math.min(minCumulativeFundingRate, cumulativeFundingRate)
        maxDrawdownFundingRate = Math.max(maxDrawdownFundingRate, cumulativeFundingRate - minCumulativeFundingRate)

        timeline.push({
          timestamp: event.timestamp,
          time: new Date(event.timestamp),
          buyExchangeFundingRate: event.buyExchangeFundingRate,
          sellExchangeFundingRate: event.sellExchangeFundingRate,
          netFundingRate,
          cumulativeFundingRate,
        })
      }
    } else {
      // spot+perp: single-leg schedule drives timeline, spot side contributes 0
      const definedFunding = buyFunding ?? sellFunding!
      const isBuyPerp = !!buyFunding
      const startTime = definedFunding.nextFundingTimestamp
      const endTime = startTime + this.projectionHours * 60 * 60 * 1000
      const singleLegEvents = this.fundingService.generateExchangeFundingEvents(definedFunding, startTime, endTime)

      for (const event of singleLegEvents) {
        // Long perp (buy leg): pay positive funding → net negative
        // Short perp (sell leg): receive positive funding → net positive
        const netFundingRate = isBuyPerp ? -event.fundingRate : event.fundingRate

        cumulativeFundingRate += netFundingRate
        minCumulativeFundingRate = Math.min(minCumulativeFundingRate, cumulativeFundingRate)
        maxDrawdownFundingRate = Math.max(maxDrawdownFundingRate, cumulativeFundingRate - minCumulativeFundingRate)

        timeline.push({
          timestamp: event.timestamp,
          time: new Date(event.timestamp),
          buyExchangeFundingRate: isBuyPerp ? event.fundingRate : 0,
          sellExchangeFundingRate: isBuyPerp ? 0 : event.fundingRate,
          netFundingRate,
          cumulativeFundingRate,
        })
      }
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
    if (profitEstimate.fundingProfitPercent >= 0) {
      return (
        // profitEstimate.spreadProfitPercent - profitEstimate.costsPercent >= this.spreadMinSpreadProfitPercent &&
        profitEstimate.estimatedProfitPercent >= this.spreadMinTotalProfitPercent
      )
    }

    // Case 2: Negative funding - apply multiplier only when funding profit is enabled
    const fundingAdjustment = profitEstimate.fundingProfitPercent * this.spreadNegativeFundingMultiplier
    return (
        // profitEstimate.spreadProfitPercent - profitEstimate.costsPercent >= this.spreadMinSpreadProfitPercent + fundingAdjustment &&
        profitEstimate.estimatedProfitPercent >= this.spreadMinTotalProfitPercent + fundingAdjustment
    )
  }

/**
   * Determine and validate strategy type for an opportunity
   */
  private determineStrategy(
    buyFundingData: ParsedFunding | undefined,
    sellFundingData: ParsedFunding | undefined,
    profitEstimate: OpportunityScore,
    bothLegsArePerp: boolean
  ): { strategy: StrategyType | null; variant: 'sync' | 'async' | 'spread' | null; reason?: string } {
    // Non-perp legs (spot+spot or spot+perp): spread strategy only
    if (!bothLegsArePerp) {
      if (this.spreadStrategyEnabled && this.validateSpreadEntry(profitEstimate.fundingProfitPercent, profitEstimate)) {
        return { strategy: 'spread', variant: 'spread' }
      }
      return { strategy: null, variant: null, reason: 'Non-perp legs: spread validation failed' }
    }

    // perp+perp: both legs guaranteed non-undefined by scanOrderbooksForSymbol guard
    const now = Date.now()

    if (buyFundingData!.nextFundingTimestamp < now || sellFundingData!.nextFundingTimestamp < now) {
      return { strategy: null, variant: null, reason: 'Outdated funding data (nextFundingTimestamp < now)' }
    }

    const isSynchronized = this.fundingService.isFundingSynchronizedEntry(buyFundingData!, sellFundingData!)

    const nextFundingTimestamp = Math.min(buyFundingData!.nextFundingTimestamp, sellFundingData!.nextFundingTimestamp)
    const nextFundingInterval = Math.min(buyFundingData!.fundingInterval, sellFundingData!.fundingInterval)
    const fundingIntervalMs = nextFundingInterval * 60 * 60 * 1000
    const previousFundingTimestamp = nextFundingTimestamp - fundingIntervalMs

    const withinFundingWindow = this.isWithinFundingWindow(nextFundingTimestamp)
    const withinSpreadWindow = this.isWithinSpreadWindow(previousFundingTimestamp, nextFundingTimestamp)

    const fundingEvents = this.fundingService.generateFundingEvents(buyFundingData!, sellFundingData!, this.projectionHours)
    const fundingRateDifferencePercent =
      (-fundingEvents[0].buyExchangeFundingRate + fundingEvents[0].sellExchangeFundingRate) * 100

    // TEMPORARY FOR DEBUGGING
    if (fundingRateDifferencePercent !== profitEstimate.fundingProfitPercent) {
      console.log('fundingRateDifferencePercent === profitEstimate.fundingProfitPercent')
    }

    if (this.fundingStrategyEnabled && withinFundingWindow) {
      if (isSynchronized) {
        if (this.validateFundingSyncEntry(fundingRateDifferencePercent, profitEstimate)) {
          return { strategy: 'funding', variant: 'sync' }
        }
        if (fundingRateDifferencePercent > 0.3) {
          if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
            logger.info({
              msg: 'Funding strategy (SYNC) entry validation failed, BUT funding rate difference is HIGH',
              function: 'ArbitrageEngine.determineStrategy',
              buyExchange: buyFundingData!.exchange,
              sellExchange: sellFundingData!.exchange,
              symbol: buyFundingData!.symbol,
              fundingRateDifferencePercent: fundingRateDifferencePercent.toFixed(3),
              fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
              estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
            })
            this.antiSpamLogTime = Date.now()
          }
        }
        return { strategy: null, variant: null, reason: 'Funding window (SYNC) but validation failed' }
      } else {
        if (this.validateFundingAsyncEntry(buyFundingData!, sellFundingData!, profitEstimate, fundingEvents)) {
          return { strategy: 'funding', variant: 'async' }
        }
        if (fundingRateDifferencePercent > 0.3) {
          if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
            logger.info({
              msg: 'Funding strategy (ASYNC) entry validation failed, BUT funding rate difference is HIGH',
              function: 'ArbitrageEngine.determineStrategy',
              buyExchange: buyFundingData!.exchange,
              sellExchange: sellFundingData!.exchange,
              symbol: buyFundingData!.symbol,
              fundingRateDifferencePercent: fundingRateDifferencePercent.toFixed(3),
              fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
              estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
            })
            this.antiSpamLogTime = Date.now()
          }
        }
        return { strategy: null, variant: null, reason: 'Funding window (ASYNC) but validation failed' }
      }
    }

    if (this.spreadStrategyEnabled && withinSpreadWindow) {
      if (this.validateSpreadEntry(fundingRateDifferencePercent, profitEstimate)) {
        return { strategy: 'spread', variant: 'spread' }
      }
      return { strategy: null, variant: null, reason: 'Spread window but validation failed' }
    }

    return { strategy: null, variant: null, reason: 'Not within any valid strategy execution window' }
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
    crossLegsPriceSpreadPercent: number,
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
        crossLegsPriceSpreadPercent: crossLegsPriceSpreadPercent,
      }
      this.candidates.set(candidateKey, newCandidate)

      logger.trace({
        msg: 'New arbitrage candidate detected',
        function: 'ArbitrageEngine.validatePersistence',
        candidateKey,
        candidateId: newCandidate.id,
        crossLegsPriceSpreadPercent: crossLegsPriceSpreadPercent.toFixed(3),
        spreadProfitPercent: profitEstimate.spreadProfitPercent.toFixed(3),
        fundingProfitPercent: profitEstimate.fundingProfitPercent.toFixed(3),
        estimatedProfitPercent: profitEstimate.estimatedProfitPercent.toFixed(3),
      })
      return { isValid: false, reason: 'New candidate - waiting for persistence', candidate: newCandidate }
    }

    // Existing candidate - check if spread is still valid using execution prices
    const crossLegsPriceSpreadChangeRatio =
      (crossLegsPriceSpreadPercent - existingCandidate.crossLegsPriceSpreadPercent) /
      existingCandidate.crossLegsPriceSpreadPercent
    const fundingProfitChangeRatio = existingCandidate.fundingProfitPercent === 0
      ? 0
      : (profitEstimate.fundingProfitPercent - existingCandidate.fundingProfitPercent) /
        existingCandidate.fundingProfitPercent
    const buyPriceChangeRatio =
      Math.abs(avgBuyNormalizedExecutionPrice - existingCandidate.avgBuyNormalizedExecutionPrice) /
      existingCandidate.avgBuyNormalizedExecutionPrice
    const sellPriceChangeRatio =
      Math.abs(avgSellNormalizedExecutionPrice - existingCandidate.avgSellNormalizedExecutionPrice) /
      existingCandidate.avgSellNormalizedExecutionPrice

    if (crossLegsPriceSpreadChangeRatio < -0.2) {
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
    existingCandidate.crossLegsPriceSpreadPercent = crossLegsPriceSpreadPercent

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
      const updatingMetadataService = this.marketMetadataServices.get(updatingExchange)
      if (!updatingMetadataService) return []

      const baseQuote = updatingMetadataService.normalizeBaseQuote(symbol)
      if (!baseQuote || this.blacklistPairs.includes(baseQuote)) return []

      // Build all legs: (exchange, marketType, symbol) tuples with live orderbooks
      interface Leg {
        exchange: string
        marketType: MarketType
        symbol: string
      }
      const legs: Leg[] = []

      for (const [exchange, orderbooks] of allOrderbooks) {
        const metadataService = this.marketMetadataServices.get(exchange)
        if (!metadataService) continue

        const disabledQuotes = config.exchanges[exchange as keyof typeof config.exchanges]?.disabledQuoteCurrencies ?? []

        for (const { marketType, symbol: sym } of metadataService.getMarketsForBaseQuote(baseQuote)) {
          if (!orderbooks.has(sym)) continue
          const quote = metadataService.getMetadata(sym)?.quote
          if (quote && disabledQuotes.includes(quote)) continue
          legs.push({ exchange, marketType, symbol: sym })
        }
      }

      // Check all i<j leg pairs
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const legA = legs[i]
          const legB = legs[j]

          // Skip same-exchange + same-type (e.g. both linear on the same exchange)
          if (legA.exchange === legB.exchange && legA.marketType === legB.marketType) continue

          const orderbookA = allOrderbooks.get(legA.exchange)?.get(legA.symbol)
          const orderbookB = allOrderbooks.get(legB.exchange)?.get(legB.symbol)
          if (!orderbookA || !orderbookB) continue

          const metadataServiceA = this.marketMetadataServices.get(legA.exchange)
          const metadataServiceB = this.marketMetadataServices.get(legB.exchange)
          if (!metadataServiceA || !metadataServiceB) continue

          const fundingDataA = legA.marketType === MarketType.SPOT
            ? undefined
            : this.fundingService.getSymbolFundingData(legA.exchange, legA.symbol)
          const fundingDataB = legB.marketType === MarketType.SPOT
            ? undefined
            : this.fundingService.getSymbolFundingData(legB.exchange, legB.symbol)

          if ((legA.marketType !== MarketType.SPOT && !fundingDataA) || (legB.marketType !== MarketType.SPOT && !fundingDataB)) {
            logger.warn({
              msg: 'Skipping leg pair: funding data unavailable for perp leg',
              function: 'ArbitrageEngine.scanOrderbooksForSymbol',
              legA: { exchange: legA.exchange, symbol: legA.symbol, marketType: legA.marketType },
              legB: { exchange: legB.exchange, symbol: legB.symbol, marketType: legB.marketType },
            })
            continue
          }

          const pairKeyAB = `${baseQuote}|${legA.marketType}:${legB.marketType}`
          const pairKeyBA = `${baseQuote}|${legB.marketType}:${legA.marketType}`

          try {
            this.checkDirection(
              pairKeyAB, legA.exchange, legB.exchange, orderbookA, orderbookB,
              legA.symbol, legB.symbol, metadataServiceA, metadataServiceB,
              opportunities, fundingDataA, fundingDataB,
              legA.marketType, legB.marketType,
              updatingExchange, orderbookUpdateTimestamp, traceId
            )
          } catch (error) {
            logger.error({
              msg: 'Error checking direction',
              event: 'arbitrage_check_direction_failed',
              function: 'ArbitrageEngine.scanOrderbooksForSymbol',
              baseQuote,
              buyExchange: legA.exchange,
              sellExchange: legB.exchange,
              error,
            })
          }

          try {
            this.checkDirection(
              pairKeyBA, legB.exchange, legA.exchange, orderbookB, orderbookA,
              legB.symbol, legA.symbol, metadataServiceB, metadataServiceA,
              opportunities, fundingDataB, fundingDataA,
              legB.marketType, legA.marketType,
              updatingExchange, orderbookUpdateTimestamp, traceId
            )
          } catch (error) {
            logger.error({
              msg: 'Error checking direction',
              event: 'arbitrage_check_direction_failed',
              function: 'ArbitrageEngine.scanOrderbooksForSymbol',
              baseQuote,
              buyExchange: legB.exchange,
              sellExchange: legA.exchange,
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
    buyFundingData: ParsedFunding | undefined,
    sellFundingData: ParsedFunding | undefined,
    buyMarketType: MarketType,
    sellMarketType: MarketType,
    updatingExchange: string,
    orderbookUpdateTimestamp: number,
    traceId: string
  ): void {
    if (!buyBook.asks[0] || !buyBook.bids[0] || !sellBook.asks[0] || !sellBook.bids[0]) return

    const buyLegIsPerp = buyMarketType !== MarketType.SPOT
    const sellLegIsPerp = sellMarketType !== MarketType.SPOT
    const bothLegsArePerp = buyLegIsPerp && sellLegIsPerp
    const isSpotSpot = !buyLegIsPerp && !sellLegIsPerp
    if (!this.sellSpotBuyPerpEnabled && !sellLegIsPerp && buyLegIsPerp) return
    // === PRICE NORMALIZATION ===
    // Use the new normalization functions to handle price scales and contract sizes
    const normalizedBuyPrice = buyMetadataService.normalizePrice(buyBook.asks[0].price, buyExchangeSymbol)
    const normalizedSellPrice = sellMetadataService.normalizePrice(sellBook.bids[0].price, sellExchangeSymbol)

    // === INITIAL SPREAD VALIDATION ===
    const crossLegsPriceSpreadPercent = ((normalizedSellPrice - normalizedBuyPrice) / normalizedBuyPrice) * 100

    if (crossLegsPriceSpreadPercent > this.maxAnomalySpreadThresholdPercent) return

    // === VOLUME CALCULATION ===
    // Calculate target normalized volume (base asset volume) based on order amount
    const targetNormalizedVolume = this.orderAmountUsd / normalizedBuyPrice

    // Convert normalized volume to exchange-specific contract amounts
    // For inverse perps, pass the mark price so contracts = (base * price) / contractSize
    const buyMarkPrice = buyMarketType === MarketType.INVERSE_PERP ? normalizedBuyPrice : undefined
    const sellMarkPrice = sellMarketType === MarketType.INVERSE_PERP ? normalizedSellPrice : undefined
    const buyExchangeVolume = buyMetadataService.denormalizeAmount(targetNormalizedVolume, buyExchangeSymbol, buyMarkPrice)
    const sellExchangeVolume = sellMetadataService.denormalizeAmount(targetNormalizedVolume, sellExchangeSymbol, sellMarkPrice)

    // Verify that both exchanges will have the same normalized volume
    const buyNormalizedVolume = buyMetadataService.normalizeAmount(buyExchangeVolume, buyExchangeSymbol, buyMarkPrice)
    const sellNormalizedVolume = sellMetadataService.normalizeAmount(sellExchangeVolume, sellExchangeSymbol, sellMarkPrice)

    // Use the smaller of the two to ensure both exchanges can handle the volume
    const minNormalizedVolume = Math.min(buyNormalizedVolume, sellNormalizedVolume)
    const maxNormalizedVolume = Math.max(buyNormalizedVolume, sellNormalizedVolume)

    // Recalculate exchange-specific volumes based on the actual normalized volume
    const minActualBuyExchangeVolume = buyMetadataService.denormalizeAmount(minNormalizedVolume, buyExchangeSymbol, buyMarkPrice)
    const minActualSellExchangeVolume = sellMetadataService.denormalizeAmount(minNormalizedVolume, sellExchangeSymbol, sellMarkPrice)
    const minActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(
      minActualBuyExchangeVolume,
      buyExchangeSymbol,
      buyMarkPrice
    )
    const minActualSellNormalizedVolume = sellMetadataService.normalizeAmount(
      minActualSellExchangeVolume,
      sellExchangeSymbol,
      sellMarkPrice
    )

    const maxActualBuyExchangeVolume = buyMetadataService.denormalizeAmount(maxNormalizedVolume, buyExchangeSymbol, buyMarkPrice)
    const maxActualSellExchangeVolume = sellMetadataService.denormalizeAmount(maxNormalizedVolume, sellExchangeSymbol, sellMarkPrice)
    const maxActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(
      maxActualBuyExchangeVolume,
      buyExchangeSymbol,
      buyMarkPrice
    )
    const maxActualSellNormalizedVolume = sellMetadataService.normalizeAmount(
      maxActualSellExchangeVolume,
      sellExchangeSymbol,
      sellMarkPrice
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

    // Cross-exchange quote compatibility check
    if (buyMetadata && sellMetadata && !quotesAreCompatible(buyMetadata.quote, sellMetadata.quote)) {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.debug({
          msg: 'Quotes not compatible for cross-exchange arb, skipping',
          function: 'ArbitrageEngine.checkDirection',
          buyExchange,
          buySymbol: buyExchangeSymbol,
          buyQuote: buyMetadata.quote,
          sellExchange,
          sellSymbol: sellExchangeSymbol,
          sellQuote: sellMetadata.quote,
        })
        this.antiSpamLogTime = Date.now()
      }
      return
    }

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
    // orderAmountQuote: notional in the leg's quote unit; for stablecoin quotes ≈ USD
    const orderAmountQuote = finalNormalizedVolume * normalizedBuyPrice
    if (
      orderAmountQuote < (this.orderAmountUsd * this.orderAmountToleranceMinPercent) / 100 ||
      orderAmountQuote > (this.orderAmountUsd * this.orderAmountToleranceMaxPercent) / 100
    ) {
      if (Date.now() - this.antiSpamLogTime > 60 * 1000) {
        logger.warn({
          msg: 'Normalized volume is outside order amount tolerance range',
          function: 'ArbitrageEngine.checkDirection',
          exchange: buyExchange,
          symbol: buyExchangeSymbol,
          orderAmountQuote,
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

    const targetFundingTimestamp = bothLegsArePerp
      ? Math.min(buyFundingData!.nextFundingTimestamp, sellFundingData!.nextFundingTimestamp)
      : buyLegIsPerp
        ? buyFundingData!.nextFundingTimestamp
        : sellLegIsPerp
          ? sellFundingData!.nextFundingTimestamp
          : 0

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
      fundingProjection,
      buyMarketType,
      sellMarketType,
      isSpotSpot
    )

    // if (normalizedPair === "PROVE/USDT|linear:linear") return

    if (!isSpotSpot) return

    // if (!bothLegsArePerp) return

    // if (isSpotSpot || bothLegsArePerp) return

    if (profitEstimate.estimatedProfitPercent > 0.5) {
      console.log(normalizedPair, buyExchange, sellExchange, profitEstimate.costsPercent, ' | ', profitEstimate.fundingProfitPercent, ' | ', profitEstimate.spreadProfitPercent, ' | ', profitEstimate.estimatedProfitPercent)
    }

    // === CONFIDENCE VALIDATION ===
    if (profitEstimate.confidenceScore < this.minConfidenceScore) return

    // === STRATEGY VALIDATION ===
    // Determine which strategy this opportunity belongs to and validate entry conditions
    const strategyResult = this.determineStrategy(buyFundingData, sellFundingData, profitEstimate, bothLegsArePerp)

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
      variant: strategyResult.variant,
    })

    // Use the validated opportunity from the persistence check
    const persistenceResult = this.validatePersistence(
      normalizedPair,
      buyExchange,
      sellExchange,
      entryBuySimulation.avgNormalizedExecutionPrice,
      entrySellSimulation.avgNormalizedExecutionPrice,
      profitEstimate,
      crossLegsPriceSpreadPercent,
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
      strategyVariant: strategyResult.variant,
      buyExchange,
      sellExchange,
      normalizedPair,
      buyMarketType,
      sellMarketType,
      bothLegsArePerp,
      isSpotSpot,
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
      buyExchangeNextFundingTimestamp: buyFundingData?.nextFundingTimestamp ?? 0,
      sellExchangeNextFundingTimestamp: sellFundingData?.nextFundingTimestamp ?? 0,
      targetFundingTimestamp,
      // Profitability metrics
      tradingFeesUsd: profitEstimate.tradingFeesUsd,
      tradingFeesPercent: profitEstimate.tradingFeesPercent,
      costsUsd: profitEstimate.costsUsd,
      costsPercent: profitEstimate.costsPercent,
      spreadProfitUsd: profitEstimate.spreadProfitUsd,
      spreadProfitPercent: profitEstimate.spreadProfitPercent,
      fundingProfitUsd: profitEstimate.fundingProfitUsd,
      fundingProfitPercent: profitEstimate.fundingProfitPercent,
      estimatedProfitUsd: profitEstimate.estimatedProfitUsd, // Use combined profit as the main metric
      estimatedProfitPercent: profitEstimate.estimatedProfitPercent, // Use combined profit percent as the main metric
    })
  }
}
