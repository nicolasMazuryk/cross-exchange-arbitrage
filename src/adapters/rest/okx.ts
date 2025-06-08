import { BaseExchange } from './base'
import { ExchangeConfig } from './types'

const CCXT_EXCHANGE_NAME = 'okx'

export class OkxExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }
} 