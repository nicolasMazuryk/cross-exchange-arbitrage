import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { Logger } from '../../utils/logger'
import { getPositionSide, positionId, getMarketTypeFromUnifiedSymbol } from '../../utils/utils'
import appConfig from '../../utils/config'
import { FundingHistory } from 'ccxt'

const EXCHANGE_NAME = 'bybit'
const CCXT_EXCHANGE_NAME = 'bybit'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class BybitExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  paramsForMarket(marketType: MarketType, _ctx?: { symbol?: string; quote?: string }): Record<string, any> {
    if (marketType === MarketType.SPOT) return { category: 'spot' }
    if (marketType === MarketType.INVERSE_PERP) return { category: 'inverse' }
    if (marketType === MarketType.LINEAR_PERP) return { category: 'linear' }
    throw new Error(`unsupported market type: ${marketType}`)
  }

  protected getExchangeFundingFeeHistoryParams(symbol: string): any {
    const mt = getMarketTypeFromUnifiedSymbol(symbol)
    return { subType: mt === MarketType.INVERSE_PERP ? 'inverse' : 'linear' }
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const account = balances.info?.result?.list?.[0]
      if (account) {
        const coins: any[] = account.coin || []
        for (const coinEntry of coins) {
          const total = parseFloat(coinEntry.walletBalance || '0')
          const available = parseFloat(coinEntry.availableToWithdraw || coinEntry.availableBalance || '0')
          if (total > 0) balanceInfos.push({ asset: coinEntry.coin, total, available })
        }
      }


      logger.debug({
        msg: 'Fetched balance entries from exchange',
        function: 'BybitExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length,
      })
      return balanceInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'BybitExchange.fetchBalancesSnapshot',
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
        const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp } = position
        positionInfos.push({
          id: positionId(symbol, side!.toUpperCase() as PositionSide),
          symbol: symbol,
          side: side!.toUpperCase() as PositionSide,
          size: Math.abs(position.contracts! * position.contractSize!),
          entryPrice: entryPrice!,
          leverage: Number(leverage) || 1,
          unrealizedPnL: unrealizedPnl!,
          timestamp: timestamp!,
          date: new Date(timestamp!),
          marketType: getMarketTypeFromUnifiedSymbol(symbol),
        })
      }

      logger.debug({
        msg: 'Fetched position entries from exchange',
        function: 'BybitExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'BybitExchange.fetchPositionsSnapshot',
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
          id: order.id!,
          clientOrderId: order.clientOrderId!,
          exchange: EXCHANGE_NAME,
          symbol: order.symbol!,
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: getPositionSide(order.side!.toUpperCase() as OrderSide, order.reduceOnly!),
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status!),
          timestamp: order.timestamp,
          date: new Date(order.timestamp),
        })
      }

      logger.debug({
        msg: 'Fetched order entries from exchange',
        function: 'BybitExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'BybitExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(bybitStatus: string): OrderStatus {
    switch (bybitStatus.toUpperCase()) {
      // case 'NEW':
      // case 'UNTRIGGERED':
      //   return 'NEW'
      // case 'PARTIALLYFILLED':
      //   return 'PARTIALLY_FILLED'
      // case 'FILLED':
      //   return 'FILLED'
      // case 'CANCELLED':
      // case 'PARTIALLYFILLEDCANCELLED':
      // case 'DEACTIVATED':
      //   return 'CANCELED'
      // case 'REJECTED':
      //   return 'FAILED'
      // default:
      //   return 'UNKNOWN'

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
      const ex = this.exchange as any

      const fetchAllInstruments = async (category: string): Promise<any[]> => {
        const items: any[] = []
        let cursor = ''
        do {
          const resp = await ex.publicGetV5MarketInstrumentsInfo({ category, limit: 1000, ...(cursor ? { cursor } : {}) })
          items.push(...(resp?.result?.list ?? []))
          cursor = resp?.result?.nextPageCursor ?? ''
        } while (cursor)
        return items
      }

      const [linearRates, inverseRates, linearInstr, inverseInstr] = await Promise.all([
        this.exchange.fetchFundingRates(undefined, { subType: 'linear' }),
        this.exchange.fetchFundingRates(undefined, { subType: 'inverse' }),
        fetchAllInstruments('linear'),
        fetchAllInstruments('inverse'),
      ])

      // Build live interval map: native symbol → hours. fundingInterval from API is in minutes.
      const liveIntervals = new Map<string, number>()
      for (const item of [...linearInstr, ...inverseInstr]) {
        const mins = parseInt(item.fundingInterval)
        if (item.symbol && !isNaN(mins) && mins > 0) liveIntervals.set(item.symbol, Math.round(mins / 60))
      }

      const ignoredFunding = appConfig.exchanges.bybit.ignoredFundingSymbols ?? []
      const allRates = { ...linearRates, ...inverseRates }
      const fundingData = new Map<string, ParsedFunding>()

      for (const [symbol, rate] of Object.entries(allRates)) {
        if (ignoredFunding.includes(symbol)) continue
        const r = rate as any
        if (typeof r.fundingRate !== 'number' || isNaN(r.fundingRate) || !r.fundingTimestamp) {
          logger.warn({
            msg: 'Skipping symbol with invalid funding data',
            function: 'BybitExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            fundingRate: r.fundingRate,
            fundingTimestamp: r.fundingTimestamp,
          })
          continue
        }

        const nativeSymbol: string = r.info?.symbol
        const fundingInterval = nativeSymbol ? liveIntervals.get(nativeSymbol) : undefined
        if (fundingInterval === undefined) {
          logger.warn({
            msg: 'No interval data for symbol, skipping',
            function: 'BybitExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
          })
          continue
        }

        fundingData.set(symbol, {
          exchange: EXCHANGE_NAME,
          symbol,
          fundingRate: r.fundingRate,
          fundingRatePercent: r.fundingRate * 100,
          fundingInterval,
          nextFundingTimestamp: r.fundingTimestamp,
          nextFundingDatetime: new Date(r.fundingDatetime ?? r.fundingTimestamp),
        })
      }

      logger.debug({
        msg: 'Parsed funding rates from exchange',
        function: 'BybitExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'BybitExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      return new Map()
    }
  }

  protected parseExchangeSpecificFundingFeeHistoryResponse(response: FundingHistory[]): FundingHistory[] {
    return response.map((entry: FundingHistory) => {
      return {
        ...entry,
        amount: parseFloat(entry.info.execFeeV2),
      }
    })
  }
}
