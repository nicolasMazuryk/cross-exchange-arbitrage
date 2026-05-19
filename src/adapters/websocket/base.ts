import { EventEmitter } from 'events'
import { Dictionary, Market } from 'ccxt'
import { PublicWebSocketClientInterface, WebSocketConfig, StreamBatch, PublicWebSocketMessageParser } from './types'
import { Logger } from '../../utils/logger'
import { wait } from '../../utils/utils'

const logger = new Logger('ws-base')

export abstract class BasePublicWebSocketClient extends EventEmitter implements PublicWebSocketClientInterface {
  protected abstract readonly exchangeName: string
  protected abstract readonly messageParser: PublicWebSocketMessageParser
  protected markets: Dictionary<Market> = {}
  protected streamBatches: StreamBatch[] = []

  constructor(protected readonly config: WebSocketConfig) {
    super()
  }

  public async initialize(markets: Dictionary<Market>): Promise<void> {
    try {
      this.markets = markets
      const symbols = Object.values(this.markets).map(market => market!.id) as string[]
      const batches = this.groupSymbolsIntoBatches(symbols)
      for (let i = 0; i < batches.length; i++) {
        await this.createPublicWebSocketConnection(batches[i], i)
      }
      logger.info({
        msg: 'Initialized WebSocket client',
        function: 'BasePublicWebSocketClient.initialize',
        exchange: this.exchangeName,
        symbolCount: symbols.length,
        batchCount: batches.length,
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to initialize WebSocket client',
        function: 'BasePublicWebSocketClient.initialize',
        exchange: this.exchangeName,
        marketCount: Object.keys(markets).length,
        error,
      })
      throw error
    }
  }

  protected groupSymbolsIntoBatches(symbols: string[]): string[][] {
    const batches: string[][] = []
    for (let i = 0; i < symbols.length; i += this.config.maxStreamsPerConnection) {
      batches.push(symbols.slice(i, i + this.config.maxStreamsPerConnection))
    }
    return batches
  }

  protected async createPublicWebSocketConnection(
    symbols: string[],
    batchIndex: number,
    isReconnect: boolean = false
  ): Promise<void> {
    try {
      const client = this.createClient()

      if (!client) {
        throw new Error(`Failed to create WebSocket client for batch ${batchIndex}`)
      }

      let batch: StreamBatch

      if (isReconnect) {
        batch = this.streamBatches.find(b => b.id === batchIndex)!

        this.cleanupClient(batch)

        batch.client = client
        batch.isConnected = false
      } else {
        batch = {
          id: batchIndex,
          client,
          symbols,
          isConnected: false,
        }
      }

      this.setupEventHandlers(batch)
      await this.subscribeToSymbols(batch)
      if (!isReconnect) this.streamBatches.push(batch)

      logger.debug({
        msg: 'Created WebSocket connection for batch',
        function: 'BasePublicWebSocketClient.createPublicWebSocketConnection',
        exchange: this.exchangeName,
        batchIndex,
        symbolCount: symbols.length,
        isReconnect,
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to create WebSocket connection',
        function: 'BasePublicWebSocketClient.createPublicWebSocketConnection',
        exchange: this.exchangeName,
        batchIndex,
        symbolCount: symbols.length,
        isReconnect,
        error,
      })
      throw error
    }
  }

  protected cleanupClient(batch: StreamBatch): void {
    if (!batch.client) return

    const oldClient = batch.client
    batch.client = null as any
    batch.isConnected = false

    try {
      // Remove our listeners first so closeAll() errors don't trigger handleConnectionError again,
      // then re-add a no-op error handler to absorb async errors from okx-api's internal reconnect
      // timers that may fire after cleanup (without this, ERR_UNHANDLED_ERROR crashes the process).
      oldClient.removeAllListeners()
      oldClient.on('error', () => {})

      if (typeof oldClient.closeAll === 'function') {
        oldClient.closeAll()
      } else if (typeof oldClient.close === 'function') {
        oldClient.close()
      }
    } catch (cleanupError) {
      logger.error({
        msg: 'Error during client cleanup',
        function: 'BasePublicWebSocketClient.cleanupClient',
        exchange: this.exchangeName,
        batchId: batch.id,
        error: cleanupError,
      })
    }
  }

  protected async handleConnectionError(batch: StreamBatch): Promise<void> {
    logger.warn({
      msg: 'Handling connection error. Reconnecting WebSocket',
      function: 'BasePublicWebSocketClient.handleConnectionError',
      exchange: this.exchangeName,
      batchId: batch.id,
      symbolCount: batch.symbols.length,
      reconnectInterval: this.config.reconnectInterval,
    })
    try {
      await wait(this.config.reconnectInterval)
      await this.createPublicWebSocketConnection(batch.symbols, batch.id, true)
    } catch (error) {
      logger.error({
        msg: 'Failed to reconnect WebSocket, will retry',
        function: 'BasePublicWebSocketClient.handleConnectionError',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        reconnectInterval: this.config.reconnectInterval,
        error,
      })
      await this.handleConnectionError(batch)
    }
  }

  public close(): void {
    try {
      logger.info({
        msg: 'Closing all WebSocket connections',
        function: 'BasePublicWebSocketClient.close',
        exchange: this.exchangeName,
      })

      this.streamBatches.forEach(batch => {
        try {
          this.cleanupClient(batch)
          logger.debug({
            msg: 'Closed WebSocket connection for batch',
            function: 'BasePublicWebSocketClient.close',
            exchange: this.exchangeName,
            batchId: batch.id,
            symbolCount: batch.symbols.length,
          })
        } catch (error) {
          logger.error({
            msg: 'Failed to close WebSocket batch',
            function: 'BasePublicWebSocketClient.close',
            exchange: this.exchangeName,
            batchId: batch.id,
            error,
          })
        }
      })
      this.streamBatches = []
      logger.info({
        msg: 'All WebSocket connections closed',
        function: 'BasePublicWebSocketClient.close',
        exchange: this.exchangeName,
      })
    } catch (error) {
      logger.error({
        msg: 'Failed to close WebSocket connections',
        function: 'BasePublicWebSocketClient.close',
        exchange: this.exchangeName,
        error,
      })
      // Don't throw - allow graceful shutdown to continue
    }
  }

  protected getUnifiedSymbol(marketId: string): string {
    const market = Object.values(this.markets).find(market => market!.id === marketId)
    return market!.symbol
  }

  // Abstract methods to be implemented by exchange-specific clients
  protected abstract createClient(): any
  protected abstract setupEventHandlers(batch: StreamBatch): void
  protected abstract subscribeToSymbols(batch: StreamBatch): Promise<void>
}
