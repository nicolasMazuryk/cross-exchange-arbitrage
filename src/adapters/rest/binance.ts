import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import logger from '../../utils/logger'

export class BinanceExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super('binance', {
      ...config,
      options: {
        ...config.options,
        defaultType: 'future'
      }
    })
  }
} 