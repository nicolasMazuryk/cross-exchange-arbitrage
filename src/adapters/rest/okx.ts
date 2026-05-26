import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { Logger } from '../../utils/logger'
import { getPositionSide, getMarketTypeFromUnifiedSymbol } from '../../utils/utils'

const EXCHANGE_NAME = 'okx'
const CCXT_EXCHANGE_NAME = 'okx'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class OkxExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  paramsForMarket(marketType: MarketType, _ctx?: { symbol?: string; quote?: string }): Record<string, any> {
    if (marketType === MarketType.SPOT) return { instType: 'SPOT' }
    if (marketType === MarketType.LINEAR_PERP) return { instType: 'SWAP' }
    if (marketType === MarketType.INVERSE_PERP) return { instType: 'SWAP', instFamily: 'inverse' }
    throw new Error(`OKX:paramsForMarket: Unsupported market type: ${marketType}`)
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
      positionSide: getPositionSide(side as OrderSide, baseParams.reduceOnly!).toLowerCase(),
    }
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
          function: 'OkxExchange.fetchBalancesSnapshot',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
      }

      logger.debug({
        msg: 'Fetched balance snapshot',
        function: 'OkxExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length,
      })
      return balanceInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'OkxExchange.fetchBalancesSnapshot',
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
        positionInfos.push({
          id: position.id!,
          symbol: position.symbol,
          side: position.side!.toUpperCase() as PositionSide,
          size: Math.abs(position.contracts! * position.contractSize!),
          entryPrice: position.entryPrice || 0,
          leverage: position.leverage || 1,
          unrealizedPnL: position.unrealizedPnl || 0,
          timestamp: position.timestamp || 0,
          date: new Date(position.timestamp || 0),
          marketType: getMarketTypeFromUnifiedSymbol(position.symbol),
        })
      }

      logger.debug({
        msg: 'Fetched positions snapshot',
        function: 'OkxExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'OkxExchange.fetchPositionsSnapshot',
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
        const contractSize = this.getTradingMarkets()[order.symbol]?.contractSize || 1
        const size = order.amount * contractSize

        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          exchange: EXCHANGE_NAME,
          symbol: order.symbol || '',
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: order.info.posSide!.toUpperCase() as PositionSide,
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: size,
          status: this.normalizeOrderStatus(order.status!),
          timestamp: order.timestamp,
          date: new Date(order.timestamp),
        })
      }

      logger.debug({
        msg: 'Fetched orders snapshot',
        function: 'OkxExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'OkxExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(okxStatus: string): OrderStatus {
    switch (okxStatus.toUpperCase()) {
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
      const allRates = await this.exchange.fetchFundingRates(undefined)
      const fundingData = new Map<string, ParsedFunding>()

      for (const [symbol, rate] of Object.entries(allRates)) {
        const r = rate as any
        if (typeof r.fundingRate !== 'number' || isNaN(r.fundingRate) || !r.nextFundingTimestamp) {
          logger.warn({
            msg: 'Invalid or empty funding data structure. Skipping symbol',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            fundingRate: r.fundingRate,
            nextFundingTimestamp: r.nextFundingTimestamp,
          })
          continue
        }

        if (!r.interval) {
          logger.warn({
            msg: 'No interval data for symbol, skipping',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
          })
          continue
        }
        const fundingInterval = parseInt(r.interval)
        if (isNaN(fundingInterval)) {
          logger.warn({
            msg: 'Invalid funding interval for symbol, skipping',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            interval: r.interval,
          })
          continue
        }

        fundingData.set(symbol, {
          exchange: EXCHANGE_NAME,
          symbol,
          fundingRate: r.fundingRate,
          fundingRatePercent: r.fundingRate * 100,
          fundingInterval,
          nextFundingTimestamp: r.nextFundingTimestamp,
          nextFundingDatetime: new Date(r.nextFundingDatetime ?? r.nextFundingTimestamp),
        })
      }

      logger.debug({
        msg: 'Parsed funding rates',
        function: 'OkxExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'OkxExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      return new Map()
    }
  }
}
