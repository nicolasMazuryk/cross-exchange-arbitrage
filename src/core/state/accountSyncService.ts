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
import logger from '../../utils/logger'
import config from '../../utils/config'

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
    
    // Forward account state updates from the manager
    this.accountStateManager.on('stateUpdate', (update: AccountStateUpdate) => {
      this.emit('accountUpdate', update)
    })
  }

  async initialize(exchangeConfigs: ExchangeAccountConfig[]): Promise<void> {
    if (this.isInitialized) {
      logger.warn('AccountSyncService already initialized')
      return
    }

    logger.info('Initializing AccountSyncService...')

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
    logger.info('AccountSyncService initialized successfully')
  }

  private async initializeRestClient(config: ExchangeAccountConfig): Promise<void> {
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

    this.restClients.set(config.exchangeId, restClient)
    logger.info(`[${config.exchangeId}] REST client initialized`)
  }

  private async initializePrivateWebSocketClient(config: ExchangeAccountConfig): Promise<void> {
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
      this.accountStateManager.handleAccountStateUpdate(update)
    })

    wsClient.on('positionUpdate', (update: AccountStateUpdate) => {
      this.accountStateManager.handleAccountStateUpdate(update)
    })

    wsClient.on('orderUpdate', (update: AccountStateUpdate) => {
      this.accountStateManager.handleAccountStateUpdate(update)
    })

    await wsClient.initialize()
    this.wsClients.set(config.exchangeId, wsClient)
    logger.info(`[${config.exchangeId}] WebSocket private client initialized`)
  }

  private async performInitialSnapshots(): Promise<void> {
    logger.info('Performing initial account snapshots...')

    for (const [exchangeId, restClient] of this.restClients.entries()) {
      try {
        await this.performExchangeSnapshot(exchangeId, restClient)
      } catch (error) {
        logger.error(`[${exchangeId}] Error performing initial snapshot:`, error)
      }
    }
  }

  private async performExchangeSnapshot(exchangeId: string, restClient: any): Promise<void> {
    try {
      // Fetch all snapshots in parallel
      const [balances, positions, orders] = await Promise.all([
        restClient.fetchBalancesSnapshot(),
        restClient.fetchPositionsSnapshot(),
        restClient.fetchOrdersSnapshot()
      ])

      // Update state manager
      this.accountStateManager.updateBalances(exchangeId, balances)
      this.accountStateManager.updatePositions(exchangeId, positions)
      this.accountStateManager.updateOrders(exchangeId, orders)

      logger.info(`[${exchangeId}] Snapshot completed: ${balances.length} balances, ${positions.length} positions, ${orders.length} orders`)
    } catch (error) {
      logger.error(`[${exchangeId}] Error performing snapshot:`, error)
      throw error
    }
  }

  private startPeriodicSnapshots(): void {
    // Perform snapshots every 5 minutes as a fallback
    const snapshotInterval = setInterval(async () => {
      logger.debug('Performing periodic account snapshots...')
      
      for (const [exchangeId, restClient] of this.restClients.entries()) {
        try {
          await this.performExchangeSnapshot(exchangeId, restClient)
        } catch (error) {
          logger.error(`[${exchangeId}] Error in periodic snapshot:`, error)
        }
      }
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
    logger.info('Refreshing all exchange states...')
    await this.performInitialSnapshots()
  }

  getExchangeState(exchangeId: string): AccountState {
    return this.accountStateManager.getAccountState(exchangeId)
  }

  getStateSummary(): Record<string, { balances: number, positions: number, orders: number }> {
    return this.accountStateManager.getStateSummary()
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down AccountSyncService...')

    // Close WebSocket connections
    for (const [exchangeId, wsClient] of this.wsClients.entries()) {
      try {
        wsClient.close()
        logger.info(`[${exchangeId}] WebSocket connection closed`)
      } catch (error) {
        logger.error(`[${exchangeId}] Error closing WebSocket:`, error)
      }
    }

    // Clear sync intervals
    for (const [name, interval] of this.syncIntervals.entries()) {
      clearInterval(interval)
      logger.info(`Cleared ${name} sync interval`)
    }

    this.isInitialized = false
    logger.info('AccountSyncService shutdown complete')
  }
} 