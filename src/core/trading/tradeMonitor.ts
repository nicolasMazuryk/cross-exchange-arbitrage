import { EventEmitter } from 'events'
import { TradeResult } from './tradeExecutor'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { OrderInfo } from '../../types/account'
import { OrderbookManager, TopOfBook, OrderBook, OrderBookLevel } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import logger from '../../utils/logger'
import config, { StrategyType } from '../../utils/config'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'
import { FundingService } from '../funding/fundingService'
import { ParsedFunding } from '../funding/types'

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
  strategy: StrategyType  // Track which strategy the trade uses
  entryTrade: TradeResult
  exitTrade?: TradeResult
  exitReason?: 'convergence' | 'timeout' | 'manual' | 'error'
  lastUpdateTimestamp: number
  // PnL calculations
  feesUsd: {
    entry: number
    exit: number
    total: number
  }
  slippageUsd: {
    entry: number
    exit: number
    total: number
  }
  feesPercent: {
    entry: number
    exit: number
    total: number
  }
  slippagePercent: {
    entry: number
    exit: number
    total: number
  }
  deltaProfitUsd: number
  deltaProfitPercent: number
  pnlUsd: number
  pnlPercent: number
}

export interface ExitCondition {
  type: 'convergence' | 'timeout' | 'manual' | 'error'
  value?: number
  description: string
}

export interface MonitorConfig {
  maxHoldTimeMs: number
  checkIntervalMs: number
  // Exit Persistence Validation
  exitMinPersistenceMs: number
  exitMinConsecutiveSnapshots: number
  exitCandidateCleanupMs: number
  // Strategy exit conditions
  strategy: {
    funding: {
      enabled: boolean
      windowStart: number
      windowEnd: number
      convergenceThresholdPercent: number
      spreadWideningThresholdPercent: number
      minFundingProfitPercent: number
    }
    spread: {
      enabled: boolean
      windowStart: number
      windowEnd: number
      windowEndClose: number
      convergenceThresholdPercent: number
      spreadWideningThresholdPercent: number
    }
  }
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
  exitType: 'convergence' | 'timeout' | 'manual' | 'error'
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
  private readonly fundingService: FundingService
  private readonly trackedTrades: Map<string, TrackedTrade> = new Map()
  private readonly config: MonitorConfig
  private isRunning = false
  // Exit Persistence Validation
  private readonly exitCandidates: Map<string, ExitCandidate> = new Map()
  private lastExitCleanupTime: number
  // Race condition prevention
  private readonly processingTrades: Set<string> = new Set()
  // Strategy-specific exit configuration
  private readonly fundingStrategyEnabled: boolean
  private readonly fundingStrategyWindowStart: number
  private readonly fundingStrategyWindowEnd: number
  private readonly fundingConvergenceThresholdPercent: number
  private readonly fundingSpreadWideningThresholdPercent: number
  private readonly fundingMinFundingProfitPercent: number
  private readonly spreadStrategyEnabled: boolean
  private readonly spreadStrategyWindowStart: number
  private readonly spreadStrategyWindowEnd: number
  private readonly spreadStrategyWindowEndClose: number
  private readonly spreadConvergenceThresholdPercent: number
  private readonly spreadWideningThresholdPercent: number

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager,
    marketMetadataServices: Map<string, MarketMetadataService>,
    fundingService: FundingService,
    config: MonitorConfig
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
    this.marketMetadataServices = marketMetadataServices
    this.fundingService = fundingService
    this.config = config
    this.lastExitCleanupTime = Date.now()
    // Strategy exit configuration
    this.fundingStrategyEnabled = config.strategy.funding.enabled
    this.fundingStrategyWindowStart = config.strategy.funding.windowStart
    this.fundingStrategyWindowEnd = config.strategy.funding.windowEnd
    this.fundingConvergenceThresholdPercent = config.strategy.funding.convergenceThresholdPercent
    this.fundingSpreadWideningThresholdPercent = config.strategy.funding.spreadWideningThresholdPercent
    this.fundingMinFundingProfitPercent = config.strategy.funding.minFundingProfitPercent
    this.spreadStrategyEnabled = config.strategy.spread.enabled
    this.spreadStrategyWindowStart = config.strategy.spread.windowStart
    this.spreadStrategyWindowEnd = config.strategy.spread.windowEnd
    this.spreadStrategyWindowEndClose = config.strategy.spread.windowEndClose
    this.spreadConvergenceThresholdPercent = config.strategy.spread.convergenceThresholdPercent
    this.spreadWideningThresholdPercent = config.strategy.spread.spreadWideningThresholdPercent

    logger.info('TradeMonitor initialized')
  }

  /**
   * Update PnL calculations with simulated exit prices
   */
  private updatePnLWithSimulatedExit(trade: TrackedTrade, exitSimulation: ExitSlippageSimulationResult): void {
    // Calculate exit fees for both legs
    const buyFeeRatePercent = this.getTradingFeeRatePercent(trade.opportunity.buyExchange, 'taker')
    const sellFeeRatePercent = this.getTradingFeeRatePercent(trade.opportunity.sellExchange, 'taker')
    
    const buyExitFeesUsd = exitSimulation.avgBuyNormalizedExecutionPrice * trade.opportunity.normalizedVolume * (buyFeeRatePercent / 100)
    const sellExitFeesUsd = exitSimulation.avgSellNormalizedExecutionPrice * trade.opportunity.normalizedVolume * (sellFeeRatePercent / 100)
    
    // Calculate slippage separately for both buy and sell sides
    const buySlippageUsd = exitSimulation.avgBuyNormalizedExecutionPrice * trade.opportunity.normalizedVolume * (exitSimulation.buySlippagePercent / 100)
    const sellSlippageUsd = exitSimulation.avgSellNormalizedExecutionPrice * trade.opportunity.normalizedVolume * (exitSimulation.sellSlippagePercent / 100)
    
    trade.feesUsd.exit = buyExitFeesUsd + sellExitFeesUsd
    trade.feesUsd.total = trade.feesUsd.entry + trade.feesUsd.exit

    trade.feesPercent.exit = buyFeeRatePercent + sellFeeRatePercent
    trade.feesPercent.total = trade.feesPercent.entry + trade.feesPercent.exit

    trade.slippageUsd.exit = buySlippageUsd + sellSlippageUsd
    trade.slippageUsd.total = trade.slippageUsd.entry + trade.slippageUsd.exit

    trade.slippagePercent.exit = exitSimulation.buySlippagePercent + exitSimulation.sellSlippagePercent
    trade.slippagePercent.total = trade.slippagePercent.entry + trade.slippagePercent.exit
    
    // Calculate profit with simulated exit prices
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitSimulation.avgBuyNormalizedExecutionPrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitSimulation.avgSellNormalizedExecutionPrice  // Exit price for the sell leg
    
    const orderAmountUsd = (trade.opportunity.avgBuyNormalizedExecutionPrice + trade.opportunity.avgSellNormalizedExecutionPrice) * trade.opportunity.normalizedVolume / 2

    const buyLegDeltaUsd = (buyExchangeExitPrice - buyExchangeEntryPrice) * trade.entryTrade.buyOrder!.quantity
    const sellLegDeltaUsd = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.entryTrade.sellOrder!.quantity
    trade.deltaProfitUsd = buyLegDeltaUsd + sellLegDeltaUsd
    trade.deltaProfitPercent = (trade.deltaProfitUsd / orderAmountUsd) * 100

    // Calculate final PnL: Profit - Costs
    trade.pnlUsd = trade.deltaProfitUsd - trade.feesUsd.total
    trade.pnlPercent = (trade.pnlUsd / orderAmountUsd) * 100
  }


  // Exit Persistence Validation Methods
  private generateExitCandidateKey(tradeId: string, exitType: 'convergence' | 'timeout' | 'manual' | 'error'): string {
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
    exitType: 'convergence' | 'timeout' | 'manual' | 'error',
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
    const convergenceChangeRatio = (convergencePercent - existingCandidate.convergencePercent) / existingCandidate.convergencePercent
    const buyPriceChangeRatio = Math.abs(avgBuyNormalizedExecutionPrice - existingCandidate.avgBuyNormalizedExecutionPrice) / existingCandidate.avgBuyNormalizedExecutionPrice
    const sellPriceChangeRatio = Math.abs(avgSellNormalizedExecutionPrice - existingCandidate.avgSellNormalizedExecutionPrice) / existingCandidate.avgSellNormalizedExecutionPrice

    if (convergenceChangeRatio > 0.2) {
      logger.info(`Candidate ${candidateKey} convergence decreased, resetting`)
      this.exitCandidates.delete(candidateKey)
      return { isValid: false, reason: 'Convergence decreased significantly' }
    }
    // If prices changed significantly, reset the candidate
    if (buyPriceChangeRatio > 0.01 || sellPriceChangeRatio > 0.01) { // 1% price change threshold
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
    }
    if (updatingExchange === trade.opportunity.sellExchange) {
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
   * Check if current time is within funding strategy execution window
   */
  private isWithinFundingWindow(nextFundingTimestamp: number): boolean {
    const now = Date.now()
    const timeUntilFunding = nextFundingTimestamp - now
    const timeUntilFundingSec = timeUntilFunding / 1000
    
    return timeUntilFundingSec <= this.fundingStrategyWindowStart && 
           timeUntilFundingSec >= this.fundingStrategyWindowEnd
  }

  /**
   * Check if current time is within spread strategy execution window (for exits)
   */
  private isWithinSpreadWindowForExit(previousFundingTimestamp: number, nextFundingTimestamp: number): boolean {
    const now = Date.now()
    const timeSincePreviousFunding = now - previousFundingTimestamp
    const timeSincePreviousFundingSec = timeSincePreviousFunding / 1000
    const timeUntilNextFunding = nextFundingTimestamp - now
    const timeUntilNextFundingSec = timeUntilNextFunding / 1000
    
    // For exits: use windowStart and windowEndClose
    return timeSincePreviousFundingSec >= this.spreadStrategyWindowStart &&
           timeUntilNextFundingSec >= this.spreadStrategyWindowEndClose
  }

  /**
   * Check funding arbitrage exit conditions (SYNC mode)
   */
  private shouldExitFundingSyncTrade(
    trade: TrackedTrade,
    buyFundingData: ParsedFunding,
    sellFundingData: ParsedFunding,
    currentSpreadDifferencePercent: number
  ): { shouldExit: boolean, reason?: string } {
    // Calculate current funding difference
    const fundingDifferencePercent = (-buyFundingData.fundingRate + sellFundingData.fundingRate) * 100

    // Exit Condition 1: Funding rates converged (< 0.02%)
    if (fundingDifferencePercent < this.fundingConvergenceThresholdPercent) {
      return { 
        shouldExit: true, 
        reason: `Funding converged: ${(fundingDifferencePercent).toFixed(3)}% < ${(this.fundingConvergenceThresholdPercent).toFixed(3)}%` 
      }
    }

    // Exit Condition 2: Spread widened excessively (dynamic based on entry spread)
    const spreadWideningThresholdPercent = trade.opportunity.spreadProfitPercent + this.fundingSpreadWideningThresholdPercent
    if (currentSpreadDifferencePercent > spreadWideningThresholdPercent) {
      return { 
        shouldExit: true, 
        reason: `Spread widened: ${(currentSpreadDifferencePercent).toFixed(3)}% < ${(spreadWideningThresholdPercent).toFixed(3)}% (entry: ${(trade.opportunity.spreadProfitPercent).toFixed(3)}% + threshold: ${(this.fundingSpreadWideningThresholdPercent).toFixed(3)}%)` 
      }
    }

    return { shouldExit: false }
  }

  /**
   * Check funding arbitrage exit conditions (ASYNC mode)
   */
  private shouldExitFundingAsyncTrade(
    trade: TrackedTrade,
    buyFundingData: ParsedFunding,
    sellFundingData: ParsedFunding,
    currentSpreadDifferencePercent: number
  ): { shouldExit: boolean, reason?: string } {
    const fundingEvents = this.fundingService.generateFundingEvents(buyFundingData, sellFundingData, config.funding.projectionHours)

    // Check if currently synchronized (upcoming event is a sync)
    const isNextEventSync = buyFundingData.nextFundingTimestamp === sellFundingData.nextFundingTimestamp
    
    if (!isNextEventSync) {
      // CASE 1: ASYNC - upcoming event is NOT a sync
      // Calculate cumulative funding profit until the next sync event
      const nextSyncTimestamp = this.fundingService.findNextSyncTimestamp(buyFundingData, sellFundingData)
      const cumulativeFundingRate = this.fundingService.calculateCumulativeFundingRate(
        nextSyncTimestamp,
        fundingEvents
      )
      
      // Exit Condition: cumulativeFundingRate < 0 (should be profitable before sync)
      if (cumulativeFundingRate < 0) {
        return { 
          shouldExit: true, 
          reason: `ASYNC-ASYNC: Cumulative funding rate ${(cumulativeFundingRate * 100).toFixed(3)}% < 0%` 
        }
      }
    } else {
      // CASE 2: SYNC - upcoming event IS a sync, need to look beyond it
      // Find the next sync AFTER the upcoming sync (next + 1)
      const currentSyncTimestamp = buyFundingData.nextFundingTimestamp
      
      // Find the next sync + 1 event
      let nextPlusOneSyncTimestamp = 0
      let foundCurrentSync = false
      
      for (const event of fundingEvents) {
        if (event.timestamp === currentSyncTimestamp && event.buyExchangeFundingRate !== 0 && event.sellExchangeFundingRate !== 0) {
          foundCurrentSync = true
          continue // Skip current sync
        }
        
        if (foundCurrentSync && event.buyExchangeFundingRate !== 0 && event.sellExchangeFundingRate !== 0) {
          nextPlusOneSyncTimestamp = event.timestamp
          break
        }
      }
      
      // Calculate cumulative funding rate for all events until nextSyncPlusOne
      const cumulativeFundingRate = this.fundingService.calculateCumulativeFundingRate(
        nextPlusOneSyncTimestamp,
        fundingEvents
      )
      
      // Exit Condition: cumulativeFundingRate < minFundingProfitPercent
      if ((cumulativeFundingRate * 100) < this.fundingMinFundingProfitPercent) {
        return { 
          shouldExit: true, 
          reason: `ASYNC-SYNC: Cumulative funding rate ${(cumulativeFundingRate * 100).toFixed(3)}% < ${(this.fundingMinFundingProfitPercent).toFixed(3)}%` 
        }
      }
    }

    // Exit Condition: Spread widened excessively (dynamic based on entry spread)
    const spreadWideningThresholdPercent = trade.opportunity.spreadProfitPercent + this.fundingSpreadWideningThresholdPercent
    if (currentSpreadDifferencePercent > spreadWideningThresholdPercent) {
      return { 
        shouldExit: true, 
        reason: `Spread widened: ${(currentSpreadDifferencePercent).toFixed(3)}% < ${(spreadWideningThresholdPercent).toFixed(3)}% (entry: ${(trade.opportunity.spreadProfitPercent).toFixed(3)}% + threshold: ${(this.fundingSpreadWideningThresholdPercent).toFixed(3)}%)` 
      }
    }

    return { shouldExit: false }
  }

  /**
   * Check spread arbitrage exit conditions (includes convergence logic)
   */
  private shouldExitSpreadTrade(
    trade: TrackedTrade,
    currentSpreadDifferencePercent: number,
    exitSimulation: ExitSlippageSimulationResult
  ): { shouldExit: boolean, reason?: string } {
    // For arbitrage trades, we need to consider the exit prices:
    // - If we bought initially, we need to sell at the bid price
    // - If we sold initially, we need to buy at the ask price

    // Calculate convergence for exit prices
    const exitBuyExchangePrice = exitSimulation.avgBuyNormalizedExecutionPrice
    const exitSellExchangePrice = exitSimulation.avgSellNormalizedExecutionPrice
    
    const convergencePercent = ((exitSellExchangePrice - exitBuyExchangePrice) / exitBuyExchangePrice) * 100

    // Check convergence threshold
    if (convergencePercent <= this.spreadConvergenceThresholdPercent) {
      return {
        shouldExit: true,
        reason: 'SPREAD: Price convergence within threshold'
      }
    }

    // Check if spread widened excessively (dynamic based on entry spread)
    const spreadWideningThresholdPercent = trade.opportunity.spreadProfitPercent + this.spreadWideningThresholdPercent
    if (currentSpreadDifferencePercent > spreadWideningThresholdPercent) {
      return { 
        shouldExit: true,
        reason: `Spread widened: ${(currentSpreadDifferencePercent).toFixed(3)}% < ${(spreadWideningThresholdPercent).toFixed(3)}% (entry: ${(trade.opportunity.spreadProfitPercent).toFixed(3)}% + threshold: ${(this.spreadWideningThresholdPercent).toFixed(3)}%)` 
      }
    }

    return { shouldExit: false, reason: 'No convergence' }
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
    // Simulate exit slippage for current orderbook state
    const exitSimulation = this.simulateExitSlippage(trade)
    if (!exitSimulation) {
      logger.warn(`[${trade.id}] Could not simulate exit slippage`)
      return
    }
    
    const now = Date.now()
    const holdTimeMs = now - trade.entryTimestamp

    // Check timeout condition first
    if (holdTimeMs > this.config.maxHoldTimeMs) {
      await this.executeExitTrade(trade, exitSimulation, 'timeout', updatingExchange)
      return
    }

    // Update PnL calculations with simulated exit prices
    this.updatePnLWithSimulatedExit(trade, exitSimulation)
    trade.lastUpdateTimestamp = now

    // Calculate current spread difference for exit checks
    const currentSpreadDifferencePercent = ((exitSimulation.avgSellNormalizedExecutionPrice - exitSimulation.avgBuyNormalizedExecutionPrice) / exitSimulation.avgBuyNormalizedExecutionPrice) * 100

    // Get current funding data for all strategies
    const buyFundingData = this.fundingService.getSymbolFundingData(
      trade.opportunity.buyExchange,
      trade.opportunity.buyExchangeSymbol
    )
    const sellFundingData = this.fundingService.getSymbolFundingData(
      trade.opportunity.sellExchange,
      trade.opportunity.sellExchangeSymbol
    )

    if (!buyFundingData || !sellFundingData) {
      logger.warn(`[${trade.id}] Cannot check exit: funding data unavailable`)
      return
    }

    // Validate funding data is not outdated
    if (buyFundingData.nextFundingTimestamp < now || sellFundingData.nextFundingTimestamp < now) {
      logger.warn(`[${trade.id}] Outdated funding data, skipping exit check`)
      return
    }

    const nextFundingTimestamp = Math.min(buyFundingData.nextFundingTimestamp, sellFundingData.nextFundingTimestamp)
    const nextFundingInterval = Math.min(buyFundingData.fundingInterval, sellFundingData.fundingInterval)
    const fundingIntervalMs = nextFundingInterval * 60 * 60 * 1000
    const previousFundingTimestamp = nextFundingTimestamp - fundingIntervalMs

    // Check time window and strategy enabled conditions
    let strategyExitResult: { shouldExit: boolean, reason?: string } = { shouldExit: false }

    if (trade.strategy === 'funding' && this.fundingStrategyEnabled) {
      // Check if target funding event has occurred
      if (now < trade.opportunity.targetFundingTimestamp) {
        logger.debug(`[${trade.id}] Target funding event not reached yet (${Math.round((trade.opportunity.targetFundingTimestamp - now) / 1000)}s remaining), skipping exit check`)
        return
      }

      // Check if within funding window
      if (!this.isWithinFundingWindow(nextFundingTimestamp)) {
        logger.debug(`[${trade.id}] Not within funding window, skipping exit check`)
        return
      }

      // Determine if this is SYNC or ASYNC funding arbitrage
      const isSynchronized = this.fundingService.isFundingSynchronizedExit(buyFundingData, sellFundingData)
      
      if (isSynchronized) {
        strategyExitResult = this.shouldExitFundingSyncTrade(trade, buyFundingData, sellFundingData, currentSpreadDifferencePercent)
      } else {
        strategyExitResult = this.shouldExitFundingAsyncTrade(trade, buyFundingData, sellFundingData, currentSpreadDifferencePercent)
      }
    } else if (trade.strategy === 'spread' && this.spreadStrategyEnabled) {
      if (!this.isWithinSpreadWindowForExit(previousFundingTimestamp, nextFundingTimestamp)) {
        logger.debug(`[${trade.id}] Not within spread window, skipping exit check`)
        return
      }

      strategyExitResult = this.shouldExitSpreadTrade(trade, currentSpreadDifferencePercent, exitSimulation)
    }

    // If strategy-specific exit condition is met, execute exit with validation
    if (strategyExitResult.shouldExit) {
      logger.info(`[${trade.id}] Strategy exit condition met: ${strategyExitResult.reason}`)
      await this.executeExitTrade(trade, exitSimulation, 'convergence', updatingExchange)
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
      ? ((avgExecutionPrice - basePrice) / basePrice) * 100
      : ((basePrice - avgExecutionPrice) / basePrice) * 100

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
      strategy: tradeResult.opportunity.strategy,  // Capture strategy type from opportunity
      entryTrade: tradeResult,
      lastUpdateTimestamp: Date.now(),
      feesUsd: {
        entry: tradeResult.feesUsd,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.feesUsd
      },
      slippageUsd: {
        entry: tradeResult.slippageUsd,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.slippageUsd
      },
      feesPercent: {
        entry: tradeResult.feesPercent,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.feesPercent
      },
      slippagePercent: {
        entry: tradeResult.slippagePercent,
        exit: 0, // Will be calculated when position is closed
        total: tradeResult.slippagePercent
      },
      deltaProfitUsd: 0,
      deltaProfitPercent: 0,
      pnlUsd: 0,
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
      // Simulate exit slippage for current orderbook state
      const exitSimulation = this.simulateExitSlippage(trade)
      if (!exitSimulation) {
        logger.warn(`[${trade.id}] Could not simulate exit slippage`)
        return false
      }

      await this.executeExitTrade(trade, exitSimulation, 'manual')
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
   * Execute exit trade with parallel order placement (includes validation for convergence/timeout exits)
   */
  private async executeExitTrade(
    trade: TrackedTrade,
    exitSimulation: ExitSlippageSimulationResult,
    exitReason: 'convergence' | 'timeout' | 'manual' | 'error',
    updatingExchange?: string
  ): Promise<void> {
    // Calculate convergence for exit prices
    const exitExchangeBuyPrice = exitSimulation.avgBuyNormalizedExecutionPrice
    const exitExchangeSellPrice = exitSimulation.avgSellNormalizedExecutionPrice
    
    const convergencePercent = ((exitExchangeSellPrice - exitExchangeBuyPrice) / exitExchangeBuyPrice) * 100
    
    // Validate exit persistence for convergence
    if (exitReason === 'convergence') {
      const validation = this.validateExitPersistence(
        trade,
        exitReason,
        convergencePercent,
        exitExchangeBuyPrice,
        exitExchangeSellPrice,
        trade.pnlPercent,
        updatingExchange!
      )
      
      if (!validation.isValid) {
        logger.debug(`[${trade.id}] Exit validation failed: ${validation.reason}`)
        return
      }
    }

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

      // Calculate fees and slippage
      const buyFeeRatePercent = this.getTradingFeeRatePercent(trade.opportunity.buyExchange, 'taker')
      const sellFeeRatePercent = this.getTradingFeeRatePercent(trade.opportunity.sellExchange, 'taker')
      
      const buyFees = calculateFees(buyOrder, buyFeeRatePercent)
      const sellFees = calculateFees(sellOrder, sellFeeRatePercent)
      const buySlippage = calculateSlippage(buyOrder, buyOrder.orderSide)
      const sellSlippage = calculateSlippage(sellOrder, sellOrder.orderSide)

      // Create exit trade result
      const exitTradeResult: TradeResult = {
        id: `${trade.id}EXIT`,
        opportunity: trade.opportunity,
        buyOrder,
        sellOrder,
        success: true,
        latencyMs: 0,        
        feesUsd: buyFees.feesUsd + sellFees.feesUsd,
        feesPercent: buyFees.feesPercent + sellFees.feesPercent,
        slippageUsd: buySlippage.slippageUsd + sellSlippage.slippageUsd,
        slippagePercent: buySlippage.slippagePercent + sellSlippage.slippagePercent,
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
        feesPercent: trade.feesPercent.total,
        slippagePercent: trade.slippagePercent.total,
        deltaProfitPercent: trade.deltaProfitPercent,
        pnlPercent: trade.pnlPercent,
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
   * Update PnL calculations with actual exit trade data
   */
  private updatePnLWithActualExit(trade: TrackedTrade, exitTrade: TradeResult): void {
    // Update costs with actual exit data
    trade.feesUsd.exit = exitTrade.feesUsd
    trade.feesUsd.total = trade.feesUsd.entry + trade.feesUsd.exit

    trade.feesPercent.exit = exitTrade.feesPercent
    trade.feesPercent.total = trade.feesPercent.entry + trade.feesPercent.exit
    
    trade.slippageUsd.exit = exitTrade.slippageUsd
    trade.slippageUsd.total = trade.slippageUsd.entry + trade.slippageUsd.exit

    trade.slippagePercent.exit = exitTrade.slippagePercent
    trade.slippagePercent.total = trade.slippagePercent.entry + trade.slippagePercent.exit

    // Calculate profit with actual exit prices
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitTrade.buyOrder!.averagePrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitTrade.sellOrder!.averagePrice  // Exit price for the sell leg
    
    const orderAmountUsd = (trade.opportunity.avgBuyNormalizedExecutionPrice + trade.opportunity.avgSellNormalizedExecutionPrice) * trade.opportunity.normalizedVolume / 2

    const buyLegDeltaUsd = (buyExchangeExitPrice - buyExchangeEntryPrice) * trade.entryTrade.buyOrder!.quantity
    const sellLegDeltaUsd = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.entryTrade.sellOrder!.quantity
    trade.deltaProfitUsd = buyLegDeltaUsd + sellLegDeltaUsd
    trade.deltaProfitPercent = (trade.deltaProfitUsd / orderAmountUsd) * 100

    // Calculate final PnL: Profit - Costs
    trade.pnlUsd = trade.deltaProfitUsd - trade.feesUsd.total
    trade.pnlPercent = (trade.pnlUsd / orderAmountUsd) * 100
  }

  /**
   * Get trading fee percent for an exchange
   */
  private getTradingFeeRatePercent(exchangeId: string, feeType: 'maker' | 'taker'): number {
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
    totalPnLUsd: number
    avgPnLUsd: number
    totalDeltaProfitUsd: number
    totalFeesUsd: number
    totalSlippageUsd: number
    avgPnLPercent: number
    avgDeltaProfitPercent: number
    avgFeesPercent: number
    avgSlippagePercent: number
    exitCandidates: number
  } {
    const trades = this.getTrackedTrades()
    const openTrades = trades.filter(t => t.status === 'open')
    const closedTrades = trades.filter(t => t.status === 'closed')
    const errorTrades = trades.filter(t => t.status === 'error')

    const totalPnLUsd = trades.reduce((sum, trade) => sum + trade.pnlUsd, 0)
    const totalDeltaProfitUsd = trades.reduce((sum, trade) => sum + trade.deltaProfitUsd, 0)
    const totalFeesUsd = trades.reduce((sum, trade) => sum + trade.feesUsd.total, 0)
    const totalSlippageUsd = trades.reduce((sum, trade) => sum + trade.slippageUsd.total, 0)
    const avgPnLUsd = trades.length > 0 ? totalPnLUsd / trades.length : 0
    const avgPnLPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.pnlPercent, 0) / trades.length : 0
    const avgDeltaProfitPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.deltaProfitPercent, 0) / trades.length : 0
    const avgFeesPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.feesPercent.total, 0) / trades.length : 0
    const avgSlippagePercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.slippagePercent.total, 0) / trades.length : 0

    return {
      totalTrades: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      errorTrades: errorTrades.length,
      totalPnLUsd,
      avgPnLUsd,
      totalDeltaProfitUsd: totalDeltaProfitUsd,
      totalFeesUsd,
      totalSlippageUsd,
      avgPnLPercent,
      avgDeltaProfitPercent,
      avgFeesPercent,
      avgSlippagePercent,
      exitCandidates: this.exitCandidates.size
    }
  }
} 