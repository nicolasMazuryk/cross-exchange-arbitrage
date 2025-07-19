import { EventEmitter } from 'events'
import { OrderbookManager, OrderBook, TopOfBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { ExchangeMeta } from '../../types/exchange'
import logger from '../../utils/logger'
import config from '../../utils/config'

// Core interfaces
interface FeeModel {
  maker: number
  taker: number
}

interface DepthSimulationResult {
  avgExecutionPrice: number
  slippagePercent: number
  fillableVolume: number
}

interface OpportunityScore {
  estimatedProfit: number
  estimatedProfitPercent: number
  latencyPenalty: number
  confidence: number
}

export interface ArbitrageOpportunity {
  pair: string
  buyExchange: string
  sellExchange: string
  buyPrice: number
  sellPrice: number
  fillableVolume: number
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
  private readonly orderAmount: number
  private readonly minProfitThreshold: number
  private readonly minConfidenceScore: number
  private readonly maxMarketSpread: number
  private readonly maxCrossMarketSpread: number
  private readonly maxOrderbookAge: number
  private readonly orderAmountTolerance: number

  constructor(
    orderbookManager: OrderbookManager,
    blacklistPairs: string[],
    exchangeConfigs: ExchangeMeta[]
  ) {
    super()
    this.orderbookManager = orderbookManager
    this.blacklistPairs = blacklistPairs
    this.exchangeConfigs = new Map(exchangeConfigs.map(config => [config.name, config]))
    this.feeModels = new Map()
    this.orderAmount = config.trading.orderAmount
    this.minProfitThreshold = config.arbitrage.minProfitThreshold
    this.minConfidenceScore = config.arbitrage.minConfidenceScore
    this.maxMarketSpread = config.arbitrage.maxMarketSpread
    this.maxCrossMarketSpread = config.arbitrage.maxCrossMarketSpread
    this.maxOrderbookAge = config.arbitrage.maxOrderbookAge
    this.orderAmountTolerance = config.arbitrage.orderAmountTolerance
    this.initializeModels()
    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Listen for top of book updates
    this.orderbookManager.on('topOfBookUpdate', (topOfBook: TopOfBook) => {
      this.scanOpportunities()
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
    targetUsdAmount: number,
    isBuy: boolean
  ): DepthSimulationResult {
    let remainingAmount = targetUsdAmount
    let totalVolume = 0
    let weightedPrice = 0
    const basePrice = orderbookSide[0].price

    for (const level of orderbookSide) {
      const levelValue = level.price * level.quantity
      const fillAmount = Math.min(remainingAmount, levelValue)
      const fillVolume = fillAmount / level.price

      weightedPrice += level.price * fillVolume
      totalVolume += fillVolume
      remainingAmount -= fillAmount

      if (remainingAmount <= 0) break
    }

    const avgExecutionPrice = weightedPrice / totalVolume
    const slippagePercent = isBuy
      ? (avgExecutionPrice - basePrice) / basePrice
      : (basePrice - avgExecutionPrice) / basePrice

    return {
      avgExecutionPrice,
      slippagePercent,
      fillableVolume: totalVolume
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
    buyPrice: number,
    sellPrice: number,
    volume: number,
    buyExchange: string,
    sellExchange: string,
    buyBook: OrderBook,
    sellBook: OrderBook,
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
    const entryBuyFeeCosts = entryBuySimulation.avgExecutionPrice * volume * buyFeeModel.taker
    const entrySellFeeCosts = entrySellSimulation.avgExecutionPrice * volume * sellFeeModel.taker
    const exitBuyFeeCosts = exitBuySimulation.avgExecutionPrice * volume * buyFeeModel.taker
    const exitSellFeeCosts = exitSellSimulation.avgExecutionPrice * volume * sellFeeModel.taker
    
    const totalTradingFeesCosts = entryBuyFeeCosts + entrySellFeeCosts + exitBuyFeeCosts + exitSellFeeCosts
    
    // 2. SLIPPAGE COSTS (Entry + Exit)
    const entryBuySlippageCosts = entryBuySimulation.avgExecutionPrice * volume * entryBuySimulation.slippagePercent
    const entrySellSlippageCosts = entrySellSimulation.avgExecutionPrice * volume * entrySellSimulation.slippagePercent
    const exitBuySlippageCosts = exitBuySimulation.avgExecutionPrice * volume * exitBuySimulation.slippagePercent
    const exitSellSlippageCosts = exitSellSimulation.avgExecutionPrice * volume * exitSellSimulation.slippagePercent
    
    const totalSlippageCosts = entryBuySlippageCosts + entrySellSlippageCosts + exitBuySlippageCosts + exitSellSlippageCosts
    
    // 3. BUY/SELL SPREADS (Market Spreads)
    const buyMarketSpread = (buyBook.asks[0].price - buyBook.bids[0].price) / buyBook.bids[0].price
    const sellMarketSpread = (sellBook.asks[0].price - sellBook.bids[0].price) / sellBook.bids[0].price
    
    const buyMarketSpreadCosts = volume * buyBook.bids[0].price * buyMarketSpread
    const sellMarketSpreadCosts = volume * sellBook.asks[0].price * sellMarketSpread
    
    const totalSpreadCosts = buyMarketSpreadCosts + sellMarketSpreadCosts
    
    // === NET PROFIT CALCULATION ===
    const totalProfit = (sellPrice - buyPrice) * volume
    const totalCosts = totalTradingFeesCosts + totalSlippageCosts + totalSpreadCosts
    const netProfit = totalProfit - totalCosts
    
    const positionAmount = entryBuySimulation.avgExecutionPrice * volume

    const profitPercent = totalProfit / positionAmount * 100
    const costsPercent = totalCosts / positionAmount * 100
    const netProfitPercent = netProfit / positionAmount * 100

    const latencyPenalty = this.calculateLatencyPenalty(buyBook, sellBook)
    
    const confidence = Math.min(
      this.calculateConfidenceScore(buyBook, buyExchange, volume, buyMarketSpread),
      this.calculateConfidenceScore(sellBook, sellExchange, volume, sellMarketSpread)
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

  private scanOpportunities(): void {
    const allOrderbooks = this.orderbookManager.getAllOrderbooks()
    const opportunities = this.scanOrderbooks(allOrderbooks)

    if (opportunities.length > 0) {
      // Emit opportunities for trade execution
      this.emit('opportunities', opportunities)
    }
  }

  private scanOrderbooks(
    allOrderbooks: Map<string, Map<string, OrderBook>>
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = []
    const exchanges = Array.from(allOrderbooks.keys())
    const commonPairs = this.getCommonPairs(allOrderbooks)

    for (const pair of commonPairs) {
      if (this.blacklistPairs.includes(pair)) continue

      for (let i = 0; i < exchanges.length; i++) {
        for (let j = i + 1; j < exchanges.length; j++) {
          const exchA = exchanges[i]
          const exchB = exchanges[j]

          const bookA = allOrderbooks.get(exchA)?.get(pair)
          const bookB = allOrderbooks.get(exchB)?.get(pair)

          if (!bookA || !bookB) continue

          // Check both directions
          this.checkDirection(
            pair,
            exchA,
            exchB,
            bookA,
            bookB,
            opportunities
          )
          this.checkDirection(
            pair,
            exchB,
            exchA,
            bookB,
            bookA,
            opportunities
          )
        }
      }
    }

    // Sort by estimated profit and log top 5
    const sortedOpportunities = opportunities
      .sort((a, b) => b.estimatedProfit - a.estimatedProfit)
      // .slice(0, 5)
      .filter(opportunity => opportunity.estimatedProfit > 0)

    if (sortedOpportunities.length > 0) {
      // logger.info('Top 5 arbitrage opportunities:', sortedOpportunities)
    }

    return sortedOpportunities
  }

  private checkDirection(
    pair: string,
    buyExchange: string,
    sellExchange: string,
    buyBook: OrderBook,
    sellBook: OrderBook,
    opportunities: ArbitrageOpportunity[]
  ): void {
    // === INITIAL VALIDATION ===
    const buyPrice = buyBook.asks[0].price
    const sellPrice = sellBook.bids[0].price
    const crossMarketSpread = (sellPrice - buyPrice) / buyPrice

    if (crossMarketSpread <= this.minProfitThreshold || crossMarketSpread > this.maxCrossMarketSpread) return

    // === VOLUME CALCULATION ===
    // Simulate slippage for both entry legs
    const entryBuySimulation = this.simulateSlippage(buyBook.asks, this.orderAmount, true)
    const entrySellSimulation = this.simulateSlippage(sellBook.bids, this.orderAmount, false)

    // Use the minimum fillable volume between buy and sell legs
    const volume = Math.min(entryBuySimulation.fillableVolume, entrySellSimulation.fillableVolume)

    // Validate minimum order amount
    if (volume * buyPrice < this.orderAmount * this.orderAmountTolerance) return

    // === EXIT SLIPPAGE SIMULATION ===
    // Simulate exit slippage for both exchanges
    const exitBuySimulation = this.simulateSlippage(buyBook.bids, this.orderAmount, false)
    const exitSellSimulation = this.simulateSlippage(sellBook.asks, this.orderAmount, true)

    // === PROFIT ESTIMATION ===
    const profitEstimate = this.estimateProfit(
      buyPrice,
      sellPrice,
      volume,
      buyExchange,
      sellExchange,
      buyBook,
      sellBook,
      entryBuySimulation,
      entrySellSimulation,
      exitBuySimulation,
      exitSellSimulation
    )

    // === CONFIDENCE VALIDATION ===
    if (profitEstimate.confidence < this.minConfidenceScore) return

    // === OPPORTUNITY CREATION ===
    // Calculate volumeUSDT as the maximum between buy and sell sides
    const volumeUSDT = Math.max(volume * buyPrice, volume * sellPrice)
    
    opportunities.push({
      pair,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      fillableVolume: volume,
      volumeUSDT,
      confidenceScore: profitEstimate.confidence,
      estimatedProfit: profitEstimate.estimatedProfit,
      estimatedProfitPercent: profitEstimate.estimatedProfitPercent
    })
  }

  private getCommonPairs(orderbooks: Map<string, Map<string, OrderBook>>): string[] {
    const pairSets = Array.from(orderbooks.values()).map(exchange => 
      new Set(exchange.keys())
    )
    
    return Array.from(pairSets.reduce((common, pairs) => {
      if (common.size === 0) return pairs
      return new Set([...common].filter(pair => pairs.has(pair)))
    }, new Set<string>()))
  }
} 