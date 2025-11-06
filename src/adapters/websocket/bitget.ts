import { WebsocketClientV2 } from 'bitget-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

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
        finalUpdateId: orderbookData.seq,
        traceId: '', // Will be set by the message handler
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
      logger.debug({ msg: 'WebSocket connection opened', function: 'BitgetPublicWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        wsKey: data.wsKey
      })
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn({
        msg: 'WebSocket connection closed',
        exchange: this.exchangeName,
        batchId: batch.id
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('response', (data: any) => {
      logger.debug({ msg: 'WebSocket reply received', function: 'BitgetPublicWebSocketClient.setupEventHandlers.response',
        exchange: this.exchangeName,
        batchId: batch.id,
        data
      })
    })
  
    batch.client.on('reconnect', (data: any) => {
      logger.info({
        msg: 'WebSocket automatically reconnecting',
        exchange: this.exchangeName,
        batchId: batch.id,
        wsKey: data?.wsKey,
      })
      batch.isConnected = false
    })

    batch.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'WebSocket reconnected successfully',
        exchange: this.exchangeName,
        batchId: batch.id,
        wsKey: data?.wsKey
      })
      batch.isConnected = true
    })

    batch.client.on('exception', async (error: any) => {
      logger.error({
        msg: 'WebSocket error',
        exchange: this.exchangeName,
        batchId: batch.id,
        error: JSON.stringify(error)
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('update', (data: any) => {
      TraceContext.runWithTrace(`ws-orderbook-update-${this.exchangeName}`, async (traceId) => {
        try {
          if (this.messageParser.isOrderBookMessage(data)) {
            const update = this.messageParser.parseOrderBookUpdate(data)
            update.traceId = traceId
            this.emit('orderbookUpdate', update)
          }
        } catch (error) {
          logger.error({
            msg: 'Error parsing WebSocket message',
            exchange: this.exchangeName,
            batchId: batch.id,
            error
          })
        }
      }).catch(error => {
        logger.error({
          msg: 'Error in trace context for WebSocket message',
          function: 'BitgetPublicWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          error,
        })
      })
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