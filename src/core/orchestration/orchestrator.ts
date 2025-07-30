import { EventEmitter } from 'events'
import config from '../../utils/config'
import logger from '../../utils/logger'

// Core services
import { OrderbookManager } from '../orderbook/orderbookManager'
import { ArbitrageEngine } from '../arbitrage/arbitrageEngine'
import { AccountSyncService } from '../state/accountSyncService'
import { TradeExecutor } from '../trading/tradeExecutor'
import { TradeMonitor } from '../trading/tradeMonitor'
import { MarketMetadataService } from '../markets/marketMetadataService'

// REST adapters
import {
  BinanceExchange,
  BybitExchange,
  OkxExchange,
  BitgetExchange
} from '../../adapters/rest'

// Public WebSocket adapters
import {
  BinancePublicWebSocketClient,
  BybitPublicWebSocketClient,
  OkxPublicWebSocketClient,
  BitgetPublicWebSocketClient
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
  private tradeExecutor?: TradeExecutor
  private tradeMonitor?: TradeMonitor

  // Exchange services
  private exchangeServices: Map<string, ExchangeServices> = new Map()

  // Shutdown handlers
  private shutdownHandlers: Array<() => Promise<void>> = []

  constructor() {
    super()
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Orchestrator already initialized')
      return
    }

    logger.info('🚀 Initializing ArbiNet Orchestrator...', {
      environment: config.app.environment,
      version: config.app.version
    })

    try {
      // Stage 1: Initialize REST clients
      await this.initializeRestClients()

      // Stage 2: Initialize core services
      await this.initializeCoreServices()

      // Stage 3: Initialize account sync service
      await this.initializeAccountSyncService()

      // Stage 4: Initialize trading services
      await this.initializeTradingServices()

      // Stage 5: Initialize WebSocket clients
      await this.initializePublicWebSocketClients()

      // Stage 6: Setup graceful shutdown
      this.setupGracefulShutdown()

      this.isInitialized = true
      logger.info('✅ ArbiNet Orchestrator initialized successfully')

      this.emit('initialized')
    } catch (error) {
      logger.error('❌ Failed to initialize Orchestrator:', error)
      await this.shutdown()
      throw error
    }
  }

  private async initializeRestClients(): Promise<void> {
    logger.info('🔗 Initializing REST clients...')

    const exchanges = [
      // {
      //   id: 'binance',
      //   client: new BinanceExchange({
      //     apiKey: config.exchanges.binance.apiKey,
      //     apiSecret: config.exchanges.binance.apiSecret,
      //   })
      // },
      {
        id: 'bybit',
        client: new BybitExchange({
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
        })
      },
      {
        id: 'okx',
        client: new OkxExchange({
          apiKey: config.exchanges.okx.apiKey,
          apiSecret: config.exchanges.okx.apiSecret,
          apiPass: config.exchanges.okx.apiPass,
        })
      },
      {
        id: 'bitget',
        client: new BitgetExchange({
          apiKey: config.exchanges.bitget.apiKey,
          apiSecret: config.exchanges.bitget.apiSecret,
          apiPass: config.exchanges.bitget.apiPass,
        })
      }
    ]

    // Load markets for all exchanges
    await Promise.all(
      exchanges.map(async ({ id, client }) => {
        try {
          await client.loadMarkets()
          
          // Initialize market metadata service
          const markets = Object.values((client as any).exchange.markets || {})
          const marketMetadataService = new MarketMetadataService(id, markets as any[])
          
          this.exchangeServices.set(id, { 
            rest: client, 
            marketMetadata: marketMetadataService 
          })
          
          logger.info(`✅ [${id}] REST client initialized with ${marketMetadataService.getAvailableSymbols().length} markets`)
        } catch (error) {
          logger.error(`❌ [${id}] Failed to initialize REST client:`, error)
          throw error
        }
      })
    )

    logger.info('✅ All REST clients initialized')
  }

  private async initializeCoreServices(): Promise<void> {
    logger.info('⚙️ Initializing core services...')

    // Initialize Orderbook Manager
    this.orderbookManager = new OrderbookManager()
    logger.info('✅ Orderbook Manager initialized')

    // Initialize Arbitrage Engine
    const exchangeConfigs = [
      // {
      //   name: 'binance',
      //   isHealthy: true,
      //   feeModel: {
      //     maker: config.exchanges.binance.fees.maker,
      //     taker: config.exchanges.binance.fees.taker
      //   }
      // },
      {
        name: 'bybit',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.bybit.fees.maker,
          taker: config.exchanges.bybit.fees.taker
        }
      },
      {
        name: 'okx',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.okx.fees.maker,
          taker: config.exchanges.okx.fees.taker
        }
      },
      {
        name: 'bitget',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.bitget.fees.maker,
          taker: config.exchanges.bitget.fees.taker
        }
      }
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
      marketMetadataServices
    )

    // Listen for arbitrage opportunities
    this.arbitrageEngine.on('opportunities', (opportunities) => {
      this.emit('arbitrageOpportunities', opportunities)
      // Process opportunities with trading services
      if (this.tradeExecutor) {
        this.processArbitrageOpportunities(opportunities)
      }
    })

    logger.info('✅ Arbitrage Engine initialized')
    logger.info('✅ Core services initialized')
  }

  private async initializeTradingServices(): Promise<void> {
    logger.info('💰 Initializing trading services...')

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
    this.tradeMonitor = new TradeMonitor(
      this.accountSyncService.getAccountStateManager(),
      restClients,
      this.orderbookManager,
      marketMetadataServices,
      config.trading.monitor
    )

    // Set up event listeners for trading
    this.setupTradingEventListeners()

    // Start the trade monitor
    this.tradeMonitor.start()

    logger.info('✅ Trading services initialized')
  }

  private setupTradingEventListeners(): void {
    if (!this.tradeExecutor || !this.tradeMonitor) {
      logger.warn('Trading services not available for event setup')
      return
    }

    // Trade execution events
    this.tradeExecutor.on('tradeCompleted', (result) => {
      this.emit('tradeCompleted', result)
      logger.info(`Trade completed: ${result.id}`, {
        success: result.success,
        pnl: result.pnl,
        latencyMs: result.latencyMs
      })
    })

    // Trade monitoring events
    this.tradeMonitor.on('tradeAdded', (trade) => {
      this.emit('tradeAdded', trade)
      logger.info(`Trade added to monitoring: ${trade.id}`, {
        pair: trade.pair,
        volume: trade.volume
      })
    })

    this.tradeMonitor.on('tradeClosed', (trade) => {
      this.emit('tradeClosed', trade)
      logger.info(`Trade closed: ${trade.id}`, {
        exitReason: trade.exitReason,
        pnl: trade.pnl
      })
    })

    this.tradeMonitor.on('tradeError', ({ trade, error }) => {
      this.emit('tradeError', { trade, error })
      logger.error(`Trade error: ${trade.id}`, {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  private async processArbitrageOpportunities(opportunities: any[]): Promise<void> {
    if (!this.tradeExecutor || !this.tradeMonitor) {
      logger.warn('Trading services not available for opportunity processing')
      return
    }

    logger.info(`Processing ${opportunities.length} arbitrage opportunities`)

    for (const opportunity of opportunities) {
      try {
        // Convert opportunity to trade parameters
        const tradeParams = {
          opportunity,
          timestamp: Date.now()
        }

        // Execute the trade
        const result = await this.tradeExecutor.executeTrade(tradeParams)

        if (result.success) {
          // Add successful trade to monitoring
          this.tradeMonitor.addTrade(result)
          
          logger.info(`Trade executed successfully: ${result.id}`, {
            latencyMs: result.latencyMs
          })
        } else {
          logger.warn(`Trade execution failed: ${result.id}`, {
            error: result.errorDetails?.message
          })
        }
      } catch (error) {
        logger.error(`Failed to process opportunity`, {
          opportunity,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  private async initializeAccountSyncService(): Promise<void> {
    logger.info('🔄 Initializing Account Sync Service...')

    this.accountSyncService = new AccountSyncService()

    // Set up account sync event forwarding
    this.accountSyncService.on('accountUpdate', (update: AccountStateUpdate) => {
      this.emit('accountUpdate', update)
    })

    // Prepare exchange configurations for account sync
    const exchangeAccountConfigs = [
      // {
      //   exchangeId: 'binance',
      //   wsConfig: {
      //     apiKey: config.exchanges.binance.apiKey,
      //     apiSecret: config.exchanges.binance.apiSecret,
      //     maxStreamsPerConnection: config.exchanges.binance.maxStreamsPerConnection,
      //     reconnectInterval: config.exchanges.binance.reconnectInterval,
      //   } as WebSocketConfig,
      //   restConfig: {
      //     apiKey: config.exchanges.binance.apiKey,
      //     apiSecret: config.exchanges.binance.apiSecret,
      //   } as ExchangeConfig
      // },
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
            defaultSettleType: 'linear' // Linear settlement
          }
        } as ExchangeConfig
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
            defaultSettleType: 'linear' // Linear settlement
          }
        } as ExchangeConfig
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
            defaultSettleType: 'linear' // Linear settlement
          }
        } as ExchangeConfig
      }
    ]

    await this.accountSyncService.initialize(exchangeAccountConfigs)
    logger.info('✅ Account Sync Service initialized')
  }

  private async initializePublicWebSocketClients(): Promise<void> {
    logger.info('📡 Initializing WebSocket clients...')

    // Fetch trading markets for all exchanges
    const exchangeMarkets = Array.from(this.exchangeServices.entries()).map(
      ([exchangeId, services]) => {
        try {
          const markets = services.rest.getTradingMarkets()

          logger.info(`[${exchangeId}] Found ${Object.keys(markets).length} USDT perpetual futures markets`)
          return { exchangeId, markets }
        } catch (error) {
          logger.error(`❌ [${exchangeId}] Failed to fetch markets:`, error)
          throw error
        }
      }
    )
    const marketsMap = new Map(exchangeMarkets.map(({ exchangeId, markets }) => [exchangeId, markets]))

    // Initialize WebSocket clients
    const wsClients = [
      // {
      //   id: 'binance',
      //   client: new BinancePublicWebSocketClient({
      //     apiKey: config.exchanges.binance.apiKey,
      //     apiSecret: config.exchanges.binance.apiSecret,
      //     maxStreamsPerConnection: config.exchanges.binance.maxStreamsPerConnection,
      //     reconnectInterval: config.exchanges.binance.reconnectInterval,
      //   })
      // },
      {
        id: 'bybit',
        client: new BybitPublicWebSocketClient({
          apiKey: config.exchanges.bybit.apiKey,
          apiSecret: config.exchanges.bybit.apiSecret,
          maxStreamsPerConnection: config.exchanges.bybit.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.bybit.reconnectInterval,
        })
      },
      {
        id: 'okx',
        client: new OkxPublicWebSocketClient({
          apiKey: config.exchanges.okx.apiKey,
          apiSecret: config.exchanges.okx.apiSecret,
          apiPass: config.exchanges.okx.apiPass,
          maxStreamsPerConnection: config.exchanges.okx.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.okx.reconnectInterval,
        })
      },
      {
        id: 'bitget',
        client: new BitgetPublicWebSocketClient({
          apiKey: config.exchanges.bitget.apiKey,
          apiSecret: config.exchanges.bitget.apiSecret,
          apiPass: config.exchanges.bitget.apiPass,
          maxStreamsPerConnection: config.exchanges.bitget.maxStreamsPerConnection,
          reconnectInterval: config.exchanges.bitget.reconnectInterval,
        })
      }
    ]

    // Initialize and connect WebSocket clients
    await Promise.all(
      wsClients.map(async ({ id, client }) => {
        try {
          const markets = marketsMap.get(id) || []
          await client.initialize(markets)
          
          const services = this.exchangeServices.get(id)!
          services.ws = client
          
          logger.info(`✅ [${id}] WebSocket client initialized`)
        } catch (error) {
          logger.error(`❌ [${id}] Failed to initialize WebSocket client:`, error)
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
          logger.info(`✅ [${exchangeId}] WebSocket connected to Orderbook Manager`)
        }
      }
    }

    logger.info('✅ All WebSocket clients initialized and connected')
  }

  private setupGracefulShutdown(): void {
    logger.info('🛡️ Setting up graceful shutdown handlers...')

    const shutdownHandler = async (signal: string) => {
      if (this.isShuttingDown) {
        return
      }

      this.isShuttingDown = true
      logger.info(`🔄 Received ${signal}, initiating graceful shutdown...`)

      try {
        await this.shutdown()
        logger.info('✅ Graceful shutdown completed')
        process.exit(0)
      } catch (error) {
        logger.error('❌ Error during shutdown:', error)
        process.exit(1)
      }
    }

    process.on('SIGINT', () => shutdownHandler('SIGINT'))
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'))

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('💥 Uncaught Exception:', error)
      shutdownHandler('uncaughtException')
    })

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      logger.error('💥 Unhandled Rejection:', reason)
      shutdownHandler('unhandledRejection')
    })

    logger.info('✅ Graceful shutdown handlers configured')
  }

  async shutdown(): Promise<void> {
    if (!this.isInitialized || this.isShuttingDown) {
      return
    }

    logger.info('🔄 Shutting down ArbiNet Orchestrator...')

    // Shutdown in reverse order of initialization
    const shutdownTasks: Array<() => Promise<void>> = []

    // 1. Shutdown account sync service
    if (this.accountSyncService) {
      shutdownTasks.push(async () => {
        logger.info('🔄 Shutting down Account Sync Service...')
        await this.accountSyncService!.shutdown()
        logger.info('✅ Account Sync Service shutdown complete')
      })
    }

    // 2. Shutdown WebSocket clients
    for (const [exchangeId, services] of this.exchangeServices.entries()) {
      if (services.ws) {
        shutdownTasks.push(async () => {
          logger.info(`🔄 Shutting down [${exchangeId}] WebSocket client...`)
          services.ws.close()
          logger.info(`✅ [${exchangeId}] WebSocket client shutdown complete`)
        })
      }
    }

    // 3. Shutdown core services
    if (this.arbitrageEngine) {
      shutdownTasks.push(async () => {
        logger.info('🔄 Shutting down Arbitrage Engine...')
        // Add any cleanup logic for arbitrage engine
        logger.info('✅ Arbitrage Engine shutdown complete')
      })
    }

    // Execute shutdown tasks
    for (const task of shutdownTasks) {
      try {
        await task()
      } catch (error) {
        logger.error('❌ Error during shutdown task:', error)
      }
    }

    this.isInitialized = false
    logger.info('✅ ArbiNet Orchestrator shutdown complete')
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
          0.012700,
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
          0.012700,
          true,
          new Date().getTime().toString()
        )
        
      } catch (error) {
        logger.error(`❌ [${exchangeId}] Order creation test failed:`, error)
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