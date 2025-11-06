import { WebsocketClient } from 'binance'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'

const EXCHANGE_NAME = 'binance'

const logger = new Logger(`ws-${EXCHANGE_NAME}`)

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
      traceId: '', // Will be set by the message handler
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
      logger.debug({
        msg: 'WebSocket connection opened',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
      })
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      logger.warn({
        msg: 'WebSocket connection closed',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('reply', (data: any) => {
      logger.debug({
        msg: 'WebSocket reply received',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.reply',
        exchange: this.exchangeName,
        batchId: batch.id,
        data,
      })
    })

    batch.client.on('reconnecting', (data: any) => {
      logger.info({
        msg: 'WebSocket automatically reconnecting',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.reconnecting',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        wsKey: data?.wsKey,
      })
      batch.isConnected = false
    })

    batch.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'WebSocket reconnected successfully',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.reconnected',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        wsKey: data?.wsKey,
      })
      batch.isConnected = true
    })

    batch.client.on('error', async (error: any) => {
      logger.error({
        msg: 'WebSocket connection error',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.error',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        error,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('message', (data: any) => {
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
            function: 'BinancePublicWebSocketClient.setupEventHandlers.update',
            exchange: this.exchangeName,
            batchId: batch.id,
            messageType: data?.e,
            symbol: data?.s,
            error,
          })
        }
      }).catch(error => {
        logger.error({
          msg: 'Error in trace context for WebSocket message',
          function: 'BinancePublicWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          error,
        })
      })
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    for (const symbol of batch.symbols) {
      batch.client.subscribePartialBookDepths(symbol, 5, 100, 'usdm')
    }
  }
}
