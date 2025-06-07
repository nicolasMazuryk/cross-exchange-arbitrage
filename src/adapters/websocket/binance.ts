import { EventEmitter } from 'events'
import logger from '../../utils/logger'
import config from '../../utils/config'
import { WebsocketClient } from 'binance'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'

const EXCHANGE_NAME = 'binance'

interface StreamBatch {
  id: number
  client: WebsocketClient
  symbols: string[]
  isConnected: boolean
}

export class BinanceWebSocketClient extends EventEmitter {
  private streamBatches: StreamBatch[] = []

  constructor() {
    super()
  }

  async initialize(symbols: string[]): Promise<void> {
    // Group symbols into batches of MAX_STREAMS_PER_CONNECTION
    const batches = this.groupSymbolsIntoBatches(symbols)
    
    for (let i = 0; i < batches.length; i++) {
      await this.createWebSocketConnection(batches[i], i)
    }
  }

  private groupSymbolsIntoBatches(symbols: string[]): string[][] {
    const maxStreams = config.exchanges.binance.maxStreamsPerConnection
    const batches: string[][] = []
    for (let i = 0; i < symbols.length; i += maxStreams) {
      batches.push(symbols.slice(i, i + maxStreams))
    }
    return batches
  }

  private async createWebSocketConnection(symbols: string[], batchIndex: number): Promise<void> {
    const client = new WebsocketClient({
      api_key: config.exchanges.binance.apiKey,
      api_secret: config.exchanges.binance.apiSecret,
      wsUrl: 'wss://fstream.binance.com/ws'
    })
    
    const batch: StreamBatch = {
      id: batchIndex,
      client,
      symbols,
      isConnected: false
    }

    client.on('open', () => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket connection opened for batch ${batch.id} with ${symbols.length} symbols`)
      batch.isConnected = true
    })

    client.on('close', () => {
      logger.warn(`[${EXCHANGE_NAME}] WebSocket connection closed for batch ${batch.id}`)
      batch.isConnected = false
      this.handleConnectionError(batch)
    })

    client.on('message', (data: any) => {
      try {
        if (data.e === 'depthUpdate') {
          const update: OrderBookUpdate = {
            type: 'snapshot',
            exchange: EXCHANGE_NAME,
            symbol: data.s,
            bids: data.b.map(([price, quantity]: [string, string]) => ({
              price: parseFloat(price),
              quantity: parseFloat(quantity),
              amount: parseFloat(price) * parseFloat(quantity)
            })),
            asks: data.a.map(([price, quantity]: [string, string]) => ({
              price: parseFloat(price),
              quantity: parseFloat(quantity),
              amount: parseFloat(price) * parseFloat(quantity)
            })),
            timestamp: data.E,
            firstUpdateId: data.U,
            finalUpdateId: data.u,
            prevFinalUpdateId: data.pu,
          }
          this.emit('orderbookUpdate', update)
        }
      } catch (error) {
        logger.error(`[${EXCHANGE_NAME}] Error parsing WebSocket message for batch ${batch.id}:`, error)
      }
    })
    // read response to command sent via WS stream (e.g LIST_SUBSCRIPTIONS)
    client.on('reply', (data) => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket reply received:`, data)
    })
    
    // receive notification when a ws connection is reconnecting automatically
    client.on('reconnecting', (data) => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket automatically reconnecting for batch ${batch.id} ...`, { wsKey: data?.wsKey })
      batch.isConnected = false
    })
    
    // receive notification that a reconnection completed successfully (e.g use REST to check for missing data)
    client.on('reconnected', (data) => {
      logger.info(`[${EXCHANGE_NAME}] WebSocket reconnected successfully for batch ${batch.id}`, { wsKey: data?.wsKey })
      batch.isConnected = true
    })

    client.on('error', (error: any) => {
      logger.error(`[${EXCHANGE_NAME}] WebSocket error for batch ${batch.id}:`, error)
      batch.isConnected = false
      this.handleConnectionError(batch)
    })

    // Subscribe to orderbook streams for each symbol
    for (const symbol of symbols) {
      client.subscribePartialBookDepths(symbol, 5, 100, 'usdm')
    }

    this.streamBatches.push(batch)
  }

  private handleConnectionError(batch: StreamBatch): void {
    setTimeout(async () => {
      logger.info(`[${EXCHANGE_NAME}] Attempting to reconnect batch ${batch.id}...`)
      await this.createWebSocketConnection(batch.symbols, batch.id)
    }, config.exchanges.binance.reconnectInterval)
  }

  public close(): void {
    this.streamBatches.forEach(batch => {
      batch.client.closeAll()
      batch.isConnected = false
      logger.info(`[${EXCHANGE_NAME}] Closed WebSocket connection for batch ${batch.id}`)
    })
    this.streamBatches = []
  }
}
