import { WebsocketClient } from 'bybit-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

const EXCHANGE_NAME = 'bybit'

class BybitMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.topic?.startsWith('orderbook.50.')
  }

  parseOrderBookUpdate(data: any): OrderBookUpdate {
    return {
      type: data.type,
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.data.s),
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
      traceId: '', // Will be set by the message handler
    }
  }
}

export class BybitPublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BybitMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new BybitMessageParser(this.getUnifiedSymbol.bind(this))
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      key: this.config.apiKey,
      secret: this.config.apiSecret,
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', () => {
      logger.info({ msg: 'WebSocket connection opened', function: 'BybitPublicWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length
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
      logger.info({ msg: 'WebSocket reply received', function: 'BybitPublicWebSocketClient.setupEventHandlers.response',
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
        error
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
          function: 'BybitPublicWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          error,
        })
      })
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    for (const symbol of batch.symbols) {
      batch.client.subscribeV5(`orderbook.50.${symbol}`, 'linear')
    }
  }
}
