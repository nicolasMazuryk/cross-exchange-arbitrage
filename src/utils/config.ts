import dotenv from 'dotenv'
import { parse } from 'yaml'
import fs from 'fs'
import path from 'path'

// Load environment variables
dotenv.config()

// Load YAML config
const configPath = path.join(
  process.cwd(),
  'config',
  `${process.env.NODE_ENV || 'development'}.yaml`
)
const yamlConfig = parse(fs.readFileSync(configPath, 'utf8'))

interface AppConfig {
  environment: string
  version: string
  logLevel: string
}

interface ExchangeConfig {
  apiKey: string
  apiSecret: string
  maxStreamsPerConnection: number
  reconnectInterval: number
}

interface Config {
  app: AppConfig
  exchanges: {
    binance: ExchangeConfig
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
      maxStreamsPerConnection: yamlConfig?.exchanges?.binance?.maxStreamsPerConnection || 1024,
      reconnectInterval: yamlConfig?.exchanges?.binance?.reconnectInterval || 5000,
    },
  },
  trackedPairs: yamlConfig?.trackedPairs || [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'ADAUSDT',
    'DOGEUSDT',
  ],
}

export default config
