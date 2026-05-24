import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getPositionSide, positionId, getMarketTypeFromUnifiedSymbol, quoteCurrenciesFor } from '../../utils/utils'
import appConfig from '../../utils/config'
import { FundingHistory } from 'ccxt'

const EXCHANGE_NAME = 'bybit'
const CCXT_EXCHANGE_NAME = 'bybit'
const FUNDING_ENDPOINT = 'https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=LinearPerpetual'
const INVERSE_FUNDING_ENDPOINT = 'https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=InversePerpetual'

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

  /**
   * Fetch funding data from Bybit
   * URL: https://www.bybit.com/x-api/contract/v5/public/support/trading-param?category=LinearPerpetual
   * Response structure: {"ret_code":0,"ret_msg":"success","result":{"list":[{"symbol":2219,"contractType":"LinearPerpetual","symbolName":"XDCUSDT","fundingRateInterval":"4","nextFundingTimeE0":"1757534400","interestRate":"0.0003","predictedFundingRate":"0.005"}]}}
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      const [linearJson, inverseJson] = await Promise.all([
        fetchJsonFromUrl(FUNDING_ENDPOINT),
        fetchJsonFromUrl(INVERSE_FUNDING_ENDPOINT),
      ])

      const enabledQuotes = quoteCurrenciesFor(EXCHANGE_NAME)
      const metadata = this.getMarketMetadataService()

      const ignoredFunding = appConfig.exchanges.bybit.ignoredFundingSymbols ?? []

      const linearItems: any[] = (linearJson?.result?.list ?? [])
        .filter((item: any) => item.symbolName && enabledQuotes.some((q: string) => item.symbolName.endsWith(q)))
        .flatMap((item: any) => {
          const meta = metadata.getMetadataByNativeId(item.symbolName, MarketType.LINEAR_PERP)
          if (meta) return [{ ...item, symbol: meta.symbol }]
          const quote = enabledQuotes.find((q: string) => item.symbolName.endsWith(q))
          if (!quote) {
            logger.warn({
              msg: 'Unknown funding symbol, no enabled quote suffix match, skipping',
              function: 'BybitExchange.fetchFundingData',
              exchange: EXCHANGE_NAME,
              symbolName: item.symbolName,
              enabledQuotes,
            })
            return []
          }
          const base = item.symbolName.slice(0, -quote.length)
          return [{ ...item, symbol: `${base}/${quote}:${quote}` }]
        })
        .filter((item: any) => !ignoredFunding.includes(item.symbol))

      const inverseItems: any[] = (inverseJson?.result?.list ?? [])
        .map((item: any) => {
          if (!item.symbolName) return null
          const meta = metadata.getMetadataByNativeId(item.symbolName, MarketType.INVERSE_PERP)
          if (!meta) return null
          return { ...item, symbol: meta.symbol }
        })
        .filter(Boolean)

      const symbolsFundingData = [...linearItems, ...inverseItems]

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of symbolsFundingData) {
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
          nextFundingDatetime: new Date(nextFundingTimestamp),
        }

        fundingData.set(item.symbol, parsedFunding)
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
        endpoint: FUNDING_ENDPOINT,
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
