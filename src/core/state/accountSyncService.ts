import { EventEmitter } from 'events'
import { WebSocketConfig, PrivateWebSocketClientInterface } from '../../adapters/websocket/types'
import { ExchangeConfig, RestClientInterface } from '../../adapters/rest/types'
import { AccountStateManager } from './accountStateManager'
import { AccountStateUpdate, AccountState } from '../../types/account'
import {
  BinancePrivateWebSocketClient,
  BybitPrivateWebSocketClient,
  OKXPrivateWebSocketClient,
  BitgetPrivateWebSocketClient,
} from '../../adapters/websocket/private'
import {
  BinanceExchange,
  BybitExchange,
  OkxExchange,
  BitgetExchange
} from '../../adapters/rest'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import config from '../../utils/config'

const logger = new Logger('account-sync-service')

interface ExchangeAccountConfig {
  exchangeId: string
  wsConfig: WebSocketConfig
  restConfig: ExchangeConfig
}

export class AccountSyncService extends EventEmitter {
  private accountStateManager: AccountStateManager
  private wsClients: Map<string, PrivateWebSocketClientInterface> = new Map()
  private restClients: Map<string, RestClientInterface> = new Map()
  private syncIntervals: Map<string, NodeJS.Timeout> = new Map()
  private isInitialized = false

  constructor() {
    super()
    this.accountStateManager = new AccountStateManager()
  }

  async initialize(exchangeConfigs: ExchangeAccountConfig[]): Promise<void> {
    try {
      if (this.isInitialized) {
        logger.warn({
          msg: 'AccountSyncService already initialized',
          function: 'AccountSyncService.initialize'
        })
        return
      }

      logger.info({
        msg: 'Initializing AccountSyncService',
        function: 'AccountSyncService.initialize',
        exchangeCount: exchangeConfigs.length
      })

      // Initialize REST clients
      for (const config of exchangeConfigs) {
        await this.initializeRestClient(config)
      }

      // Initialize WebSocket clients
      for (const config of exchangeConfigs) {
        await this.initializePrivateWebSocketClient(config)
      }

      // Perform initial snapshots
      await this.performInitialSnapshots()

      // Start periodic snapshot sync
      this.startPeriodicSnapshots()

      this.isInitialized = true
      logger.info({
        msg: 'AccountSyncService initialized successfully',
        function: 'AccountSyncService.initialize',
        exchangeCount: exchangeConfigs.length
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize AccountSyncService',
        function: 'AccountSyncService.initialize',
        exchangeCount: exchangeConfigs.length,
        error
      })
      throw error
    }
  }

  private async initializeRestClient(config: ExchangeAccountConfig): Promise<void> {
    try {
      let restClient: any

      switch (config.exchangeId) {
        case 'binance':
          restClient = new BinanceExchange(config.restConfig)
          break
        case 'bybit':
          restClient = new BybitExchange(config.restConfig)
          break
        case 'okx':
          restClient = new OkxExchange(config.restConfig)
          break
        case 'bitget':
          restClient = new BitgetExchange(config.restConfig)
          break
        default:
          throw new Error(`Unsupported exchange: ${config.exchangeId}`)
      }

      await restClient.loadMarkets()

      this.restClients.set(config.exchangeId, restClient)
      logger.debug({
        msg: 'REST client initialized for exchange',
        function: 'AccountSyncService.initializeRestClient',
        exchange: config.exchangeId
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize REST client for exchange',
        function: 'AccountSyncService.initializeRestClient',
        exchange: config.exchangeId,
        error
      })
      throw error
    }
  }

  private async initializePrivateWebSocketClient(config: ExchangeAccountConfig): Promise<void> {
    try {
      let wsClient: PrivateWebSocketClientInterface

      // Get the REST client for this exchange
      const restClient = this.restClients.get(config.exchangeId)
      if (!restClient) {
        throw new Error(`REST client not found for exchange: ${config.exchangeId}`)
      }

      switch (config.exchangeId) {
        case 'binance':
          wsClient = new BinancePrivateWebSocketClient(config.wsConfig, restClient)
          break
        case 'bybit':
          wsClient = new BybitPrivateWebSocketClient(config.wsConfig, restClient)
          break
        case 'okx':
          wsClient = new OKXPrivateWebSocketClient(config.wsConfig, restClient)
          break
        case 'bitget':
          wsClient = new BitgetPrivateWebSocketClient(config.wsConfig, restClient)
          break
        default:
          throw new Error(`Unsupported exchange: ${config.exchangeId}`)
      }

      // Set up event handlers for WebSocket updates
      wsClient.on('balanceUpdate', (update: AccountStateUpdate) => {
        TraceContext.runWithExistingTrace(update.traceId, 'account-state-update', () => {
          this.accountStateManager.handleAccountStateUpdate(update)
        })
      })

      wsClient.on('positionUpdate', (update: AccountStateUpdate) => {
        TraceContext.runWithExistingTrace(update.traceId, 'account-state-update', () => {
          this.accountStateManager.handleAccountStateUpdate(update)
        })
      })

      wsClient.on('orderUpdate', (update: AccountStateUpdate) => {
        TraceContext.runWithExistingTrace(update.traceId, 'account-state-update', () => {
          this.accountStateManager.handleAccountStateUpdate(update)
        })
      })

      await wsClient.initialize()
      this.wsClients.set(config.exchangeId, wsClient)
      logger.debug({
        msg: 'Private WebSocket client initialized for exchange',
        function: 'AccountSyncService.initializePrivateWebSocketClient',
        exchange: config.exchangeId
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize private WebSocket client for exchange',
        function: 'AccountSyncService.initializePrivateWebSocketClient',
        exchange: config.exchangeId,
        error
      })
      throw error
    }
  }

  private async performInitialSnapshots(): Promise<void> {
    logger.info({
      msg: 'Performing initial account snapshots',
      function: 'AccountSyncService.performInitialSnapshots'
    })

    for (const [exchangeId, restClient] of this.restClients.entries()) {
      try {
        await this.performExchangeSnapshot(exchangeId, restClient)
      } catch (error) {
        logger.error({
          msg: 'Error performing initial snapshot',
          function: 'AccountSyncService.performInitialSnapshots',
          exchange: exchangeId,
          error,
        })
      }
    }
  }

  private async performExchangeSnapshot(exchangeId: string, restClient: any): Promise<void> {
    try {
      const [balances, positions, orders] = await Promise.all([
        restClient.fetchBalancesSnapshot(),
        restClient.fetchPositionsSnapshot(),
        restClient.fetchOrdersSnapshot()
      ])

      this.accountStateManager.updateBalances(exchangeId, balances)
      this.accountStateManager.updatePositions(exchangeId, positions)
      this.accountStateManager.updateOrders(exchangeId, orders)

      logger.debug({
        msg: 'Snapshot completed',
        function: 'AccountSyncService.performExchangeSnapshot',
        exchange: exchangeId,
        balances: balances.length,
        positions: positions.length,
        orders: orders.length
      })
    } catch (error) {
      logger.error({
        msg: 'Error performing snapshot',
        function: 'AccountSyncService.performExchangeSnapshot',
        exchange: exchangeId,
        error,
      })
      throw error
    }
  }

  private startPeriodicSnapshots(): void {
    // Perform snapshots every 5 minutes as a fallback
    const snapshotInterval = setInterval(async () => {
      TraceContext.runWithTrace('account-snapshot', async () => {
        logger.debug({
          msg: 'Performing periodic account snapshots',
          function: 'AccountSyncService.startPeriodicSnapshots'
        })
        
        for (const [exchangeId, restClient] of this.restClients.entries()) {
          try {
            await this.performExchangeSnapshot(exchangeId, restClient)
          } catch (error) {
            logger.error({
              msg: 'Error in periodic snapshot - will retry next interval',
              function: 'AccountSyncService.startPeriodicSnapshots',
              exchange: exchangeId,
              snapshotIntervalMs: config.accountSync.snapshotIntervalMs,
              error
            })
          }
        }
      })
    }, config.accountSync.snapshotIntervalMs)

    this.syncIntervals.set('snapshot', snapshotInterval)
  }

  // Public methods for accessing account state
  getAccountStateManager(): AccountStateManager {
    return this.accountStateManager
  }

  async refreshExchangeState(exchangeId: string): Promise<void> {
    const restClient = this.restClients.get(exchangeId)

    await this.performExchangeSnapshot(exchangeId, restClient)
  }

  async refreshAllStates(): Promise<void> {
    logger.info({ msg: 'Refreshing all exchange states' })
    await this.performInitialSnapshots()
  }

  getExchangeState(exchangeId: string): AccountState {
    return this.accountStateManager.getAccountState(exchangeId)
  }

  getStateSummary(): Record<string, { balances: number, positions: number, orders: number }> {
    return this.accountStateManager.getStateSummary()
  }

  async shutdown(): Promise<void> {
    logger.info({
      msg: 'Shutting down AccountSyncService',
      function: 'AccountSyncService.shutdown'
    })

    // Close WebSocket connections
    for (const [exchangeId, wsClient] of this.wsClients.entries()) {
      try {
        wsClient.close()
        logger.debug({
          msg: 'WebSocket connection closed',
          function: 'AccountSyncService.shutdown',
          exchange: exchangeId
        })
      } catch (error) {
        logger.error({
          msg: 'Error closing WebSocket during shutdown',
          function: 'AccountSyncService.shutdown',
          exchange: exchangeId,
          error
        })
      }
    }

    // Clear sync intervals
    for (const [name, interval] of this.syncIntervals.entries()) {
      try {
        clearInterval(interval)
        logger.debug({
          msg: 'Cleared sync interval',
          function: 'AccountSyncService.shutdown',
          intervalName: name
        })
      } catch (error) {
        logger.error({
          msg: 'Error clearing interval during shutdown',
          function: 'AccountSyncService.shutdown',
          intervalName: name,
          error
        })
      }
    }

    this.isInitialized = false
    logger.info({
      msg: '✅ AccountSyncService shutdown complete',
      function: 'AccountSyncService.shutdown'
    })
  }
} 