import { WebsocketClientV2 } from 'bitget-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'

const EXCHANGE_NAME = 'bitget'

class BitgetMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.arg?.channel === 'books5'
  }

  parseOrderBookUpdate(data: any): OrderBookUpdate {
    const symbol = this.getUnifiedSymbol(data.arg?.instId || data.arg?.instId)
    
    const orderbookData = data.data[0]
    return {
        type: 'snapshot',
        exchange: EXCHANGE_NAME,
        symbol,
        timestamp: +orderbookData.ts,
        asks: orderbookData.asks.map(([price, quantity]: [string, string]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity),
            amount: parseFloat(price) * parseFloat(quantity),
        })),
        bids: orderbookData.bids.map(([price, quantity]: [string, string]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity),
            amount: parseFloat(price) * parseFloat(quantity),
        })),
        finalUpdateId: orderbookData.seq
    }
  }
}

export class BitgetPublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BitgetMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new BitgetMessageParser(this.getUnifiedSymbol.bind(this))
  }

  protected createClient(): WebsocketClientV2 {
    return new WebsocketClientV2({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      apiPass: this.config.apiPass,
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', (data: any) => {
      // logger.info(`[${this.exchangeName}] WebSocket connection opened for batch ${batch.id} with ${batch.symbols.length} symbols: ${data.wsKey}`)
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn(`[${this.exchangeName}] WebSocket connection closed for batch ${batch.id}`)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('response', (data: any) => {
        // logger.info(`[${this.exchangeName}] WebSocket reply received:`, data)
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
      logger.error(`[${this.exchangeName}] WebSocket error for batch ${batch.id}:`, JSON.stringify(error))
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
      // Subscribe to orderbook depth5 (top 5 levels) for better performance
      batch.client.subscribe({
        instType: 'USDT-FUTURES',
        channel: 'books5', // books15
        instId: symbol,
      })
    }
  }
} 