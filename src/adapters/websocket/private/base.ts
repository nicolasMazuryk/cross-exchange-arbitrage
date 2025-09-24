import { EventEmitter } from 'events'
import { WebSocketConfig, PrivateWebSocketClientInterface, PrivateWebSocketMessageParser } from '../types'
import { AccountStateUpdate } from '../../../types/account'
import { RestClientInterface } from '../../rest/types'
import logger from '../../../utils/logger'
import { wait } from '../../../utils/utils'

export abstract class BasePrivateWebSocketClient extends EventEmitter implements PrivateWebSocketClientInterface {
  protected abstract readonly exchangeName: string
  protected abstract readonly messageParser: PrivateWebSocketMessageParser
  protected client: any
  protected isConnected = false

  constructor(
    protected readonly config: WebSocketConfig,
    public readonly restClient: RestClientInterface
  ) {
    super()
  }

  public async initialize(): Promise<void> {
    logger.info(`[${this.exchangeName}] Initializing account WebSocket client`)
    
    await this.createPrivateWebSocketConnection()
  }

  protected async createPrivateWebSocketConnection(): Promise<void> {
    this.client = this.createClient()
    this.setupEventHandlers()
    await this.subscribeToAccountStreams()
  }

  protected async handleConnectionError(): Promise<void> {
    logger.info(`[${this.exchangeName}] Attempting to reconnect account stream...`)
    try {
      await wait(this.config.reconnectInterval)
      await this.createPrivateWebSocketConnection()
    } catch (error) {
      logger.error(`[${this.exchangeName}] Failed to reconnect account stream:`, error)
      await this.handleConnectionError()
    }
  }

  protected handleMessage(data: any): void {
    try {
      if (this.messageParser.isBalanceMessage(data)) {
        const balances = this.messageParser.parseBalanceUpdate(data)
        this.emit('balanceUpdate', {
          exchange: this.exchangeName,
          type: 'balance',
          data: balances,
          timestamp: Date.now()
        } as AccountStateUpdate)
      }
      if (this.messageParser.isPositionMessage(data)) {
        const positions = this.messageParser.parsePositionUpdate(data, this.restClient)
        this.emit('positionUpdate', {
          exchange: this.exchangeName,
          type: 'position',
          data: positions,
          timestamp: Date.now()
        } as AccountStateUpdate)
      }
      if (this.messageParser.isOrderMessage(data)) {
        const orders = this.messageParser.parseOrderUpdate(data, this.restClient)
        this.emit('orderUpdate', {
          exchange: this.exchangeName,
          type: 'order',
          data: orders,
          timestamp: Date.now()
        } as AccountStateUpdate)
      }
    } catch (error) {
      logger.error(`[${this.exchangeName}] Error parsing account message:`, error)
    }
  }

  public close(): void {
    if (this.client) {
      this.client.closeAll()
      this.isConnected = false
      logger.info(`[${this.exchangeName}] Closed account WebSocket connection`)
    }
  }



  // Abstract methods to be implemented by exchange-specific clients
  protected abstract createClient(): any
  protected abstract setupEventHandlers(): void
  protected abstract subscribeToAccountStreams(): Promise<void>
} 