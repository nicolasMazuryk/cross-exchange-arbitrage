import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getPositionSide, positionId } from '../../utils/utils'

const EXCHANGE_NAME = 'binance'
const CCXT_EXCHANGE_NAME = 'binanceusdm'
const FUNDING_ENDPOINT = 'https://www.binance.com/bapi/futures/v1/public/future/common/get-funding-info'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class BinanceExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  // Note: Binance doesn't require exchange-specific parameters for order creation
  // The base implementation will be used

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []
      const { availableBalance, totalWalletBalance } = balances.info
      balanceInfos.push({
        asset: 'USDT',
        total: parseFloat(totalWalletBalance),
        available: parseFloat(availableBalance),
      })
      logger.debug({
        msg: 'Fetched balance entries from exchange',
        function: 'BinanceExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length,
      })
      return balanceInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'BinanceExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
    // TODO: review response structure and normalize it once NEW Binance account is created
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
          // liquidationPrice: liqPrice,
          // notional: notional,
        })
      }
      logger.debug({
        msg: 'Fetched positions snapshot',
        function: 'BinanceExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'BinanceExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    // TODO: review response structure and normalize it once NEW Binance account is created
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
      const orderInfos: OrderInfo[] = []
      for (const order of orders) {
        orderInfos.push({
          id: String(order.id!),
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
        function: 'BinanceExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'BinanceExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
    // TODO: review response structure and normalize it once NEW Binance account is created
    switch (binanceStatus.toUpperCase()) {
      case 'OPEN':
        return 'NEW'
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELED'
      case 'REJECTED':
      case 'EXPIRED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }

  /**
   * Fetch funding data from Binance by combining browser data (funding interval) with ccxt data (funding rate and datetime)
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      if (!FUNDING_ENDPOINT) {
        logger.error({
          msg: 'No funding endpoint configured',
          function: 'BinanceExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      const [rawJson, ccxtFundingRates] = await Promise.all([
        fetchJsonFromUrl(FUNDING_ENDPOINT),
        this.exchange.fetchFundingRates(undefined, { subType: 'linear' }),
      ])

      if (!rawJson || !rawJson.data || !Array.isArray(rawJson.data)) {
        logger.error({
          msg: 'Invalid funding data structure received from exchange',
          function: 'BinanceExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      // Filter symbols in rawJson.data to only ones that end with 'USDT'
      const usdtSymbolsIntervalData = rawJson.data
        .filter((item: any) => item.symbol && item.symbol.endsWith('USDT') && item.fundingIntervalHours !== undefined)
        .map((item: any) => ({
          ...item,
          symbol: item.symbol.replace('USDT', '/USDT:USDT'),
        }))

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of usdtSymbolsIntervalData) {
        const ccxtFundingData = ccxtFundingRates[item.symbol]

        if (
          !ccxtFundingData ||
          typeof ccxtFundingData.fundingRate !== 'number' ||
          isNaN(ccxtFundingData.fundingRate) ||
          !ccxtFundingData.fundingTimestamp ||
          !ccxtFundingData.fundingDatetime
        ) {
          logger.warn({
            msg: 'Invalid funding data values for symbol',
            function: 'BinanceExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            exchangeId: this.exchangeId,
            symbol: item.symbol,
            hasCcxtData: !!ccxtFundingData,
            fundingRate: ccxtFundingData?.fundingRate,
            fundingTimestamp: ccxtFundingData?.fundingTimestamp,
          })
          continue
        }

        const parsedFunding: ParsedFunding = {
          exchange: EXCHANGE_NAME,
          symbol: item.symbol,
          fundingRate: ccxtFundingData.fundingRate,
          fundingRatePercent: ccxtFundingData.fundingRate * 100,
          fundingInterval: item.fundingIntervalHours,
          nextFundingTimestamp: ccxtFundingData.fundingTimestamp,
          nextFundingDatetime: new Date(ccxtFundingData.fundingDatetime),
        }

        fundingData.set(item.symbol, parsedFunding)
      }

      logger.debug({
        msg: 'Parsed funding rates from exchange',
        function: 'BinanceExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'BinanceExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        endpoint: FUNDING_ENDPOINT,
        error,
      })
      return new Map()
    }
  }
}
