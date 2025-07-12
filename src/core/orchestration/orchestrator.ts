import { EventEmitter } from 'events'
import config from '../../utils/config'
import logger from '../../utils/logger'

// Core services
import { OrderbookManager } from '../orderbook/orderbookManager'
import { ArbitrageEngine } from '../arbitrage/arbitrageEngine'
import { AccountSyncService } from '../state/accountSyncService'

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
}

export class Orchestrator extends EventEmitter {
  private isInitialized = false
  private isShuttingDown = false

  // Core services
  private orderbookManager?: OrderbookManager
  private arbitrageEngine?: ArbitrageEngine
  private accountSyncService?: AccountSyncService

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

      // Stage 3: Initialize WebSocket clients
      // await this.initializePublicWebSocketClients()

      // Stage 4: Initialize account sync service
      await this.initializeAccountSyncService()

      // Stage 5: Connect services and start data flow
      await this.connectServices()

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
          this.exchangeServices.set(id, { rest: client })
          logger.info(`✅ [${id}] REST client initialized`)
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
      // {
      //   name: 'okx',
      //   isHealthy: true,
      //   feeModel: {
      //     maker: config.exchanges.okx.fees.maker,
      //     taker: config.exchanges.okx.fees.taker
      //   }
      // },
      // {
      //   name: 'bitget',
      //   isHealthy: true,
      //   feeModel: {
      //     maker: config.exchanges.bitget.fees.maker,
      //     taker: config.exchanges.bitget.fees.taker
      //   }
      // }
    ]

    const blacklistPairs = config.arbitrage.blacklistPairs || []
    this.arbitrageEngine = new ArbitrageEngine(
      this.orderbookManager,
      blacklistPairs,
      exchangeConfigs
    )

    // Listen for arbitrage opportunities
    this.arbitrageEngine.on('opportunities', (opportunities) => {
      this.emit('arbitrageOpportunities', opportunities)
      // TODO: Pass opportunities to trade execution engine
    })

    logger.info('✅ Arbitrage Engine initialized')
    logger.info('✅ Core services initialized')
  }

  private async initializePublicWebSocketClients(): Promise<void> {
    logger.info('📡 Initializing WebSocket clients...')

    // Fetch trading markets for all exchanges
    const marketPromises = Array.from(this.exchangeServices.entries()).map(
      async ([exchangeId, services]) => {
        try {
          const markets = await services.rest.getTradingMarkets()

          logger.info(`[${exchangeId}] Found ${Object.keys(markets).length} USDT perpetual futures markets`)
          return { exchangeId, markets }
        } catch (error) {
          logger.error(`❌ [${exchangeId}] Failed to fetch markets:`, error)
          throw error
        }
      }
    )

    const exchangeMarkets = await Promise.all(marketPromises)
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

    logger.info('✅ All WebSocket clients initialized')
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
        } as ExchangeConfig
      },
      // {
      //   exchangeId: 'okx',
      //   wsConfig: {
      //     apiKey: config.exchanges.okx.apiKey,
      //     apiSecret: config.exchanges.okx.apiSecret,
      //     apiPass: config.exchanges.okx.apiPass,
      //     maxStreamsPerConnection: config.exchanges.okx.maxStreamsPerConnection,
      //     reconnectInterval: config.exchanges.okx.reconnectInterval,
      //   } as WebSocketConfig,
      //   restConfig: {
      //     apiKey: config.exchanges.okx.apiKey,
      //     apiSecret: config.exchanges.okx.apiSecret,
      //     apiPass: config.exchanges.okx.apiPass,
      //   } as ExchangeConfig
      // },
      // {
      //   exchangeId: 'bitget',
      //   wsConfig: {
      //     apiKey: config.exchanges.bitget.apiKey,
      //     apiSecret: config.exchanges.bitget.apiSecret,
      //     apiPass: config.exchanges.bitget.apiPass,
      //     maxStreamsPerConnection: config.exchanges.bitget.maxStreamsPerConnection,
      //     reconnectInterval: config.exchanges.bitget.reconnectInterval,
      //   } as WebSocketConfig,
      //   restConfig: {
      //     apiKey: config.exchanges.bitget.apiKey,
      //     apiSecret: config.exchanges.bitget.apiSecret,
      //     apiPass: config.exchanges.bitget.apiPass,
      //     options: {
      //       defaultType: 'swap', // Use USDT Futures
      //       defaultSubType: 'linear', // USDT linear contracts
      //       defaultSettleType: 'linear' // Linear settlement
      //     }
      //   } as ExchangeConfig
      // }
    ]

    await this.accountSyncService.initialize(exchangeAccountConfigs)
    logger.info('✅ Account Sync Service initialized')
  }

  private async connectServices(): Promise<void> {
    logger.info('🔗 Connecting services...')

    // Connect WebSocket updates to orderbook manager
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

    logger.info('✅ Services connected')
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

  isServiceInitialized(): boolean {
    return this.isInitialized
  }
}

// Factory function for easy initialization
export async function createOrchestrator(): Promise<Orchestrator> {
  const orchestrator = new Orchestrator()
  await orchestrator.initialize()
  return orchestrator
}

// Default export for backward compatibility
export default Orchestrator 