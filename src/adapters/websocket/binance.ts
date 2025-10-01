import { WebsocketClient } from 'binance'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'

const EXCHANGE_NAME = 'binance'

class BinanceMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.e === 'depthUpdate'
  }

  parseOrderBookUpdate(data: any): OrderBookUpdate {
    return {
      type: 'snapshot',
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.s),
      timestamp: data.E,
      asks: data.a.map(([price, quantity]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(quantity),
        amount: parseFloat(price) * parseFloat(quantity),
      })),
      bids: data.b.map(([price, quantity]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(quantity),
        amount: parseFloat(price) * parseFloat(quantity),
      })),
      firstUpdateId: data.U,
      finalUpdateId: data.u,
      prevFinalUpdateId: data.pu,
    }
  }
}

export class BinancePublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BinanceMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new BinanceMessageParser(this.getUnifiedSymbol.bind(this))
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      wsUrl: this.config.wsUrl || 'wss://fstream.binance.com/ws',
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', () => {
      // logger.info(`[${this.exchangeName}] WebSocket connection opened for batch ${batch.id} with ${batch.symbols.length} symbols`)
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn(`[${this.exchangeName}] WebSocket connection closed for batch ${batch.id}`)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('reply', (data: any) => {
      // logger.info(`[${this.exchangeName}] WebSocket reply received:`, data)
    })

    batch.client.on('reconnecting', (data: any) => {
      logger.info(`[${this.exchangeName}] WebSocket automatically reconnecting for batch ${batch.id} ...`, {
        wsKey: data?.wsKey,
      })
      batch.isConnected = false
    })

    batch.client.on('reconnected', (data: any) => {
      logger.info(`[${this.exchangeName}] WebSocket reconnected successfully for batch ${batch.id}`, { wsKey: data?.wsKey })
      batch.isConnected = true
    })

    batch.client.on('error', async (error: any) => {
      logger.error(`[${this.exchangeName}] WebSocket error for batch ${batch.id}:`, error)
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('message', (data: any) => {
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
      batch.client.subscribePartialBookDepths(symbol, 5, 100, 'usdm')
    }
  }
}
