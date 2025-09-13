import { EventEmitter } from 'events'
import { OrderbookManager, OrderBook, TopOfBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ExchangeMeta } from '../../types/exchange'
import { FundingService } from '../funding/fundingService'
import logger from '../../utils/logger'
import config from '../../utils/config'

// Core interfaces
interface FeeModel {
  maker: number
  taker: number
}

interface DepthSimulationResult {
  avgExecutionPrice: number
  avgNormalizedExecutionPrice: number
  slippagePercent: number
}

interface OpportunityScore {
  estimatedProfit: number
  estimatedProfitPercent: number
  latencyPenalty: number
  confidence: number
}

// Temporal Persistence Validation interfaces
interface ArbitrageCandidate {
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
  estimatedProfitPercent: number
  spread: number
}

interface PersistenceValidationResult {
  isValid: boolean
  reason?: string
  candidate?: ArbitrageCandidate
}

export interface ArbitrageOpportunity {
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
  volumeUSDT: number
  confidenceScore: number
  estimatedProfit: number
  estimatedProfitPercent: number
}

export class ArbitrageEngine extends EventEmitter {
  private readonly blacklistPairs: string[]
  private readonly exchangeConfigs: Map<string, ExchangeMeta>
  private readonly feeModels: Map<string, FeeModel>
  private readonly orderbookManager: OrderbookManager
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly fundingService: FundingService
  private readonly orderAmount: number
  private readonly minProfitThreshold: number
  private readonly minConfidenceScore: number
  private readonly maxMarketSpread: number
  private readonly maxCrossMarketSpread: number
  private readonly maxOrderbookAge: number
  private readonly orderAmountToleranceMin: number
  private readonly orderAmountToleranceMax: number
  // Temporal Persistence Validation
  private readonly minPersistenceMs: number
  private readonly minConsecutiveSnapshots: number
  private readonly candidateCleanupMs: number
  private readonly candidates: Map<string, ArbitrageCandidate>
  private lastCleanupTime: number

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
    this.orderAmount = config.trading.orderAmount
    this.minProfitThreshold = config.arbitrage.minProfitThreshold
    this.minConfidenceScore = config.arbitrage.minConfidenceScore
    this.maxMarketSpread = config.arbitrage.maxMarketSpread
    this.maxCrossMarketSpread = config.arbitrage.maxCrossMarketSpread
    this.maxOrderbookAge = config.arbitrage.maxOrderbookAge
    this.orderAmountToleranceMin = config.arbitrage.orderAmountToleranceMin
    this.orderAmountToleranceMax = config.arbitrage.orderAmountToleranceMax
    // Temporal Persistence Validation
    this.minPersistenceMs = config.arbitrage.minPersistenceMs
    this.minConsecutiveSnapshots = config.arbitrage.minConsecutiveSnapshots
    this.candidateCleanupMs = config.arbitrage.candidateCleanupMs
    this.candidates = new Map()
    this.lastCleanupTime = Date.now()
    this.initializeModels()
    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Listen for top of book updates
    this.orderbookManager.on('topOfBookUpdate', (topOfBook: TopOfBook) => {
      this.scanOpportunities(topOfBook)
    })
  }

  private initializeModels(): void {
    // Initialize fee models for each exchange
    for (const [exchange, config] of this.exchangeConfigs) {
      this.feeModels.set(exchange, {
        maker: config.feeModel.maker,
        taker: config.feeModel.taker
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
    const basePrice = orderbookSide[0].price

    for (const level of orderbookSide) {
      const fillVolume = Math.min(remainingVolume, level.quantity)

      weightedPrice += level.price * fillVolume
      remainingVolume -= fillVolume

      if (remainingVolume <= 0) break
    }

    if (remainingVolume > 0) {
      logger.warn(`[${exchange}] Volume cannot be filled in orderbook for ${isBuy ? 'BUY' : 'SELL'} ${exchangeSymbol}: Remaining Requested Volume ${remainingVolume} ($${remainingVolume * basePrice}) - Order Volume ${exchangeVolume} ($${exchangeVolume * basePrice})`)
    }

    const avgExecutionPrice = weightedPrice / exchangeVolume
    const slippagePercent = isBuy
      ? (avgExecutionPrice - basePrice) / basePrice
      : (basePrice - avgExecutionPrice) / basePrice

    return {
      avgExecutionPrice,
      avgNormalizedExecutionPrice: metadataService.normalizePrice(avgExecutionPrice, exchangeSymbol),
      slippagePercent,
    }
  }

  private calculateConfidenceScore(
    orderbook: OrderBook,
    exchange: string,
    volume: number,
    marketSpread: number
  ): number {
    const config = this.exchangeConfigs.get(exchange)
    if (!config) return 0

    // Freshness score: How recent is the orderbook data
    const ageMs = Date.now() - orderbook.timestamp
    const freshnessScore = Math.max(0, 1 - (ageMs / this.maxOrderbookAge))
    
    // Market spread score: Tighter spreads indicate better market quality
    // Normalize spread to a 0-1 score where 0 is MAX_MARKET_SPREAD and 1 is 0 spread
    const spreadScore = Math.max(0, 1 - (marketSpread / this.maxMarketSpread))
    
    // Health score: Is the exchange operating normally
    const healthScore = config.isHealthy ? 1 : 0
    
    // Weighted average of all factors
    // Freshness is most important (40%), followed by spread (35%) and health (25%)
    return (freshnessScore * 0.4 + spreadScore * 0.35 + healthScore * 0.25)
  }

  private estimateProfit(
    normalizedBuyPrice: number,
    normalizedSellPrice: number,
    normalizedVolume: number,
    buyExchangeVolume: number,
    sellExchangeVolume: number,
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
    exitSellSimulation: DepthSimulationResult
  ): OpportunityScore {
    const buyFeeModel = this.feeModels.get(buyExchange)
    const sellFeeModel = this.feeModels.get(sellExchange)
    
    if (!buyFeeModel || !sellFeeModel) {
      throw new Error(`Fee models not found for exchange: ${!buyFeeModel ? buyExchange : sellExchange}`)
    }
    
    // === COST BREAKDOWN ===
    
    // 1. TRADING FEES (Entry + Exit)
    const entryBuyFeeCosts = entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * buyFeeModel.taker
    const entrySellFeeCosts = entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * sellFeeModel.taker
    const exitBuyFeeCosts = exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * buyFeeModel.taker
    const exitSellFeeCosts = exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * sellFeeModel.taker
    
    const totalTradingFeesCosts = entryBuyFeeCosts + entrySellFeeCosts + exitBuyFeeCosts + exitSellFeeCosts
    
    // 2. SLIPPAGE COSTS (Entry + Exit)
    const entryBuySlippageCosts = entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * entryBuySimulation.slippagePercent
    const entrySellSlippageCosts = entrySellSimulation.avgNormalizedExecutionPrice * normalizedVolume * entrySellSimulation.slippagePercent
    const exitBuySlippageCosts = exitBuySimulation.avgNormalizedExecutionPrice * normalizedVolume * exitBuySimulation.slippagePercent
    const exitSellSlippageCosts = exitSellSimulation.avgNormalizedExecutionPrice * normalizedVolume * exitSellSimulation.slippagePercent
    
    const totalSlippageCosts = entryBuySlippageCosts + entrySellSlippageCosts + exitBuySlippageCosts + exitSellSlippageCosts
    
    // 3. BUY/SELL SPREADS (Market Spreads)
    const buyMarketSpread = (buyBook.asks[0].price - buyBook.bids[0].price) / buyBook.bids[0].price
    const sellMarketSpread = (sellBook.asks[0].price - sellBook.bids[0].price) / sellBook.bids[0].price
    
    const buyMarketSpreadCosts = normalizedVolume * buyMetadataService.normalizePrice(buyBook.bids[0].price, buyExchangeSymbol) * buyMarketSpread
    const sellMarketSpreadCosts = normalizedVolume * sellMetadataService.normalizePrice(sellBook.asks[0].price, sellExchangeSymbol) * sellMarketSpread
    
    const totalSpreadCosts = buyMarketSpreadCosts + sellMarketSpreadCosts
    
    // === NET PROFIT CALCULATION ===
    const totalProfit = (normalizedSellPrice - normalizedBuyPrice) * normalizedVolume
    const totalCosts = totalTradingFeesCosts + totalSlippageCosts + totalSpreadCosts
    const netProfit = totalProfit - totalCosts
    
    const positionAmount = entryBuySimulation.avgNormalizedExecutionPrice * normalizedVolume

    const profitPercent = totalProfit / positionAmount * 100
    const costsPercent = totalCosts / positionAmount * 100
    const netProfitPercent = netProfit / positionAmount * 100

    const latencyPenalty = this.calculateLatencyPenalty(buyBook, sellBook)
    
    const confidence = Math.min(
      this.calculateConfidenceScore(buyBook, buyExchange, normalizedVolume, buyMarketSpread),
      this.calculateConfidenceScore(sellBook, sellExchange, normalizedVolume, sellMarketSpread)
    )

    return {
      estimatedProfit: netProfit,
      estimatedProfitPercent: netProfitPercent,
      latencyPenalty,
      confidence
    }
  }

  private calculateLatencyPenalty(buyBook: OrderBook, sellBook: OrderBook): number {
    // TODO: exchange execution latency score
    return 0
  }

  // Temporal Persistence Validation Methods
  private generateCandidateKey(
    normalizedPair: string,
    buyExchange: string,
    sellExchange: string
  ): string {
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
      logger.debug(`Cleaned up stale candidate: ${key}`)
    }

    this.lastCleanupTime = now
  }

  private validatePersistence(
    normalizedPair: string,
    buyExchange: string,
    sellExchange: string,
    avgBuyNormalizedExecutionPrice: number,
    avgSellNormalizedExecutionPrice: number,
    estimatedProfitPercent: number,
    spread: number,
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
        estimatedProfitPercent,
        spread
      }
      this.candidates.set(candidateKey, newCandidate)
      
      logger.debug(`New arbitrage candidate detected: ${candidateKey}, spread: ${(spread * 100).toFixed(3)}%, profit: ${estimatedProfitPercent.toFixed(3)}%`)
      return { isValid: false, reason: 'New candidate - waiting for persistence', candidate: newCandidate }
    }

    // Existing candidate - check if spread is still valid using execution prices
    const spreadChange = (spread - existingCandidate.spread) / existingCandidate.spread
    const buyPriceChange = Math.abs(avgBuyNormalizedExecutionPrice - existingCandidate.avgBuyNormalizedExecutionPrice) / existingCandidate.avgBuyNormalizedExecutionPrice
    const sellPriceChange = Math.abs(avgSellNormalizedExecutionPrice - existingCandidate.avgSellNormalizedExecutionPrice) / existingCandidate.avgSellNormalizedExecutionPrice

    if (spreadChange < -0.2) {
      logger.info(`Candidate ${candidateKey} spread decreased, resetting`)
      this.candidates.delete(candidateKey)
      return { isValid: false, reason: 'Spread decreased significantly' }
    }
    if (buyPriceChange > 0.01 || sellPriceChange > 0.01) {
      logger.info(`Candidate ${candidateKey} price changed, resetting`)
      this.candidates.delete(candidateKey)
      return { isValid: false, reason: 'Price changed significantly' }
    }

    // Update existing candidate
    existingCandidate.lastDetectedAt = now
    
    // Update snapshots based on which exchange is updating
    if (updatingExchange === buyExchange) {
      existingCandidate.buyExchangeConsecutiveSnapshots++
    } else if (updatingExchange === sellExchange) {
      existingCandidate.sellExchangeConsecutiveSnapshots++
    }
    
    existingCandidate.avgBuyNormalizedExecutionPrice = avgBuyNormalizedExecutionPrice
    existingCandidate.avgSellNormalizedExecutionPrice = avgSellNormalizedExecutionPrice
    existingCandidate.estimatedProfitPercent = estimatedProfitPercent
    existingCandidate.spread = spread

    // Check persistence conditions
    const persistenceDuration = existingCandidate.lastDetectedAt - existingCandidate.firstDetectedAt
    const hasMinDuration = persistenceDuration >= this.minPersistenceMs
    const hasMinSnapshots = existingCandidate.buyExchangeConsecutiveSnapshots >= this.minConsecutiveSnapshots && existingCandidate.sellExchangeConsecutiveSnapshots >= this.minConsecutiveSnapshots

    if (hasMinDuration && hasMinSnapshots) {
      logger.info(`Arbitrage opportunity validated: ${candidateKey}, duration: ${persistenceDuration}ms, buySnapshots: ${existingCandidate.buyExchangeConsecutiveSnapshots}, sellSnapshots: ${existingCandidate.sellExchangeConsecutiveSnapshots}, spread: ${(spread * 100).toFixed(3)}%, profit: ${estimatedProfitPercent.toFixed(3)}%`)
      this.candidates.delete(candidateKey) // Remove after validation
      return { isValid: true, candidate: existingCandidate }
    }

    logger.debug(`Candidate ${candidateKey} still building persistence: duration=${persistenceDuration}ms, buySnapshots=${existingCandidate.buyExchangeConsecutiveSnapshots}, sellSnapshots=${existingCandidate.sellExchangeConsecutiveSnapshots}`)
    return { isValid: false, reason: 'Building persistence', candidate: existingCandidate }
  }


// Optimized: scan only the updated symbol across all exchanges to improve latency and CPU usage
  private scanOpportunities(topOfBook: TopOfBook): void {
    const allOrderbooks = this.orderbookManager.getAllOrderbooks()
    // const opportunities = this.scanAllOrderbooks(allOrderbooks)
    const opportunities = this.scanOrderbooksForSymbol(topOfBook.exchange, topOfBook.symbol, allOrderbooks)

    if (opportunities.length > 0) {
      // Emit opportunities for trade execution
      this.emit('opportunities', opportunities)
    }
  }

  private scanOrderbooksForSymbol(updatingExchange: string, symbol: string, allOrderbooks: Map<string, Map<string, OrderBook>>): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = []
    const exchanges = Array.from(allOrderbooks.keys())
    
    // Normalize the symbol to find the normalized pair
    let normalizedPair: string | null = null
    let exchangeSymbols = new Map<string, string>()

    // Find the normalized pair and exchange-specific symbols
    for (const exchange of exchanges) {
      const metadataService = this.marketMetadataServices.get(exchange)
      if (!metadataService) continue

      const normalizedSymbol = metadataService.normalizeSymbol(symbol)
      if (normalizedSymbol) {
        normalizedPair = normalizedSymbol
        exchangeSymbols.set(exchange, symbol)
      }
    }

    if (!normalizedPair || this.blacklistPairs.includes(normalizedPair)) return []

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

        // Check both directions
        this.checkDirection(
          normalizedPair,
          exchangeA,
          exchangeB,
          orderbookA,
          orderbookB,
          exchangeSymbolA,
          exchangeSymbolB,
          metadataServiceA,
          metadataServiceB,
          opportunities,
          updatingExchange
        )
        this.checkDirection(
          normalizedPair,
          exchangeB,
          exchangeA,
          orderbookB,
          orderbookA,
          exchangeSymbolB,
          exchangeSymbolA,
          metadataServiceB,
          metadataServiceA,
          opportunities,
          updatingExchange
        )
      }
    }

    // Sort by estimated profit and filter by minimum threshold
    const sortedOpportunities = opportunities
      .sort((a, b) => b.estimatedProfit - a.estimatedProfit)
      .filter(opportunity => opportunity.estimatedProfitPercent >= this.minProfitThreshold * 100)
      // .filter(opportunity => opportunity.estimatedProfitPercent > -0.5)

    return sortedOpportunities
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
    updatingExchange?: string
  ): void {
    // === PRICE NORMALIZATION ===
    // Use the new normalization functions to handle price scales and contract sizes
    const normalizedBuyPrice = buyMetadataService.normalizePrice(buyBook.asks[0].price, buyExchangeSymbol)
    const normalizedSellPrice = sellMetadataService.normalizePrice(sellBook.bids[0].price, sellExchangeSymbol)
    
    // === INITIAL VALIDATION ===
    const crossMarketSpread = (normalizedSellPrice - normalizedBuyPrice) / normalizedBuyPrice
    // Minimum required spread is minProfitThreshold plus round-trip taker fees
    const buyFee = this.feeModels.get(buyExchange)?.taker ?? 0
    const sellFee = this.feeModels.get(sellExchange)?.taker ?? 0

    const minRequiredSpread = this.minProfitThreshold + ((buyFee + sellFee) * 2)
    
    if (crossMarketSpread < minRequiredSpread) return
    if (crossMarketSpread > this.maxCrossMarketSpread) return

    // === VOLUME CALCULATION ===
    // Calculate target normalized volume (base asset volume) based on order amount
    const targetNormalizedVolume = this.orderAmount / normalizedBuyPrice

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
    const minActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(minActualBuyExchangeVolume, buyExchangeSymbol)
    const minActualSellNormalizedVolume = sellMetadataService.normalizeAmount(minActualSellExchangeVolume, sellExchangeSymbol)
    
    const maxActualBuyExchangeVolume = buyMetadataService.denormalizeAmount(maxNormalizedVolume, buyExchangeSymbol)
    const maxActualSellExchangeVolume = sellMetadataService.denormalizeAmount(maxNormalizedVolume, sellExchangeSymbol)
    const maxActualBuyNormalizedVolume = buyMetadataService.normalizeAmount(maxActualBuyExchangeVolume, buyExchangeSymbol)
    const maxActualSellNormalizedVolume = sellMetadataService.normalizeAmount(maxActualSellExchangeVolume, sellExchangeSymbol)

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
      // Neither min nor max volumes are equal - this indicates a problem with normalization
      logger.warn(`Volume normalization failed for ${normalizedPair}: min volumes (${minActualBuyNormalizedVolume}, ${minActualSellNormalizedVolume}) and max volumes (${maxActualBuyNormalizedVolume}, ${maxActualSellNormalizedVolume}) are not equal`)
      return
    }
    
    // Validate minimum contract amounts
    const buyMetadata = buyMetadataService.getMetadata(buyExchangeSymbol)
    const sellMetadata = sellMetadataService.getMetadata(sellExchangeSymbol)
    
    if (buyMetadata && finalBuyExchangeVolume < buyMetadata.minAmount!) {
      logger.warn(`[${buyExchange}] Buy volume ${finalBuyExchangeVolume} below minimum ${buyMetadata.minAmount} for ${buyExchangeSymbol}`)
      return
    }
    
    if (sellMetadata && finalSellExchangeVolume < sellMetadata.minAmount!) {
      logger.warn(`[${sellExchange}] Sell volume ${finalSellExchangeVolume} below minimum ${sellMetadata.minAmount} for ${sellExchangeSymbol}`)
      return
    }

    // Validate order amount tolerance using normalized price
    const orderAmountValue = finalNormalizedVolume * normalizedBuyPrice
    if (orderAmountValue < this.orderAmount * this.orderAmountToleranceMin || orderAmountValue > this.orderAmount * this.orderAmountToleranceMax) {
      logger.warn(`[${buyExchange}] Normalized volume is outside order amount tolerance range ${orderAmountValue} not in [${this.orderAmount * this.orderAmountToleranceMin}, ${this.orderAmount * this.orderAmountToleranceMax}] for ${buyExchangeSymbol}`)
      return
    }

    // Simulate slippage for both entry legs using the actual exchange-specific volumes
    const entryBuySimulation = this.simulateSlippage(buyBook.asks, finalBuyExchangeVolume, true, buyExchange, buyExchangeSymbol, buyMetadataService)
    const entrySellSimulation = this.simulateSlippage(sellBook.bids, finalSellExchangeVolume, false, sellExchange, sellExchangeSymbol, sellMetadataService)

    // === EXIT SLIPPAGE SIMULATION ===
    // Simulate exit slippage for both exchanges using the actual exchange-specific volumes
    const exitBuySimulation = this.simulateSlippage(buyBook.bids, finalBuyExchangeVolume, false, buyExchange, buyExchangeSymbol, buyMetadataService)
    const exitSellSimulation = this.simulateSlippage(sellBook.asks, finalSellExchangeVolume, true, sellExchange, sellExchangeSymbol, sellMetadataService)

    // === PROFIT ESTIMATION ===
    const profitEstimate = this.estimateProfit(
      normalizedBuyPrice,
      normalizedSellPrice,
      finalNormalizedVolume,
      finalBuyExchangeVolume,
      finalSellExchangeVolume,
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
      exitSellSimulation
    )

    // === PROFIT VALIDATION ===
    if (profitEstimate.estimatedProfitPercent < 0) return

    // === CONFIDENCE VALIDATION ===
    if (profitEstimate.confidence < this.minConfidenceScore) return
    
    // Use the validated opportunity from the persistence check
    const persistenceResult = this.validatePersistence(
      normalizedPair,
      buyExchange,
      sellExchange,
      entryBuySimulation.avgNormalizedExecutionPrice,
      entrySellSimulation.avgNormalizedExecutionPrice,
      profitEstimate.estimatedProfitPercent,
      crossMarketSpread,
      updatingExchange! // Use provided updating exchange or default to buy exchange
    )

    if (!persistenceResult.isValid) {
      return // Opportunity hasn't met persistence requirements yet
    }

    // === OPPORTUNITY CREATION ===
    // Calculate volumeUSDT as the maximum between buy and sell sides
    const volumeUSDT = Math.max(finalNormalizedVolume * entryBuySimulation.avgNormalizedExecutionPrice, finalNormalizedVolume * entrySellSimulation.avgNormalizedExecutionPrice)

    if (persistenceResult.isValid) {
      // Create the final opportunity object
      opportunities.push({
        normalizedPair,
        buyExchangeSymbol,
        sellExchangeSymbol,
        buyExchange,
        sellExchange,
        avgBuyNormalizedExecutionPrice: entryBuySimulation.avgNormalizedExecutionPrice,
        avgSellNormalizedExecutionPrice: entrySellSimulation.avgNormalizedExecutionPrice,
        normalizedVolume: finalNormalizedVolume,
        buyExchangeVolume: finalBuyExchangeVolume,
        sellExchangeVolume: finalSellExchangeVolume,
        volumeUSDT,
        confidenceScore: profitEstimate.confidence,
        estimatedProfit: profitEstimate.estimatedProfit,
        estimatedProfitPercent: profitEstimate.estimatedProfitPercent,
      })
    }
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
    return Array.from(normalizedPairSets.reduce((common, pairs) => {
      if (common.size === 0) return pairs
      return new Set([...common].filter(pair => pairs.has(pair)))
    }, new Set<string>()))
  }
} 