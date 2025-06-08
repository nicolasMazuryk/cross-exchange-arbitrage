import { BaseExchange } from './base'
import { ExchangeConfig } from './types'

const CCXT_EXCHANGE_NAME = 'binanceusdm'

export class BinanceExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }
}
