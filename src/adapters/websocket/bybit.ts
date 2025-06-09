import { WebsocketClient } from 'bybit-api'
import { BaseWebSocketClient } from './base'
import { WebSocketConfig, WebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'

const EXCHANGE_NAME = 'bybit'

class BybitMessageParser implements WebSocketMessageParser {
  isOrderBookMessage(data: any): boolean {
    return data.topic?.startsWith('orderbook.50.')
  }

  parseOrderBookUpdate(data: any): OrderBookUpdate {
    return {
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
  }
}

export class BybitWebSocketClient extends BaseWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser = new BybitMessageParser()

  constructor(config: WebSocketConfig) {
    super(config)
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      key: this.config.apiKey,
      secret: this.config.apiSecret,
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', () => {
      logger.info(`[${this.exchangeName}] WebSocket connection opened for batch ${batch.id} with ${batch.symbols.length} symbols`)
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn(`[${this.exchangeName}] WebSocket connection closed for batch ${batch.id}`)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('response', (data: any) => {
      logger.info(`[${this.exchangeName}] WebSocket reply received:`, data)
    })

    batch.client.on('reconnect', (data: any) => {
      logger.info(`[${this.exchangeName}] WebSocket automatically reconnecting for batch ${batch.id} ...`, {
        wsKey: data?.wsKey,
      })
      batch.isConnected = false
    })

    batch.client.on('reconnected', (data: any) => {
      logger.info(`[${this.exchangeName}] WebSocket reconnected successfully for batch ${batch.id}`, { wsKey: data?.wsKey })
      batch.isConnected = true
    })

    batch.client.on('exception', async (error: any) => {
      logger.error(`[${this.exchangeName}] WebSocket error for batch ${batch.id}:`, error)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('update', (data: any) => {
      try {
        if (this.messageParser.isOrderBookMessage(data)) {
          const update = this.messageParser.parseOrderBookUpdate(data)
          this.emit('orderbookUpdate', update)
        }
      } catch (error) {
        logger.error(`[${this.exchangeName}] Error parsing WebSocket message for batch ${batch.id}:`, error)
      }
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    for (const symbol of batch.symbols) {
      batch.client.subscribeV5(`orderbook.50.${symbol}`, 'linear')
    }
  }
}
