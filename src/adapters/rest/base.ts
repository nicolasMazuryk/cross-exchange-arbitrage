import ccxt, { Exchange, Market, Order, Balances, Dictionary } from 'ccxt'
import { ExchangeConfig, ExchangeInterface } from './types'
import logger from '../../utils/logger'

export abstract class BaseExchange implements ExchangeInterface {
  protected exchange: Exchange

  constructor(
    protected readonly exchangeId: string,
    protected readonly config: ExchangeConfig
  ) {
    this.exchange = new (ccxt as any)[exchangeId]({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.apiPass,
      options: config.options || {},
    })
  }

  async loadMarkets(): Promise<Dictionary<Market>> {
    try {
      return await this.exchange.loadMarkets()
    } catch (error) {
      logger.error(`Error fetching markets for ${this.exchangeId}:`, error)
      throw error
    }
  }

  async getUSDTPerpetualSymbols(): Promise<string[]> {
    try {
    //   const markets = Object.values(this.exchange.markets)

    //   logger.info(`Found ${markets.length} markets`)

    //   const USDTmarkets = Object.values(this.exchange.markets)
    //   .filter(
    //     market =>
    //       market.quote === 'USDT'
    //   )

    //   logger.info(`Found ${USDTmarkets.length} markets`)

    //   const Swapmarkets = Object.values(this.exchange.markets)
    //   .filter(
    //     market =>
    //       market.quote === 'USDT' && market.swap
    //   )

    //   logger.info(`Found ${Swapmarkets.length} markets`)

    //   const notInverseMarkets = Object.values(this.exchange.markets)
    //   .filter(
    //     market =>
    //       market.quote === 'USDT' && market.swap && !market.inverse
    //   )

    //   logger.info(`Found ${notInverseMarkets.length} markets`)

      const usdtPairs = Object.values(this.exchange.markets)
        .filter(
          market =>
            market.quote === 'USDT' && // TODO: add USDC
            market.swap && // TODO: add SPOT markets
            !market.inverse &&
            market.active
        )
        .map(market => market.id)
        .slice(-2)

      logger.info(`Found ${usdtPairs.length} USDT perpetual futures pairs`)
      return usdtPairs
    } catch (error) {
      logger.error('Error fetching USDT perpetual pairs:', error)
      throw error
    }
  }

  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<Order> {
    try {
      return (await this.exchange.createOrder(symbol, type, side, amount, price)) as Order
    } catch (error) {
      logger.error(`Error creating order for ${symbol} on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async cancelOrder(id: string, symbol: string): Promise<Order> {
    try {
      return (await this.exchange.cancelOrder(id, symbol)) as Order
    } catch (error) {
      logger.error(`Error canceling order ${id} for ${symbol} on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchBalance(): Promise<Balances> {
    try {
      return await this.exchange.fetchBalance()
    } catch (error) {
      logger.error(`Error fetching balance on ${this.exchangeId}:`, error)
      throw error
    }
  }

  getExchangeId(): string {
    return this.exchangeId
  }
}
