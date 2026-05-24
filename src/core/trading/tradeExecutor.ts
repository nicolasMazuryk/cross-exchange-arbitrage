import { EventEmitter } from 'events'
import { AccountStateManager } from '../state/accountStateManager'
import { RestClientInterface } from '../../adapters/rest/types'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ArbitrageOpportunity } from '../arbitrage/arbitrageEngine'
import { OrderInfo } from '../../types/account'
import { OrderbookManager } from '../orderbook/orderbookManager'
import { placeOrderAndMonitor, calculateSlippage, calculateFees } from './utils'
import { Logger } from '../../utils/logger'
import config, { getFees } from '../../utils/config'
import { MarketType } from '../../types/exchange'
import { State } from '../state/stateService'

const logger = new Logger('trade-executor')

// Generate UUID for trade IDs
function generateTradeId(): string {
  return `T${Date.now().toString().slice(-10)}${Math.random().toString(36).substr(2, 6)}`
}

function getRequiredBalanceCurrency(normalizedPair: string, marketType: MarketType, isBuyLeg: boolean): string {
  const parts = normalizedPair.split(':')
  const [base, quote] = parts[0].split('/')
  const settle = parts[1] || quote
  switch (marketType) {
    case MarketType.SPOT:
      return isBuyLeg ? quote : base
    case MarketType.LINEAR_PERP:
      return settle
    case MarketType.INVERSE_PERP:
      return base
    default:
      return settle
  }
}

// Core interfaces
export interface TradeParams {
  opportunity: ArbitrageOpportunity
  timestamp: number
}

export interface TradeResult {
  id: string
  success: boolean
  latencyMs: number
  buyOrder: OrderInfo | null
  sellOrder: OrderInfo | null
  feesUsd: number
  feesPercent: number
  slippageUsd: number
  slippagePercent: number
}

export interface TradeValidationResult {
  isValid: boolean
  availableBalance: number
  requiredBalance: number
}

export class TradeExecutor extends EventEmitter {
  private readonly accountStateManager: AccountStateManager
  private readonly restClients: Map<string, RestClientInterface>
  private readonly orderbookManager: OrderbookManager
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly stateService: State
  private readonly processingPairs: Set<string> = new Set()

  constructor(
    accountStateManager: AccountStateManager,
    restClients: Map<string, RestClientInterface>,
    orderbookManager: OrderbookManager,
    marketMetadataServices: Map<string, MarketMetadataService>,
    stateService: State
  ) {
    super()
    this.accountStateManager = accountStateManager
    this.restClients = restClients
    this.orderbookManager = orderbookManager
    this.marketMetadataServices = marketMetadataServices
    this.stateService = stateService
    logger.info({ msg: 'TradeExecutor initialized' })
  }

  /**
   * Execute a paired arbitrage trade across two exchanges
   */
  async executeTrade(tradeParams: TradeParams): Promise<TradeResult | null> {
    const { opportunity } = tradeParams
    const tradeId = generateTradeId()

    // Check if pair is already being processed
    if (this.isPairProcessing(opportunity.normalizedPair)) {
      logger.debug({
        msg: 'Skipping trade - pair already being processed',
        function: 'TradeExecutor.executeTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
      })
      return null
    }

    this.processingPairs.add(opportunity.normalizedPair)

    try {
      // Pre-trade validation
      const validation = await this.validateTrade(tradeId, tradeParams)
      if (!validation.isValid) {
        return null
      }

      logger.debug({ msg: 'Starting trade execution', function: 'TradeExecutor.executeTrade', tradeId, opportunity })

      // Execute the trade pair
      const entryTradeResult = await this.executeTradePair(tradeId, tradeParams)

      if (!entryTradeResult) {
        return null
      }

      entryTradeResult.latencyMs = Date.now() - opportunity.orderbookUpdateTimestamp

      return entryTradeResult
    } catch (error) {
      logger.error({
        msg: 'Trade execution failed',
        function: 'TradeExecutor.executeTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        error,
      })

      return null
    } finally {
      // Always release the pair lock
      this.processingPairs.delete(opportunity.normalizedPair)
    }
  }

  /**
   * Validate trade parameters and account state
   */
  private async validateTrade(tradeId: string, tradeParams: TradeParams): Promise<TradeValidationResult> {
    const { opportunity } = tradeParams
    let hasErrors = false

    // Validate account state freshness
    // if (!this.accountStateManager.isExchangeStateFresh(tradeParams.buyExchange)) {
    //   logger.warn({
    //     msg: 'Account state is stale',
    //     function: 'TradeExecutor.validateTrade',
    //     tradeId,
    //     normalizedPair: opportunity.normalizedPair,
    //     exchange: tradeParams.buyExchange,
    //   })
    //   hasErrors = true
    // }
    // if (!this.accountStateManager.isExchangeStateFresh(tradeParams.sellExchange)) {
    //   logger.warn({
    //     msg: 'Account state is stale',
    //     function: 'TradeExecutor.validateTrade',
    //     tradeId,
    //     normalizedPair: opportunity.normalizedPair,
    //     exchange: tradeParams.sellExchange,
    //   })
    //   hasErrors = true
    // }

    const requiredBalance = opportunity.orderAmountUsd * (1 + config.trading.minBalanceBufferPercent / 100)

    const buyBalanceCurrency = getRequiredBalanceCurrency(opportunity.normalizedPair, opportunity.buyMarketType, true)
    const sellBalanceCurrency = getRequiredBalanceCurrency(opportunity.normalizedPair, opportunity.sellMarketType, false)
    const buyExchangeBalance = this.accountStateManager.getAvailableBalance(opportunity.buyExchange, buyBalanceCurrency)
    const sellExchangeBalance = this.accountStateManager.getAvailableBalance(opportunity.sellExchange, sellBalanceCurrency)

    if (buyExchangeBalance < requiredBalance) {
      logger.warn({
        msg: 'Insufficient balance',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.buyExchange,
        availableBalance: buyExchangeBalance,
        requiredBalance,
      })
      hasErrors = true
    }
    if (sellExchangeBalance < requiredBalance) {
      logger.warn({
        msg: 'Insufficient balance',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.sellExchange,
        availableBalance: sellExchangeBalance,
        requiredBalance,
      })
      hasErrors = true
    }

    // Check for active orders for the same symbol
    const buyExchangeOrders = this.accountStateManager.getActiveOrders(opportunity.buyExchange)
    const sellExchangeOrders = this.accountStateManager.getActiveOrders(opportunity.sellExchange)

    const activeBuyOrders = buyExchangeOrders.filter(o => o.symbol === opportunity.buyExchangeSymbol)
    const activeSellOrders = sellExchangeOrders.filter(o => o.symbol === opportunity.sellExchangeSymbol)

    if (activeBuyOrders.length > 0) {
      logger.warn({
        msg: 'Active orders found',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.buyExchange,
        symbol: opportunity.buyExchangeSymbol,
        activeOrdersCount: activeBuyOrders.length,
      })
      hasErrors = true
    }
    if (activeSellOrders.length > 0) {
      logger.warn({
        msg: 'Active orders found',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.sellExchange,
        symbol: opportunity.sellExchangeSymbol,
        activeOrdersCount: activeSellOrders.length,
      })
      hasErrors = true
    }

    // Check for opposite-direction positions — only applicable for perp legs (spot has no positions)
    if (opportunity.buyMarketType !== MarketType.SPOT) {
      const buyExchangeOppositePosition = this.accountStateManager.getPosition(
        opportunity.buyExchange,
        opportunity.buyExchangeSymbol,
        'SHORT'
      )
      if (buyExchangeOppositePosition) {
        logger.warn({
          msg: 'Opposite direction position (SHORT) exists on BUY exchange - cannot open new (LONG) position',
          function: 'TradeExecutor.validateTrade',
          tradeId,
          normalizedPair: opportunity.normalizedPair,
          exchange: opportunity.buyExchange,
          symbol: opportunity.buyExchangeSymbol,
          existingPositionSide: 'SHORT',
          newPositionSide: 'LONG',
          existingPositionSize: buyExchangeOppositePosition.size,
        })
        hasErrors = true
      }
    }

    if (opportunity.sellMarketType !== MarketType.SPOT) {
      const sellExchangeOppositePosition = this.accountStateManager.getPosition(
        opportunity.sellExchange,
        opportunity.sellExchangeSymbol,
        'LONG'
      )
      if (sellExchangeOppositePosition) {
        logger.warn({
          msg: 'Opposite direction position (LONG) exists on SELL exchange - cannot open new (SHORT) position',
          function: 'TradeExecutor.validateTrade',
          tradeId,
          normalizedPair: opportunity.normalizedPair,
          exchange: opportunity.sellExchange,
          symbol: opportunity.sellExchangeSymbol,
          existingPositionSide: 'LONG',
          newPositionSide: 'SHORT',
          existingPositionSize: sellExchangeOppositePosition.size,
        })
        hasErrors = true
      }
    }

    // Max position size check — aggregate open trade exposure per (exchange, symbol) leg
    const openTrades = await this.stateService.getAllTrackedTrades()
    const openBuyUsd = openTrades
      .filter(t => t.status === 'open' && t.opportunity.buyExchange === opportunity.buyExchange && t.opportunity.buyExchangeSymbol === opportunity.buyExchangeSymbol)
      .reduce((sum, t) => sum + t.opportunity.orderAmountUsd, 0)
    if (openBuyUsd + opportunity.orderAmountUsd > config.trading.maxPositionAmountUsd) {
      logger.warn({
        msg: 'Max position USD limit would be exceeded',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.buyExchange,
        symbol: opportunity.buyExchangeSymbol,
        existingExposureUsd: openBuyUsd,
        newTradeUsd: opportunity.orderAmountUsd,
        maxPositionAmountUsd: config.trading.maxPositionAmountUsd,
      })
      hasErrors = true
    }

    const openSellUsd = openTrades
      .filter(t => t.status === 'open' && t.opportunity.sellExchange === opportunity.sellExchange && t.opportunity.sellExchangeSymbol === opportunity.sellExchangeSymbol)
      .reduce((sum, t) => sum + t.opportunity.orderAmountUsd, 0)
    if (openSellUsd + opportunity.orderAmountUsd > config.trading.maxPositionAmountUsd) {
      logger.warn({
        msg: 'Max position USD limit would be exceeded',
        function: 'TradeExecutor.validateTrade',
        tradeId,
        normalizedPair: opportunity.normalizedPair,
        exchange: opportunity.sellExchange,
        symbol: opportunity.sellExchangeSymbol,
        existingExposureUsd: openSellUsd,
        newTradeUsd: opportunity.orderAmountUsd,
        maxPositionAmountUsd: config.trading.maxPositionAmountUsd,
      })
      hasErrors = true
    }

    return {
      isValid: !hasErrors,
      availableBalance: Math.min(buyExchangeBalance, sellExchangeBalance),
      requiredBalance,
    }
  }

  /**
   * Get current orderbook prices for a trade
   */
  private getCurrentOrderbookPrices(opportunity: ArbitrageOpportunity): { buyPrice: number; sellPrice: number } {
    try {
      const buyTopOfBook = this.orderbookManager.getTopOfBook(opportunity.buyExchange, opportunity.buyExchangeSymbol)
      const sellTopOfBook = this.orderbookManager.getTopOfBook(opportunity.sellExchange, opportunity.sellExchangeSymbol)

      if (!buyTopOfBook || !sellTopOfBook) {
        throw new Error(
          `No orderbook data available for ${opportunity.normalizedPair} on ${opportunity.buyExchange} or ${opportunity.sellExchange}`
        )
      }

      // For BUY orders, use ask price (we're buying from the ask side)
      // For SELL orders, use bid price (we're selling to the bid side)
      return {
        buyPrice: buyTopOfBook.bestAsk.price,
        sellPrice: sellTopOfBook.bestBid.price,
      }
    } catch (error) {
      logger.error({
        msg: 'Failed to get current orderbook prices',
        function: 'TradeExecutor.getCurrentOrderbookPrices',
        normalizedPair: opportunity.normalizedPair,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        error,
      })
      throw error
    }
  }

  /**
   * Execute the actual trade pair with parallel order placement
   */
  private async executeTradePair(tradeId: string, tradeParams: TradeParams): Promise<TradeResult | null> {
    const { opportunity } = tradeParams
    const buyClient = this.restClients.get(opportunity.buyExchange)
    const sellClient = this.restClients.get(opportunity.sellExchange)

    if (!buyClient || !sellClient) {
      throw new Error(`REST clients for ${opportunity.buyExchange} or ${opportunity.sellExchange} not available`)
    }

    const buyMetadataService = this.marketMetadataServices.get(opportunity.buyExchange)
    const sellMetadataService = this.marketMetadataServices.get(opportunity.sellExchange)

    if (!buyMetadataService || !sellMetadataService) {
      throw new Error(
        `Market metadata services for ${opportunity.buyExchange} or ${opportunity.sellExchange} not available`
      )
    }

    const buyPrice = buyMetadataService.denormalizePrice(
      opportunity.avgBuyNormalizedExecutionPrice,
      opportunity.buyExchangeSymbol
    )
    const sellPrice = sellMetadataService.denormalizePrice(
      opportunity.avgSellNormalizedExecutionPrice,
      opportunity.sellExchangeSymbol
    )

    // Get current orderbook prices
    // const currentPrices = this.getCurrentOrderbookPrices(opportunity)

    // Generate unique client order IDs
    const buyClientOrderId = `${tradeId}BUY`
    const sellClientOrderId = `${tradeId}SELL`

    logger.debug({
      msg: 'Placing orders in parallel',
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
          this.accountStateManager,
          opportunity.orderbookUpdateTimestamp
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
          this.accountStateManager,
          opportunity.orderbookUpdateTimestamp
        ),
      ])

      // Calculate fees and slippage
      const buyFeeRatePercent = this.getTradingFeeRatePercent(opportunity.buyExchange, 'taker', opportunity.buyMarketType)
      const sellFeeRatePercent = this.getTradingFeeRatePercent(opportunity.sellExchange, 'taker', opportunity.sellMarketType)

      const buyFees = calculateFees(buyOrder, buyFeeRatePercent)
      const sellFees = calculateFees(sellOrder, sellFeeRatePercent)
      const buySlippage = calculateSlippage(buyOrder, buyOrder.orderSide)
      const sellSlippage = calculateSlippage(sellOrder, sellOrder.orderSide)

      // Store per-order fees
      buyOrder.feesUsd = buyFees.feesUsd
      sellOrder.feesUsd = sellFees.feesUsd

      buyOrder.slippagePercent = buySlippage.slippagePercent
      sellOrder.slippagePercent = sellSlippage.slippagePercent

      return {
        id: tradeId,
        success: true,
        latencyMs: 0, // Will be set by caller
        buyOrder,
        sellOrder,
        feesUsd: buyFees.feesUsd + sellFees.feesUsd,
        feesPercent: buyFees.feesPercent + sellFees.feesPercent,
        slippageUsd: buySlippage.slippageUsd + sellSlippage.slippageUsd,
        slippagePercent: buySlippage.slippagePercent + sellSlippage.slippagePercent,
      }
    } catch (error) {
      logger.error({
        msg: 'Trade pair execution failed',
        function: 'TradeExecutor.executeTradePair',
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
        error,
      })
      // Rollback logic: cancel any successful orders and handle filled legs
      await this.rollbackFailedTrade(tradeId, tradeParams, buyClient, sellClient)

      return null
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
    logger.warn({
      msg: 'Rolling back failed trade',
      function: 'TradeExecutor.rollbackFailedTrade',
      tradeId,
      normalizedPair: opportunity.normalizedPair,
      opportunity,
    })

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
          logger.info({
            msg: 'Buy leg was filled, closing position',
            function: 'TradeExecutor.rollbackFailedTrade',
            tradeId,
            buyOrderId: buyOrder.id,
            exchange: opportunity.buyExchange,
            symbol: opportunity.buyExchangeSymbol,
            volume: opportunity.buyExchangeVolume,
          })
          const closeBuyPrice = this.orderbookManager.getTopOfBook(
            opportunity.buyExchange,
            opportunity.buyExchangeSymbol
          )?.bestBid.price
          closePromises.push(
            buyClient
              .createOrder(
                opportunity.buyExchangeSymbol,
                'MARKET',
                'SELL',
                opportunity.buyExchangeVolume,
                closeBuyPrice,
                opportunity.buyMarketType !== MarketType.SPOT,
                `${buyOrder.clientOrderId}CLOSE`
              )
              .then(() => {
                logger.info({
                  msg: 'Closed buy position',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume,
                })
              })
              .catch(error => {
                logger.error({
                  msg: 'Failed to close buy position',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume,
                  error,
                })
              })
          )
        } else if (buyOrder.status === 'NEW' || buyOrder.status === 'PARTIALLY_FILLED') {
          // Cancel unfilled buy order
          cancelPromises.push(
            buyClient
              .cancelOrder(buyOrder.id, buyOrder.symbol)
              .then(() => {
                logger.info({
                  msg: 'Canceled buy order',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume,
                })
              })
              .catch(error => {
                logger.error({
                  msg: 'Failed to cancel buy order',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  buyOrderId: buyOrder.id,
                  exchange: opportunity.buyExchange,
                  symbol: opportunity.buyExchangeSymbol,
                  volume: opportunity.buyExchangeVolume,
                  error,
                })
              })
          )
        }
      }

      // Handle sell leg
      if (sellOrder) {
        if (sellOrder.status === 'FILLED') {
          // Sell leg was filled, need to close the position
          logger.info({
            msg: 'Sell leg was filled, closing position',
            function: 'TradeExecutor.rollbackFailedTrade',
            tradeId,
            sellOrderId: sellOrder.id,
            exchange: opportunity.sellExchange,
            symbol: opportunity.sellExchangeSymbol,
            volume: opportunity.sellExchangeVolume,
          })
          const closeSellPrice = this.orderbookManager.getTopOfBook(
            opportunity.sellExchange,
            opportunity.sellExchangeSymbol
          )?.bestAsk.price
          closePromises.push(
            sellClient
              .createOrder(
                opportunity.sellExchangeSymbol,
                'MARKET',
                'BUY',
                opportunity.sellExchangeVolume,
                closeSellPrice,
                opportunity.sellMarketType !== MarketType.SPOT,
                `${sellOrder.clientOrderId}CLOSE`
              )
              .then(() => {
                logger.info({
                  msg: 'Closed sell position',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume,
                })
              })
              .catch(error => {
                logger.error({
                  msg: 'Failed to close sell position',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume,
                  error,
                })
              })
          )
        } else if (sellOrder.status === 'NEW' || sellOrder.status === 'PARTIALLY_FILLED') {
          // Cancel unfilled sell order
          cancelPromises.push(
            sellClient
              .cancelOrder(sellOrder.id, sellOrder.symbol)
              .then(() => {
                logger.info({
                  msg: 'Canceled sell order',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume,
                })
              })
              .catch(error => {
                logger.error({
                  msg: 'Failed to cancel sell order',
                  function: 'TradeExecutor.rollbackFailedTrade',
                  tradeId,
                  sellOrderId: sellOrder.id,
                  exchange: opportunity.sellExchange,
                  symbol: opportunity.sellExchangeSymbol,
                  volume: opportunity.sellExchangeVolume,
                  error,
                })
              })
          )
        }
      }

      // Execute all rollback operations in parallel
      await Promise.allSettled([...cancelPromises, ...closePromises])

      logger.info({
        msg: 'Trade rollback completed',
        function: 'TradeExecutor.rollbackFailedTrade',
        tradeId,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        normalizedPair: opportunity.normalizedPair,
        buyOrderId: buyOrder?.id,
        sellOrderId: sellOrder?.id,
      })
    } catch (error) {
      logger.error({
        msg: 'Error during trade rollback',
        function: 'TradeExecutor.rollbackFailedTrade',
        tradeId,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
        normalizedPair: opportunity.normalizedPair,
        error,
      })
    }
  }

  private getTradingFeeRatePercent(exchangeId: string, feeType: 'maker' | 'taker', marketType: MarketType): number {
    return getFees(exchangeId, marketType)[feeType]
  }

  /**
   * Get trade execution statistics
   */
  getExecutionStats(): { totalTrades: number; successRate: number; avgLatency: number } {
    // TODO: Implement statistics tracking
    return {
      totalTrades: 0,
      successRate: 0,
      avgLatency: 0,
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
