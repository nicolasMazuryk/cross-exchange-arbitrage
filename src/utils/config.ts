import dotenv from 'dotenv'
import { parse } from 'yaml'
import fs from 'fs'
import path from 'path'

// Load environment variables
dotenv.config()

// Load YAML config
const configPath = path.join(process.cwd(), 'config', `${process.env.NODE_ENV || 'development'}.yaml`)
const yamlConfig = parse(fs.readFileSync(configPath, 'utf8'))

interface AppConfig {
  environment: string
  version: string
  logLevel: string
}

interface ExchangeConfiguration {
  apiKey: string
  apiSecret: string
  apiPass?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
}

interface Config {
  app: AppConfig
  exchanges: {
    binance: ExchangeConfiguration
    bybit: ExchangeConfiguration
    okx: ExchangeConfiguration
  }
  trackedPairs: string[]
}

const config: Config = {
  app: {
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '1.0.0',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  exchanges: {
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.binance?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.binance?.reconnectInterval,
    },
    bybit: {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bybit?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bybit?.reconnectInterval,
    },
    okx: {
      apiKey: process.env.OKX_API_KEY || '',
      apiSecret: process.env.OKX_API_SECRET || '',
      apiPass: process.env.OKX_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.okx?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.okx?.reconnectInterval,
    },
  },
  trackedPairs: yamlConfig?.trackedPairs || ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT'],
}

export default config
