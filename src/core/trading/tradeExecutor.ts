import { EventEmitter } from 'events'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { OrderInfo } from '../../types/account'
import { OrderbookManager } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import logger from '../../utils/logger'
import config from '../../utils/config'

// Generate UUID for trade IDs
function generateTradeId(): string {
  return `T${Date.now().toString().slice(-10)}${Math.random().toString(36).substr(2, 6)}`
}

// Core interfaces
export interface TradeParams {
  pair: string
  buyExchange: string
  sellExchange: string
  volume: number
  volumeUSDT: number
  expectedProfitPercent: number
  confidenceScore: number
  timestamp: number
}



export interface TradeResult {
  id: string
  success: boolean
  buyOrder: OrderInfo | null
  sellOrder: OrderInfo | null
  executedVolume: number
  fees: number
  slippage: number
  latencyMs: number
  errorDetails?: {
    stage: 'pre-check' | 'entry' | 'monitor' | 'exit'
    message: string
    exchange?: string
  }
}

export interface TradeValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
  availableBalance: number
  requiredBalance: number
}

export class TradeExecutor extends EventEmitter {
  private readonly accountStateManager: AccountStateManager
  private readonly restClients: Map<string, RestClientInterface>
  private readonly orderbookManager: OrderbookManager
  private readonly processingPairs: Set<string> = new Set() // Track pairs being processed

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
    logger.info('TradeExecutor initialized')
  }

  /**
   * Execute a paired arbitrage trade across two exchanges
   */
  async executeTrade(tradeParams: TradeParams): Promise<TradeResult> {
    const tradeId = generateTradeId()
    const startTime = Date.now()
    
    // Check if pair is already being processed
    if (this.processingPairs.has(tradeParams.pair)) {
      logger.warn(`[${tradeId}] Skipping trade - pair ${tradeParams.pair} already being processed`)
      return this.createErrorResult(tradeId, 'pre-check', `Pair ${tradeParams.pair} already being processed`)
    }

    // Lock the pair for processing
    this.processingPairs.add(tradeParams.pair)
    
    logger.info(`[${tradeId}] Starting trade execution`, {
      pair: tradeParams.pair,
      buyExchange: tradeParams.buyExchange,
      sellExchange: tradeParams.sellExchange,
      volume: tradeParams.volume,
      expectedProfit: tradeParams.expectedProfitPercent
    })

    try {
      // Pre-trade validation
      const validation = await this.validateTrade(tradeParams)
      if (!validation.isValid) {
        return this.createErrorResult(tradeId, 'pre-check', validation.errors.join('; '))
      }

      // Execute the trade pair
      const entryTradeResult = await this.executeTradePair(tradeId, tradeParams)
      
      const latencyMs = Date.now() - startTime
      entryTradeResult.latencyMs = latencyMs

      logger.info(`[${tradeId}] Trade execution completed`, {
        success: entryTradeResult.success,
        latencyMs,
        executedVolume: entryTradeResult.executedVolume
      })

      // Emit trade result event
      this.emit('tradeCompleted', entryTradeResult)
      
      return entryTradeResult

    } catch (error) {
      logger.error(`[${tradeId}] Trade execution failed`, {
        error: error instanceof Error ? error.message : String(error),
        params: tradeParams
      })

      return this.createErrorResult(tradeId, 'entry', error instanceof Error ? error.message : String(error))
    } finally {
      // Always release the pair lock
      this.processingPairs.delete(tradeParams.pair)
    }
  }

  /**
   * Validate trade parameters and account state
   */
  private async validateTrade(tradeParams: TradeParams): Promise<TradeValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []

    // Validate account state freshness
    // if (!this.accountStateManager.isExchangeStateFresh(tradeParams.buyExchange)) {
    //   errors.push(`Account state for ${tradeParams.buyExchange} is stale`)
    // }
    // if (!this.accountStateManager.isExchangeStateFresh(tradeParams.sellExchange)) {
    //   errors.push(`Account state for ${tradeParams.sellExchange} is stale`)
    // }

    // Calculate required USDT balance using volumeUSDT from opportunity
    // For arbitrage, we need USDT to buy on one exchange and sell on another
    const requiredBalance = tradeParams.volumeUSDT * (1 + config.trading.minBalanceBuffer)
    
    const buyExchangeBalance = this.accountStateManager.getAvailableBalance(tradeParams.buyExchange, 'USDT')
    const sellExchangeBalance = this.accountStateManager.getAvailableBalance(tradeParams.sellExchange, 'USDT')

    if (buyExchangeBalance < requiredBalance) {
      errors.push(`Insufficient balance on ${tradeParams.buyExchange}: ${buyExchangeBalance} < ${requiredBalance}`)
    }
    if (sellExchangeBalance < requiredBalance) {
      errors.push(`Insufficient balance on ${tradeParams.sellExchange}: ${sellExchangeBalance} < ${requiredBalance}`)
    }

    // Check for conflicting orders
    const buyExchangeOrders = this.accountStateManager.getActiveOrders(tradeParams.buyExchange)
    const sellExchangeOrders = this.accountStateManager.getActiveOrders(tradeParams.sellExchange)
    
    const conflictingBuyOrders = buyExchangeOrders.filter(o => o.symbol === tradeParams.pair)
    const conflictingSellOrders = sellExchangeOrders.filter(o => o.symbol === tradeParams.pair)
    
    if (conflictingBuyOrders.length > 0) {
      warnings.push(`Active orders found on ${tradeParams.buyExchange} for ${tradeParams.pair}`)
    }
    if (conflictingSellOrders.length > 0) {
      warnings.push(`Active orders found on ${tradeParams.sellExchange} for ${tradeParams.pair}`)
    }

    // Check position limits using config value
    const buyPosition = this.accountStateManager.getPosition(tradeParams.buyExchange, tradeParams.pair)
    const sellPosition = this.accountStateManager.getPosition(tradeParams.sellExchange, tradeParams.pair)
    
    if (buyPosition && Math.abs(buyPosition.size * buyPosition.entryPrice) > config.trading.orderAmount * config.trading.positionLimitMultiplier) {
      warnings.push(`Large position detected on ${tradeParams.buyExchange}: ${buyPosition.size}`)
    }
    if (sellPosition && Math.abs(sellPosition.size * sellPosition.entryPrice) > config.trading.orderAmount * config.trading.positionLimitMultiplier) {
      warnings.push(`Large position detected on ${tradeParams.sellExchange}: ${sellPosition.size}`)
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      availableBalance: Math.min(buyExchangeBalance, sellExchangeBalance),
      requiredBalance
    }
  }

  /**
   * Get current orderbook prices for a trade
   */
  private getCurrentOrderbookPrices(pair: string, buyExchange: string, sellExchange: string): { buyPrice: number, sellPrice: number } {
    const buyTopOfBook = this.orderbookManager.getTopOfBook(buyExchange, pair)
    const sellTopOfBook = this.orderbookManager.getTopOfBook(sellExchange, pair)
    
    if (!buyTopOfBook || !sellTopOfBook) {
      throw new Error(`No orderbook data available for ${pair} on ${buyExchange} or ${sellExchange}`)
    }
    
    // For BUY orders, use ask price (we're buying from the ask side)
    // For SELL orders, use bid price (we're selling to the bid side)
    return {
      buyPrice: buyTopOfBook.bestAsk.price,
      sellPrice: sellTopOfBook.bestBid.price
    }
  }

  /**
   * Execute the actual trade pair with parallel order placement
   */
  private async executeTradePair(tradeId: string, tradeParams: TradeParams): Promise<TradeResult> {
    const buyClient = this.restClients.get(tradeParams.buyExchange)
    const sellClient = this.restClients.get(tradeParams.sellExchange)
    
    if (!buyClient || !sellClient) {
      throw new Error('REST clients not available')
    }

    // Get current orderbook prices
    const currentPrices = this.getCurrentOrderbookPrices(tradeParams.pair, tradeParams.buyExchange, tradeParams.sellExchange)

    // Generate unique client order IDs
    const buyClientOrderId = `${tradeId}BUY`
    const sellClientOrderId = `${tradeId}SELL`

    logger.debug(`[${tradeId}] Placing orders in parallel`, {
      buyExchange: tradeParams.buyExchange,
      sellExchange: tradeParams.sellExchange,
      pair: tradeParams.pair,
      volume: tradeParams.volume,
      buyPrice: currentPrices.buyPrice,
      sellPrice: currentPrices.sellPrice
    })

    try {
      // Place orders in parallel
      const [buyOrder, sellOrder] = await Promise.all([
        placeOrderAndMonitor(
          buyClient, 
          tradeParams.pair, 
          'BUY', 
          tradeParams.volume, 
          currentPrices.buyPrice,
          false,
          buyClientOrderId, 
          tradeParams.buyExchange,
          this.accountStateManager
        ),
        placeOrderAndMonitor(
          sellClient, 
          tradeParams.pair, 
          'SELL', 
          tradeParams.volume, 
          currentPrices.sellPrice,
          false,
          sellClientOrderId, 
          tradeParams.sellExchange,
          this.accountStateManager
        )
      ])

      // Calculate fees and slippage
      const buyFeeRate = this.getFeeRate(tradeParams.buyExchange, 'taker')
      const sellFeeRate = this.getFeeRate(tradeParams.sellExchange, 'taker')
      
      const buyFees = calculateFees(buyOrder, buyFeeRate)
      const sellFees = calculateFees(sellOrder, sellFeeRate)
      const buySlippage = calculateSlippage(buyOrder, buyOrder.orderSide)
      const sellSlippage = calculateSlippage(sellOrder, sellOrder.orderSide)

      return {
        id: tradeId,
        success: true,
        buyOrder,
        sellOrder,
        executedVolume: buyOrder.quantity,
        fees: buyFees + sellFees,
        slippage: buySlippage + sellSlippage,
        latencyMs: 0 // Will be set by caller
      }

    } catch (error) {
      // Rollback logic: cancel any successful orders and handle filled legs
      await this.rollbackFailedTrade(tradeId, tradeParams, buyClient, sellClient)
      throw error
    }
  }

  /**
   * Enhanced rollback logic for failed trades
   */
  private async rollbackFailedTrade(
    tradeId: string,
    tradeParams: TradeParams,
    buyClient: RestClientInterface,
    sellClient: RestClientInterface
  ): Promise<void> {
    logger.warn(`[${tradeId}] Rolling back failed trade`, { pair: tradeParams.pair })

    // Check which legs were filled
    const buyOrder = this.accountStateManager.getOrderByClientOrderId(tradeParams.buyExchange, `${tradeId}BUY`)
    const sellOrder = this.accountStateManager.getOrderByClientOrderId(tradeParams.sellExchange, `${tradeId}SELL`)

    const cancelPromises: Promise<void>[] = []
    const closePromises: Promise<void>[] = []

    // Handle buy leg
    if (buyOrder) {
      if (buyOrder.status === 'FILLED') {
        // Buy leg was filled, need to close the position
        logger.info(`[${tradeId}] Buy leg was filled, closing position`)
        const closeBuyPrice = this.orderbookManager.getTopOfBook(tradeParams.buyExchange, tradeParams.pair)?.bestBid.price
        if (closeBuyPrice) {
          closePromises.push(
            buyClient.createOrder(tradeParams.pair, 'MARKET', 'SELL', buyOrder.quantity, closeBuyPrice, true, `${buyOrder.clientOrderId}CLOSE`)
              .then(() => {
                logger.info(`[${tradeId}] Closed buy position`)
              })
              .catch(error => {
                logger.error(`[${tradeId}] Failed to close buy position`, { error })
              })
          )
        }
      } else if (buyOrder.status === 'NEW' || buyOrder.status === 'PARTIALLY_FILLED') {
        // Cancel unfilled buy order
        cancelPromises.push(
          buyClient.cancelOrder(buyOrder.id, buyOrder.symbol)
            .then(() => {
              logger.info(`[${tradeId}] Canceled buy order ${buyOrder.id}`)
            })
            .catch(error => {
              logger.error(`[${tradeId}] Failed to cancel buy order ${buyOrder.id}`, { error })
            })
        )
      }
    }

    // Handle sell leg
    if (sellOrder) {
      if (sellOrder.status === 'FILLED') {
        // Sell leg was filled, need to close the position
        logger.info(`[${tradeId}] Sell leg was filled, closing position`)
        const closeSellPrice = this.orderbookManager.getTopOfBook(tradeParams.sellExchange, tradeParams.pair)?.bestAsk.price
        if (closeSellPrice) {
          closePromises.push(
            sellClient.createOrder(tradeParams.pair, 'MARKET', 'BUY', sellOrder.quantity, closeSellPrice, true, `${sellOrder.clientOrderId}CLOSE`)
              .then(() => {
                logger.info(`[${tradeId}] Closed sell position`)
              })
              .catch(error => {
                logger.error(`[${tradeId}] Failed to close sell position`, { error })
              })
          )
        }
      } else if (sellOrder.status === 'NEW' || sellOrder.status === 'PARTIALLY_FILLED') {
        // Cancel unfilled sell order
        cancelPromises.push(
          sellClient.cancelOrder(sellOrder.id, sellOrder.symbol)
            .then(() => {
              logger.info(`[${tradeId}] Canceled sell order ${sellOrder.id}`)
            })
            .catch(error => {
              logger.error(`[${tradeId}] Failed to cancel sell order ${sellOrder.id}`, { error })
            })
        )
      }
    }

    // Execute all rollback operations in parallel
    await Promise.allSettled([...cancelPromises, ...closePromises])
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
   * Create error result
   */
  private createErrorResult(tradeId: string, stage: 'pre-check' | 'entry' | 'monitor' | 'exit', message: string): TradeResult {
    return {
      id: tradeId,
      success: false,
      buyOrder: null,
      sellOrder: null,
      executedVolume: 0,
      fees: 0,
      slippage: 0,
      latencyMs: 0,
      errorDetails: {
        stage,
        message
      }
    }
  }

  /**
   * Get trade execution statistics
   */
  getExecutionStats(): { totalTrades: number, successRate: number, avgLatency: number } {
    // TODO: Implement statistics tracking
    return {
      totalTrades: 0,
      successRate: 0,
      avgLatency: 0
    }
  }

  /**
   * Check if a pair is currently being processed
   */
  isPairProcessing(pair: string): boolean {
    return this.processingPairs.has(pair)
  }

  /**
   * Get all currently processing pairs
   */
  getProcessingPairs(): string[] {
    return Array.from(this.processingPairs)
  }
} 