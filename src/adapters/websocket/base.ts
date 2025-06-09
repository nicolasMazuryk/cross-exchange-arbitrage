import { EventEmitter } from 'events'
import { WebSocketClientInterface, WebSocketConfig, StreamBatch, WebSocketMessageParser } from './types'
import logger from '../../utils/logger'
import { wait } from '../../utils/utils'

export abstract class BaseWebSocketClient extends EventEmitter implements WebSocketClientInterface {
  protected streamBatches: StreamBatch[] = []
  protected abstract readonly exchangeName: string
  protected abstract readonly messageParser: WebSocketMessageParser

  constructor(protected readonly config: WebSocketConfig) {
    super()
  }

  public async initialize(symbols: string[]): Promise<void> {
    const batches = this.groupSymbolsIntoBatches(symbols)
    for (let i = 0; i < batches.length; i++) {
      await this.createWebSocketConnection(batches[i], i)
    }
  }

  protected groupSymbolsIntoBatches(symbols: string[]): string[][] {
    const batches: string[][] = []
    for (let i = 0; i < symbols.length; i += this.config.maxStreamsPerConnection) {
      batches.push(symbols.slice(i, i + this.config.maxStreamsPerConnection))
    }
    return batches
  }

  protected async createWebSocketConnection(symbols: string[], batchIndex: number): Promise<void> {
    const client = this.createClient()

    const batch: StreamBatch = {
      id: batchIndex,
      client,
      symbols,
      isConnected: false,
    }

    this.setupEventHandlers(batch)
    await this.subscribeToSymbols(batch)

    this.streamBatches.push(batch)
  }

  protected async handleConnectionError(batch: StreamBatch): Promise<void> {
    logger.info(`[${this.exchangeName}] Attempting to connect again for batch ${batch.id}...`)
    try {
      await wait(this.config.reconnectInterval)
      await this.createWebSocketConnection(batch.symbols, batch.id)
    } catch (error) {
      logger.error(`[${this.exchangeName}] Failed to connect again for batch ${batch.id}:`, error)
      await this.handleConnectionError(batch)
    }
  }

  public close(): void {
    this.streamBatches.forEach(batch => {
      batch.client.closeAll()
      batch.isConnected = false
      logger.info(`[${this.exchangeName}] Closed WebSocket connection for batch ${batch.id}`)
    })
    this.streamBatches = []
  }

  // Abstract methods to be implemented by exchange-specific clients
  protected abstract createClient(): any
  protected abstract setupEventHandlers(batch: StreamBatch): void
  protected abstract subscribeToSymbols(batch: StreamBatch): Promise<void>
} 