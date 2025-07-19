import { EventEmitter } from 'events'
import { TradeResult } from './tradeExecutor'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { OrderInfo } from '../../types/account'
import { OrderSide, OrderStatus } from '../../types/exchange'
import { OrderbookManager, TopOfBook } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import logger from '../../utils/logger'
import config from '../../utils/config'

// Core interfaces
export interface TrackedTrade {
  id: string
  pair: string
  buyExchange: string
  sellExchange: string
  volume: number
  entryTimestamp: number
  status: 'open' | 'closed' | 'error'
  entryTrade: TradeResult
  exitTrade?: TradeResult
  exitReason?: 'convergence' | 'timeout' | 'manual' | 'error'
  lastUpdateTimestamp: number
  // PnL calculations
  costs: {
    entryFees: number
    entrySlippage: number
    exitFees: number
    exitSlippage: number
    total: number
  }
  profit: number
  pnl: number
  // Percentage calculations
  costsPercent: number
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
  private readonly trackedTrades: Map<string, TrackedTrade> = new Map()
  private readonly config: MonitorConfig
  private checkInterval: NodeJS.Timeout | null = null
  private isRunning = false

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager,
    config: MonitorConfig
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
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
      pair: tradeResult.buyOrder.symbol,
      buyExchange: this.getExchangeFromOrder(tradeResult.buyOrder),
      sellExchange: this.getExchangeFromOrder(tradeResult.sellOrder),
      volume: tradeResult.executedVolume,
      entryTimestamp: tradeResult.buyOrder.timestamp,
      status: 'open',
      entryTrade: tradeResult,
      lastUpdateTimestamp: Date.now(),
      costs: {
        entryFees: tradeResult.fees,
        entrySlippage: tradeResult.slippage,
        exitFees: 0, // Will be calculated when position is open
        exitSlippage: 0, // Will be calculated when position is open
        total: tradeResult.fees + tradeResult.slippage
      },
      profit: 0, // Will be calculated based on current or actual exit prices
      pnl: 0, // Will be calculated as profit - costs
      costsPercent: 0,
      profitPercent: 0,
      pnlPercent: 0
    }

    this.trackedTrades.set(tradeResult.id, trackedTrade)
    
    logger.info(`[${tradeResult.id}] Trade added to monitoring`, {
      pair: trackedTrade.pair,
      buyExchange: trackedTrade.buyExchange,
      sellExchange: trackedTrade.sellExchange,
      volume: trackedTrade.volume
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
    const currentPrices = this.getCurrentOrderbookPrices(trade)
    if (!currentPrices) {
      logger.debug(`[${trade.id}] No orderbook data available for price check`)
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
        bidPrice: currentPrices.bidPrice,
        askPrice: currentPrices.askPrice,
        exitReason: convergenceResult.reason
      })
      await this.executeExitTrade(trade, 'convergence')
      return
    }
  }

  /**
   * Get current orderbook prices for a trade using getTopOfBook
   */
  private getCurrentOrderbookPrices(trade: TrackedTrade): { bidPrice: number, askPrice: number } | null {
    try {
      const buyTopOfBook = this.orderbookManager.getTopOfBook(trade.buyExchange, trade.pair)
      const sellTopOfBook = this.orderbookManager.getTopOfBook(trade.sellExchange, trade.pair)

      if (!buyTopOfBook || !sellTopOfBook) {
        return null
      }

      // Use best bid/ask prices from top of book
      const bidPrice = buyTopOfBook.bestBid.price
      const askPrice = sellTopOfBook.bestAsk.price

      if (bidPrice === 0 || askPrice === 0) {
        return null
      }

      return { bidPrice, askPrice }
    } catch (error) {
      logger.error(`[${trade.id}] Error getting orderbook prices`, {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /**
   * Check convergence condition with exit price consideration
   */
  private checkConvergenceCondition(
    trade: TrackedTrade, 
    currentPrices: { bidPrice: number, askPrice: number }
  ): { shouldExit: boolean, convergencePercent: number, reason: string } {
    // For arbitrage trades, we need to consider the exit prices:
    // - If we bought initially, we need to sell at the bid price
    // - If we sold initially, we need to buy at the ask price
    
    const exitBuyPrice = currentPrices.askPrice  // To close a short position
    const exitSellPrice = currentPrices.bidPrice // To close a long position
    
    // Calculate the price difference between entry and exit
    const buyExitDifference = Math.abs(exitSellPrice - trade.entryTrade.buyOrder!.averagePrice)
    const sellExitDifference = Math.abs(exitBuyPrice - trade.entryTrade.sellOrder!.averagePrice)
    
    // Calculate convergence as percentage
    const convergencePercent = ((exitSellPrice - exitBuyPrice) / exitBuyPrice) * 100

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
  private updatePnLCalculations(trade: TrackedTrade, currentPrices: { bidPrice: number, askPrice: number }): void {
    // Calculate exit prices
    const exitBuyPrice = currentPrices.askPrice  // To close a short position
    const exitSellPrice = currentPrices.bidPrice // To close a long position
    
    // Calculate profit: ((Entry Price A - Exit Price A) × Volume) - ((Entry Price B - Exit Price B) × Volume)
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitSellPrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitBuyPrice  // Exit price for the sell leg
    
    const buyLegProfit = (buyExchangeEntryPrice - buyExchangeExitPrice) * trade.volume
    const sellLegProfit = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.volume
    trade.profit = buyLegProfit - sellLegProfit

    // Calculate estimated exit costs
    const buyFeeRate = this.getFeeRate(trade.buyExchange, 'taker')
    const sellFeeRate = this.getFeeRate(trade.sellExchange, 'taker')
    
    const exitBuyFees = calculateFees({ averagePrice: exitBuyPrice, quantity: trade.volume } as OrderInfo, trade.sellExchange, buyFeeRate)
    const exitSellFees = calculateFees({ averagePrice: exitSellPrice, quantity: trade.volume } as OrderInfo, trade.buyExchange, sellFeeRate)
    
    trade.costs.exitFees = exitBuyFees + exitSellFees
    trade.costs.exitSlippage = 0 // Exit slippage is 0 for open positions (estimated exit)
    trade.costs.total = trade.costs.entryFees + trade.costs.entrySlippage + trade.costs.exitFees + trade.costs.exitSlippage

    // Calculate total PnL: Profit - Costs
    trade.pnl = trade.profit - trade.costs.total

    // Calculate percentages
    const totalTradeValue = (buyExchangeEntryPrice + sellExchangeEntryPrice) * trade.volume / 2
    trade.costsPercent = (trade.costs.total / totalTradeValue) * 100
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
      const buyClient = this.restClients.get(trade.sellExchange)
      const sellClient = this.restClients.get(trade.buyExchange)

      if (!buyClient || !sellClient) {
        throw new Error('REST clients not available for exit')
      }

      // Place exit orders in parallel
      const [buyOrder, sellOrder] = await Promise.all([
        placeOrderAndMonitor(
          buyClient, 
          trade.pair, 
          'BUY', 
          trade.volume, 
          `${trade.id}_exit_buy`,
          trade.sellExchange,
          this.accountStateManager
        ),
        placeOrderAndMonitor(
          sellClient, 
          trade.pair, 
          'SELL', 
          trade.volume, 
          `${trade.id}_exit_sell`,
          trade.buyExchange,
          this.accountStateManager
        )
      ])

      // Create exit trade result
      const exitTradeResult: TradeResult = {
        id: `${trade.id}_exit`,
        success: true,
        buyOrder,
        sellOrder,
        executedVolume: trade.volume,
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
        pnl: trade.pnl,
        profit: trade.profit,
        costs: trade.costs,
        pnlPercent: trade.pnlPercent
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
    const buyFeeRate = this.getFeeRate(trade.sellExchange, 'taker')
    const sellFeeRate = this.getFeeRate(trade.buyExchange, 'taker')
    
    const buyFees = calculateFees(buyOrder, trade.sellExchange, buyFeeRate)
    const sellFees = calculateFees(sellOrder, trade.buyExchange, sellFeeRate)
    
    return buyFees + sellFees
  }

  /**
   * Calculate exit slippage for the exit trade
   */
  private calculateExitSlippage(buyOrder: OrderInfo, sellOrder: OrderInfo): number {
    const buySlippage = calculateSlippage(buyOrder, 'BUY')
    const sellSlippage = calculateSlippage(sellOrder, 'SELL')
    
    return buySlippage + sellSlippage
  }

  /**
   * Update PnL calculations with actual exit trade data
   */
  private updatePnLWithActualExit(trade: TrackedTrade, exitTrade: TradeResult): void {
    // Update costs with actual exit data
    trade.costs.exitFees = exitTrade.fees
    trade.costs.exitSlippage = exitTrade.slippage
    trade.costs.total = trade.costs.entryFees + trade.costs.entrySlippage + trade.costs.exitFees + trade.costs.exitSlippage

    // Calculate profit with actual exit prices
    const buyExchangeEntryPrice = trade.entryTrade.buyOrder!.averagePrice
    const sellExchangeEntryPrice = trade.entryTrade.sellOrder!.averagePrice
    const buyExchangeExitPrice = exitTrade.sellOrder!.averagePrice // Exit price for the buy leg
    const sellExchangeExitPrice = exitTrade.buyOrder!.averagePrice  // Exit price for the sell leg
    
    const buyLegProfit = (buyExchangeEntryPrice - buyExchangeExitPrice) * trade.volume
    const sellLegProfit = (sellExchangeEntryPrice - sellExchangeExitPrice) * trade.volume
    trade.profit = buyLegProfit - sellLegProfit

    // Calculate final PnL: Profit - Costs
    trade.pnl = trade.profit - trade.costs.total

    // Calculate percentages
    const totalTradeValue = (buyExchangeEntryPrice + sellExchangeEntryPrice) * trade.volume / 2
    trade.costsPercent = (trade.costs.total / totalTradeValue) * 100
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
   * Extract exchange name from order
   */
  private getExchangeFromOrder(order: OrderInfo): string {
    // This is a simplified implementation
    // In a real system, you'd have the exchange information in the order
    return 'unknown'
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
    totalCosts: number
    avgPnLPercent: number
    avgProfitPercent: number
    avgCostsPercent: number
  } {
    const trades = this.getTrackedTrades()
    const openTrades = trades.filter(t => t.status === 'open')
    const closedTrades = trades.filter(t => t.status === 'closed')
    const errorTrades = trades.filter(t => t.status === 'error')

    const totalPnL = trades.reduce((sum, trade) => sum + trade.pnl, 0)
    const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0)
    const totalCosts = trades.reduce((sum, trade) => sum + trade.costs.total, 0)
    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0
    const avgPnLPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.pnlPercent, 0) / trades.length : 0
    const avgProfitPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.profitPercent, 0) / trades.length : 0
    const avgCostsPercent = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.costsPercent, 0) / trades.length : 0

    return {
      totalTrades: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      errorTrades: errorTrades.length,
      totalPnL,
      avgPnL,
      totalProfit,
      totalCosts,
      avgPnLPercent,
      avgProfitPercent,
      avgCostsPercent
    }
  }
} 