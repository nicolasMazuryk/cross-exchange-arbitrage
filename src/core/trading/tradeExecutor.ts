import { EventEmitter } from 'events'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'
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
  opportunity: ArbitrageOpportunity
  timestamp: number
}



export interface TradeResult {
  id: string
  opportunity: ArbitrageOpportunity
  success: boolean
  buyOrder: OrderInfo | null
  sellOrder: OrderInfo | null
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
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly processingPairs: Set<string> = new Set() // Track pairs being processed

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager,
    marketMetadataServices: Map<string, MarketMetadataService>
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
    this.marketMetadataServices = marketMetadataServices
    logger.info('TradeExecutor initialized')
  }

  /**
   * Execute a paired arbitrage trade across two exchanges
   */
  async executeTrade(tradeParams: TradeParams): Promise<TradeResult> {
    const { opportunity } = tradeParams
    const tradeId = generateTradeId()
    const startTime = Date.now()

    // Lock the pair for processing
    this.processingPairs.add(opportunity.normalizedPair)

    try {
      // Pre-trade validation
      const validation = await this.validateTrade(tradeParams)
      if (!validation.isValid) {
        return this.createErrorResult(opportunity, tradeId, 'pre-check', [...validation.errors, ...validation.warnings].join('; '))
      }

      // logger.info(`💰 [${tradeId}] Starting trade execution`, { opportunity })

      // Execute the trade pair
      const entryTradeResult = await this.executeTradePair(tradeId, tradeParams)
      
      const latencyMs = Date.now() - startTime
      entryTradeResult.latencyMs = latencyMs

      // Emit trade result event
      this.emit('tradeCompleted', entryTradeResult)
      
      return entryTradeResult

    } catch (error) {
      logger.error(`[${tradeId}] Trade execution failed`, {
        error: error instanceof Error ? error.message : String(error),
        params: tradeParams
      })

      return this.createErrorResult(opportunity, tradeId, 'entry', error instanceof Error ? error.message : String(error))
    } finally {
      // Always release the pair lock
      this.processingPairs.delete(opportunity.normalizedPair)
    }
  }

  /**
   * Validate trade parameters and account state
   */
  private async validateTrade(tradeParams: TradeParams): Promise<TradeValidationResult> {
    const { opportunity } = tradeParams
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
    const requiredBalance = opportunity.volumeUSDT * (1 + config.trading.minBalanceBuffer)
    
    const buyExchangeBalance = this.accountStateManager.getAvailableBalance(opportunity.buyExchange, 'USDT')
    const sellExchangeBalance = this.accountStateManager.getAvailableBalance(opportunity.sellExchange, 'USDT')

    if (buyExchangeBalance < requiredBalance) {
      errors.push(`Insufficient balance on ${opportunity.buyExchange}: ${buyExchangeBalance} < ${requiredBalance}`)
    }
    if (sellExchangeBalance < requiredBalance) {
      errors.push(`Insufficient balance on ${opportunity.sellExchange}: ${sellExchangeBalance} < ${requiredBalance}`)
    }

    // Check for conflicting orders
    const buyExchangeOrders = this.accountStateManager.getActiveOrders(opportunity.buyExchange)
    const sellExchangeOrders = this.accountStateManager.getActiveOrders(opportunity.sellExchange)

    const conflictingBuyOrders = buyExchangeOrders.filter(o => o.symbol === opportunity.buyExchangeSymbol)
    const conflictingSellOrders = sellExchangeOrders.filter(o => o.symbol === opportunity.sellExchangeSymbol)
    
    if (conflictingBuyOrders.length > 0) {
      warnings.push(`Active orders found on ${opportunity.buyExchange} for ${opportunity.buyExchangeSymbol}`)
    }
    if (conflictingSellOrders.length > 0) {
      warnings.push(`Active orders found on ${opportunity.sellExchange} for ${opportunity.sellExchangeSymbol}`)
    }

    // Check position limits using config value
    const buyPosition = this.accountStateManager.getPosition(opportunity.buyExchange, opportunity.buyExchangeSymbol, 'LONG')
    const sellPosition = this.accountStateManager.getPosition(opportunity.sellExchange, opportunity.sellExchangeSymbol, 'SHORT')

    if (buyPosition && Math.abs(buyPosition.size * buyPosition.entryPrice) > config.trading.orderAmount * config.trading.positionLimitMultiplier) {
      warnings.push(`Large position detected on ${opportunity.buyExchange}: ${buyPosition.size}`)
    }
    if (sellPosition && Math.abs(sellPosition.size * sellPosition.entryPrice) > config.trading.orderAmount * config.trading.positionLimitMultiplier) {
      warnings.push(`Large position detected on ${opportunity.sellExchange}: ${sellPosition.size}`)
    }

    return {
      isValid: errors.length === 0 && warnings.length === 0,
      errors,
      warnings,
      availableBalance: Math.min(buyExchangeBalance, sellExchangeBalance),
      requiredBalance
    }
  }

  /**
   * Get current orderbook prices for a trade
   */
  private getCurrentOrderbookPrices(opportunity: ArbitrageOpportunity): { buyPrice: number, sellPrice: number } {
    const buyTopOfBook = this.orderbookManager.getTopOfBook(opportunity.buyExchange, opportunity.buyExchangeSymbol)
    const sellTopOfBook = this.orderbookManager.getTopOfBook(opportunity.sellExchange, opportunity.sellExchangeSymbol)
    
    if (!buyTopOfBook || !sellTopOfBook) {
      throw new Error(`No orderbook data available for ${opportunity.normalizedPair} on ${opportunity.buyExchange} or ${opportunity.sellExchange}`)
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
    const { opportunity } = tradeParams
    const buyClient = this.restClients.get(opportunity.buyExchange)
    const sellClient = this.restClients.get(opportunity.sellExchange)
    
    if (!buyClient || !sellClient) {
      throw new Error(`REST clients for ${opportunity.buyExchange} or ${opportunity.sellExchange} not available`)
    }
    
    const buyMetadataService = this.marketMetadataServices.get(opportunity.buyExchange)
    const sellMetadataService = this.marketMetadataServices.get(opportunity.sellExchange)
    
    if (!buyMetadataService || !sellMetadataService) {
      throw new Error(`Market metadata services for ${opportunity.buyExchange} or ${opportunity.sellExchange} not available`)
    }

    const buyPrice = buyMetadataService.denormalizePrice(opportunity.avgBuyNormalizedExecutionPrice, opportunity.buyExchangeSymbol)
    const sellPrice = sellMetadataService.denormalizePrice(opportunity.avgSellNormalizedExecutionPrice, opportunity.sellExchangeSymbol)

    // Get current orderbook prices
    // const currentPrices = this.getCurrentOrderbookPrices(opportunity)

    // Generate unique client order IDs
    const buyClientOrderId = `${tradeId}BUY`
    const sellClientOrderId = `${tradeId}SELL`

    logger.debug(`[${tradeId}] Placing orders in parallel`, {
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      normalizedPair: opportunity.normalizedPair,
      volumeUSDT: opportunity.volumeUSDT,
      normalizedVolume: opportunity.normalizedVolume,
      buyExchangeVolume: opportunity.buyExchangeVolume,
      sellExchangeVolume: opportunity.sellExchangeVolume,
      buyPrice,
      sellPrice
    })

    try {
      // Place orders in parallel
      const [buyOrder, sellOrder] = await Promise.all([
        placeOrderAndMonitor(
          buyClient, 
          opportunity.buyExchangeSymbol, 
          'BUY', 
          opportunity.buyExchangeVolume, 
          buyPrice,
          false,
          buyClientOrderId, 
          opportunity.buyExchange,
          this.accountStateManager
        ),
        placeOrderAndMonitor(
          sellClient, 
          opportunity.sellExchangeSymbol, 
          'SELL', 
          opportunity.sellExchangeVolume, 
          sellPrice,  
          false,
          sellClientOrderId, 
          opportunity.sellExchange,
          this.accountStateManager
        )
      ])

      // Calculate fees and slippage
      const buyFeeRate = this.getFeeRate(opportunity.buyExchange, 'taker')
      const sellFeeRate = this.getFeeRate(opportunity.sellExchange, 'taker')
      
      const buyFees = calculateFees(buyOrder, buyFeeRate)
      const sellFees = calculateFees(sellOrder, sellFeeRate)
      const buySlippage = calculateSlippage(buyOrder, buyOrder.orderSide)
      const sellSlippage = calculateSlippage(sellOrder, sellOrder.orderSide)

      return {
        id: tradeId,
        opportunity,
        buyOrder,
        sellOrder,
        success: true,
        fees: buyFees + sellFees,
        slippage: buySlippage + sellSlippage,
        latencyMs: 0, // Will be set by caller
      }

    } catch (error) {
      // Rollback logic: cancel any successful orders and handle filled legs
      await this.rollbackFailedTrade(tradeId, tradeParams, buyClient, sellClient)
      throw error

      // return this.createErrorResult(opportunity, tradeId, 'entry', error instanceof Error ? error.message : String(error))
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
    const { opportunity } = tradeParams
    logger.warn(`[${tradeId}] Rolling back failed trade`, { normalizedPair: opportunity.normalizedPair })

    // Check which legs were filled
    const buyOrder = this.accountStateManager.getOrderByClientOrderId(opportunity.buyExchange, `${tradeId}BUY`)
    const sellOrder = this.accountStateManager.getOrderByClientOrderId(opportunity.sellExchange, `${tradeId}SELL`)

    const cancelPromises: Promise<void>[] = []
    const closePromises: Promise<void>[] = []

    // Handle buy leg
    if (buyOrder) {
      if (buyOrder.status === 'FILLED') {
        // Buy leg was filled, need to close the position
        logger.info(`[${tradeId}] Buy leg was filled, closing position`)
        const closeBuyPrice = this.orderbookManager.getTopOfBook(opportunity.buyExchange, opportunity.buyExchangeSymbol)?.bestBid.price
          closePromises.push(
            buyClient.createOrder(opportunity.buyExchangeSymbol, 'MARKET', 'SELL', opportunity.buyExchangeVolume, closeBuyPrice, true, `${buyOrder.clientOrderId}CLOSE`)
              .then(() => {
                logger.info(`[${tradeId}] Closed buy position`)
              })
              .catch(error => {
                logger.error(`[${tradeId}] Failed to close buy position`, { error })
              })
          )
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
        const closeSellPrice = this.orderbookManager.getTopOfBook(opportunity.sellExchange, opportunity.sellExchangeSymbol)?.bestAsk.price
          closePromises.push(
            sellClient.createOrder(opportunity.sellExchangeSymbol, 'MARKET', 'BUY', opportunity.sellExchangeVolume, closeSellPrice, true, `${sellOrder.clientOrderId}CLOSE`)
              .then(() => {
                logger.info(`[${tradeId}] Closed sell position`)
              })
              .catch(error => {
                logger.error(`[${tradeId}] Failed to close sell position`, { error })
              })
          )
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
  private createErrorResult(opportunity: ArbitrageOpportunity, tradeId: string, stage: 'pre-check' | 'entry' | 'monitor' | 'exit', message: string): TradeResult {
    return {
      id: tradeId,
      opportunity,
      success: false,
      buyOrder: null,
      sellOrder: null,
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