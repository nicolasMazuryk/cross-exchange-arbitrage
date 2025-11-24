import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getPositionSide } from '../../utils/utils'

const EXCHANGE_NAME = 'okx'
const CCXT_EXCHANGE_NAME = 'okx'
const FUNDING_ENDPOINT = 'https://www.okx.com/priapi/v5/public/funding-rate-all?ccyType=USDT'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class OkxExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
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

      balanceInfos.push({
        asset: 'USDT',
        total: balances['USDT'].total || 0,
        available: balances['USDT'].free || 0,
      })

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
      if (!FUNDING_ENDPOINT) {
        logger.error({
          msg: 'No funding endpoint configured',
          function: 'OkxExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      const rawJson = await fetchJsonFromUrl(FUNDING_ENDPOINT)

      if (
        !rawJson ||
        !rawJson.data ||
        !Array.isArray(rawJson.data) ||
        !rawJson.data[0].fundingList ||
        !Array.isArray(rawJson.data[0].fundingList)
      ) {
        logger.error({
          msg: 'Invalid funding data structure received from OKX',
          function: 'OkxExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      // Extract and filter USDT symbols
      const usdtSymbolsFundingData: any[] = []
      for (const item of rawJson.data[0].fundingList) {
        if (!item.instId || !item.instId.endsWith('-USDT-SWAP')) {
          logger.warn({
            msg: 'Invalid funding data symbol format',
            function: 'OkxExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            exchangeId: this.exchangeId,
            instId: item.instId,
          })
          continue
        }

        // OKX symbols are already in format like "BTC-USDT-SWAP", convert to "BTC/USDT:USDT"
        usdtSymbolsFundingData.push({
          ...item,
          symbol: item.instId.replace('-USDT-SWAP', '/USDT:USDT'),
        })
      }

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of usdtSymbolsFundingData) {
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
        endpoint: FUNDING_ENDPOINT,
        error,
      })
      return new Map()
    }
  }
}
