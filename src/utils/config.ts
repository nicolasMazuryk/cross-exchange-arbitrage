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

interface FeeConfig {
  maker: number
  taker: number
}

interface ExchangeConfiguration {
  apiKey: string
  apiSecret: string
  apiPass?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
  fees: FeeConfig
  ignoredMarkets: string[]
}

interface ArbitrageConfig {
  blacklistPairs: string[]
  minConfidenceScore: number
  maxMarketSpread: number
  maxCrossMarketSpread: number
  maxOrderbookAge: number
  minProfitThreshold: number
  orderAmountToleranceMin: number
  orderAmountToleranceMax: number
  minPersistenceMs: number
  minConsecutiveSnapshots: number
  candidateCleanupMs: number
}

interface TradingConfig {
  orderAmount: number
  minBalanceBuffer: number
  positionLimitMultiplier: number
  orderConfirmationTimeoutMs: number
  monitor: {
    maxHoldTimeMs: number
    convergenceBufferPercent: number
    checkIntervalMs: number
    exitMinPersistenceMs: number
    exitMinConsecutiveSnapshots: number
    exitCandidateCleanupMs: number
  }
}

interface AccountSyncConfig {
  maxStateAgeMs: number
  snapshotIntervalMs: number
}

interface FundingConfig {
  fetchIntervalMs: number
  maxDataAgeMs: number
  minFundingDifferential: number
  supportedExchanges: string[]
}

interface Config {
  app: AppConfig
  exchanges: {
    binance: ExchangeConfiguration
    bybit: ExchangeConfiguration
    okx: ExchangeConfiguration
    bitget: ExchangeConfiguration
  }
  trackedPairs: string[]
  arbitrage: ArbitrageConfig
  trading: TradingConfig
  accountSync: AccountSyncConfig
  funding: FundingConfig
}

const config: Config = {
  app: {
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.0',
    logLevel: process.env.LOG_LEVEL || 'debug',
  },
  exchanges: {
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.binance?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.binance?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.binance?.fees?.maker,
        taker: yamlConfig?.exchanges?.binance?.fees?.taker
      },
      ignoredMarkets: yamlConfig?.exchanges?.binance?.ignoredMarkets || []
    },
    bybit: {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bybit?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bybit?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.bybit?.fees?.maker,
        taker: yamlConfig?.exchanges?.bybit?.fees?.taker
      },
      ignoredMarkets: yamlConfig?.exchanges?.bybit?.ignoredMarkets || []
    },
    okx: {
      apiKey: process.env.OKX_API_KEY || '',
      apiSecret: process.env.OKX_API_SECRET || '',
      apiPass: process.env.OKX_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.okx?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.okx?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.okx?.fees?.maker,
        taker: yamlConfig?.exchanges?.okx?.fees?.taker
      },
      ignoredMarkets: yamlConfig?.exchanges?.okx?.ignoredMarkets || []
    },
    bitget: {
      apiKey: process.env.BITGET_API_KEY || '',
      apiSecret: process.env.BITGET_API_SECRET || '',
      apiPass: process.env.BITGET_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bitget?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bitget?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.bitget?.fees?.maker,
        taker: yamlConfig?.exchanges?.bitget?.fees?.taker
      },
      ignoredMarkets: yamlConfig?.exchanges?.bitget?.ignoredMarkets || []
    },
  },
  trackedPairs: yamlConfig?.trackedPairs || ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT'],
  arbitrage: {
    blacklistPairs: yamlConfig?.arbitrage?.blacklistPairs || [],
    minConfidenceScore: yamlConfig?.arbitrage?.minConfidenceScore,
    maxMarketSpread: yamlConfig?.arbitrage?.maxMarketSpread,
    maxCrossMarketSpread: yamlConfig?.arbitrage?.maxCrossMarketSpread,
    maxOrderbookAge: yamlConfig?.arbitrage?.maxOrderbookAge,
    minProfitThreshold: yamlConfig?.arbitrage?.minProfitThreshold,
    orderAmountToleranceMin: yamlConfig?.arbitrage?.orderAmountToleranceMin,
    orderAmountToleranceMax: yamlConfig?.arbitrage?.orderAmountToleranceMax,
    minPersistenceMs: yamlConfig?.arbitrage?.minPersistenceMs,
    minConsecutiveSnapshots: yamlConfig?.arbitrage?.minConsecutiveSnapshots,
    candidateCleanupMs: yamlConfig?.arbitrage?.candidateCleanupMs
  },
  trading: {
    orderAmount: yamlConfig?.trading?.orderAmount,
    minBalanceBuffer: yamlConfig?.trading?.minBalanceBuffer,
    positionLimitMultiplier: yamlConfig?.trading?.positionLimitMultiplier,
    orderConfirmationTimeoutMs: yamlConfig?.trading?.orderConfirmationTimeoutMs,
    monitor: yamlConfig?.trading?.monitor
  },
  accountSync: {
    maxStateAgeMs: yamlConfig?.accountSync?.maxStateAgeMs,
    snapshotIntervalMs: yamlConfig?.accountSync?.snapshotIntervalMs
  },
  funding: {
    fetchIntervalMs: yamlConfig?.funding?.fetchIntervalMs,
    maxDataAgeMs: yamlConfig?.funding?.maxDataAgeMs,
    minFundingDifferential: yamlConfig?.funding?.minFundingDifferential,
    supportedExchanges: yamlConfig?.funding?.supportedExchanges
  }
}

export default config
