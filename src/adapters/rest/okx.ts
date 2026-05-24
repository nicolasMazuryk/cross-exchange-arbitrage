import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getPositionSide, getMarketTypeFromUnifiedSymbol, quoteCurrenciesFor } from '../../utils/utils'

const EXCHANGE_NAME = 'okx'
const CCXT_EXCHANGE_NAME = 'okx'
const FUNDING_BASE_URL = 'https://www.okx.com/priapi/v5/public/funding-rate-all'

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

  /**
   * Fetch funding data from OKX
   * URL: https://www.okx.com/priapi/v5/public/funding-rate-all?ccyType=USDT
   * Response structure: {"code":"0","data":[{"fundingTime":1757548800000,"fundingList":[{"instId":"BTC-USDT-SWAP","fundingRate":"0.0001000000000000","fundingTime":"1757548800000","frequency":"8"}]}]}
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      const quotes = quoteCurrenciesFor(EXCHANGE_NAME)
      const metadata = this.getMarketMetadataService()

      // Fetch linear quotes + 'USD' for inverse perps (OKX coin-margined SWAPs use ccyType=USD)
      const ccyTypes = [...new Set([...quotes, 'USD'])]
      const rawResults = await Promise.all(
        ccyTypes.map(q => fetchJsonFromUrl(`${FUNDING_BASE_URL}?ccyType=${q}`))
      )

      const allFundingItems: any[] = []
      for (const rawJson of rawResults) {
        if (
          !rawJson ||
          !rawJson.data ||
          !Array.isArray(rawJson.data) ||
          !rawJson.data[0]?.fundingList ||
          !Array.isArray(rawJson.data[0].fundingList)
        ) {
          logger.warn({
            msg: 'Invalid or empty funding data structure from OKX endpoint',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            exchangeId: this.exchangeId,
          })
          continue
        }
        for (const item of rawJson.data[0].fundingList) {
          if (!item.instId || !item.instId.endsWith('-SWAP')) continue
          // Try LINEAR_PERP first, then INVERSE_PERP
          const meta =
            metadata.getMetadataByNativeId(item.instId, MarketType.LINEAR_PERP) ??
            metadata.getMetadataByNativeId(item.instId, MarketType.INVERSE_PERP)
          allFundingItems.push({
            ...item,
            symbol: meta?.symbol ?? (() => {
              const parts = item.instId.split('-')
              const base = parts[0]
              const quote = parts[1]
              // OKX inverse: BTC-USD-SWAP → BTC/USD:BTC
              const settle = quote === 'USD' ? base : quote
              return `${base}/${quote}:${settle}`
            })(),
          })
        }
      }

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of allFundingItems) {
        // OKX provides fundingTime in milliseconds
        const fundingRate = parseFloat(item.fundingRate)
        const fundingInterval = parseInt(item.frequency)
        const nextFundingTimestamp = parseInt(item.fundingTime)

        if (isNaN(fundingRate) || !fundingInterval || !nextFundingTimestamp) {
          logger.warn({
            msg: 'Invalid funding data values for symbol',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            exchangeId: this.exchangeId,
            symbol: item.symbol,
            fundingRate: item.fundingRate,
            fundingInterval: item.frequency,
            nextFundingTime: item.fundingTime,
          })
          continue
        }

        const parsedFunding: ParsedFunding = {
          exchange: EXCHANGE_NAME,
          symbol: item.symbol,
          fundingRate,
          fundingRatePercent: fundingRate * 100,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: new Date(nextFundingTimestamp),
        }

        fundingData.set(item.symbol, parsedFunding)
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
        endpoint: FUNDING_BASE_URL,
        error,
      })
      return new Map()
    }
  }
}
