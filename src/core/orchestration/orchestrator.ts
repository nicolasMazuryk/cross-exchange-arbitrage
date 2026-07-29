import { EventEmitter } from 'events'
import config, { IngestWorkerSpec } from '../../utils/config'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

const logger = new Logger('orchestrator')

// Core services
import { OrderbookManager } from '../orderbook/orderbookManager'
import { BookMirror } from '../orderbook/bookMirror'
import { IngestWorkerHost } from '../../ingest/ingestWorkerHost'
import { MarketLite } from '../../ingest/protocol'
import { ArbitrageEngine } from '../arbitrage/arbitrageEngine'
import { AccountSyncService } from '../state/accountSyncService'
import { State } from '../state/stateService'
import { TradeExecutor } from '../trading/tradeExecutor'
import { TradeMonitor } from '../trading/tradeMonitor'
import { Dictionary, Market } from 'ccxt'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { filterByPeerCount } from '../markets/peerFilter'
import { FundingService } from '../funding/fundingService'
import { FundingFeeCollector } from '../funding/fundingFeeCollector'
import { PerformanceMonitor } from '../monitoring'

// Utils
import { startOpportunityTracker } from '../../utils/opportunityTracker'
import { marketTypeFromCcxtMarket } from '../../utils/utils'

// REST adapters
import { BinanceExchange, BybitExchange, OkxExchange, BitgetExchange } from '../../adapters/rest'

// Public WebSocket adapters
import {
  BinancePublicWebSocketClient,
  BybitPublicWebSocketClient,
  OkxPublicWebSocketClient,
  BitgetPublicWebSocketClient,
} from '../../adapters/websocket'

// Types
import { WebSocketConfig } from '../../adapters/websocket/types'
import { ExchangeConfig } from '../../adapters/rest/types'
import { httpsAgentV4 } from '../../utils/network'

interface ExchangeServices {
  rest: any
  ws?: any
  accountWs?: any
  marketMetadata: MarketMetadataService
}

export class Orchestrator extends EventEmitter {
  private isInitialized = false
  private isShuttingDown = false
  // Separate from isShuttingDown: the signal handler sets isShuttingDown before
  // calling shutdown(), so shutdown() must gate re-entry on its own flag or it
  // no-ops on the very call that's supposed to do the work.
  private shutdownStarted = false

  // Core services
  private orderbookManager?: OrderbookManager
  // Set only when config.ingest.enabled — same object as orderbookManager.
  private bookMirror?: BookMirror
  private ingestHosts: Map<string, IngestWorkerHost> = new Map()
  private arbitrageEngine?: ArbitrageEngine
  private accountSyncService?: AccountSyncService
  private state?: State
  private tradeExecutor?: TradeExecutor
  private tradeMonitor?: TradeMonitor
  private fundingService?: FundingService
  private fundingFeeCollector?: FundingFeeCollector
  private performanceMonitor?: PerformanceMonitor

  // Exchange services
  private exchangeServices: Map<string, ExchangeServices> = new Map()

  // Shutdown handlers
  private shutdownHandlers: Array<() => Promise<void>> = []

  constructor() {
    super()
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn({ msg: 'Orchestrator already initialized', function: 'Orchestrator.initialize' })
      return
    }

    logger.info({ msg: '🚀 Initializing ArbiNet Orchestrator...', function: 'Orchestrator.initialize' })

    try {
      // Stage 1: Initialize REST clients
      await this.initializeRestClients()

      // Stage 2: Initialize funding service (needed by ArbitrageEngine)
      await this.initializeFundingService()

      // Stage 3: Initialize core services
      await this.initializeCoreServices()

      // Stage 4: Initialize state service
      await this.initializeStateService()

      // Stage 5: Initialize account sync service
      await this.initializeAccountSyncService()

      // Stage 6: Initialize trading services
      await this.initializeTradingServices()

      // Stage 7: Initialize WebSocket clients
      await this.initializePublicWebSocketClients()

      // Stage 8: Initialize funding fee collector
      await this.initializeFundingFeeCollector()

      // Stage 8.5: Initialize performance monitor (cheap; covers later init cost too)
      this.initializePerformanceMonitor()

      // Stage 9: Setup graceful shutdown
      this.setupGracefulShutdown()

      // Stage 10: Restore open tracked trades from Redis
      await this.tradeMonitor!.restoreState()

      this.isInitialized = true
      logger.info({ msg: '✅ ArbiNet Orchestrator initialized successfully', function: 'Orchestrator.initialize' })
    } catch (error) {
      logger.error({ msg: '❌ Failed to initialize Orchestrator', function: 'Orchestrator.initialize', error })
      await this.shutdown()
      throw error
    }
  }

  private async initializeRestClients(): Promise<void> {
    logger.info({ msg: '🔗 Initializing REST clients...', function: 'Orchestrator.initializeRestClients' })

    const exchanges = [
      {
        id: 'binance',
        client: new BinanceExchange({
          apiKey: config.exchanges.binance.apiKey,
          apiSecret: config.exchanges.binance.apiSecret,
          options: { agent: httpsAgentV4 },
        }),
      },
      {
        id: 'bybit',
        client: new BybitExchange({
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
          options: { agent: httpsAgentV4 },
        }),
      },
      {
        id: 'okx',
        client: new OkxExchange({
          apiKey: config.exchanges.okx.apiKey,
          apiSecret: config.exchanges.okx.apiSecret,
          apiPass: config.exchanges.okx.apiPass,
          options: { agent: httpsAgentV4 },
        }),
      },
      {
        id: 'bitget',
        client: new BitgetExchange({
          apiKey: config.exchanges.bitget.apiKey,
          apiSecret: config.exchanges.bitget.apiSecret,
          apiPass: config.exchanges.bitget.apiPass,
          options: { agent: httpsAgentV4 },
        }),
      },
    ]

    // Load markets for all exchanges
    await Promise.all(
      exchanges.map(async ({ id, client }) => {
        try {
          await client.loadMarkets()

          // Initialize market metadata service
          const markets = Object.values(client.getAllMarkets())
          const exchangeCfg = config.exchanges[id as keyof typeof config.exchanges]
          const marketMetadataService = new MarketMetadataService(
            id,
            markets as any[],
            exchangeCfg?.ignoredMarkets || [],
            exchangeCfg?.enabledMarketTypes,
            exchangeCfg?.enabledQuoteCurrencies
          )

          client.setMarketMetadataService(marketMetadataService)

          this.exchangeServices.set(id, {
            rest: client,
            marketMetadata: marketMetadataService,
          })

          logger.info({
            msg: 'REST client initialized',
            function: 'Orchestrator.initializeRestClients',
            exchange: id,
            marketCount: marketMetadataService.getAvailableSymbols().length,
          })
        } catch (error) {
          logger.error({
            msg: 'Failed to initialize REST client',
            function: 'Orchestrator.initializeRestClients',
            exchange: id,
            error,
          })
          throw error
        }
      })
    )

    logger.info({
      msg: '✅ All REST clients initialized',
      function: 'Orchestrator.initializeRestClients',
      exchangeCount: exchanges.length,
    })
  }

  private async initializeCoreServices(): Promise<void> {
    try {
      logger.info({ msg: '⚙️ Initializing core services...', function: 'Orchestrator.initializeCoreServices' })

      // Initialize Orderbook Manager. With ingest workers enabled the main
      // thread holds a read mirror instead — same public surface, so every
      // consumer (engine, executor, monitor, collector) is unchanged.
      if (config.ingest.enabled) {
        this.bookMirror = new BookMirror()
        this.orderbookManager = this.bookMirror
      } else {
        this.orderbookManager = new OrderbookManager()
      }
      logger.info({
        msg: '✅ Orderbook Manager initialized',
        function: 'Orchestrator.initializeCoreServices',
        ingestWorkers: config.ingest.enabled,
      })

      // Initialize Arbitrage Engine
      const exchangeConfigs = [
        { name: 'binance', isHealthy: true },
        { name: 'bybit', isHealthy: true },
        { name: 'okx', isHealthy: true },
        { name: 'bitget', isHealthy: true },
      ]

      // Create market metadata services map
      const marketMetadataServices = new Map<string, MarketMetadataService>()
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (services.marketMetadata) {
          marketMetadataServices.set(exchangeId, services.marketMetadata)
        }
      }

      const blacklistPairs = config.arbitrage.blacklistPairs || []
      this.arbitrageEngine = new ArbitrageEngine(
        this.orderbookManager,
        blacklistPairs,
        exchangeConfigs,
        marketMetadataServices,
        this.fundingService! // Pass funding service to arbitrage engine
      )

      // startOpportunityTracker(this.arbitrageEngine) // local-dev opportunity tracker

      // Listen for arbitrage opportunities
      this.arbitrageEngine.on('opportunities', opportunities => {
        // this.emit('arbitrageOpportunities', opportunities)
        // Process opportunities with trading services
        TraceContext.runWithExistingTrace(opportunities[0].traceId, 'arbitrage-opportunities', () => {
          if (this.tradeExecutor) {
            // this.processArbitrageOpportunities(opportunities)
          }
        })
      })

      logger.info({ msg: '✅ Arbitrage Engine initialized', function: 'Orchestrator.initializeCoreServices' })
      logger.info({ msg: '✅ Core services initialized', function: 'Orchestrator.initializeCoreServices' })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize core services',
        function: 'Orchestrator.initializeCoreServices',
        error,
      })
      throw error
    }
  }

  private async initializeStateService(): Promise<void> {
    try {
      logger.info({ msg: '💾 Initializing State Service...', function: 'Orchestrator.initializeStateService' })

      this.state = new State()

      // Connect to Redis
      try {
        await this.state.connect()
        logger.info({ msg: '✅ State Service connected to Redis', function: 'Orchestrator.initializeStateService' })
      } catch (error) {
        logger.error({
          msg: 'Failed to connect to Redis, continuing without persistence',
          function: 'Orchestrator.initializeStateService',
          error,
        })
        throw error
      }

      logger.info({ msg: '✅ State Service initialized', function: 'Orchestrator.initializeStateService' })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize State Service',
        function: 'Orchestrator.initializeStateService',
        error,
      })
      throw error
    }
  }

  private async initializeFundingService(): Promise<void> {
    try {
      logger.info({ msg: '💰 Initializing Funding Service...', function: 'Orchestrator.initializeFundingService' })

      // Create ccxt exchange instances for funding rate fetching
      const exchangeAdapters = new Map()

      // Add exchanges that support funding rates
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (config.funding.supportedExchanges.includes(exchangeId)) {
          // Get the exchange adapter for funding data fetching
          if (services.rest) {
            exchangeAdapters.set(exchangeId, services.rest)
          }
        }
      }

      if (exchangeAdapters.size !== this.exchangeServices.size) {
        const missing = Array.from(this.exchangeServices.keys()).filter(
          id => !config.funding.supportedExchanges.includes(id)
        )
        logger.error({
          msg: 'Some exchanges not in supported list for funding rate fetching — they will be skipped',
          function: 'Orchestrator.initializeFundingService',
          missingExchanges: missing,
          configuredExchanges: Array.from(this.exchangeServices.keys()),
          supportedExchanges: config.funding.supportedExchanges,
        })
      }

      // Create market metadata services map
      const marketMetadataServices = new Map<string, MarketMetadataService>()
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (services.marketMetadata) {
          marketMetadataServices.set(exchangeId, services.marketMetadata)
        }
      }

      // Initialize funding service
      this.fundingService = new FundingService(exchangeAdapters, marketMetadataServices, config.funding)

      // Set up funding service event listeners
      // this.fundingService.on('fundingDataUpdated', state => {})

      // Start the funding service
      this.fundingService.start()

      logger.info({
        msg: '✅ Funding Service initialized and started',
        function: 'Orchestrator.initializeFundingService',
        exchangeCount: exchangeAdapters.size,
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize Funding Service',
        function: 'Orchestrator.initializeFundingService',
        error,
      })
      throw error
    }
  }

  private async initializeTradingServices(): Promise<void> {
    try {
      logger.info({ msg: '💰 Initializing trading services...', function: 'Orchestrator.initializeTradingServices' })

      if (!this.accountSyncService || !this.orderbookManager) {
        throw new Error('Account sync service and orderbook manager must be initialized before trading services')
      }

      // Get REST clients map
      const restClients = new Map()
      const marketMetadataServices = new Map<string, MarketMetadataService>()
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (services.rest) {
          restClients.set(exchangeId, services.rest)
        }
        if (services.marketMetadata) {
          marketMetadataServices.set(exchangeId, services.marketMetadata)
        }
      }

      // Initialize Trade Executor
      if (!this.state) {
        throw new Error('State service must be initialized before trade executor')
      }
      this.tradeExecutor = new TradeExecutor(
        this.accountSyncService.getAccountStateManager(),
        restClients,
        this.orderbookManager,
        marketMetadataServices,
        this.state
      )

      // Initialize Trade Monitor
      const fundingService = this.fundingService
      if (!fundingService) {
        throw new Error('Funding service must be initialized before trade monitor')
      }
      if (!this.state) {
        throw new Error('State service must be initialized before trade monitor')
      }

      this.tradeMonitor = new TradeMonitor(
        this.accountSyncService.getAccountStateManager(),
        restClients,
        this.orderbookManager,
        marketMetadataServices,
        fundingService,
        {
          ...config.trading.monitor,
          strategy: {
            funding: {
              enabled: config.strategy.funding.enabled,
              exitWindowStart: config.strategy.funding.exitWindowStart,
              exitWindowEnd: config.strategy.funding.exitWindowEnd,
              exitWindowStartTakeProfitStopLoss: config.strategy.funding.exitWindowStartTakeProfitStopLoss,
              exitWindowEndTakeProfitStopLoss: config.strategy.funding.exitWindowEndTakeProfitStopLoss,
              takeProfitTargetPercent: config.strategy.funding.takeProfitTargetPercent,
              convergenceThresholdPercent: config.strategy.funding.convergenceThresholdPercent,
              spreadWideningThresholdPercent: config.strategy.funding.spreadWideningThresholdPercent,
              minFundingProfitPercent: config.strategy.funding.minFundingProfitPercent,
              minFundingProfitAsyncSyncExitPercent: config.strategy.funding.minFundingProfitAsyncSyncExitPercent,
            },
            spread: {
              enabled: config.strategy.spread.enabled,
              exitWindowStart: config.strategy.spread.exitWindowStart,
              exitWindowEnd: config.strategy.spread.exitWindowEnd,
              takeProfitTargetPercent: config.strategy.spread.takeProfitTargetPercent,
              convergenceThresholdPercent: config.strategy.spread.convergenceThresholdPercent,
              spreadWideningThresholdPercent: config.strategy.spread.spreadWideningThresholdPercent,
            },
          },
        },
        this.state
      )

      // Set up event listeners for trading
      this.setupTradingEventListeners()

      // Start the trade monitor
      this.tradeMonitor.start()

      logger.info({ msg: '✅ Trading services initialized', function: 'Orchestrator.initializeTradingServices' })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize trading services',
        function: 'Orchestrator.initializeTradingServices',
        error,
      })
      throw error
    }
  }

  private setupTradingEventListeners(): void {
    if (!this.tradeExecutor || !this.tradeMonitor) {
      logger.error({
        msg: 'Trading services not available for event setup',
        function: 'Orchestrator.setupTradingEventListeners',
      })
      throw new Error('Trading services not available for event setup')
    }
  }

  private async processArbitrageOpportunities(opportunities: any[]): Promise<void> {
    if (!this.tradeExecutor || !this.tradeMonitor) {
      logger.error({
        msg: 'Trading services not available for opportunity processing',
        function: 'Orchestrator.processArbitrageOpportunities',
      })
      throw new Error('Trading services not available for opportunity processing')
    }

    for (const opportunity of opportunities) {
      try {
        // Convert opportunity to trade parameters
        const tradeParams = {
          opportunity,
          timestamp: Date.now(),
        }

        // Execute the trade
        const tradeResult = await this.tradeExecutor.executeTrade(tradeParams)

        if (tradeResult && tradeResult.success) {
          // Add successful trade to monitoring
          this.tradeMonitor.addTrade(opportunity, tradeResult)

          logger.info({
            msg: 'Trade executed successfully',
            function: 'Orchestrator.processArbitrageOpportunities',
            tradeId: tradeResult.id,
            latencyMs: tradeResult.latencyMs,
          })
        } else {
          logger.debug({
            msg: 'Failed to execute arbitrage opportunity',
            function: 'Orchestrator.processArbitrageOpportunities',
            normalizedPair: opportunity.normalizedPair,
            buyExchange: opportunity.buyExchange,
            sellExchange: opportunity.sellExchange,
          })
        }
      } catch (error) {
        logger.error({
          msg: 'Failed to process opportunity',
          function: 'Orchestrator.processArbitrageOpportunities',
          normalizedPair: opportunity.normalizedPair,
          buyExchange: opportunity.buyExchange,
          sellExchange: opportunity.sellExchange,
          error,
        })
      }
    }
  }

  private async initializeAccountSyncService(): Promise<void> {
    try {
      logger.info({
        msg: '🔄 Initializing Account Sync Service...',
        function: 'Orchestrator.initializeAccountSyncService',
      })

      this.accountSyncService = new AccountSyncService()

      // Prepare exchange configurations for account sync
      const exchangeAccountConfigs = [
        {
          exchangeId: 'binance',
          wsConfig: {
            apiKey: config.exchanges.binance.apiKey,
            apiSecret: config.exchanges.binance.apiSecret,
            maxStreamsPerConnection: config.exchanges.binance.maxStreamsPerConnection,
            reconnectInterval: config.exchanges.binance.reconnectInterval,
          } as WebSocketConfig,
          restConfig: {
            apiKey: config.exchanges.binance.apiKey,
            apiSecret: config.exchanges.binance.apiSecret,
            options: { agent: httpsAgentV4 },
          } as ExchangeConfig,
          existingRestClient: this.exchangeServices.get('binance')?.rest,
        },
        {
          exchangeId: 'bybit',
          wsConfig: {
            apiKey: config.exchanges.bybit.apiKey,
            apiSecret: config.exchanges.bybit.apiSecret,
            maxStreamsPerConnection: config.exchanges.bybit.maxStreamsPerConnection,
            reconnectInterval: config.exchanges.bybit.reconnectInterval,
          } as WebSocketConfig,
          restConfig: {
            apiKey: config.exchanges.bybit.apiKey,
            apiSecret: config.exchanges.bybit.apiSecret,
            options: {
              agent: httpsAgentV4,
              defaultType: 'swap',
            },
          } as ExchangeConfig,
          existingRestClient: this.exchangeServices.get('bybit')?.rest,
        },
        {
          exchangeId: 'okx',
          wsConfig: {
            apiKey: config.exchanges.okx.apiKey,
            apiSecret: config.exchanges.okx.apiSecret,
            apiPass: config.exchanges.okx.apiPass,
            maxStreamsPerConnection: config.exchanges.okx.maxStreamsPerConnection,
            reconnectInterval: config.exchanges.okx.reconnectInterval,
          } as WebSocketConfig,
          restConfig: {
            apiKey: config.exchanges.okx.apiKey,
            apiSecret: config.exchanges.okx.apiSecret,
            apiPass: config.exchanges.okx.apiPass,
            options: {
              agent: httpsAgentV4,
              defaultType: 'swap',
            },
          } as ExchangeConfig,
          existingRestClient: this.exchangeServices.get('okx')?.rest,
        },
        {
          exchangeId: 'bitget',
          wsConfig: {
            apiKey: config.exchanges.bitget.apiKey,
            apiSecret: config.exchanges.bitget.apiSecret,
            apiPass: config.exchanges.bitget.apiPass,
            maxStreamsPerConnection: config.exchanges.bitget.maxStreamsPerConnection,
            reconnectInterval: config.exchanges.bitget.reconnectInterval,
          } as WebSocketConfig,
          restConfig: {
            apiKey: config.exchanges.bitget.apiKey,
            apiSecret: config.exchanges.bitget.apiSecret,
            apiPass: config.exchanges.bitget.apiPass,
            options: {
              agent: httpsAgentV4,
              defaultType: 'swap',
            },
          } as ExchangeConfig,
          existingRestClient: this.exchangeServices.get('bitget')?.rest,
        },
      ]

      await this.accountSyncService.initialize(exchangeAccountConfigs)
      logger.info({
        msg: '✅ Account Sync Service initialized',
        function: 'Orchestrator.initializeAccountSyncService',
        exchangeCount: exchangeAccountConfigs.length,
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize Account Sync Service',
        function: 'Orchestrator.initializeAccountSyncService',
        error,
      })
      throw error
    }
  }

  private async initializePublicWebSocketClients(): Promise<void> {
    logger.info({
      msg: '📡 Initializing WebSocket clients...',
      function: 'Orchestrator.initializePublicWebSocketClients',
    })

    // Fetch trading markets for all exchanges
    const exchangeMarkets = Array.from(this.exchangeServices.entries()).map(([exchangeId, services]) => {
      try {
        const markets = services.rest.getTradingMarkets()

        logger.info({
          msg: 'Found trading markets',
          function: 'Orchestrator.initializePublicWebSocketClients',
          exchange: exchangeId,
          marketCount: Object.keys(markets).length,
        })
        return { exchangeId, markets }
      } catch (error) {
        logger.error({
          msg: 'Failed to fetch markets',
          function: 'Orchestrator.initializePublicWebSocketClients',
          exchange: exchangeId,
          error,
        })
        throw error
      }
    })
    const marketsMap = new Map(exchangeMarkets.map(({ exchangeId, markets }) => [exchangeId, markets]))

    // Prune markets without enough arbitrage peers before subscribing (perf: fewer WS streams).
    const peerMetadataServices = new Map<string, MarketMetadataService>()
    for (const [exchangeId, services] of this.exchangeServices.entries()) {
      if (services.marketMetadata) {
        peerMetadataServices.set(exchangeId, services.marketMetadata)
      }
    }
    const { pruned: subscriptionMarkets, stats: peerStats } = filterByPeerCount(
      marketsMap,
      peerMetadataServices,
      config.minMarketPeers ?? 0
    )
    logger.info({
      msg: peerStats.enabled ? '🔎 Peer filter applied' : 'Peer filter disabled (minMarketPeers=0)',
      function: 'Orchestrator.initializePublicWebSocketClients',
      ...peerStats,
    })

    // Phase 2 ingest path: per-exchange worker threads own the WS connections;
    // main thread only mirrors books. Legacy in-process path below stays as
    // the rollback lever (ingest.enabled: false).
    if (config.ingest.enabled) {
      await this.initializeIngestWorkers(subscriptionMarkets)
      return
    }

    // Initialize WebSocket clients
    const wsClients = [
      {
        id: 'binance',
        client: new BinancePublicWebSocketClient({
          apiKey: config.exchanges.binance.apiKey,
          apiSecret: config.exchanges.binance.apiSecret,
          maxStreamsPerConnection: config.exchanges.binance.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.binance.reconnectInterval,
        }),
      },
      {
        id: 'bybit',
        client: new BybitPublicWebSocketClient({
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
          maxStreamsPerConnection: config.exchanges.bybit.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.bybit.reconnectInterval,
        }),
      },
      {
        id: 'okx',
        client: new OkxPublicWebSocketClient({
          apiKey: config.exchanges.okx.apiKey,
          apiSecret: config.exchanges.okx.apiSecret,
          apiPass: config.exchanges.okx.apiPass,
          maxStreamsPerConnection: config.exchanges.okx.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.okx.reconnectInterval,
        }),
      },
      {
        id: 'bitget',
        client: new BitgetPublicWebSocketClient({
          apiKey: config.exchanges.bitget.apiKey,
          apiSecret: config.exchanges.bitget.apiSecret,
          apiPass: config.exchanges.bitget.apiPass,
          maxStreamsPerConnection: config.exchanges.bitget.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.bitget.reconnectInterval,
        }),
      },
    ]

    // Initialize and connect WebSocket clients
    await Promise.all(
      wsClients.map(async ({ id, client }) => {
        try {
          const markets = subscriptionMarkets.get(id) || ({} as Dictionary<Market>)
          await client.initialize(markets)

          const services = this.exchangeServices.get(id)!
          services.ws = client

          logger.debug({
            msg: 'WebSocket client initialized',
            function: 'Orchestrator.initializePublicWebSocketClients',
            exchange: id,
          })
        } catch (error) {
          logger.error({
            msg: 'Failed to initialize WebSocket client',
            function: 'Orchestrator.initializePublicWebSocketClients',
            exchange: id,
            error,
          })
          throw error
        }
      })
    )

    // Connect WebSocket clients to orderbook manager
    if (this.orderbookManager) {
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (services.ws) {
          services.ws.on('orderbookUpdate', (update: any) => {
            this.orderbookManager!.updateOrderbook(update)
          })
          logger.info({
            msg: 'WebSocket connected to Orderbook Manager',
            function: 'Orchestrator.initializePublicWebSocketClients',
            exchange: exchangeId,
          })
        }
      }
    }

    logger.info({
      msg: '✅ All WebSocket clients initialized and connected',
      function: 'Orchestrator.initializePublicWebSocketClients',
      clientCount: wsClients.length,
    })
  }

  private async initializeIngestWorkers(subscriptionMarkets: Map<string, Dictionary<Market>>): Promise<void> {
    if (!this.bookMirror) {
      throw new Error('BookMirror must be initialized before ingest workers')
    }
    const mirror = this.bookMirror

    // Resolve topology: explicit ingest.workers specs, one implicit all-types
    // worker for every exchange not listed (config.ts validated the specs).
    const specsByExchange = new Map<string, IngestWorkerSpec[]>()
    for (const spec of config.ingest.workers ?? []) {
      const specs = specsByExchange.get(spec.exchange) ?? []
      specs.push(spec)
      specsByExchange.set(spec.exchange, specs)
    }
    const workerSpecs: IngestWorkerSpec[] = []
    for (const exchangeId of this.exchangeServices.keys()) {
      workerSpecs.push(...(specsByExchange.get(exchangeId) ?? [{ exchange: exchangeId }]))
    }

    await Promise.all(
      workerSpecs.map(async spec => {
        const exchangeId = spec.exchange
        const workerLabel = spec.marketType ? `${exchangeId}:${spec.marketType}` : exchangeId
        try {
          const markets = subscriptionMarkets.get(exchangeId) || ({} as Dictionary<Market>)
          const marketsLite: MarketLite[] = []
          let skippedByType = 0
          for (const m of Object.values(markets)) {
            if (!m || !m.id || !m.symbol) continue
            // Ship only the split worker's market type — the worker's WS client
            // filters again (base.ts filterMarketType), this just trims the payload.
            if (spec.marketType) {
              try {
                if (marketTypeFromCcxtMarket(m) !== spec.marketType) {
                  skippedByType++
                  continue
                }
              } catch {
                skippedByType++
                continue
              }
            }
            marketsLite.push({
              id: m.id,
              symbol: m.symbol,
              base: m.base ?? '',
              quote: m.quote ?? '',
              type: (m.type as string) ?? '',
              spot: m.spot,
              swap: m.swap,
              linear: m.linear ?? undefined,
              inverse: m.inverse ?? undefined,
              contract: m.contract ?? undefined,
            })
          }

          const exchangeCfg = config.exchanges[exchangeId as keyof typeof config.exchanges]
          const host = new IngestWorkerHost(
            exchangeId,
            {
              apiKey: exchangeCfg.apiKey,
              apiSecret: exchangeCfg.apiSecret,
              apiPass: exchangeCfg.apiPass,
              maxStreamsPerConnection: exchangeCfg.maxStreamsPerConnection,
              reconnectInterval: exchangeCfg.reconnectInterval,
              marketType: spec.marketType,
            } as WebSocketConfig,
            marketsLite,
            { depth: config.ingest.depth },
            mirror
          )

          await host.start()
          this.ingestHosts.set(workerLabel, host)

          logger.info({
            msg: 'Ingest worker started',
            function: 'Orchestrator.initializeIngestWorkers',
            worker: workerLabel,
            marketCount: marketsLite.length,
            ...(spec.marketType && { skippedByType }),
            depth: config.ingest.depth,
          })
        } catch (error) {
          logger.error({
            msg: 'Failed to start ingest worker',
            function: 'Orchestrator.initializeIngestWorkers',
            worker: workerLabel,
            error,
          })
          throw error
        }
      })
    )

    // A split exchange only subscribes the market types listed for it — warn
    // about tracked markets no worker covers.
    for (const [exchangeId, specs] of specsByExchange.entries()) {
      const covered = new Set(specs.map(s => s.marketType))
      if (covered.has(undefined)) continue
      const markets = subscriptionMarkets.get(exchangeId)
      if (!markets) continue
      const uncovered: string[] = []
      for (const m of Object.values(markets)) {
        try {
          if (m && !covered.has(marketTypeFromCcxtMarket(m))) uncovered.push(m.symbol)
        } catch {
          if (m?.symbol) uncovered.push(m.symbol)
        }
      }
      if (uncovered.length > 0) {
        logger.warn({
          msg: 'Ingest topology leaves markets unsubscribed (no worker covers their market type)',
          function: 'Orchestrator.initializeIngestWorkers',
          exchange: exchangeId,
          uncoveredCount: uncovered.length,
          sample: uncovered.slice(0, 10),
        })
      }
    }

    logger.info({
      msg: '✅ All ingest workers started',
      function: 'Orchestrator.initializeIngestWorkers',
      workerCount: this.ingestHosts.size,
      workers: Array.from(this.ingestHosts.keys()),
    })
  }

  private async initializeFundingFeeCollector(): Promise<void> {
    try {
      logger.info({
        msg: '💰 Initializing Funding Fee Collector...',
        function: 'Orchestrator.initializeFundingFeeCollector',
      })

      if (!this.state) {
        throw new Error('State service must be initialized before funding fee collector')
      }

      if (!this.fundingService) {
        throw new Error('Funding service must be initialized before funding fee collector')
      }

      // Get REST clients map
      const restClients = new Map()
      for (const [exchangeId, services] of this.exchangeServices.entries()) {
        if (services.rest) {
          restClients.set(exchangeId, services.rest)
        }
      }

      // Initialize Funding Fee Collector
      this.fundingFeeCollector = new FundingFeeCollector(
        restClients,
        this.state,
        this.fundingService,
        config.fundingFeeCollector.cronPattern,
        this.orderbookManager
      )

      // Start the collector
      this.fundingFeeCollector.start()

      logger.info({
        msg: '✅ Funding Fee Collector initialized and started',
        function: 'Orchestrator.initializeFundingFeeCollector',
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize Funding Fee Collector',
        function: 'Orchestrator.initializeFundingFeeCollector',
        error,
      })
      throw error
    }
  }

  private initializePerformanceMonitor(): void {
    try {
      if (!config.performanceMonitor.enabled) {
        logger.info({
          msg: '⏭️ Performance Monitor disabled by config, skipping',
          function: 'Orchestrator.initializePerformanceMonitor',
        })
        return
      }

      logger.info({
        msg: '📈 Initializing Performance Monitor...',
        function: 'Orchestrator.initializePerformanceMonitor',
      })

      this.performanceMonitor = new PerformanceMonitor(config.performanceMonitor.intervalMs)
      this.performanceMonitor.start()

      logger.info({
        msg: '✅ Performance Monitor initialized and started',
        function: 'Orchestrator.initializePerformanceMonitor',
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize Performance Monitor',
        function: 'Orchestrator.initializePerformanceMonitor',
        error,
      })
      throw error
    }
  }

  private setupGracefulShutdown(): void {
    logger.info({ msg: '🛡️ Setting up graceful shutdown handlers...', function: 'Orchestrator.setupGracefulShutdown' })

    const shutdownHandler = async (signal: string) => {
      if (this.isShuttingDown) {
        return
      }

      this.isShuttingDown = true
      logger.warn({
        msg: 'Received shutdown signal, initiating graceful shutdown',
        function: 'Orchestrator.setupGracefulShutdown',
        signal,
      })

      try {
        await this.shutdown()
        logger.info({ msg: '✅ Graceful shutdown completed', function: 'Orchestrator.setupGracefulShutdown' })
        process.exit(0)
      } catch (error) {
        logger.error({ msg: '❌ Error during shutdown', function: 'Orchestrator.setupGracefulShutdown', error })
        process.exit(1)
      }
    }

    process.on('SIGINT', () => shutdownHandler('SIGINT'))
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'))

    // Handle uncaught exceptions
    process.on('uncaughtException', error => {
      logger.fatal({ msg: '💥 Uncaught Exception', function: 'Orchestrator.setupGracefulShutdown', error })
      shutdownHandler('uncaughtException')
    })

    // Handle unhandled promise rejections
    process.on('unhandledRejection', reason => {
      logger.fatal({
        msg: '💥 Unhandled Rejection',
        function: 'Orchestrator.setupGracefulShutdown',
        reason: reason instanceof Error ? reason : String(reason),
      })
      shutdownHandler('unhandledRejection')
    })

    logger.info({ msg: '✅ Graceful shutdown handlers configured', function: 'Orchestrator.setupGracefulShutdown' })
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) {
      return
    }
    this.shutdownStarted = true

    logger.info({ msg: '🔄 Shutting down ArbiNet Orchestrator...', function: 'Orchestrator.shutdown' })

    // Shutdown in reverse order of initialization
    const shutdownTasks: Array<() => Promise<void>> = []

    // 0. Shutdown performance monitor
    if (this.performanceMonitor) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Performance Monitor...', function: 'Orchestrator.shutdown' })
        this.performanceMonitor!.stop()
        logger.info({ msg: '✅ Performance Monitor shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 1. Shutdown funding fee collector
    if (this.fundingFeeCollector) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Funding Fee Collector...', function: 'Orchestrator.shutdown' })
        this.fundingFeeCollector!.stop()
        logger.info({ msg: '✅ Funding Fee Collector shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 2. Shutdown trade monitor
    if (this.tradeMonitor) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Trade Monitor...', function: 'Orchestrator.shutdown' })
        this.tradeMonitor!.stop()
        logger.info({ msg: '✅ Trade Monitor shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 3. Shutdown state service
    if (this.state) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down State Service...', function: 'Orchestrator.shutdown' })
        await this.state!.disconnect()
        logger.info({ msg: '✅ State Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 4. Shutdown account sync service
    if (this.accountSyncService) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Account Sync Service...', function: 'Orchestrator.shutdown' })
        await this.accountSyncService!.shutdown()
        logger.info({ msg: '✅ Account Sync Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 5a. Shutdown ingest workers (Phase 2 path)
    for (const [workerLabel, host] of this.ingestHosts.entries()) {
      shutdownTasks.push(async () => {
        logger.info({ msg: 'Shutting down ingest worker', function: 'Orchestrator.shutdown', worker: workerLabel })
        await host.close()
        logger.info({
          msg: 'Ingest worker shutdown complete',
          function: 'Orchestrator.shutdown',
          worker: workerLabel,
        })
      })
    }

    // 5. Shutdown WebSocket clients
    for (const [exchangeId, services] of this.exchangeServices.entries()) {
      if (services.ws) {
        shutdownTasks.push(async () => {
          logger.info({
            msg: 'Shutting down WebSocket client',
            function: 'Orchestrator.shutdown',
            exchange: exchangeId,
          })
          services.ws.close()
          logger.info({
            msg: 'WebSocket client shutdown complete',
            function: 'Orchestrator.shutdown',
            exchange: exchangeId,
          })
        })
      }
    }

    // 6. Shutdown funding service
    if (this.fundingService) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Funding Service...', function: 'Orchestrator.shutdown' })
        this.fundingService!.stop()
        logger.info({ msg: '✅ Funding Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 7. Shutdown core services
    if (this.arbitrageEngine) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Arbitrage Engine...', function: 'Orchestrator.shutdown' })
        // Add any cleanup logic for arbitrage engine
        logger.info({ msg: '✅ Arbitrage Engine shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // Execute shutdown tasks
    for (const task of shutdownTasks) {
      try {
        await task()
      } catch (error) {
        logger.error({ msg: '❌ Error during shutdown task', function: 'Orchestrator.shutdown', error })
      }
    }

    this.isInitialized = false
    logger.info({ msg: '✅ ArbiNet Orchestrator shutdown complete', function: 'Orchestrator.shutdown' })
  }

  // Public getters for accessing services
  getOrderbookManager(): OrderbookManager | undefined {
    return this.orderbookManager
  }

  getArbitrageEngine(): ArbitrageEngine | undefined {
    return this.arbitrageEngine
  }

  getAccountSyncService(): AccountSyncService | undefined {
    return this.accountSyncService
  }

  getExchangeServices(): Map<string, ExchangeServices> {
    return this.exchangeServices
  }

  getTradeExecutor(): TradeExecutor | undefined {
    return this.tradeExecutor
  }

  getTradeMonitor(): TradeMonitor | undefined {
    return this.tradeMonitor
  }

  getFundingService(): FundingService | undefined {
    return this.fundingService
  }

  getFundingFeeCollector(): FundingFeeCollector | undefined {
    return this.fundingFeeCollector
  }

  isServiceInitialized(): boolean {
    return this.isInitialized
  }

  // async testOrderCreation(): Promise<void> {
  //   const exchangeServices = this.getExchangeServices()

  //   for (const [exchangeId, services] of exchangeServices.entries()) {
  //     if (exchangeId !== 'bybit') continue

  //     try {
  //       const testSymbol = '1000PEPE/USDT:USDT'

  //       const openOrder = await services.rest.createOrder(
  //         testSymbol,
  //         'LIMIT',
  //         'BUY',
  //         100,
  //         0.0127,
  //         false,
  //         new Date().getTime().toString()
  //       )
  //       await new Promise(resolve => setTimeout(resolve, 20000))

  //       // await services.rest.cancelOrder(openOrder.id, testSymbol)

  //       const closeOrder = await services.rest.createOrder(
  //         testSymbol,
  //         'MARKET',
  //         'SELL',
  //         100,
  //         0.0127,
  //         true,
  //         new Date().getTime().toString()
  //       )
  //     } catch (error) {
  //       logger.error({
  //         msg: 'Order creation test failed',
  //         function: 'Orchestrator.testOrderCreation',
  //         exchange: exchangeId,
  //         error,
  //       })
  //       continue
  //     }
  //   }
  // }
}

// Factory function for easy initialization
export async function createOrchestrator(): Promise<Orchestrator> {
  const orchestrator = new Orchestrator()
  await orchestrator.initialize()

  // Temporary test order placement
  // await orchestrator.testOrderCreation()

  return orchestrator
}

// Default export for backward compatibility
export default Orchestrator
