import { EventEmitter } from 'events'
import config from '../../utils/config'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

const logger = new Logger('orchestrator')

// Core services
import { OrderbookManager } from '../orderbook/orderbookManager'
import { ArbitrageEngine } from '../arbitrage/arbitrageEngine'
import { AccountSyncService } from '../state/accountSyncService'
import { State } from '../state/stateService'
import { TradeExecutor } from '../trading/tradeExecutor'
import { TradeMonitor } from '../trading/tradeMonitor'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { FundingService } from '../funding/fundingService'

// REST adapters
import { BinanceExchange, BybitExchange, OkxExchange, BitgetExchange } from '../../adapters/rest'

// Public WebSocket adapters
import {
  BinancePublicWebSocketClient,
  BybitPublicWebSocketClient,
  OkxPublicWebSocketClient,
  BitgetPublicWebSocketClient,
} from '../../adapters/websocket'

// Private WebSocket adapters
import {
  BinancePrivateWebSocketClient,
  BybitPrivateWebSocketClient,
  OKXPrivateWebSocketClient,
  BitgetPrivateWebSocketClient,
} from '../../adapters/websocket/private'

// Types
import { WebSocketConfig } from '../../adapters/websocket/types'
import { ExchangeConfig } from '../../adapters/rest/types'
import { AccountStateUpdate } from '../../types/account'

interface ExchangeServices {
  rest: any
  ws?: any
  accountWs?: any
  marketMetadata: MarketMetadataService
}

export class Orchestrator extends EventEmitter {
  private isInitialized = false
  private isShuttingDown = false

  // Core services
  private orderbookManager?: OrderbookManager
  private arbitrageEngine?: ArbitrageEngine
  private accountSyncService?: AccountSyncService
  private state?: State
  private tradeExecutor?: TradeExecutor
  private tradeMonitor?: TradeMonitor
  private fundingService?: FundingService

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

      // Stage 8: Setup graceful shutdown
      this.setupGracefulShutdown()

      // Stage 9: Restore open tracked trades from Redis
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
        }),
      },
      {
        id: 'bybit',
        client: new BybitExchange({
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
        }),
      },
      {
        id: 'okx',
        client: new OkxExchange({
          apiKey: config.exchanges.okx.apiKey,
          apiSecret: config.exchanges.okx.apiSecret,
          apiPass: config.exchanges.okx.apiPass,
        }),
      },
      {
        id: 'bitget',
        client: new BitgetExchange({
          apiKey: config.exchanges.bitget.apiKey,
          apiSecret: config.exchanges.bitget.apiSecret,
          apiPass: config.exchanges.bitget.apiPass,
        }),
      },
    ]

    // Load markets for all exchanges
    await Promise.all(
      exchanges.map(async ({ id, client }) => {
        try {
          await client.loadMarkets()

          // Initialize market metadata service
          const markets = Object.values((client as any).exchange.markets || {})
          const ignoredMarkets = config.exchanges[id as keyof typeof config.exchanges]?.ignoredMarkets || []
          const marketMetadataService = new MarketMetadataService(id, markets as any[], ignoredMarkets)

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

      // Initialize Orderbook Manager
      this.orderbookManager = new OrderbookManager()
      logger.info({ msg: '✅ Orderbook Manager initialized', function: 'Orchestrator.initializeCoreServices' })

      // Initialize Arbitrage Engine
      const exchangeConfigs = [
        {
          name: 'binance',
          isHealthy: true,
          feeModel: {
            maker: config.exchanges.binance.fees.maker,
            taker: config.exchanges.binance.fees.taker,
          },
        },
        {
          name: 'bybit',
          isHealthy: true,
          feeModel: {
            maker: config.exchanges.bybit.fees.maker,
            taker: config.exchanges.bybit.fees.taker,
          },
        },
        {
          name: 'okx',
          isHealthy: true,
          feeModel: {
            maker: config.exchanges.okx.fees.maker,
            taker: config.exchanges.okx.fees.taker,
          },
        },
        {
          name: 'bitget',
          isHealthy: true,
          feeModel: {
            maker: config.exchanges.bitget.fees.maker,
            taker: config.exchanges.bitget.fees.taker,
          },
        },
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

      // Listen for arbitrage opportunities
      this.arbitrageEngine.on('opportunities', opportunities => {
        // this.emit('arbitrageOpportunities', opportunities)
        // Process opportunities with trading services
        TraceContext.runWithExistingTrace(opportunities[0].traceId, 'arbitrage-opportunities', () => {
          if (this.tradeExecutor) {
            this.processArbitrageOpportunities(opportunities)
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
        logger.error({
          msg: '⚠️ Mismatch between exchanges and supported exchanges for funding rate fetching',
          function: 'Orchestrator.initializeFundingService',
        })
        throw new Error('Mismatch between exchanges and supported exchanges for funding rate fetching')
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
      this.fundingService.on('fundingDataUpdated', state => {})

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
      this.tradeExecutor = new TradeExecutor(
        this.accountSyncService.getAccountStateManager(),
        restClients,
        this.orderbookManager,
        marketMetadataServices
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
              windowStart: config.strategy.funding.windowStart,
              windowEnd: config.strategy.funding.windowEnd,
              convergenceThresholdPercent: config.strategy.funding.convergenceThresholdPercent,
              spreadWideningThresholdPercent: config.strategy.funding.spreadWideningThresholdPercent,
              minFundingProfitPercent: config.strategy.funding.minFundingProfitPercent,
              minFundingProfitAsyncSyncExitPercent: config.strategy.funding.minFundingProfitAsyncSyncExitPercent,
            },
            spread: {
              enabled: config.strategy.spread.enabled,
              windowStart: config.strategy.spread.windowStart,
              windowEnd: config.strategy.spread.windowEnd,
              windowEndClose: config.strategy.spread.windowEndClose,
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
        const result = await this.tradeExecutor.executeTrade(tradeParams)

        if (result && result.success) {
          // Add successful trade to monitoring
          this.tradeMonitor.addTrade(result)

          logger.info({
            msg: 'Trade executed successfully',
            function: 'Orchestrator.processArbitrageOpportunities',
            tradeId: result.id,
            latencyMs: result.latencyMs,
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
          } as ExchangeConfig,
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
              defaultType: 'swap', // Use USDT Futures
              defaultSubType: 'linear', // USDT linear contracts
              defaultSettleType: 'linear', // Linear settlement
            },
          } as ExchangeConfig,
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
              defaultType: 'swap', // Use USDT Futures
              defaultSubType: 'linear', // USDT linear contracts
              defaultSettleType: 'linear', // Linear settlement
            },
          } as ExchangeConfig,
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
              defaultType: 'swap', // Use USDT Futures
              defaultSubType: 'linear', // USDT linear contracts
              defaultSettleType: 'linear', // Linear settlement
            },
          } as ExchangeConfig,
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
          msg: 'Found USDT perpetual futures markets',
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
          const markets = marketsMap.get(id) || []
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
          services.ws.on('orderbookUpdate', async (update: any) => {
            TraceContext.runWithExistingTrace(update.traceId, 'orderbook-update', () => {
              this.orderbookManager!.updateOrderbook(update)
            })
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
    if (!this.isInitialized || this.isShuttingDown) {
      return
    }

    logger.info({ msg: '🔄 Shutting down ArbiNet Orchestrator...', function: 'Orchestrator.shutdown' })

    // Shutdown in reverse order of initialization
    const shutdownTasks: Array<() => Promise<void>> = []

    // 1. Shutdown trade monitor
    if (this.tradeMonitor) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Trade Monitor...', function: 'Orchestrator.shutdown' })
        this.tradeMonitor!.stop()
        logger.info({ msg: '✅ Trade Monitor shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 2. Shutdown state service
    if (this.state) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down State Service...', function: 'Orchestrator.shutdown' })
        await this.state!.disconnect()
        logger.info({ msg: '✅ State Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 3. Shutdown account sync service
    if (this.accountSyncService) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Account Sync Service...', function: 'Orchestrator.shutdown' })
        await this.accountSyncService!.shutdown()
        logger.info({ msg: '✅ Account Sync Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 4. Shutdown WebSocket clients
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

    // 5. Shutdown funding service
    if (this.fundingService) {
      shutdownTasks.push(async () => {
        logger.info({ msg: '🔄 Shutting down Funding Service...', function: 'Orchestrator.shutdown' })
        this.fundingService!.stop()
        logger.info({ msg: '✅ Funding Service shutdown complete', function: 'Orchestrator.shutdown' })
      })
    }

    // 6. Shutdown core services
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

  isServiceInitialized(): boolean {
    return this.isInitialized
  }

  async testOrderCreation(): Promise<void> {
    const exchangeServices = this.getExchangeServices()

    for (const [exchangeId, services] of exchangeServices.entries()) {
      if (exchangeId !== 'bybit') continue

      try {
        const testSymbol = '1000PEPE/USDT:USDT'

        const openOrder = await services.rest.createOrder(
          testSymbol,
          'LIMIT',
          'BUY',
          100,
          0.0127,
          false,
          new Date().getTime().toString()
        )
        await new Promise(resolve => setTimeout(resolve, 20000))

        // await services.rest.cancelOrder(openOrder.id, testSymbol)

        const closeOrder = await services.rest.createOrder(
          testSymbol,
          'MARKET',
          'SELL',
          100,
          0.0127,
          true,
          new Date().getTime().toString()
        )
      } catch (error) {
        logger.error({
          msg: 'Order creation test failed',
          function: 'Orchestrator.testOrderCreation',
          exchange: exchangeId,
          error,
        })
        continue
      }
    }
  }
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
