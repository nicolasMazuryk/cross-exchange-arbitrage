import { WebsocketClient } from 'bybit-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { MarketType } from '../../types/exchange'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'
import { parseLevels } from './parseLevels'

const EXCHANGE_NAME = 'bybit'

class BybitMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string, marketType: MarketType) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.topic?.startsWith('orderbook.50.')
  }

  parseOrderBookUpdate(data: any, marketType: MarketType): OrderBookUpdate {
    return {
      type: data.type,
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.data.s, marketType),
      marketType,
      timestamp: data.cts ?? data.ts,
      asks: parseLevels(data.data.a),
      bids: parseLevels(data.data.b),
      finalUpdateId: data.data.u,
      sequence: data.data.seq,
    }
  }
}

export class BybitPublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BybitMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new BybitMessageParser((id, mt) => this.getUnifiedSymbol(id, mt))
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      key: this.config.apiKey,
      secret: this.config.apiSecret,
    })
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    batch.client.on('open', () => {
      // logger.info({
      //   msg: 'WebSocket connection opened',
      //   function: 'BybitPublicWebSocketClient.setupEventHandlers.open',
      //   exchange: this.exchangeName,
      //   batchId: batch.id,
      //   symbolCount: batch.symbols.length,
      // })
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

    batch.client.on('response', () => {
      // logger.info({
      //   msg: 'WebSocket reply received',
      //   function: 'BybitPublicWebSocketClient.setupEventHandlers.response',
      //   exchange: this.exchangeName,
      //   batchId: batch.id,
      //   data,
      // })
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

    batch.client.on('exception', async (error: any) => {
      const isPerSymbolError = typeof error?.ret_msg === 'string' && error.ret_msg.includes('handler not found')

      if (isPerSymbolError) {
        const topic = error.ret_msg.replace('error:handler not found,topic:', '')
        logger.warn({
          msg: 'WebSocket per-symbol subscription error (topic not found)',
          exchange: this.exchangeName,
          batchId: batch.id,
          topic,
        })
        return
      }

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
      try {
        if (this.messageParser.isOrderBookMessage(data)) {
          const update = this.messageParser.parseOrderBookUpdate(data, batch.marketType)
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
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    const category =
      batch.marketType === MarketType.SPOT ? 'spot' :
      batch.marketType === MarketType.INVERSE_PERP ? 'inverse' : 'linear'
    for (const symbol of batch.symbols) {
      batch.client.subscribeV5(`orderbook.50.${symbol}`, category)
    }
    logger.info({
      msg: 'Subscribed to symbols',
      function: 'BybitPublicWebSocketClient.subscribeToSymbols',
      exchange: this.exchangeName,
      batchId: batch.id,
      marketType: batch.marketType,
      symbolCount: batch.symbols.length,
    })
  }
}
