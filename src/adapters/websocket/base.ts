import { EventEmitter } from 'events'
import { Dictionary, Market } from 'ccxt'
import { PublicWebSocketClientInterface, WebSocketConfig, StreamBatch, PublicWebSocketMessageParser } from './types'
import { MarketType } from '../../types/exchange'
import { Logger } from '../../utils/logger'
import { wait, marketTypeFromCcxtMarket } from '../../utils/utils'

const logger = new Logger('ws-base')

export abstract class BasePublicWebSocketClient extends EventEmitter implements PublicWebSocketClientInterface {
  protected abstract readonly exchangeName: string
  protected abstract readonly messageParser: PublicWebSocketMessageParser
  protected markets: Dictionary<Market> = {}
  protected streamBatches: StreamBatch[] = []
  // Lookup: `${marketType}:${market.id}` → unified symbol (handles same-id collisions across types)
  private marketIdAndTypeToUnified: Map<string, string> = new Map()
  private reconnectingBatches: Set<number> = new Set()

  constructor(protected readonly config: WebSocketConfig) {
    super()
  }

  public async initialize(markets: Dictionary<Market>): Promise<void> {
    try {
      this.markets = markets

      // Build type-aware symbol lookup to handle exchanges where spot+linear share the same market.id
      for (const market of Object.values(markets)) {
        if (!market) continue
        const mt = marketTypeFromCcxtMarket(market)
        this.marketIdAndTypeToUnified.set(`${mt}:${market.id}`, market.symbol)
      }

      // Group markets by type, create separate batches per type so subscriptions carry the right category
      const marketGroups = new Map<MarketType, string[]>()
      for (const market of Object.values(markets)) {
        if (!market) continue
        const mt = this.filterMarketType(marketTypeFromCcxtMarket(market))
        if (!mt) continue
        if (!market.id) continue
        if (!marketGroups.has(mt)) marketGroups.set(mt, [])
        marketGroups.get(mt)!.push(market.id)
      }

      let batchIndex = 0
      for (const [marketType, symbols] of marketGroups) {
        const batches = this.groupSymbolsIntoBatches(symbols)
        for (const symbolBatch of batches) {
          await this.createPublicWebSocketConnection(symbolBatch, batchIndex, false, marketType)
          batchIndex++
        }
      }

      logger.info({
        msg: 'Initialized WebSocket client',
        function: 'BasePublicWebSocketClient.initialize',
        exchange: this.exchangeName,
        marketCount: Object.keys(markets).length,
        batchCount: batchIndex,
        marketTypes: Array.from(marketGroups.keys()),
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

  // Override in subclasses that are restricted to a single market type (e.g. Binance spot vs usdm vs coinm).
  // Return null to skip that market type entirely when filtering.
  protected filterMarketType(mt: MarketType): MarketType | null {
    if (this.config.marketType && this.config.marketType !== mt) return null
    return mt
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
    isReconnect: boolean = false,
    marketType: MarketType
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
          marketType,
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
        marketType,
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
    if (this.reconnectingBatches.has(batch.id)) return
    this.reconnectingBatches.add(batch.id)

    // Books built from this batch may be stale until fresh snapshots arrive —
    // ingest workers listen for this to clear local books and notify main.
    this.emit('connectionReset', { batchId: batch.id, marketType: batch.marketType })

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
      await this.createPublicWebSocketConnection(batch.symbols, batch.id, true, batch.marketType)
      this.reconnectingBatches.delete(batch.id)
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
      this.reconnectingBatches.delete(batch.id)
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

  protected getUnifiedSymbol(marketId: string, marketType: MarketType): string {
    const unified = this.marketIdAndTypeToUnified.get(`${marketType}:${marketId}`)
    if (unified) return unified
    throw new Error(
      `[${this.exchangeName}] Cannot resolve unified symbol for marketId=${marketId} marketType=${marketType}`,
    )
  }

  // Abstract methods to be implemented by exchange-specific clients
  protected abstract createClient(): any
  protected abstract setupEventHandlers(batch: StreamBatch): void
  protected abstract subscribeToSymbols(batch: StreamBatch): Promise<void>
}
