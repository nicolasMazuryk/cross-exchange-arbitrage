import dotenv from 'dotenv'
import { parse } from 'yaml'
import fs from 'fs'
import path from 'path'

// Load environment variables only in development
const nodeEnv = process.env.NODE_ENV || 'development'
if (nodeEnv === 'development') {
  try {
    dotenv.config()
  } catch (error) {
    console.error({ msg: 'Failed to load environment variables from .env', function: 'config.loadEnv', error })
    throw error
  }
}

let yamlConfig: any = {}
try {
  let configFileName: string
  if (nodeEnv === 'development') {
    configFileName = 'development.yaml'
  } else if (nodeEnv === 'production') {
    configFileName = `${process.env.STRATEGY}.production.yaml`
  } else {
    configFileName = `${nodeEnv}.yaml`
  }

  const configPath = path.join(process.cwd(), 'config', configFileName)
  const configContent = fs.readFileSync(configPath, 'utf8')
  yamlConfig = parse(configContent)

  console.info({
    msg: 'Configuration loaded successfully',
    function: 'config.loadYamlConfig',
    environment: nodeEnv,
    configFile: configFileName,
  })

  console.log(yamlConfig)

} catch (error) {
  console.error({ msg: 'Failed to load YAML configuration file', function: 'config.loadYamlConfig', error })
  throw error
}

interface AppConfig {
  name: string
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
  maxMarketSpreadPercent: number
  maxAnomalySpreadThresholdPercent: number
  maxOrderbookAge: number
  orderAmountToleranceMinPercent: number
  orderAmountToleranceMaxPercent: number
  minPersistenceMs: number
  minConsecutiveSnapshots: number
  candidateCleanupMs: number
}

interface TradingConfig {
  orderAmountUsd: number
  minBalanceBufferPercent: number
  maxPositionAmountUsd: number
  orderConfirmationTimeoutMs: number
  leverage: number
  monitor: {
    maxHoldTimeMs: number
    checkIntervalMs: number
    exitMinPersistenceMs: number
    exitMinConsecutiveSnapshots: number
    exitCandidateCleanupMs: number
  }
}

interface RedisConfig {
  url: string
  keyPrefix: string
}

interface AccountSyncConfig {
  maxStateAgeMs: number
  snapshotIntervalMs: number
}

interface FundingConfig {
  fetchIntervalMs: number
  maxDataAgeMs: number
  supportedExchanges: string[]
  projectionHours: number
}

interface FundingFeeCollectorConfig {
  cronPattern: string
}

export type StrategyType = 'funding' | 'spread'

interface StrategyConfig {
  funding: {
    enabled: boolean
    entryWindowStart: number
    entryWindowEnd: number
    exitWindowStart: number
    exitWindowEnd: number
    minFundingProfitPercent: number
    minTotalProfitPercent: number
    convergenceThresholdPercent: number
    minFundingProfitAsyncSyncExitPercent: number
    spreadWideningThresholdPercent: number
  }
  spread: {
    enabled: boolean
    entryWindowStart: number
    entryWindowEnd: number
    exitWindowStart: number
    exitWindowEnd: number
    minSpreadProfitPercent: number
    minTotalProfitPercent: number
    negativeFundingMultiplier: number
    convergenceThresholdPercent: number
    spreadWideningThresholdPercent: number
  }
}

interface Config {
  app: AppConfig
  redis: RedisConfig
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
  fundingFeeCollector: FundingFeeCollectorConfig
  strategy: StrategyConfig
}

const config: Config = {
  app: {
    name: yamlConfig?.app?.name,
    version: yamlConfig?.app?.version,
    logLevel: yamlConfig?.app?.logLevel,
  },
  redis: {
    url: yamlConfig?.redis?.url,
    keyPrefix: yamlConfig?.redis?.keyPrefix,
  },
  exchanges: {
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.binance?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.binance?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.binance?.fees?.maker,
        taker: yamlConfig?.exchanges?.binance?.fees?.taker,
      },
      ignoredMarkets: yamlConfig?.exchanges?.binance?.ignoredMarkets || [],
    },
    bybit: {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bybit?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bybit?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.bybit?.fees?.maker,
        taker: yamlConfig?.exchanges?.bybit?.fees?.taker,
      },
      ignoredMarkets: yamlConfig?.exchanges?.bybit?.ignoredMarkets || [],
    },
    okx: {
      apiKey: process.env.OKX_API_KEY || '',
      apiSecret: process.env.OKX_API_SECRET || '',
      apiPass: process.env.OKX_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.okx?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.okx?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.okx?.fees?.maker,
        taker: yamlConfig?.exchanges?.okx?.fees?.taker,
      },
      ignoredMarkets: yamlConfig?.exchanges?.okx?.ignoredMarkets || [],
    },
    bitget: {
      apiKey: process.env.BITGET_API_KEY || '',
      apiSecret: process.env.BITGET_API_SECRET || '',
      apiPass: process.env.BITGET_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bitget?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bitget?.reconnectInterval,
      fees: {
        maker: yamlConfig?.exchanges?.bitget?.fees?.maker,
        taker: yamlConfig?.exchanges?.bitget?.fees?.taker,
      },
      ignoredMarkets: yamlConfig?.exchanges?.bitget?.ignoredMarkets || [],
    },
  },
  trackedPairs: yamlConfig?.trackedPairs,
  arbitrage: {
    blacklistPairs: yamlConfig?.arbitrage?.blacklistPairs || [],
    minConfidenceScore: yamlConfig?.arbitrage?.minConfidenceScore,
    maxMarketSpreadPercent: yamlConfig?.arbitrage?.maxMarketSpreadPercent,
    maxAnomalySpreadThresholdPercent: yamlConfig?.arbitrage?.maxAnomalySpreadThresholdPercent,
    maxOrderbookAge: yamlConfig?.arbitrage?.maxOrderbookAge,
    orderAmountToleranceMinPercent: yamlConfig?.arbitrage?.orderAmountToleranceMinPercent,
    orderAmountToleranceMaxPercent: yamlConfig?.arbitrage?.orderAmountToleranceMaxPercent,
    minPersistenceMs: yamlConfig?.arbitrage?.minPersistenceMs,
    minConsecutiveSnapshots: yamlConfig?.arbitrage?.minConsecutiveSnapshots,
    candidateCleanupMs: yamlConfig?.arbitrage?.candidateCleanupMs,
  },
  trading: {
    orderAmountUsd: yamlConfig?.trading?.orderAmountUsd,
    minBalanceBufferPercent: yamlConfig?.trading?.minBalanceBufferPercent,
    maxPositionAmountUsd: yamlConfig?.trading?.maxPositionAmountUsd,
    orderConfirmationTimeoutMs: yamlConfig?.trading?.orderConfirmationTimeoutMs,
    leverage: yamlConfig?.trading?.leverage,
    monitor: yamlConfig?.trading?.monitor,
  },
  accountSync: {
    maxStateAgeMs: yamlConfig?.accountSync?.maxStateAgeMs,
    snapshotIntervalMs: yamlConfig?.accountSync?.snapshotIntervalMs,
  },
  funding: {
    fetchIntervalMs: yamlConfig?.funding?.fetchIntervalMs,
    maxDataAgeMs: yamlConfig?.funding?.maxDataAgeMs,
    supportedExchanges: yamlConfig?.funding?.supportedExchanges,
    projectionHours: yamlConfig?.funding?.projectionHours,
  },
  fundingFeeCollector: {
    cronPattern: yamlConfig?.fundingFeeCollector?.cronPattern,
  },
  strategy: {
    funding: {
      enabled: yamlConfig?.strategy?.funding?.enabled ?? false,
      entryWindowStart: yamlConfig?.strategy?.funding?.entryWindowStart,
      entryWindowEnd: yamlConfig?.strategy?.funding?.entryWindowEnd,
      exitWindowStart: yamlConfig?.strategy?.funding?.exitWindowStart,
      exitWindowEnd: yamlConfig?.strategy?.funding?.exitWindowEnd,
      minFundingProfitPercent: yamlConfig?.strategy?.funding?.minFundingProfitPercent,
      minTotalProfitPercent: yamlConfig?.strategy?.funding?.minTotalProfitPercent,
      convergenceThresholdPercent: yamlConfig?.strategy?.funding?.convergenceThresholdPercent,
      minFundingProfitAsyncSyncExitPercent: yamlConfig?.strategy?.funding?.minFundingProfitAsyncSyncExitPercent,
      spreadWideningThresholdPercent: yamlConfig?.strategy?.funding?.spreadWideningThresholdPercent,
    },
    spread: {
      enabled: yamlConfig?.strategy?.spread?.enabled ?? false,
      entryWindowStart: yamlConfig?.strategy?.spread?.entryWindowStart,
      entryWindowEnd: yamlConfig?.strategy?.spread?.entryWindowEnd,
      exitWindowStart: yamlConfig?.strategy?.spread?.exitWindowStart,
      exitWindowEnd: yamlConfig?.strategy?.spread?.exitWindowEnd,
      minSpreadProfitPercent: yamlConfig?.strategy?.spread?.minSpreadProfitPercent,
      minTotalProfitPercent: yamlConfig?.strategy?.spread?.minTotalProfitPercent,
      negativeFundingMultiplier: yamlConfig?.strategy?.spread?.negativeFundingMultiplier,
      convergenceThresholdPercent: yamlConfig?.strategy?.spread?.convergenceThresholdPercent,
      spreadWideningThresholdPercent: yamlConfig?.strategy?.spread?.spreadWideningThresholdPercent,
    },
  },
}

export { yamlConfig }

export default config
