import { EventEmitter } from 'events'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'
import { OrderInfo } from '../../types/account'
import { OrderbookManager } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import config from '../../utils/config'

const logger = new Logger('trade-executor')

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
  feesUsd: number
  feesPercent: number
  slippageUsd: number
  slippagePercent: number
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
    logger.info({ msg: 'TradeExecutor initialized' })
  }

  /**
   * Execute a paired arbitrage trade across two exchanges
   */
  async executeTrade(tradeParams: TradeParams): Promise<TradeResult> {
    const { opportunity } = tradeParams
    const tradeId = generateTradeId()
    const startTime = Date.now()

    // Check if pair is already being processed
    if (this.isPairProcessing(opportunity.normalizedPair)) {
      logger.debug({ msg: 'Skipping trade - pair already being processed', function: 'TradeExecutor.executeTrade',
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange
        })
      return this.createErrorResult(opportunity, tradeId, 'pre-check', `Pair ${opportunity.normalizedPair} is already being processed`)
    }

    this.processingPairs.add(opportunity.normalizedPair)

    try {
      // Pre-trade validation
      const validation = await this.validateTrade(tradeParams)
      if (!validation.isValid) {
        return this.createErrorResult(opportunity, tradeId, 'pre-check', [...validation.errors, ...validation.warnings].join('; '))
      }

      logger.debug({ msg: 'Starting trade execution', function: 'TradeExecutor.executeTrade',
        tradeId,
        opportunity })

      // Execute the trade pair
      const entryTradeResult = await this.executeTradePair(tradeId, tradeParams)
      
      const latencyMs = Date.now() - startTime
      entryTradeResult.latencyMs = latencyMs

      return entryTradeResult
    } catch (error) {
      logger.error({
        msg: 'Trade execution failed',
        function: 'TradeExecutor.executeTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        error
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

    // Calculate required USDT balance using orderAmountUsd from opportunity
    // For arbitrage, we need USDT to buy on one exchange and sell on another
    const requiredBalance = opportunity.orderAmountUsd * (1 + config.trading.minBalanceBufferPercent / 100)
    
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

    // Calculate what the position would be AFTER executing this trade
    const buyPosition = this.accountStateManager.getPosition(opportunity.buyExchange, opportunity.buyExchangeSymbol, 'LONG')
    let buyPositionAfterTradeUsd: number
    if (buyPosition) {
      // Existing LONG position - add new trade volume
      const existingPositionUsd = Math.abs(buyPosition.size) * buyPosition.entryPrice
      buyPositionAfterTradeUsd = existingPositionUsd + opportunity.orderAmountUsd
    } else {
      // No existing position - this trade creates a new LONG position
      buyPositionAfterTradeUsd = opportunity.orderAmountUsd
    }
    
    const sellPosition = this.accountStateManager.getPosition(opportunity.sellExchange, opportunity.sellExchangeSymbol, 'SHORT')
    let sellPositionAfterTradeUsd: number
    if (sellPosition) {
      // Existing SHORT position - add new trade volume (size is absolute value)
      const existingPositionUsd = Math.abs(sellPosition.size) * sellPosition.entryPrice
      sellPositionAfterTradeUsd = existingPositionUsd + opportunity.orderAmountUsd
    } else {
      // No existing position - this trade creates a new SHORT position
      sellPositionAfterTradeUsd = opportunity.orderAmountUsd
    }

    if (buyPositionAfterTradeUsd > config.trading.maxPositionAmountUsd) {
      errors.push(`Max position USD limit would be exceeded on ${opportunity.buyExchange}: position after trade ${buyPositionAfterTradeUsd.toFixed(2)} USD > max position limit ${config.trading.maxPositionAmountUsd.toFixed(2)} USD, new trade USD: ${opportunity.orderAmountUsd.toFixed(2)}`)
    }
    if (sellPositionAfterTradeUsd > config.trading.maxPositionAmountUsd) {
      errors.push(`Max position USD limit would be exceeded on ${opportunity.sellExchange}: position after trade ${sellPositionAfterTradeUsd.toFixed(2)} USD > max position limit ${config.trading.maxPositionAmountUsd.toFixed(2)} USD, new trade USD: ${opportunity.orderAmountUsd.toFixed(2)}`)
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
    try {
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
    } catch (error) {
      logger.error({ msg: 'Failed to get current orderbook prices', function: 'TradeExecutor.getCurrentOrderbookPrices',
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        error })
      throw error
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

    logger.debug({ msg: 'Placing orders in parallel', tradeId,
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      normalizedPair: opportunity.normalizedPair,
      orderAmountUsd: opportunity.orderAmountUsd,
      normalizedVolume: opportunity.normalizedVolume,
      buyExchangeVolume: opportunity.buyExchangeVolume,
      sellExchangeVolume: opportunity.sellExchangeVolume,
      buyPrice,
      sellPrice })

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
      const buyFeeRatePercent = this.getTradingFeeRatePercent(opportunity.buyExchange, 'taker')
      const sellFeeRatePercent = this.getTradingFeeRatePercent(opportunity.sellExchange, 'taker')
      
      const buyFees = calculateFees(buyOrder, buyFeeRatePercent)
      const sellFees = calculateFees(sellOrder, sellFeeRatePercent)
      const buySlippage = calculateSlippage(buyOrder, buyOrder.orderSide)
      const sellSlippage = calculateSlippage(sellOrder, sellOrder.orderSide)

      return {
        id: tradeId,
        opportunity,
        buyOrder,
        sellOrder,
        success: true,
        latencyMs: 0, // Will be set by caller
        feesUsd: buyFees.feesUsd + sellFees.feesUsd,
        feesPercent: buyFees.feesPercent + sellFees.feesPercent,
        slippageUsd: buySlippage.slippageUsd + sellSlippage.slippageUsd,
        slippagePercent: buySlippage.slippagePercent + sellSlippage.slippagePercent,
      }

    } catch (error) {
      logger.error({ msg: 'Error executing trade pair', function: 'TradeExecutor.executeTradePair',
        tradeId,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        normalizedPair: opportunity.normalizedPair,
        orderAmountUsd: opportunity.orderAmountUsd,
        normalizedVolume: opportunity.normalizedVolume,
        buyExchangeVolume: opportunity.buyExchangeVolume,
        sellExchangeVolume: opportunity.sellExchangeVolume,
        buyPrice,
        sellPrice,
        error })
      // Rollback logic: cancel any successful orders and handle filled legs
      await this.rollbackFailedTrade(tradeId, tradeParams, buyClient, sellClient)
      
      return this.createErrorResult(opportunity, tradeId, 'entry', error instanceof Error ? error.message : String(error))
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
    logger.warn({ msg: 'Rolling back failed trade', function: 'TradeExecutor.rollbackFailedTrade',
      tradeId,
      normalizedPair: opportunity.normalizedPair,
      opportunity })

    try {
      // Check which legs were filled
      const buyOrder = this.accountStateManager.getOrderByClientOrderId(opportunity.buyExchange, `${tradeId}BUY`)
      const sellOrder = this.accountStateManager.getOrderByClientOrderId(opportunity.sellExchange, `${tradeId}SELL`)

      const cancelPromises: Promise<void>[] = []
      const closePromises: Promise<void>[] = []

      // Handle buy leg
      if (buyOrder) {
        if (buyOrder.status === 'FILLED') {
          // Buy leg was filled, need to close the position
          logger.info({ msg: 'Buy leg was filled, closing position', function: 'TradeExecutor.rollbackFailedTrade',
            tradeId,
            buyOrderId: buyOrder.id,
            exchange: opportunity.buyExchange,
            symbol: opportunity.buyExchangeSymbol,
            volume: opportunity.buyExchangeVolume, })
          const closeBuyPrice = this.orderbookManager.getTopOfBook(opportunity.buyExchange, opportunity.buyExchangeSymbol)?.bestBid.price
            closePromises.push(
              buyClient.createOrder(opportunity.buyExchangeSymbol, 'MARKET', 'SELL', opportunity.buyExchangeVolume, closeBuyPrice, true, `${buyOrder.clientOrderId}CLOSE`)
                .then(() => {
                  logger.info({ msg: 'Closed buy position', function: 'TradeExecutor.rollbackFailedTrade',
                    tradeId,
                    buyOrderId: buyOrder.id,
                    exchange: opportunity.buyExchange,
                    symbol: opportunity.buyExchangeSymbol,
                    volume: opportunity.buyExchangeVolume, })
                })
                .catch(error => {
                  logger.error({ msg: 'Failed to close buy position', function: 'TradeExecutor.rollbackFailedTrade',
                    tradeId,
                    buyOrderId: buyOrder.id,
                    exchange: opportunity.buyExchange,
                    symbol: opportunity.buyExchangeSymbol,
                    volume: opportunity.buyExchangeVolume,
                    error })
                })
            )
        } else if (buyOrder.status === 'NEW' || buyOrder.status === 'PARTIALLY_FILLED') {
          // Cancel unfilled buy order
          cancelPromises.push(
            buyClient.cancelOrder(buyOrder.id, buyOrder.symbol)
              .then(() => {
                logger.info({ msg: 'Canceled buy order', function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume, })
              })
              .catch(error => {
                logger.error({ msg: 'Failed to cancel buy order', function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume,
                  error })
              })
          )
        }
      }

      // Handle sell leg
      if (sellOrder) {
        if (sellOrder.status === 'FILLED') {
          // Sell leg was filled, need to close the position
          logger.info({ msg: 'Sell leg was filled, closing position', function: 'TradeExecutor.rollbackFailedTrade',
            tradeId,
            sellOrderId: sellOrder.id,
            exchange: opportunity.sellExchange,
            symbol: opportunity.sellExchangeSymbol,
            volume: opportunity.sellExchangeVolume, })
          const closeSellPrice = this.orderbookManager.getTopOfBook(opportunity.sellExchange, opportunity.sellExchangeSymbol)?.bestAsk.price
            closePromises.push(
              sellClient.createOrder(opportunity.sellExchangeSymbol, 'MARKET', 'BUY', opportunity.sellExchangeVolume, closeSellPrice, true, `${sellOrder.clientOrderId}CLOSE`)
                .then(() => {
                  logger.info({ msg: 'Closed sell position', function: 'TradeExecutor.rollbackFailedTrade',
                    tradeId,
                    sellOrderId: sellOrder.id,
                    exchange: opportunity.sellExchange,
                    symbol: opportunity.sellExchangeSymbol,
                    volume: opportunity.sellExchangeVolume, })
                })
                .catch(error => {
                  logger.error({ msg: 'Failed to close sell position', function: 'TradeExecutor.rollbackFailedTrade',
                    tradeId,
                    sellOrderId: sellOrder.id,
                    exchange: opportunity.sellExchange,
                    symbol: opportunity.sellExchangeSymbol,
                    volume: opportunity.sellExchangeVolume,
                    error })
                })
            )
        } else if (sellOrder.status === 'NEW' || sellOrder.status === 'PARTIALLY_FILLED') {
          // Cancel unfilled sell order
          cancelPromises.push(
            sellClient.cancelOrder(sellOrder.id, sellOrder.symbol)
              .then(() => {
                logger.info({ msg: 'Canceled sell order', function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume, })
              })
              .catch(error => {
                logger.error({ msg: 'Failed to cancel sell order', function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume,
                  error })
              })
          )
        }
      }

      // Execute all rollback operations in parallel
      await Promise.allSettled([...cancelPromises, ...closePromises])

      logger.info({ msg: 'Trade rollback completed', function: 'TradeExecutor.rollbackFailedTrade',
        tradeId,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        normalizedPair: opportunity.normalizedPair,
        buyOrderId: buyOrder?.id,
        sellOrderId: sellOrder?.id, })
    } catch (error) {
      logger.error({ msg: 'Error during trade rollback', function: 'TradeExecutor.rollbackFailedTrade',
        tradeId,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        normalizedPair: opportunity.normalizedPair,
        error })
    }
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
   * Create error result
   */
  private createErrorResult(opportunity: ArbitrageOpportunity, tradeId: string, stage: 'pre-check' | 'entry' | 'monitor' | 'exit', message: string): TradeResult {
    return {
      id: tradeId,
      opportunity,
      success: false,
      buyOrder: null,
      sellOrder: null,
      feesUsd: 0,
      feesPercent: 0,
      slippageUsd: 0,
      slippagePercent: 0,
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