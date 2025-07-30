import ccxt, { Exchange, Market, Order, Dictionary } from 'ccxt'
import { ExchangeConfig, RestClientInterface, ExchangeOrderParams } from './types'
import logger from '../../utils/logger'

export abstract class BaseExchange implements RestClientInterface {
  protected exchange: Exchange

  constructor(
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
        ...config.options
      },
    })
  }

  async loadMarkets(): Promise<Dictionary<Market>> {
    try {
      return await this.exchange.loadMarkets()
    } catch (error) {
      logger.error(`[${this.exchangeId}] Error fetching markets:`, error)
      throw error
    }
  }

  getTradingMarkets(): Dictionary<Market> {
    try {
      // const markets = Object.values(this.exchange.markets)

      // logger.info(`Found ${markets.length} markets`)

      // const USDTmarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT'
      // )

      // logger.info(`Found ${USDTmarkets.length} markets`)

      // const Swapmarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT' && market.swap
      // )

      // logger.info(`Found ${Swapmarkets.length} markets`)

      // const notInverseMarkets = Object.values(this.exchange.markets)
      // .filter(
      //   market =>
      //     market.quote === 'USDT' && market.swap && !market.inverse
      // )

      // logger.info(`Found ${notInverseMarkets.length} markets`)

      const usdtPerpetualMarkets = Object.fromEntries(
        Object.entries(this.exchange.markets)
          .filter(([symbol, market]) =>
            market.quote === 'USDT' && // TODO: add USDC
            market.swap && // TODO: add SPOT markets
            !market.inverse &&
            market.active
          )
          .filter(([symbol, market]) => 
            // symbol.startsWith('SAHARA') || 
            // symbol.startsWith('SOL') || 
            // symbol.startsWith('GOAT') || 
            // symbol.startsWith('DOGS') ||
            symbol.includes('PEPE')
            // symbol.includes('ACH')
            // market.contractSize !== 1
          )
      )
      
      return usdtPerpetualMarkets
    } catch (error) {
      logger.error(`[${this.exchangeId}] Error fetching USDT perpetual pairs:`, error)
      throw error
    }
  }

  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number, reduceOnly?: boolean, clientOrderId?: string): Promise<Order> {
    try {
      const baseParams: ExchangeOrderParams = {
        reduceOnly,
        clientOrderId
      }

      // Get exchange-specific parameters
      const exchangeParams = this.getExchangeOrderParams(symbol, type, side, amount, price, baseParams)
      
      return (await this.exchange.createOrder(symbol, type.toLowerCase(), side.toLowerCase(), amount, price, exchangeParams)) as Order
    } catch (error) {
      logger.error(`[${this.exchangeId}] Error creating order for ${symbol}:`, error)
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

  async cancelOrder(id: string, symbol: string): Promise<Order> {
    try {
      return (await this.exchange.cancelOrder(id, symbol)) as Order
    } catch (error) {
      logger.error(`[${this.exchangeId}] Error canceling order ${id} for ${symbol}:`, error)
      throw error
    }
  }

  getExchangeId(): string {
    return this.exchangeId
  }
}
