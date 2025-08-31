import { EventEmitter } from 'events'
import { TradeResult } from './tradeExecutor'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { OrderInfo } from '../../types/account'
import { OrderbookManager, TopOfBook, OrderBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import logger from '../../utils/logger'
import config from '../../utils/config'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'

// Import DepthSimulationResult type from arbitrageEngine
interface DepthSimulationResult {
  avgExecutionPrice: number
  avgNormalizedExecutionPrice: number
  slippagePercent: number
}

// Core interfaces
export interface TrackedTrade {
  id: string
  opportunity: ArbitrageOpportunity
  entryTimestamp: number
  status: 'open' | 'closed' | 'error'
  entryTrade: TradeResult
  exitTrade?: TradeResult
  exitReason?: 'convergence' | 'timeout' | 'manual' | 'error'
  lastUpdateTimestamp: number
  // PnL calculations
  fees: {
    entry: number
    exit: number
    total: number
  }
  slippage: {
    entry: number
    exit: number
    total: number
  }
  profit: number
  pnl: number
  // Percentage calculations
  feesPercent: number
  slippagePercent: number
  profitPercent: number
  pnlPercent: number
}

export interface ExitCondition {
  type: 'convergence' | 'timeout' | 'manual'
  value?: number
  description: string
}

export interface MonitorConfig {
  maxHoldTimeMs: number
  convergenceBufferPercent: number
  checkIntervalMs: number
  // Exit Persistence Validation
  exitMinPersistenceMs: number
  exitMinConsecutiveSnapshots: number
  exitCandidateCleanupMs: number
}

// Exit Slippage Simulation Result
interface ExitSlippageSimulationResult {
  avgBuyExecutionPrice: number
  avgSellExecutionPrice: number
  avgBuyNormalizedExecutionPrice: number
  avgSellNormalizedExecutionPrice: number
  buySlippagePercent: number
  sellSlippagePercent: number
  totalSlippagePercent: number
}

// Exit Persistence Validation interfaces
interface ExitCandidate {
  tradeId: string
  exitType: 'convergence' | 'timeout'
  firstDetectedAt: number
  lastDetectedAt: number
  convergencePercent: number
  // Simulated exit prices from slippage simulation
  avgBuyNormalizedExecutionPrice: number
  avgSellNormalizedExecutionPrice: number
  pnlPercent: number
  // Exchange-specific persistence tracking
  buyExchangeConsecutiveSnapshots: number
  sellExchangeConsecutiveSnapshots: number
}

interface ExitPersistenceValidationResult {
  isValid: boolean
  reason?: string
  candidate?: ExitCandidate
}

export class TradeMonitor extends EventEmitter {
  private readonly accountStateManager: AccountStateManager
  private readonly restClients: Map<string, RestClientInterface>
  private readonly orderbookManager: OrderbookManager
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly trackedTrades: Map<string, TrackedTrade> = new Map()
  private readonly config: MonitorConfig
  private isRunning = false
  // Exit Persistence Validation
  private readonly exitCandidates: Map<string, ExitCandidate> = new Map()
  private lastExitCleanupTime: number
  // Race condition prevention
  private readonly processingTrades: Set<string> = new Set()

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager,
    marketMetadataServices: Map<string, MarketMetadataService>,
    config: MonitorConfig
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
    this.marketMetadataServices = marketMetadataServices
    this.config = config
    this.lastExitCleanupTime = Date.now()

    logger.info('TradeMonitor initialized', { config: this.config })
  }

  /**
   * Update PnL calculations with simulated exit prices
   */
  private updatePnLWithSimulatedExit(trade: TrackedTrade, exitSimulation: ExitSlippageSimulationResult): void {
    // Calculate exit fees for both legs
    const buyFeeRate = this.getFeeRate(trade.opportunity.buyExchange, 'taker')
    const sellFeeRate = this.getFeeRate(trade.opportunity.sellExchange, 'taker')
    
    const buyExitFees = exitSimulation.avgBuyNormalizedExecutionPrice * trade.opportunity.normalizedVolume * buyFeeRate
    const sellExitFees = exitSimulation.avgSellNormalizedExecutionPrice * trade.opportunity.normalizedVolume * sellFeeRate
    
    // Calculate slippage separately for both buy and sell sides
    const buySlippage = exitSimulation.buySlippagePercent * exitSimulation.avgBuyNormalizedExecutionPrice * trade.opportunity.normalizedVolume
    const sellSlippage = exitSimulation.sellSlippagePercent * exitSimulation.avgSellNormalizedExecutionPrice * trade.opportunity.normalizedVolume
    
    trade.fees.exit = buyExitFees + sellExitFees
    trade.slippage.exit = buySlippage + sellSlippage
    trade.fees.total = trade.fees.entry + trade.fees.exit
    trade.slippage.total = trade.slippage.entry + trade.slippage.exit

    // Calculate profit with simulated exit prices
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitSimulation.avgBuyNormalizedExecutionPrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitSimulation.avgSellNormalizedExecutionPrice  // Exit price for the sell leg
    
    const buyLegProfit = (buyExchangeExitPrice - buyExchangeEntryPrice) * trade.entryTrade.buyOrder!.quantity
    const sellLegProfit = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.entryTrade.sellOrder!.quantity
    trade.profit = buyLegProfit + sellLegProfit

    // Calculate final PnL: Profit - Costs
    trade.pnl = trade.profit - trade.fees.total

    // Calculate percentages
    const totalTradeValue = (trade.opportunity.avgBuyNormalizedExecutionPrice + trade.opportunity.avgSellNormalizedExecutionPrice) * trade.opportunity.normalizedVolume / 2
    trade.feesPercent = (trade.fees.total / totalTradeValue) * 100
    trade.slippagePercent = (trade.slippage.total / totalTradeValue) * 100
    trade.profitPercent = (trade.profit / totalTradeValue) * 100
    trade.pnlPercent = (trade.pnl / totalTradeValue) * 100
  }

  /**
   * Handle timeout exit condition
   */
  private async handleTimeoutExit(trade: TrackedTrade, now: number): Promise<void> {
    const holdTimeMs = now - trade.entryTimestamp
    
    const timeoutValidation = this.validateExitPersistence(
      trade,
      'timeout',
      0, // No convergence for timeout
      0, // No buy price for timeout
      0, // No sell price for timeout
      trade.pnlPercent,
      'timeout' // Indicates this is a timeout update
    )
    
    if (timeoutValidation.isValid) {
      logger.info(`[${trade.id}] Trade timeout validated`, {
        holdTimeMs,
        maxHoldTimeMs: this.config.maxHoldTimeMs
      })
      await this.executeExitTrade(trade, 'timeout')
    } else {
      logger.debug(`[${trade.id}] Timeout condition building persistence: ${timeoutValidation.reason}`)
    }
  }

  /**
   * Handle convergence exit condition
   */
  private async handleConvergenceExit(
    trade: TrackedTrade, 
    convergenceResult: { shouldExit: boolean, convergencePercent: number, reason: string },
    exitSimulation: ExitSlippageSimulationResult,
    updatingExchange: string
  ): Promise<void> {
    const convergenceValidation = this.validateExitPersistence(
      trade,
      'convergence',
      convergenceResult.convergencePercent,
      exitSimulation.avgBuyNormalizedExecutionPrice,
      exitSimulation.avgSellNormalizedExecutionPrice,
      trade.pnlPercent,
      updatingExchange
    )
    
    if (convergenceValidation.isValid) {
      logger.info(`[${trade.id}] Exit price convergence validated`, {
        convergencePercent: convergenceResult.convergencePercent,
        bufferThreshold: this.config.convergenceBufferPercent,
        buyPrice: exitSimulation.avgBuyNormalizedExecutionPrice,
        sellPrice: exitSimulation.avgSellNormalizedExecutionPrice,
        exitReason: convergenceResult.reason
      })
      await this.executeExitTrade(trade, 'convergence')
    } else {
      logger.debug(`[${trade.id}] Convergence condition building persistence: ${convergenceValidation.reason}`)
    }
  }

  /**
   * Check convergence condition with simulated exit prices
   */
  private checkConvergenceCondition(
    trade: TrackedTrade, 
    exitSimulation: ExitSlippageSimulationResult
  ): { shouldExit: boolean, convergencePercent: number, reason: string } {
    // For arbitrage trades, we need to consider the exit prices:
    // - If we bought initially, we need to sell at the bid price
    // - If we sold initially, we need to buy at the ask price
    
    const exitExchangeBuyPrice = exitSimulation.avgBuyNormalizedExecutionPrice
    const exitExchangeSellPrice = exitSimulation.avgSellNormalizedExecutionPrice
    
    // Calculate the price difference between entry and exit
    const buyExitDifference = Math.abs(exitExchangeBuyPrice - trade.entryTrade.buyOrder!.averagePrice)
    const sellExitDifference = Math.abs(exitExchangeSellPrice - trade.entryTrade.sellOrder!.averagePrice)
    
    // Calculate convergence as percentage
    const convergencePercent = ((exitExchangeSellPrice - exitExchangeBuyPrice) / exitExchangeBuyPrice) * 100

    if (convergencePercent <= this.config.convergenceBufferPercent) {
      return {
        shouldExit: true,
        convergencePercent,
        reason: 'Price convergence within buffer'
      }
    }

    return {
      shouldExit: false,
      convergencePercent,
      reason: 'No convergence'
    }
  }

  // Exit Persistence Validation Methods
  private generateExitCandidateKey(tradeId: string, exitType: 'convergence' | 'timeout'): string {
    return `${tradeId}::${exitType}`
  }

  private cleanupStaleExitCandidates(): void {
    const now = Date.now()
    if (now - this.lastExitCleanupTime < this.config.exitCandidateCleanupMs) return

    const staleThreshold = now - this.config.exitCandidateCleanupMs
    const keysToRemove: string[] = []

    for (const [key, candidate] of this.exitCandidates) {
      if (candidate.lastDetectedAt < staleThreshold) {
        keysToRemove.push(key)
      }
    }

    for (const key of keysToRemove) {
      this.exitCandidates.delete(key)
      logger.debug(`Cleaned up stale exit candidate: ${key}`)
    }

    this.lastExitCleanupTime = now
  }

  private validateExitPersistence(
    trade: TrackedTrade,
    exitType: 'convergence' | 'timeout',
    convergencePercent: number,
    avgBuyNormalizedExecutionPrice: number,
    avgSellNormalizedExecutionPrice: number,
    pnlPercent: number,
    updatingExchange: string
  ): ExitPersistenceValidationResult {
    const candidateKey = this.generateExitCandidateKey(trade.id, exitType)
    const now = Date.now()

    // Clean up stale candidates
    this.cleanupStaleExitCandidates()

    // Check if this is a new candidate or existing one
    const existingCandidate = this.exitCandidates.get(candidateKey)

    if (!existingCandidate) {
      // New candidate - create and track
      const newCandidate: ExitCandidate = {
        tradeId: trade.id,
        exitType,
        firstDetectedAt: now,
        lastDetectedAt: now,
        convergencePercent,
        avgBuyNormalizedExecutionPrice,
        avgSellNormalizedExecutionPrice,
        pnlPercent,
        buyExchangeConsecutiveSnapshots: updatingExchange === trade.opportunity.buyExchange ? 1 : 0,
        sellExchangeConsecutiveSnapshots: updatingExchange === trade.opportunity.sellExchange ? 1 : 0
      }
      this.exitCandidates.set(candidateKey, newCandidate)
      
      logger.debug(`New exit candidate detected: ${candidateKey}, convergence: ${convergencePercent.toFixed(3)}%, pnl: ${pnlPercent.toFixed(3)}%`)
      return { isValid: false, reason: 'New exit candidate - waiting for persistence', candidate: newCandidate }
    }

    // Existing candidate - check if conditions are still valid
    const convergenceChange = (convergencePercent - existingCandidate.convergencePercent) / existingCandidate.convergencePercent
    const buyPriceChange = Math.abs(avgBuyNormalizedExecutionPrice - existingCandidate.avgBuyNormalizedExecutionPrice) / existingCandidate.avgBuyNormalizedExecutionPrice
    const sellPriceChange = Math.abs(avgSellNormalizedExecutionPrice - existingCandidate.avgSellNormalizedExecutionPrice) / existingCandidate.avgSellNormalizedExecutionPrice

    if (convergenceChange > 0.2) {
      logger.info(`Candidate ${candidateKey} convergence decreased, resetting`)
      this.exitCandidates.delete(candidateKey)
      return { isValid: false, reason: 'Convergence decreased significantly' }
    }
    // If prices changed significantly, reset the candidate
    if (buyPriceChange > 0.01 || sellPriceChange > 0.01) { // 1% price change threshold
      logger.info(`Exit candidate ${candidateKey} price changed significantly, resetting`)
      this.exitCandidates.delete(candidateKey)
      return { isValid: false, reason: 'Price changed significantly' }
    }

    // Update existing candidate
    existingCandidate.lastDetectedAt = now
    existingCandidate.convergencePercent = convergencePercent
    existingCandidate.avgBuyNormalizedExecutionPrice = avgBuyNormalizedExecutionPrice
    existingCandidate.avgSellNormalizedExecutionPrice = avgSellNormalizedExecutionPrice
    existingCandidate.pnlPercent = pnlPercent

    // Update snapshots based on which exchange is updating
    if (updatingExchange === trade.opportunity.buyExchange) {
      existingCandidate.buyExchangeConsecutiveSnapshots++
    } else if (updatingExchange === trade.opportunity.sellExchange) {
      existingCandidate.sellExchangeConsecutiveSnapshots++
    }

    // Check persistence conditions - require both exchanges to have sufficient snapshots
    const persistenceDuration = existingCandidate.lastDetectedAt - existingCandidate.firstDetectedAt
    const hasMinDuration = persistenceDuration >= this.config.exitMinPersistenceMs
    const hasMinSnapshots = existingCandidate.buyExchangeConsecutiveSnapshots >= this.config.exitMinConsecutiveSnapshots && existingCandidate.sellExchangeConsecutiveSnapshots >= this.config.exitMinConsecutiveSnapshots

    if (hasMinDuration && hasMinSnapshots) {
      logger.info(`Exit condition validated: ${candidateKey}, duration: ${persistenceDuration}ms, buySnapshots: ${existingCandidate.buyExchangeConsecutiveSnapshots}, sellSnapshots: ${existingCandidate.sellExchangeConsecutiveSnapshots}, convergence: ${convergencePercent.toFixed(3)}%, pnl: ${pnlPercent.toFixed(3)}%`)
      this.exitCandidates.delete(candidateKey) // Remove after validation
      return { isValid: true, candidate: existingCandidate }
    }

    logger.debug(`Exit candidate ${candidateKey} still building persistence: duration=${persistenceDuration}ms, buySnapshots=${existingCandidate.buyExchangeConsecutiveSnapshots}, sellSnapshots=${existingCandidate.sellExchangeConsecutiveSnapshots}`)
    return { isValid: false, reason: 'Building exit persistence', candidate: existingCandidate }
  }

  /**
   * Start monitoring trades
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('TradeMonitor is already running')
      return
    }

    this.isRunning = true
    // Setup real-time orderbook event listeners
    this.setupOrderbookEventListeners()
    logger.info('TradeMonitor started with real-time orderbook monitoring')
  }

  /**
   * Stop monitoring trades
   */
  stop(): void {
    this.isRunning = false
    // Remove orderbook event listeners
    this.orderbookManager.removeAllListeners('topOfBookUpdate')
    // Clear processing trades set
    this.processingTrades.clear()
    logger.info('TradeMonitor stopped')
  }

  /**
   * Setup real-time orderbook event listeners
   */
  private setupOrderbookEventListeners(): void {
    // Listen for top of book updates from orderbook manager
    this.orderbookManager.on('topOfBookUpdate', (topOfBook: TopOfBook) => {
      this.handleOrderbookUpdate(topOfBook)
    })
  }

  /**
   * Handle real-time orderbook updates
   */
  private handleOrderbookUpdate(topOfBook: TopOfBook): void {
    if (!this.isRunning) return

    const { exchange, symbol } = topOfBook
    
    // Check if this update affects any open trades
    const affectedTrades = this.getTradesForSymbol(exchange, symbol)
    
    if (affectedTrades.length > 0) {
      logger.debug(`Orderbook update for ${exchange}:${symbol} affects ${affectedTrades.length} trades`)
      
      // Process each affected trade
      for (const trade of affectedTrades) {
        // Prevent race conditions by checking if trade is already being processed
        if (this.processingTrades.has(trade.id)) {
          logger.debug(`[${trade.id}] Trade already being processed, skipping`)
          continue
        }

        try {
          this.processingTrades.add(trade.id)
          this.processTradeExitConditions(trade, exchange)
        } catch (error) {
          logger.error(`[${trade.id}] Error processing trade exit conditions`, {
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          this.processingTrades.delete(trade.id)
        }
      }
    }
  }

  /**
   * Get all trades that involve a specific exchange and symbol
   */
  private getTradesForSymbol(exchange: string, symbol: string): TrackedTrade[] {
    const affectedTrades: TrackedTrade[] = []
    
    for (const trade of this.trackedTrades.values()) {
      if (trade.status !== 'open') continue
      
      // Check if this trade involves the updated exchange and symbol
      if ((trade.opportunity.buyExchange === exchange && trade.opportunity.buyExchangeSymbol === symbol) ||
          (trade.opportunity.sellExchange === exchange && trade.opportunity.sellExchangeSymbol === symbol)) {
        affectedTrades.push(trade)
      }
    }
    
    return affectedTrades
  }

  /**
   * Process exit conditions for a trade based on real-time orderbook update
   */
  private async processTradeExitConditions(trade: TrackedTrade, updatingExchange: string): Promise<void> {
    const now = Date.now()
    const holdTimeMs = now - trade.entryTimestamp

    // Check timeout condition first
    if (holdTimeMs > this.config.maxHoldTimeMs) {
      await this.handleTimeoutExit(trade, now)
      return
    }

    // Simulate exit slippage for current orderbook state
    const exitSimulation = this.simulateExitSlippage(trade)
    if (!exitSimulation) {
      logger.warn(`[${trade.id}] Could not simulate exit slippage`)
      return
    }

    // Update PnL calculations with simulated exit prices
    this.updatePnLWithSimulatedExit(trade, exitSimulation)
    trade.lastUpdateTimestamp = now

    // Check convergence condition
    const convergenceResult = this.checkConvergenceCondition(trade, exitSimulation)
    if (convergenceResult.shouldExit) {
      await this.handleConvergenceExit(trade, convergenceResult, exitSimulation, updatingExchange)
    }
  }

  /**
   * Simulate exit slippage for a trade
   */
  private simulateExitSlippage(trade: TrackedTrade): ExitSlippageSimulationResult | null {
    try {
      const buyBook = this.orderbookManager.getOrderbook(trade.opportunity.buyExchange, trade.opportunity.buyExchangeSymbol)
      const sellBook = this.orderbookManager.getOrderbook(trade.opportunity.sellExchange, trade.opportunity.sellExchangeSymbol)
      
      if (!buyBook || !sellBook) {
        return null
      }

      const buyMetadataService = this.marketMetadataServices.get(trade.opportunity.buyExchange)
      const sellMetadataService = this.marketMetadataServices.get(trade.opportunity.sellExchange)
      
      if (!buyMetadataService || !sellMetadataService) {
        return null
      }

      // Simulate exit slippage for both sides
      const buyExitSimulation = this.simulateSlippage(
        buyBook.bids, // We're selling to close the buy position
        trade.opportunity.buyExchangeVolume,
        false, // Selling
        trade.opportunity.buyExchange,
        trade.opportunity.buyExchangeSymbol,
        buyMetadataService
      )

      const sellExitSimulation = this.simulateSlippage(
        sellBook.asks, // We're buying to close the sell position
        trade.opportunity.sellExchangeVolume,
        true, // Buying
        trade.opportunity.sellExchange,
        trade.opportunity.sellExchangeSymbol,
        sellMetadataService
      )

      return {
        avgBuyExecutionPrice: buyExitSimulation.avgExecutionPrice,
        avgSellExecutionPrice: sellExitSimulation.avgExecutionPrice,
        avgBuyNormalizedExecutionPrice: buyExitSimulation.avgNormalizedExecutionPrice,
        avgSellNormalizedExecutionPrice: sellExitSimulation.avgNormalizedExecutionPrice,
        buySlippagePercent: buyExitSimulation.slippagePercent,
        sellSlippagePercent: sellExitSimulation.slippagePercent,
        totalSlippagePercent: buyExitSimulation.slippagePercent + sellExitSimulation.slippagePercent
      }
    } catch (error) {
      logger.error(`[${trade.id}] Error simulating exit slippage`, {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /**
   * Simulate slippage for a specific orderbook side and volume
   */
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
      slippagePercent
    }
  }

  /**
   * Add a new trade to monitoring
   */
  addTrade(tradeResult: TradeResult): void {
    if (!tradeResult.success || !tradeResult.buyOrder || !tradeResult.sellOrder) {
      logger.warn(`Cannot monitor failed trade: ${tradeResult.id}`)
      return
    }

    const trackedTrade: TrackedTrade = {
      id: tradeResult.id,
      opportunity: tradeResult.opportunity,
      entryTimestamp: Math.min(tradeResult.buyOrder.timestamp, tradeResult.sellOrder.timestamp),
      status: 'open',
      entryTrade: tradeResult,
      lastUpdateTimestamp: Date.now(),
      fees: {
        entry: tradeResult.fees,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.fees
      },
      slippage: {
        entry: tradeResult.slippage,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.slippage
      },
      profit: 0, // Will be calculated based on current or actual exit prices
      pnl: 0, // Will be calculated as profit - fees
      feesPercent: 0,
      slippagePercent: 0,
      profitPercent: 0,
      pnlPercent: 0
    }

    this.trackedTrades.set(tradeResult.id, trackedTrade)
    
    logger.info(`[${tradeResult.id}] Trade added to monitoring`, {
      id: trackedTrade.id,
      entryTrade: trackedTrade.entryTrade,
    })

    this.emit('tradeAdded', trackedTrade)
  }

  /**
   * Get all tracked trades
   */
  getTrackedTrades(): TrackedTrade[] {
    return Array.from(this.trackedTrades.values())
  }

  /**
   * Get a specific tracked trade
   */
  getTrackedTrade(tradeId: string): TrackedTrade | null {
    return this.trackedTrades.get(tradeId) || null
  }

  /**
   * Manually close a trade
   */
  async closeTrade(tradeId: string, reason: 'manual' | 'error' = 'manual'): Promise<boolean> {
    const trade = this.trackedTrades.get(tradeId)
    if (!trade || trade.status !== 'open') {
      logger.warn(`Cannot close trade ${tradeId}: not found or already closed`)
      return false
    }

    logger.info(`[${tradeId}] Manually closing trade`, { reason })

    // Clear any pending exit candidates for this trade
    this.clearExitCandidatesForTrade(tradeId)

    try {
      await this.executeExitTrade(trade, reason)
      return true
    } catch (error) {
      logger.error(`[${tradeId}] Failed to close trade`, {
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  /**
   * Clear exit candidates for a specific trade
   */
  private clearExitCandidatesForTrade(tradeId: string): void {
    const keysToRemove: string[] = []
    for (const [key, candidate] of this.exitCandidates) {
      if (candidate.tradeId === tradeId) {
        keysToRemove.push(key)
      }
    }
    
    for (const key of keysToRemove) {
      this.exitCandidates.delete(key)
      logger.debug(`Cleared exit candidate: ${key}`)
    }

    // Also clear from processing trades set to prevent race conditions
    this.processingTrades.delete(tradeId)
  }



  /**
   * Get current orderbook prices for a trade with normalization
   */
  private getCurrentOrderbookPrices(opportunity: ArbitrageOpportunity): { buyPrice: number, sellPrice: number, normalizedBuyPrice: number, normalizedSellPrice: number } {
    const buyTopOfBook = this.orderbookManager.getTopOfBook(opportunity.buyExchange, opportunity.buyExchangeSymbol)
    const sellTopOfBook = this.orderbookManager.getTopOfBook(opportunity.sellExchange, opportunity.sellExchangeSymbol)
    
    if (!buyTopOfBook || !sellTopOfBook) {
      throw new Error(`No orderbook data available for ${opportunity.buyExchange} ${opportunity.buyExchangeSymbol} or ${opportunity.sellExchange} ${opportunity.sellExchangeSymbol}`)
    }
    
    // Get market metadata services for normalization
    const buyMetadataService = this.marketMetadataServices.get(opportunity.buyExchange)
    const sellMetadataService = this.marketMetadataServices.get(opportunity.sellExchange)
    
    if (!buyMetadataService || !sellMetadataService) {
      throw new Error('Market metadata services not available')
    }
    
    // Normalize prices to base scale for comparison
    const normalizedBuyPrice = buyMetadataService.normalizePrice(buyTopOfBook.bestBid.price, opportunity.buyExchangeSymbol)
    const normalizedSellPrice = sellMetadataService.normalizePrice(sellTopOfBook.bestAsk.price, opportunity.sellExchangeSymbol)
    
    return {
      buyPrice: buyTopOfBook.bestBid.price,
      sellPrice: sellTopOfBook.bestAsk.price,
      normalizedBuyPrice,
      normalizedSellPrice
    }
  }

  /**
   * Update PnL calculations using current market prices
   */
  private updatePnLCalculations(trade: TrackedTrade, currentPrices: { buyPrice: number, sellPrice: number, normalizedBuyPrice: number, normalizedSellPrice: number }): void {
    // Calculate exit prices
    // const exitBuyExchangePrice = currentPrices.buyPrice  // To close a long position
    // const exitSellExchangePrice = currentPrices.sellPrice // To close a short position
    
    // Calculate profit: ((Entry Price A - Exit Price A) × Volume) - ((Entry Price B - Exit Price B) × Volume)
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = currentPrices.buyPrice // Exit price for the buy leg
    const sellExchangeExitPrice = currentPrices.sellPrice  // Exit price for the sell leg
    
    const buyLegProfit = (buyExchangeExitPrice - buyExchangeEntryPrice) * trade.entryTrade.buyOrder!.quantity
    const sellLegProfit = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.entryTrade.sellOrder!.quantity
    trade.profit = buyLegProfit + sellLegProfit

    // Calculate estimated exit costs
    const buyFeeRate = this.getFeeRate(trade.opportunity.buyExchange, 'taker')
    const sellFeeRate = this.getFeeRate(trade.opportunity.sellExchange, 'taker')
    
    const exitBuyFees = calculateFees({ averagePrice: buyExchangeExitPrice, quantity: trade.entryTrade.buyOrder!.quantity } as OrderInfo, buyFeeRate)
    const exitSellFees = calculateFees({ averagePrice: sellExchangeExitPrice, quantity: trade.entryTrade.sellOrder!.quantity } as OrderInfo, sellFeeRate)
    
    trade.fees.exit = exitBuyFees + exitSellFees
    trade.slippage.exit = 0 // Exit slippage is 0 for open positions (estimated exit)
    trade.fees.total = trade.fees.entry + trade.fees.exit
    trade.slippage.total = trade.slippage.entry + trade.slippage.exit

    // Calculate total PnL: Profit - Fees
    // Note: Slippage costs already included in averagePrices
    trade.pnl = trade.profit - trade.fees.total

    // Calculate percentages
    const totalTradeValue = (trade.opportunity.avgBuyNormalizedExecutionPrice + trade.opportunity.avgSellNormalizedExecutionPrice) * trade.opportunity.normalizedVolume / 2
    trade.feesPercent = (trade.fees.total / totalTradeValue) * 100
    trade.slippagePercent = (trade.slippage.total / totalTradeValue) * 100
    trade.profitPercent = (trade.profit / totalTradeValue) * 100
    trade.pnlPercent = (trade.pnl / totalTradeValue) * 100
  }

  /**
   * Execute exit trade with parallel order placement
   */
  private async executeExitTrade(trade: TrackedTrade, exitReason: 'convergence' | 'timeout' | 'manual' | 'error'): Promise<void> {
    logger.info(`[${trade.id}] Executing exit trade`, { exitReason })

    try {
      // Execute reverse trades in parallel
      const buyClient = this.restClients.get(trade.opportunity.buyExchange)
      const sellClient = this.restClients.get(trade.opportunity.sellExchange)

      if (!buyClient || !sellClient) {
        throw new Error('REST clients not available for exit')
      }

      // Get current orderbook prices for exit
      const currentPrices = this.getCurrentOrderbookPrices(trade.opportunity)

      // Place exit orders in parallel
      const [buyOrder, sellOrder] = await Promise.all([
        placeOrderAndMonitor(
          buyClient, 
          trade.opportunity.buyExchangeSymbol, 
          'SELL', 
          trade.opportunity.buyExchangeVolume, 
          currentPrices.buyPrice,
          true,
          `${trade.id}EXITBUY`,
          trade.opportunity.buyExchange,
          this.accountStateManager
        ),
        placeOrderAndMonitor(
          sellClient, 
          trade.opportunity.sellExchangeSymbol, 
          'BUY', 
          trade.opportunity.sellExchangeVolume, 
          currentPrices.sellPrice,
          true,
          `${trade.id}EXITSELL`,
          trade.opportunity.sellExchange,
          this.accountStateManager
        )
      ])

      // Create exit trade result
      const exitTradeResult: TradeResult = {
        id: `${trade.id}EXIT`,
        success: true,
        buyOrder,
        sellOrder,
        opportunity: trade.opportunity,
        fees: this.calculateExitFees(buyOrder, sellOrder, trade),
        slippage: this.calculateExitSlippage(buyOrder, sellOrder),
        latencyMs: 0
      }

      // Update PnL calculations with actual exit prices
      this.updatePnLWithActualExit(trade, exitTradeResult)

      // Update tracked trade
      trade.status = 'closed'
      trade.exitReason = exitReason
      trade.exitTrade = exitTradeResult

      // Clear any pending exit candidates for this trade
      this.clearExitCandidatesForTrade(trade.id)

      logger.info(`[${trade.id}] Exit trade completed`, {
        exitReason,
        pnlPercent: trade.pnlPercent,
        profitPercent: trade.profitPercent,
        feesPercent: trade.feesPercent,
        slippagePercent: trade.slippagePercent,
      })

      this.emit('tradeClosed', trade)

    } catch (error) {
      logger.error(`[${trade.id}] Exit trade failed`, {
        error: error instanceof Error ? error.message : String(error),
        exitReason
      })

      trade.status = 'error'
      trade.exitReason = 'error'
      this.emit('tradeError', { trade, error })
    }
  }

  /**
   * Calculate exit fees for the exit trade
   */
  private calculateExitFees(buyOrder: OrderInfo, sellOrder: OrderInfo, trade: TrackedTrade): number {
    const buyFeeRate = this.getFeeRate(trade.opportunity.buyExchange, 'taker')
    const sellFeeRate = this.getFeeRate(trade.opportunity.sellExchange, 'taker')
    
    const buyFees = calculateFees(buyOrder, buyFeeRate)
    const sellFees = calculateFees(sellOrder, sellFeeRate)
    
    return buyFees + sellFees
  }

  /**
   * Calculate exit slippage for the exit trade
   */
  private calculateExitSlippage(buyOrder: OrderInfo, sellOrder: OrderInfo): number {
    const buySlippage = calculateSlippage(buyOrder, 'SELL')
    const sellSlippage = calculateSlippage(sellOrder, 'BUY')
    
    return buySlippage + sellSlippage
  }

  /**
   * Update PnL calculations with actual exit trade data
   */
  private updatePnLWithActualExit(trade: TrackedTrade, exitTrade: TradeResult): void {
    // Update costs with actual exit data
    trade.fees.exit = exitTrade.fees
    trade.slippage.exit = exitTrade.slippage
    trade.fees.total = trade.fees.entry + trade.fees.exit
    trade.slippage.total = trade.slippage.entry + trade.slippage.exit

    // Calculate profit with actual exit prices
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitTrade.buyOrder!.averagePrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitTrade.sellOrder!.averagePrice  // Exit price for the sell leg
    
    const buyLegProfit = (buyExchangeExitPrice - buyExchangeEntryPrice) * trade.entryTrade.buyOrder!.quantity
    const sellLegProfit = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.entryTrade.sellOrder!.quantity
    trade.profit = buyLegProfit + sellLegProfit

    // Calculate final PnL: Profit - Costs
    trade.pnl = trade.profit - trade.fees.total

    // Calculate percentages
    const totalTradeValue = (trade.opportunity.avgBuyNormalizedExecutionPrice + trade.opportunity.avgSellNormalizedExecutionPrice) * trade.opportunity.normalizedVolume / 2
    trade.feesPercent = (trade.fees.total / totalTradeValue) * 100
    trade.slippagePercent = (trade.slippage.total / totalTradeValue) * 100
    trade.profitPercent = (trade.profit / totalTradeValue) * 100
    trade.pnlPercent = (trade.pnl / totalTradeValue) * 100
  }

  /**
   * Get fee rate for an exchange
   */
  private getFeeRate(exchangeId: string, feeType: 'maker' | 'taker'): number {
    const exchangeConfig = config.exchanges[exchangeId as keyof typeof config.exchanges]
    if (!exchangeConfig) return 0

    return exchangeConfig.fees[feeType]
  }



  /**
   * Get monitoring statistics
   */
  getStats(): {
    totalTrades: number
    openTrades: number
    closedTrades: number
    errorTrades: number
    totalPnL: number
    avgPnL: number
    totalProfit: number
    totalFees: number
    totalSlippage: number
    avgPnLPercent: number
    avgProfitPercent: number
    avgFeesPercent: number
    avgSlippagePercent: number
    exitCandidates: number
  } {
    const trades = this.getTrackedTrades()
    const openTrades = trades.filter(t => t.status === 'open')
    const closedTrades = trades.filter(t => t.status === 'closed')
    const errorTrades = trades.filter(t => t.status === 'error')

    const totalPnL = trades.reduce((sum, trade) => sum + trade.pnl, 0)
    const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0)
    const totalFees = trades.reduce((sum, trade) => sum + trade.fees.total, 0)
    const totalSlippage = trades.reduce((sum, trade) => sum + trade.slippage.total, 0)
    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0
    const avgPnLPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.pnlPercent, 0) / trades.length : 0
    const avgProfitPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.profitPercent, 0) / trades.length : 0
    const avgFeesPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.feesPercent, 0) / trades.length : 0
    const avgSlippagePercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.slippagePercent, 0) / trades.length : 0

    return {
      totalTrades: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      errorTrades: errorTrades.length,
      totalPnL,
      avgPnL,
      totalProfit,
      totalFees,
      totalSlippage,
      avgPnLPercent,
      avgProfitPercent,
      avgFeesPercent,
      avgSlippagePercent,
      exitCandidates: this.exitCandidates.size
    }
  }
} 