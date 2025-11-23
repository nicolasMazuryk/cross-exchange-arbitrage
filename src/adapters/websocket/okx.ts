import { WebsocketClient } from 'okx-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

const EXCHANGE_NAME = 'okx'

class OkxMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.arg?.channel === 'books' // books5 - snapshot (5 levels), books - delta (400 levels)
  }

  parseOrderBookUpdate(data: any): OrderBookUpdate {
    const type = data.action === 'update' ? 'delta' : 'snapshot'

    return {
      type: type,
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.arg.instId),
      timestamp: +data.data[0].ts,
      asks: data.data[0].asks.map(([price, quantity]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(quantity),
        amount: parseFloat(price) * parseFloat(quantity),
      })),
      bids: data.data[0].bids.map(([price, quantity]: [string, string]) => ({
        price: parseFloat(price),
        quantity: parseFloat(quantity),
        amount: parseFloat(price) * parseFloat(quantity),
      })),
      finalUpdateId: data.data[0].seqId,
      sequence: data.data[0].seqId,
      traceId: '', // Will be set by the message handler
    }
  }
}

export class OkxPublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: OkxMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new OkxMessageParser(this.getUnifiedSymbol.bind(this))
  }

  protected createClient(): WebsocketClient {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error('API key and secret are required for OKX WebSocket client')
    }

    return new WebsocketClient({
      accounts: [
        {
          apiKey: this.config.apiKey,
          apiSecret: this.config.apiSecret,
          apiPass: this.config.apiPass || '',
        },
      ],
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', () => {
      logger.debug({
        msg: 'WebSocket connection opened',
        function: 'OkxPublicWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
      })
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn({
        msg: 'WebSocket connection closed',
        exchange: this.exchangeName,
        batchId: batch.id,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('response', (data: any) => {
      logger.debug({
        msg: 'WebSocket reply received',
        function: 'OkxPublicWebSocketClient.setupEventHandlers.response',
        exchange: this.exchangeName,
        batchId: batch.id,
        data,
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
        wsKey: data?.wsKey,
      })
      batch.isConnected = true
    })

    batch.client.on('error', async (error: any) => {
      logger.error({
        msg: 'WebSocket error',
        exchange: this.exchangeName,
        batchId: batch.id,
        error,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('update', (data: any) => {
      TraceContext.runWithTrace(`ws-orderbook-update-${this.exchangeName}`, async traceId => {
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
            error,
          })
        }
      }).catch(error => {
        logger.error({
          msg: 'Error in trace context for WebSocket message',
          function: 'OKXPublicWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          error,
        })
      })
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    for (const symbol of batch.symbols) {
      batch.client.subscribe({
        channel: 'books', // books5 - snapshot (5 levels), books - delta (400 levels)
        instId: symbol,
      })
    }
    logger.info({
      msg: 'Subscribed to symbols',
      function: 'OkxPublicWebSocketClient.subscribeToSymbols',
      exchange: this.exchangeName,
      batchId: batch.id,
      symbolCount: batch.symbols.length,
    })
  }
}
