import { BaseExchange } from './base'
import { ExchangeConfig } from './types'

const CCXT_EXCHANGE_NAME = 'bybit'

export class BybitExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }
}
