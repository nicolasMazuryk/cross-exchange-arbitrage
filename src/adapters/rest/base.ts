import ccxt, { Exchange, Market, Order, Dictionary, FundingHistory } from 'ccxt'
import { ExchangeConfig, RestClientInterface, ExchangeOrderParams } from './types'
import { MarketType } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import appConfig from '../../utils/config'
import { Logger } from '../../utils/logger'
import { normalizeFundingTimestamp, marketTypeFromCcxtMarket, getMarketTypeFromUnifiedSymbol } from '../../utils/utils'
import { FundingFeeHistory, FundingRateHistory } from '../../core/funding/fundingFeeCollector'
import { MarketMetadataService } from '../../core/markets/marketMetadataService'

const logger = new Logger('rest-base')

export abstract class BaseExchange implements RestClientInterface {
  protected exchange: Exchange
  private _marketMetadataService?: MarketMetadataService

  setMarketMetadataService(svc: MarketMetadataService): void {
    this._marketMetadataService = svc
  }

  getMarketMetadataService(): MarketMetadataService {
    if (!this._marketMetadataService) {
      throw new Error(`MarketMetadataService not initialised for exchange ${this.exchangeName}. Call setMarketMetadataService() first.`)
    }
    return this._marketMetadataService
  }

  constructor(
    protected readonly exchangeName: string,
    protected readonly exchangeId: string,
    protected readonly config: ExchangeConfig
  ) {
    this.exchange = new (ccxt as any)[exchangeId]({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.apiPass,
      agent: config.options?.agent,
      options: {
        warnOnFetchOpenOrdersWithoutSymbol: false,
        ...config.options,
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected clientForSymbol(symbol?: string): Exchange {
    return this.exchange
  }

  protected allClients(): Exchange[] {
    return [this.exchange]
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected symbolMarketType(symbol: string): MarketType {
    return getMarketTypeFromUnifiedSymbol(symbol)
  }

  getAllMarkets(): Dictionary<Market> {
    return this.exchange.markets || {}
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
      const exchangeCfg = appConfig.exchanges[this.exchangeName as keyof typeof appConfig.exchanges]
      const ignoredMarkets = exchangeCfg?.ignoredMarkets || []
      const enabledMarketTypes = exchangeCfg?.enabledMarketTypes
      const enabledQuoteCurrencies = exchangeCfg?.enabledQuoteCurrencies

      return Object.fromEntries(
        Object.entries(this.getAllMarkets())
          .filter(([, market]) => this.isTradableMarket(market!))
          .filter(([, market]) => {
            if (!enabledMarketTypes?.length) return true
            return enabledMarketTypes.includes(marketTypeFromCcxtMarket(market!))
          })
          .filter(([, market]) => {
            if (!enabledQuoteCurrencies?.length) return true
            return enabledQuoteCurrencies.includes(market!.quote)
          })
          .filter(([symbol]) => !ignoredMarkets.includes(symbol))
      )
    } catch (error) {
      logger.error({
        msg: 'Failed to filter trading markets',
        function: 'BaseExchange.getTradingMarkets',
        exchange: this.exchangeName,
        exchangeId: this.exchangeId,
        totalMarkets: Object.keys(this.getAllMarkets()).length,
        error,
      })
      throw error
    }
  }

  private isTradableMarket(market: Market): boolean {
    if (!market) return false
    if (market.option) return false
    if (market.future && !market.swap) return false
    if (!market.active) return false
    if (market.spot) return true
    if (market.swap && (market.linear || market.inverse)) return true
    return false
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  paramsForMarket(marketType: MarketType, ctx?: { symbol?: string; quote?: string }): Record<string, any> {
    return {}
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

      return (await this.clientForSymbol(symbol).createOrder(
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
    if (this.symbolMarketType(symbol) === MarketType.SPOT) return
    if (this.exchangeName === 'bybit') return

    try {
        await this.clientForSymbol(symbol).setLeverage(leverage, symbol)
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getExchangeFundingFeeHistoryParams(symbol: string): any {
    return {}
  }

  async cancelOrder(id: string, symbol: string): Promise<Order> {
    try {
      return (await this.clientForSymbol(symbol).cancelOrder(id, symbol)) as Order
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

  protected parseExchangeSpecificFundingFeeHistoryResponse(response: FundingHistory[]): FundingHistory[] {
    return response
  }

  async fetchFundingFeeHistory(symbol: string, since?: number, limit?: number): Promise<FundingFeeHistory[]> {
    try {
      const exchangeParams = this.getExchangeFundingFeeHistoryParams(symbol)

      const response = await this.clientForSymbol(symbol).fetchFundingHistory(symbol, since, limit, exchangeParams)

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
      const rawData = await this.clientForSymbol(symbol).fetchFundingRateHistory(symbol, since, limit, params)

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

  abstract fetchFundingData(): Promise<Map<string, ParsedFunding>>
}
