import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { Logger } from '../../utils/logger'
import { getOrderSide, positionId, getMarketTypeFromUnifiedSymbol, quoteCurrenciesFor } from '../../utils/utils'

const EXCHANGE_NAME = 'bitget'
const CCXT_EXCHANGE_NAME = 'bitget'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export const BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE: Record<string, string> = {
  USDT: 'USDT-FUTURES',
  USDC: 'USDC-FUTURES',
}

export class BitgetExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  paramsForMarket(marketType: MarketType, ctx?: { symbol?: string; quote?: string }): Record<string, any> {
    if (marketType === MarketType.SPOT) return { productType: 'SPOT' }
    if (marketType === MarketType.INVERSE_PERP) return { productType: 'COIN-FUTURES', hedged: true }
    if (marketType === MarketType.LINEAR_PERP) {
      let quote = ctx?.quote
      if (!quote && ctx?.symbol) {
        try { quote = this.getMarketMetadataService().getQuoteFor(ctx.symbol) } catch (_) { /* metadata not yet initialised */ }
      }
      const productType = (quote && BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[quote]) ?? 'USDT-FUTURES'
      return { productType, hedged: true }
    }
    throw new Error(`unsupported market type: ${marketType}`)
  }

  protected getExchangeOrderParams(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    baseParams: ExchangeOrderParams = {}
  ): ExchangeOrderParams {
    return {
      ...baseParams,
      hedged: true, // Bitget requires hedged parameter
    }
  }

  protected getExchangeFundingFeeHistoryParams(symbol: string): any {
    const mt = getMarketTypeFromUnifiedSymbol(symbol)
    return { subType: mt === MarketType.INVERSE_PERP ? 'inverse' : 'linear' }
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const skipKeys = new Set(['info', 'free', 'used', 'total', 'datetime', 'timestamp'])
      for (const [asset, entry] of Object.entries(balances)) {
        if (skipKeys.has(asset)) continue
        const b = entry as any
        const total = b?.total ?? 0
        if (total > 0) balanceInfos.push({ asset, total, available: b?.free ?? 0 })
      }

      if (balanceInfos.length === 0) {
        logger.warn({
          msg: 'No balance entries returned by exchange',
          function: 'BitgetExchange.fetchBalancesSnapshot',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
      }

      logger.debug({
        msg: 'Fetched balance snapshot',
        function: 'BitgetExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length,
      })
      return balanceInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'BitgetExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
    try {
      const positions = await this.exchange.fetchPositions()
      const positionInfos: PositionInfo[] = []

      for (const position of positions) {
        const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp, contracts, contractSize } = position
        const size = Math.abs(contracts! * contractSize!)
        positionInfos.push({
          id: positionId(symbol, side!.toUpperCase() as PositionSide),
          symbol: symbol,
          side: side!.toUpperCase() as PositionSide,
          size: size,
          entryPrice: entryPrice!,
          leverage: Number(leverage) || 1,
          unrealizedPnL: unrealizedPnl!,
          timestamp: timestamp!,
          date: new Date(timestamp!),
          marketType: getMarketTypeFromUnifiedSymbol(symbol),
        })
      }

      logger.debug({
        msg: 'Fetched positions snapshot',
        function: 'BitgetExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'BitgetExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
      const orderInfos: OrderInfo[] = []

      for (const order of orders) {
        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          exchange: EXCHANGE_NAME,
          symbol: order.symbol || '',
          orderSide: getOrderSide(order.info.posSide, order.info.tradeSide),
          positionSide: order.info.posSide.toUpperCase() as PositionSide,
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status || ''),
          timestamp: order.timestamp,
          date: new Date(order.timestamp),
        })
      }

      logger.debug({
        msg: 'Fetched orders snapshot',
        function: 'BitgetExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'BitgetExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(bitgetStatus: string): OrderStatus {
    switch (bitgetStatus.toUpperCase()) {
      case 'OPEN':
        return 'NEW'
      case 'CLOSED':
        return 'FILLED'
      case 'CANCELED':
        return 'CANCELED'
      case 'REJECTED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }

  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      const quotes = quoteCurrenciesFor(EXCHANGE_NAME)
      const linearQuotes = quotes.filter(q => BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[q])

      const linearProductTypes = linearQuotes.map(q => BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[q])

      const [inverseResult, ...linearResults] = await Promise.allSettled([
        this.exchange.fetchFundingIntervals(undefined, { subType: 'inverse', productType: 'COIN-FUTURES' }),
        ...linearProductTypes.map(pt =>
          this.exchange.fetchFundingIntervals(undefined, { subType: 'linear', productType: pt })
        ),
      ])

      const allIntervals: Record<string, any> = {}
      if (inverseResult.status === 'fulfilled') {
        Object.assign(allIntervals, inverseResult.value)
      } else {
        logger.warn({
          msg: 'Failed to fetch inverse funding intervals',
          function: 'BitgetExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          error: inverseResult.reason,
        })
      }
      for (let i = 0; i < linearResults.length; i++) {
        const result = linearResults[i]
        if (result.status === 'fulfilled') {
          Object.assign(allIntervals, result.value)
        } else {
          logger.warn({
            msg: 'Failed to fetch linear funding intervals for product type',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            productType: linearProductTypes[i],
            error: result.reason,
          })
        }
      }

      const fundingData = new Map<string, ParsedFunding>()

      for (const [symbol, data] of Object.entries(allIntervals)) {
        const d = data as any
        const info = d.info ?? {}

        const rawFundingRate = typeof d.fundingRate === 'number' ? d.fundingRate : (info.fundingRate !== undefined ? parseFloat(info.fundingRate) : undefined)
        if (rawFundingRate === undefined || isNaN(rawFundingRate)) {
          logger.warn({
            msg: 'Skipping symbol: missing or invalid funding rate',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            fundingRate: info.fundingRate,
          })
          continue
        }

        const rawInterval = d.interval ?? info.fundingRateInterval
        if (!rawInterval) {
          logger.warn({
            msg: 'Skipping symbol: missing funding interval',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
          })
          continue
        }
        const fundingInterval = parseInt(rawInterval)
        if (isNaN(fundingInterval) || fundingInterval === 0) {
          logger.warn({
            msg: 'Skipping symbol: invalid funding interval',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            rawInterval,
          })
          continue
        }

        const rawNextUpdate = d.fundingTimestamp ?? (info.nextUpdate !== undefined ? parseInt(info.nextUpdate) : undefined)
        if (!rawNextUpdate) {
          logger.warn({
            msg: 'Skipping symbol: missing next funding timestamp',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            nextUpdate: info.nextUpdate,
          })
          continue
        }

        fundingData.set(symbol, {
          exchange: EXCHANGE_NAME,
          symbol,
          fundingRate: rawFundingRate,
          fundingRatePercent: rawFundingRate * 100,
          fundingInterval,
          nextFundingTimestamp: rawNextUpdate,
          nextFundingDatetime: new Date(rawNextUpdate),
        })
      }

      logger.debug({
        msg: 'Parsed funding rates',
        function: 'BitgetExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'BitgetExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      return new Map()
    }
  }
}
