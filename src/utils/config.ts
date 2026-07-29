import dotenv from 'dotenv'
import { parse } from 'yaml'
import fs from 'fs'
import path from 'path'
import { MarketType } from '../types/exchange'

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

interface PerMarketTypeFees {
  spot?: FeeConfig
  linear?: FeeConfig
  inverse?: FeeConfig
}

interface ExchangeConfiguration {
  apiKey: string
  apiSecret: string
  apiPass?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
  feesPerMarketType: PerMarketTypeFees
  ignoredMarkets: string[]
  enabledMarketTypes?: string[] // e.g. ['linear', 'spot', 'inverse'] — absent = all tradable
  enabledQuoteCurrencies?: string[] // e.g. ['USDT', 'USDC'] — absent = all
  disabledQuoteCurrencies?: string[] // e.g. ['BRL'] — skip pairs quoted in these currencies
  ignoredFundingSymbols?: string[] // unified symbols to exclude from funding data (e.g. 'USDC/USDT:USDT')
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
  sellSpotBuyPerpEnabled: boolean
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

interface PerformanceMonitorConfig {
  enabled: boolean
  intervalMs: number
}

/**
 * One ingest worker in an explicit topology. Splitting a heavy exchange by
 * market type reuses WebSocketConfig.marketType filtering inside the worker.
 */
export interface IngestWorkerSpec {
  exchange: string
  /** Absent = the worker handles all of the exchange's market types. */
  marketType?: MarketType
}

interface IngestConfig {
  /** true = per-exchange ingest workers own the WS connections (Phase 2); false = legacy in-process path (rollback lever). */
  enabled: boolean
  /** Levels per side shipped from workers to main per book message. */
  depth: number
  /**
   * Explicit worker topology (Phase 3). Exchanges without an entry get one
   * worker covering all market types. Listing an exchange with marketTypes
   * spawns one worker per entry — market types not listed are NOT subscribed.
   */
  workers?: IngestWorkerSpec[]
}

export type StrategyType = 'funding' | 'spread'
export type StrategyVariant = 'sync' | 'async' | 'spread' | null

interface StrategyConfig {
  funding: {
    enabled: boolean
    entryWindowStart: number
    entryWindowEnd: number
    exitWindowStart: number
    exitWindowEnd: number
    exitWindowStartTakeProfitStopLoss: number
    exitWindowEndTakeProfitStopLoss: number
    minFundingProfitPercent: number
    minTotalProfitPercent: number
    takeProfitTargetPercent: number
    convergenceThresholdPercent: number
    minFundingProfitAsyncSyncExitPercent: number
    spreadWideningThresholdPercent: number
  }
  spread: {
    enabled: boolean
    fundingProfitEnabled: boolean
    entryWindowStart: number
    entryWindowEnd: number
    exitWindowStart: number
    exitWindowEnd: number
    minSpreadProfitPercent: number
    minTotalProfitPercent: number
    negativeFundingMultiplier: number
    takeProfitTargetPercent: number
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
  trackedPairsByQuote?: Record<string, string[]>
  minMarketPeers?: number
  arbitrage: ArbitrageConfig
  trading: TradingConfig
  accountSync: AccountSyncConfig
  funding: FundingConfig
  fundingFeeCollector: FundingFeeCollectorConfig
  performanceMonitor: PerformanceMonitorConfig
  ingest: IngestConfig
  strategy: StrategyConfig
}

function buildPerMarketTypeFees(rawFees: any, exchangeName: string): PerMarketTypeFees {
  if (!rawFees) throw new Error(`missing fees config for exchange: ${exchangeName}`)
  const spot = rawFees.spot ? { maker: rawFees.spot.maker, taker: rawFees.spot.taker } : undefined
  const linear = rawFees.linear ? { maker: rawFees.linear.maker, taker: rawFees.linear.taker } : undefined
  const inverse = rawFees.inverse ? { maker: rawFees.inverse.maker, taker: rawFees.inverse.taker } : undefined
  if (!spot && !linear && !inverse)
    throw new Error(`fees config for ${exchangeName} has no spot/linear/inverse entries`)
  return { spot, linear, inverse }
}

const KNOWN_EXCHANGES = ['binance', 'bybit', 'okx', 'bitget']
const MARKET_TYPE_VALUES = Object.values(MarketType) as string[]

/** Validate ingest.workers topology — fail fast on typos or overlapping specs. */
function parseIngestWorkers(raw: any): IngestWorkerSpec[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new Error('ingest.workers must be a list')

  const specs: IngestWorkerSpec[] = []
  const seen = new Set<string>()
  const untyped = new Set<string>()
  for (const entry of raw) {
    const exchange = entry?.exchange
    if (!KNOWN_EXCHANGES.includes(exchange)) {
      throw new Error(`ingest.workers: unknown exchange '${exchange}' (expected one of ${KNOWN_EXCHANGES.join(', ')})`)
    }
    const marketType = entry.marketType
    if (marketType !== undefined && !MARKET_TYPE_VALUES.includes(marketType)) {
      throw new Error(
        `ingest.workers: invalid marketType '${marketType}' for ${exchange} (expected one of ${MARKET_TYPE_VALUES.join(', ')})`
      )
    }
    const key = `${exchange}:${marketType ?? 'all'}`
    if (seen.has(key)) throw new Error(`ingest.workers: duplicate entry ${key}`)
    seen.add(key)
    if (marketType === undefined) untyped.add(exchange)
    specs.push({ exchange, marketType: marketType as MarketType | undefined })
  }
  // An all-types worker plus a typed worker for the same exchange would
  // double-subscribe that market type.
  for (const spec of specs) {
    if (spec.marketType !== undefined && untyped.has(spec.exchange)) {
      throw new Error(`ingest.workers: ${spec.exchange} has both an all-types entry and a marketType entry (overlap)`)
    }
  }
  return specs
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
      feesPerMarketType: buildPerMarketTypeFees(yamlConfig?.exchanges?.binance?.fees, 'binance'),
      ignoredMarkets: yamlConfig?.exchanges?.binance?.ignoredMarkets || [],
      enabledMarketTypes: yamlConfig?.exchanges?.binance?.enabledMarketTypes,
      enabledQuoteCurrencies: yamlConfig?.exchanges?.binance?.enabledQuoteCurrencies,
      disabledQuoteCurrencies: yamlConfig?.exchanges?.binance?.disabledQuoteCurrencies,
      ignoredFundingSymbols: yamlConfig?.exchanges?.binance?.ignoredFundingSymbols,
    },
    bybit: {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bybit?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bybit?.reconnectInterval,
      feesPerMarketType: buildPerMarketTypeFees(yamlConfig?.exchanges?.bybit?.fees, 'bybit'),
      ignoredMarkets: yamlConfig?.exchanges?.bybit?.ignoredMarkets || [],
      enabledMarketTypes: yamlConfig?.exchanges?.bybit?.enabledMarketTypes,
      enabledQuoteCurrencies: yamlConfig?.exchanges?.bybit?.enabledQuoteCurrencies,
      disabledQuoteCurrencies: yamlConfig?.exchanges?.bybit?.disabledQuoteCurrencies,
      ignoredFundingSymbols: yamlConfig?.exchanges?.bybit?.ignoredFundingSymbols,
    },
    okx: {
      apiKey: process.env.OKX_API_KEY || '',
      apiSecret: process.env.OKX_API_SECRET || '',
      apiPass: process.env.OKX_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.okx?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.okx?.reconnectInterval,
      feesPerMarketType: buildPerMarketTypeFees(yamlConfig?.exchanges?.okx?.fees, 'okx'),
      ignoredMarkets: yamlConfig?.exchanges?.okx?.ignoredMarkets || [],
      enabledMarketTypes: yamlConfig?.exchanges?.okx?.enabledMarketTypes,
      enabledQuoteCurrencies: yamlConfig?.exchanges?.okx?.enabledQuoteCurrencies,
      disabledQuoteCurrencies: yamlConfig?.exchanges?.okx?.disabledQuoteCurrencies,
      ignoredFundingSymbols: yamlConfig?.exchanges?.okx?.ignoredFundingSymbols,
    },
    bitget: {
      apiKey: process.env.BITGET_API_KEY || '',
      apiSecret: process.env.BITGET_API_SECRET || '',
      apiPass: process.env.BITGET_API_PASS || '',
      maxStreamsPerConnection: yamlConfig?.exchanges?.bitget?.maxStreamsPerConnection,
      reconnectInterval: yamlConfig?.exchanges?.bitget?.reconnectInterval,
      feesPerMarketType: buildPerMarketTypeFees(yamlConfig?.exchanges?.bitget?.fees, 'bitget'),
      ignoredMarkets: yamlConfig?.exchanges?.bitget?.ignoredMarkets || [],
      enabledMarketTypes: yamlConfig?.exchanges?.bitget?.enabledMarketTypes,
      enabledQuoteCurrencies: yamlConfig?.exchanges?.bitget?.enabledQuoteCurrencies,
      disabledQuoteCurrencies: yamlConfig?.exchanges?.bitget?.disabledQuoteCurrencies,
      ignoredFundingSymbols: yamlConfig?.exchanges?.bitget?.ignoredFundingSymbols,
    },
  },
  trackedPairs: [...(yamlConfig?.trackedPairs ?? []), ...Object.values(yamlConfig?.trackedPairsByQuote ?? {}).flat()],
  trackedPairsByQuote: yamlConfig?.trackedPairsByQuote,
  minMarketPeers: yamlConfig?.minMarketPeers ?? 0,
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
    sellSpotBuyPerpEnabled: yamlConfig?.arbitrage?.sellSpotBuyPerpEnabled ?? false,
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
  performanceMonitor: {
    enabled: yamlConfig?.performanceMonitor?.enabled ?? false,
    intervalMs: yamlConfig?.performanceMonitor?.intervalMs ?? 10000,
  },
  ingest: {
    enabled: yamlConfig?.ingest?.enabled ?? false,
    depth: yamlConfig?.ingest?.depth ?? 20,
    workers: parseIngestWorkers(yamlConfig?.ingest?.workers),
  },
  strategy: {
    funding: {
      enabled: yamlConfig?.strategy?.funding?.enabled ?? false,
      entryWindowStart: yamlConfig?.strategy?.funding?.entryWindowStart,
      entryWindowEnd: yamlConfig?.strategy?.funding?.entryWindowEnd,
      exitWindowStart: yamlConfig?.strategy?.funding?.exitWindowStart,
      exitWindowEnd: yamlConfig?.strategy?.funding?.exitWindowEnd,
      exitWindowStartTakeProfitStopLoss: yamlConfig?.strategy?.funding?.exitWindowStartTakeProfitStopLoss,
      exitWindowEndTakeProfitStopLoss: yamlConfig?.strategy?.funding?.exitWindowEndTakeProfitStopLoss,
      minFundingProfitPercent: yamlConfig?.strategy?.funding?.minFundingProfitPercent,
      minTotalProfitPercent: yamlConfig?.strategy?.funding?.minTotalProfitPercent,
      takeProfitTargetPercent: yamlConfig?.strategy?.funding?.takeProfitTargetPercent,
      convergenceThresholdPercent: yamlConfig?.strategy?.funding?.convergenceThresholdPercent,
      minFundingProfitAsyncSyncExitPercent: yamlConfig?.strategy?.funding?.minFundingProfitAsyncSyncExitPercent,
      spreadWideningThresholdPercent: yamlConfig?.strategy?.funding?.spreadWideningThresholdPercent,
    },
    spread: {
      enabled: yamlConfig?.strategy?.spread?.enabled ?? false,
      fundingProfitEnabled: yamlConfig?.strategy?.spread?.fundingProfitEnabled ?? true,
      entryWindowStart: yamlConfig?.strategy?.spread?.entryWindowStart,
      entryWindowEnd: yamlConfig?.strategy?.spread?.entryWindowEnd,
      exitWindowStart: yamlConfig?.strategy?.spread?.exitWindowStart,
      exitWindowEnd: yamlConfig?.strategy?.spread?.exitWindowEnd,
      minSpreadProfitPercent: yamlConfig?.strategy?.spread?.minSpreadProfitPercent,
      minTotalProfitPercent: yamlConfig?.strategy?.spread?.minTotalProfitPercent,
      negativeFundingMultiplier: yamlConfig?.strategy?.spread?.negativeFundingMultiplier,
      takeProfitTargetPercent: yamlConfig?.strategy?.spread?.takeProfitTargetPercent,
      convergenceThresholdPercent: yamlConfig?.strategy?.spread?.convergenceThresholdPercent,
      spreadWideningThresholdPercent: yamlConfig?.strategy?.spread?.spreadWideningThresholdPercent,
    },
  },
}

export { yamlConfig }

/** Get fee config for a specific exchange and market type. Throws if not configured. */
export function getFees(exchangeName: string, marketType: MarketType): FeeConfig {
  const exCfg = config.exchanges[exchangeName as keyof typeof config.exchanges]
  if (!exCfg) throw new Error(`getFees: unknown exchange: ${exchangeName}`)
  const perType = exCfg.feesPerMarketType[marketType as keyof PerMarketTypeFees]
  if (!perType) throw new Error(`getFees: no fee config for ${exchangeName}/${marketType}`)
  return perType
}

export default config
