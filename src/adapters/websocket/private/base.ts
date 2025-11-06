import { EventEmitter } from 'events'
import { WebSocketConfig, PrivateWebSocketClientInterface, PrivateWebSocketMessageParser } from '../types'
import { AccountStateUpdate } from '../../../types/account'
import { RestClientInterface } from '../../rest/types'
import { Logger } from '../../../utils/logger'
import { TraceContext } from '../../../utils/traceContext'
import { wait } from '../../../utils/utils'

const logger = new Logger('ws-private-base')

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
    logger.info({ msg: 'Initializing private WebSocket client', function: 'BasePrivateWebSocketClient.initialize',
      exchange: this.exchangeName })
    
    await this.createPrivateWebSocketConnection()

  }

  protected async createPrivateWebSocketConnection(): Promise<void> {
    try {
      this.client = this.createClient()
      this.setupEventHandlers()
      await this.subscribeToAccountStreams()
    } catch (error) {
      logger.error({ msg: 'Failed to create private WebSocket connection', function: 'BasePrivateWebSocketClient.createPrivateWebSocketConnection',
        exchange: this.exchangeName,
        error })
      throw error
    }
  }

  protected async handleConnectionError(): Promise<void> {
    logger.warn({ msg: 'Handling connection error. Reconnecting Private WebSocket', function: 'BasePrivateWebSocketClient.handleConnectionError',
      exchange: this.exchangeName,
      reconnectInterval: this.config.reconnectInterval })
    
    try {
      await wait(this.config.reconnectInterval)
      await this.createPrivateWebSocketConnection()
    } catch (error) {
      logger.error({ msg: 'Failed to reconnect private WebSocket, will retry', function: 'BasePrivateWebSocketClient.handleConnectionError',
        exchange: this.exchangeName,
        reconnectInterval: this.config.reconnectInterval,
        error })
      await this.handleConnectionError()
    }
  }

  protected handleMessage(data: any): void {
    TraceContext.runWithTrace(`ws-private-message-${this.exchangeName}`, async (traceId) => {
      try {
        if (this.messageParser.isBalanceMessage(data)) {
          const balances = this.messageParser.parseBalanceUpdate(data)
          this.emit('balanceUpdate', {
            exchange: this.exchangeName,
            type: 'balance',
            data: balances,
            timestamp: Date.now(),
            traceId,
          } as AccountStateUpdate)
        }
        if (this.messageParser.isPositionMessage(data)) {
          const positions = this.messageParser.parsePositionUpdate(data, this.restClient)
          this.emit('positionUpdate', {
            exchange: this.exchangeName,
            type: 'position',
            data: positions,
            timestamp: Date.now(),
            traceId,
          } as AccountStateUpdate)
        }
        if (this.messageParser.isOrderMessage(data)) {
          const orders = this.messageParser.parseOrderUpdate(data, this.restClient)
          this.emit('orderUpdate', {
            exchange: this.exchangeName,
            type: 'order',
            data: orders,
            timestamp: Date.now(),
            traceId,
          } as AccountStateUpdate)
        }
      } catch (error) {
        logger.error({ msg: 'Error parsing private WebSocket message', function: 'BasePrivateWebSocketClient.handleMessage',
          exchange: this.exchangeName,
          messageType: data?.e || data?.topic,
          error })
      }
    }).catch(error => {
      logger.error({ msg: 'Error in trace context for private WebSocket message', function: 'BasePrivateWebSocketClient.handleMessage',
        exchange: this.exchangeName,
        error })
    })
  }

  public close(): void {
    try {
      if (this.client) {
        this.client.closeAll()
        this.isConnected = false
        logger.debug({ msg: 'Closed private WebSocket connection', function: 'BasePrivateWebSocketClient.close',
          exchange: this.exchangeName })
      }
    } catch (error) {
      logger.error({ msg: 'Error closing private WebSocket connection', function: 'BasePrivateWebSocketClient.close',
        exchange: this.exchangeName,
        error })
      // Don't throw - allow graceful shutdown to continue
    }
  }



  // Abstract methods to be implemented by exchange-specific clients
  protected abstract createClient(): any
  protected abstract setupEventHandlers(): void
  protected abstract subscribeToAccountStreams(): Promise<void>
} 