import { EventEmitter } from 'events'
import { WebsocketClient } from 'bybit-api'
import logger from '../../utils/logger'
import config from '../../utils/config'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import { wait } from '../../utils/utils'

const EXCHANGE_NAME = 'bybit'

interface StreamBatch {
  id: number
  client: WebsocketClient
  symbols: string[]
  isConnected: boolean
}

export class BybitWebSocketClient extends EventEmitter {
  private streamBatches: StreamBatch[] = []

  constructor() {
    super()
  }

  public async initialize(symbols: string[]): Promise<void> {
    // Group symbols into batches of MAX_STREAMS_PER_CONNECTION
    const batches = this.groupSymbolsIntoBatches(symbols)

    // Create WebSocket connections for each batch
    for (let i = 0; i < batches.length; i++) {
      await this.createWebSocketConnection(batches[i], i)
    }
  }

  private groupSymbolsIntoBatches(symbols: string[]): string[][] {
    const maxStreams = config.exchanges.bybit.maxStreamsPerConnection
    const batches: string[][] = []
    for (let i = 0; i < symbols.length; i += maxStreams) {
      batches.push(symbols.slice(i, i + maxStreams))
    }
    return batches
  }

  private async createWebSocketConnection(symbols: string[], batchIndex: number): Promise<void> {
    const client = new WebsocketClient({
      key: config.exchanges.bybit?.apiKey,
      secret: config.exchanges.bybit?.apiSecret,
    })

    const batch: StreamBatch = {
      id: batchIndex,
      client,
      symbols,
      isConnected: false,
    }

    client.on('open', () => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket connection opened for batch ${batch.id} with ${symbols.length} symbols`)
      batch.isConnected = true
    })

    client.on('close', async () => {
      logger.warn(`[${EXCHANGE_NAME}] WebSocket connection closed for batch ${batch.id}`)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    client.on('update', (data: any) => {
      try {
        if (data.topic?.startsWith('orderbook.50.')) {
          const update: OrderBookUpdate = {
            type: data.type,
            exchange: EXCHANGE_NAME,
            symbol: data.data.s,
            timestamp: data.ts,
            asks: data.data.a.map(([price, quantity]: [string, string]) => ({
              price: parseFloat(price),
              quantity: parseFloat(quantity),
              amount: parseFloat(price) * parseFloat(quantity),
            })),
            bids: data.data.b.map(([price, quantity]: [string, string]) => ({
              price: parseFloat(price),
              quantity: parseFloat(quantity),
              amount: parseFloat(price) * parseFloat(quantity),
            })),
            finalUpdateId: data.data.u,
            sequence: data.data.seq,
          }
          this.emit('orderbookUpdate', update)
        }
      } catch (error) {
        logger.error(`[${EXCHANGE_NAME}] Error parsing WebSocket message for batch ${batch.id}:`, error)
      }
    })

    // read response to command sent via WS stream (e.g LIST_SUBSCRIPTIONS)
    client.on('response', data => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket reply received:`, data)
    })

    // receive notification when a ws connection is reconnecting automatically
    client.on('reconnect', data => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket automatically reconnecting for batch ${batch.id} ...`, {
        wsKey: data?.wsKey,
      })
      batch.isConnected = false
    })

    // receive notification that a reconnection completed successfully (e.g use REST to check for missing data)
    client.on('reconnected', data => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket reconnected successfully for batch ${batch.id}`, { wsKey: data?.wsKey })
      batch.isConnected = true
    })

    client.on('exception', async (error: any) => {
      logger.error(`[${EXCHANGE_NAME}] WebSocket error for batch ${batch.id}:`, error)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    // Subscribe to orderbook streams for each symbol
    for (const symbol of symbols) {
      client.subscribeV5(`orderbook.50.${symbol}`, 'linear')
    }

    this.streamBatches.push(batch)
  }

  private async handleConnectionError(batch: StreamBatch): Promise<void> {
    logger.info(`[${EXCHANGE_NAME}] Attempting to reconnect batch ${batch.id}...`)
    try {
      await wait(config.exchanges.bybit?.reconnectInterval)
      await this.createWebSocketConnection(batch.symbols, batch.id)
    } catch (error) {
      logger.error(`[${EXCHANGE_NAME}] Failed to reconnect batch ${batch.id}:`, error)
      await this.handleConnectionError(batch)
    }
  }

  public close(): void {
    // Close all WebSocket connections
    for (const batch of this.streamBatches) {
      batch.client.closeAll()
    }
    this.streamBatches = []
  }
}
