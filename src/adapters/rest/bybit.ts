import { BaseExchange } from './base'
import { ExchangeConfig } from './types'

const CCXT_EXCHANGE_NAME = 'bybit'

export class BybitExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }

  //   public async getUSDTPerpetualSymbols(): Promise<string[]> {
  //     try {
  //       const markets = await this.exchange.loadMarkets()
  //       return Object.keys(markets).filter(symbol => {
  //         const market = markets[symbol]
  //         return market &&
  //           symbol.endsWith('USDT') &&
  //           market.linear === true &&
  //           market.active === true
  //       })
  //     } catch (error) {
  //       logger.error('Error fetching Bybit USDT perpetual symbols:', error)
  //       throw error
  //     }
  //   }
}
