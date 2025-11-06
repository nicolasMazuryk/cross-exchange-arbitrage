import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getPositionSide, positionId } from '../../utils/utils'

const EXCHANGE_NAME = 'bybit'
const CCXT_EXCHANGE_NAME = 'bybit'
const FUNDING_ENDPOINT = 'https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=LinearPerpetual'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class BybitExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  // Note: Bybit doesn't require exchange-specific parameters for order creation
  // The base implementation will be used

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    // TODO: review response structure and normalize it for all assets
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const { totalAvailableBalance, totalEquity } = balances.info.result.list[0]

      balanceInfos.push({
        asset: 'USDT',
        total: parseFloat(totalEquity),
        available: parseFloat(totalAvailableBalance)
      })

      logger.debug({ msg: 'Fetched balance entries from exchange', function: 'BybitExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length })
      return balanceInfos
    } catch (error) {
      logger.error({ msg: 'Failed to fetch balance snapshot from exchange', function: 'BybitExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error, })
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
          date: new Date(timestamp!)
          // liquidationPrice: liqPrice,
          // notional: notional,
        })
      }

      logger.debug({ msg: 'Fetched position entries from exchange', function: 'BybitExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length })
      return positionInfos
    } catch (error) {
      logger.error({ msg: 'Failed to fetch positions snapshot from exchange', function: 'BybitExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error, })
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
          date: new Date(order.timestamp)
        })
      }

      logger.debug({ msg: 'Fetched order entries from exchange', function: 'BybitExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length })
      return orderInfos
    } catch (error) {
      logger.error({ msg: 'Failed to fetch orders snapshot from exchange', function: 'BybitExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error, })
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

  /**
   * Fetch funding data from Bybit
   * URL: https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=LinearPerpetual
   * Response structure: {"ret_code":0,"ret_msg":"success","result":{"list":[{"symbol":2219,"contractType":"LinearPerpetual","symbolName":"XDCUSDT","fundingRateInterval":"4","nextFundingTimeE0":"1757534400","interestRate":"0.0003","predictedFundingRate":"0.005"}]}}
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      if (!FUNDING_ENDPOINT) {
        logger.error({ msg: 'No funding endpoint configured', function: 'BybitExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId })
        return new Map()
      }

      const rawJson = await fetchJsonFromUrl(FUNDING_ENDPOINT)

      if (!rawJson || !rawJson.result || !rawJson.result.list || !Array.isArray(rawJson.result.list)) {
        logger.error({ msg: 'Invalid funding data structure received from exchange', function: 'BybitExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId, })
        return new Map()
      }

      // Filter symbols to only ones that end with 'USDT'
      const usdtSymbolsFundingData = rawJson.result.list
        .filter((item: any) =>
          item.symbolName && item.symbolName.endsWith('USDT'))
        .map((item: any) => ({
          ...item,
          symbol: item.symbolName.replace('USDT', '/USDT:USDT')
        }))
        .filter((item: any) => !['USDCUSDT', 'ETHBTCUSDT'].includes(item.symbolName))

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of usdtSymbolsFundingData) {
        // Bybit provides nextFundingTimeE0 in seconds, convert to milliseconds
        const fundingRate = parseFloat(item.predictedFundingRate)
        const fundingInterval = parseInt(item.fundingRateInterval)
        const nextFundingTimestamp = parseInt(item.nextFundingTimeE0) * 1000

        if (isNaN(fundingRate) || !fundingInterval || !nextFundingTimestamp) {
          // logger.warn({ msg: 'Invalid funding data values for symbol', function: 'BybitExchange.fetchFundingData',
          //   exchange: EXCHANGE_NAME,
          //   exchangeId: this.exchangeId,
          //   symbol: item.symbol,
          //   fundingRate: item.predictedFundingRate,
          //   fundingInterval: item.fundingRateInterval,
          //   nextFundingTime: item.nextFundingTimeE0 })
          continue
        }

        const parsedFunding: ParsedFunding = {
          exchange: EXCHANGE_NAME,
          symbol: item.symbol,
          fundingRate: fundingRate / 100,
          fundingRatePercent: fundingRate,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: new Date(nextFundingTimestamp)
        }

        fundingData.set(item.symbol, parsedFunding)
      }

      logger.debug({ msg: 'Parsed funding rates from exchange', function: 'BybitExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size })
      return fundingData
    } catch (error) {
      logger.error({ msg: 'Failed to fetch funding data from exchange', function: 'BybitExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        endpoint: FUNDING_ENDPOINT,
        error, })
      return new Map()
    }
  }
}
