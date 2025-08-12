import { EventEmitter } from 'events'
import { TradeResult } from './tradeExecutor'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { OrderInfo } from '../../types/account'
import { OrderbookManager, TopOfBook } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import logger from '../../utils/logger'
import config from '../../utils/config'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'

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
}

export class TradeMonitor extends EventEmitter {
  private readonly accountStateManager: AccountStateManager
  private readonly restClients: Map<string, RestClientInterface>
  private readonly orderbookManager: OrderbookManager
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly trackedTrades: Map<string, TrackedTrade> = new Map()
  private readonly config: MonitorConfig
  private checkInterval: NodeJS.Timeout | null = null
  private isRunning = false

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

    logger.info('TradeMonitor initialized', { config: this.config })
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
    this.scheduleNextCheck()
    logger.info('TradeMonitor started')
  }

  /**
   * Stop monitoring trades
   */
  stop(): void {
    this.isRunning = false
    if (this.checkInterval) {
      clearTimeout(this.checkInterval)
      this.checkInterval = null
    }
    logger.info('TradeMonitor stopped')
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
   * Check all open trades for exit conditions
   */
  private async checkExitConditions(): Promise<void> {
    const openTrades = this.getTrackedTrades().filter(t => t.status === 'open')
    
    if (openTrades.length === 0) {
      return
    }

    logger.debug(`Checking ${openTrades.length} open trades for exit conditions`)

    for (const trade of openTrades) {
      try {
        await this.checkTradeExitConditions(trade)
      } catch (error) {
        logger.error(`[${trade.id}] Error checking exit conditions`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /**
   * Check exit conditions for a specific trade based on orderbook prices
   */
  private async checkTradeExitConditions(trade: TrackedTrade): Promise<void> {
    const now = Date.now()
    const holdTimeMs = now - trade.entryTimestamp

    // Check timeout condition
    if (holdTimeMs > this.config.maxHoldTimeMs) {
      logger.info(`[${trade.id}] Trade timeout reached`, {
        holdTimeMs,
        maxHoldTimeMs: this.config.maxHoldTimeMs
      })
      await this.executeExitTrade(trade, 'timeout')
      return
    }

    // Get current orderbook prices
    const currentPrices = this.getCurrentOrderbookPrices(trade.opportunity)
    if (!currentPrices.buyPrice || !currentPrices.sellPrice) {
      logger.warn(`[${trade.id}] No orderbook data available for price check`)
      return
    }

    // Update PnL calculations using current market prices
    this.updatePnLCalculations(trade, currentPrices)
    trade.lastUpdateTimestamp = now

    // Check convergence condition with exit price consideration
    const convergenceResult = this.checkConvergenceCondition(trade, currentPrices)
    if (convergenceResult.shouldExit) {
      logger.info(`[${trade.id}] Price convergence detected`, {
        convergencePercent: convergenceResult.convergencePercent,
        threshold: this.config.convergenceBufferPercent,
        bidPrice: currentPrices.buyPrice,
        askPrice: currentPrices.sellPrice,
        exitReason: convergenceResult.reason
      })
      await this.executeExitTrade(trade, 'convergence')
      return
    }
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
   * Check convergence condition with exit price consideration
   */
  private checkConvergenceCondition(
    trade: TrackedTrade, 
    currentPrices: { buyPrice: number, sellPrice: number, normalizedBuyPrice: number, normalizedSellPrice: number }
  ): { shouldExit: boolean, convergencePercent: number, reason: string } {
    // For arbitrage trades, we need to consider the exit prices:
    // - If we bought initially, we need to sell at the bid price
    // - If we sold initially, we need to buy at the ask price
    
    const exitExchangeBuyPrice = currentPrices.normalizedBuyPrice
    const exitExchangeSellPrice = currentPrices.normalizedSellPrice
    
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
   * Schedule the next check interval
   */
  private scheduleNextCheck(): void {
    if (!this.isRunning) return

    // Clear any existing timeout to prevent memory leaks
    if (this.checkInterval) {
      clearTimeout(this.checkInterval)
    }

    // Schedule the next check
    this.checkInterval = setTimeout(async () => {
      try {
        await this.checkExitConditions()
      } catch (error) {
        logger.error('Error during exit conditions check:', error)
      } finally {
        // Schedule the next check only if still running
        if (this.isRunning) {
          this.scheduleNextCheck()
        }
      }
    }, this.config.checkIntervalMs)
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
      avgSlippagePercent
    }
  }
} 