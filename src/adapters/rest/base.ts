import ccxt, { Exchange, Market, Order, Dictionary, FundingHistory } from 'ccxt'
import { ExchangeConfig, RestClientInterface, ExchangeOrderParams } from './types'
import { ParsedFunding } from '../../core/funding/types'
import appConfig from '../../utils/config'
import { Logger } from '../../utils/logger'
import { normalizeFundingTimestamp } from '../../utils/utils'
import { FundingFeeHistory, FundingRateHistory } from '../../core/funding/fundingFeeCollector'

const logger = new Logger('rest-base')

export abstract class BaseExchange implements RestClientInterface {
  protected exchange: Exchange

  constructor(
    protected readonly exchangeName: string,
    protected readonly exchangeId: string,
    protected readonly config: ExchangeConfig
  ) {
    this.exchange = new (ccxt as any)[exchangeId]({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.apiPass,
      options: {
        // Suppress warning about fetching open orders without symbol
        // This is needed because we fetch all open orders during snapshots
        warnOnFetchOpenOrdersWithoutSymbol: false,
        ...config.options,
      },
    })
  }

  async loadMarkets(): Promise<Dictionary<Market>> {
    try {
      return await this.exchange.loadMarkets()
    } catch (error) {
      logger.error({
        msg: 'Failed to load markets from exchange',
        function: 'BaseExchange.loadMarkets',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  getTradingMarkets(): Dictionary<Market> {
    try {
      // const markets = Object.values(this.exchange.markets)

      // logger.info({ msg: `Found ${markets.length} markets` })

      // const USDTmarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT'
      // )

      // logger.info({ msg: `Found ${USDTmarkets.length} markets` })

      // const Swapmarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT' && market.swap
      // )

      // logger.info({ msg: `Found ${Swapmarkets.length} markets` })

      // const notInverseMarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT' && market.swap && !market.inverse
      // )

      // logger.info({ msg: `Found ${notInverseMarkets.length} markets` })

      // Get ignored markets for this exchange from config
      const ignoredMarkets =
        appConfig.exchanges[this.exchangeName as keyof typeof appConfig.exchanges].ignoredMarkets || []
      const usdtPerpetualMarkets = Object.fromEntries(
        Object.entries(this.exchange.markets)
          // .filter(
          //   ([, market]) =>
          //     market.quote === 'USDT' && // TODO: add USDC
          //     market.swap && // TODO: add SPOT markets
          //     !market.inverse &&
          //     market.active
          // )
          .filter(([, market]) => market.spot || market.margin || market.swap)
          .filter(([symbol]) => !ignoredMarkets.includes(symbol))
      )
      return usdtPerpetualMarkets
    } catch (error) {
      logger.error({
        msg: 'Failed to filter trading markets',
        function: 'BaseExchange.getTradingMarkets',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        totalMarkets: Object.keys(this.exchange.markets || {}).length,
        error,
      })
      throw error
    }
  }

  async createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    reduceOnly?: boolean,
    clientOrderId?: string
  ): Promise<Order> {
    try {
      await this.setLeverage(symbol, appConfig.trading.leverage)

      const baseParams: ExchangeOrderParams = {
        reduceOnly,
        clientOrderId,
      }

      // Get exchange-specific parameters
      const exchangeParams = this.getExchangeOrderParams(symbol, type, side, amount, price, baseParams)

      return (await this.exchange.createOrder(
        symbol,
        type.toLowerCase(),
        side.toLowerCase(),
        amount,
        price,
        exchangeParams
      )) as Order
    } catch (error) {
      logger.error({
        msg: 'Failed to create order on exchange',
        function: 'BaseExchange.createOrder',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        symbol,
        type,
        side,
        amount,
        price,
        reduceOnly,
        clientOrderId,
        error,
      })
      throw error
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.exchangeName === 'bybit') return

    try {
        await this.exchange.setLeverage(leverage, symbol)
    } catch (error) {
      logger.error({
        msg: 'Failed to set leverage on exchange',
        function: 'BaseExchange.setLeverage',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        symbol,
        leverage,
        error,
      })
      throw error
    }
  }

  /**
   * Override this method in exchange-specific implementations to provide
   * exchange-specific order parameters
   */
  protected getExchangeOrderParams(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    baseParams: ExchangeOrderParams = {}
  ): ExchangeOrderParams {
    return baseParams
  }

  /**
   * Override this method in exchange-specific implementations to provide
   * exchange-specific parameters for funding fee history requests
   */
  protected getExchangeFundingFeeHistoryParams(): any {
    return {}
  }

  async cancelOrder(id: string, symbol: string): Promise<Order> {
    try {
      return (await this.exchange.cancelOrder(id, symbol)) as Order
    } catch (error) {
      logger.error({
        msg: 'Failed to cancel order on exchange',
        function: 'BaseExchange.cancelOrder',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        orderId: id,
        symbol,
        error,
      })
      throw error
    }
  }

  getExchangeId(): string {
    return this.exchangeId
  }

  /**
 * Override this method in exchange-specific implementations to provide
 * exchange-specific response body parsing for funding fee history
 */
  protected parseExchangeSpecificFundingFeeHistoryResponse(response: FundingHistory[]): FundingHistory[] {
    return response
  }

  async fetchFundingFeeHistory(symbol?: string, since?: number, limit?: number): Promise<FundingFeeHistory[]> {
    try {
      // Get exchange-specific parameters
      const exchangeParams = this.getExchangeFundingFeeHistoryParams()

      const response = await this.exchange.fetchFundingHistory(symbol, since, limit, exchangeParams)

      const parsedResponse = this.parseExchangeSpecificFundingFeeHistoryResponse(response)
      
      return parsedResponse.map((entry: any) => {
        const { normalizedTimestamp, actualTimestamp } = normalizeFundingTimestamp(entry.timestamp)
        return {
          ...entry,
          actualTimestamp,
          timestamp: normalizedTimestamp,
          datetime: new Date(normalizedTimestamp).toISOString(),
        }
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding fee history from exchange',
        function: 'BaseExchange.fetchFundingFeeHistory',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        symbol,
        since,
        limit,
        error,
      })
      throw error
    }
  }

  async fetchFundingRateHistory(symbol?: string, since?: number, limit?: number, params?: any): Promise<FundingRateHistory[]> {
    try {
      const rawData = await this.exchange.fetchFundingRateHistory(symbol, since, limit, params)

      return rawData.map((entry: any) => {
        const { normalizedTimestamp, actualTimestamp } = normalizeFundingTimestamp(entry.timestamp)
        return {
          ...entry,
          actualTimestamp,
          timestamp: normalizedTimestamp,
          datetime: new Date(normalizedTimestamp).toISOString(),
        }
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding rate history from exchange',
        function: 'BaseExchange.fetchFundingRateHistory',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        symbol,
        since,
        limit,
        params,
        error,
      })
      throw error
    }
  }

  /**
   * Abstract method to fetch funding data from the exchange
   * Must be implemented by each exchange with their specific logic
   */
  abstract fetchFundingData(): Promise<Map<string, ParsedFunding>>
}
