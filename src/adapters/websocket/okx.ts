import { WebsocketClient } from 'okx-api'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { MarketType } from '../../types/exchange'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import logger from '../../utils/logger'
import { parseLevels } from './parseLevels'

const EXCHANGE_NAME = 'okx'

class OkxMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string, marketType: MarketType) => string) {}

  isOrderBookMessage(data: any): boolean {
    return data.arg?.channel === 'books' // books5 - snapshot (5 levels), books - delta (400 levels)
  }

  parseOrderBookUpdate(data: any, marketType: MarketType): OrderBookUpdate {
    const type = data.action === 'update' ? 'delta' : 'snapshot'

    return {
      type: type,
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.arg.instId, marketType),
      marketType,
      timestamp: +data.data[0].ts,
      asks: parseLevels(data.data[0].asks),
      bids: parseLevels(data.data[0].bids),
      finalUpdateId: data.data[0].seqId,
      sequence: data.data[0].seqId,
    }
  }
}

export class OkxPublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: OkxMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new OkxMessageParser((id, mt) => this.getUnifiedSymbol(id, mt))
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
      const isPerSymbolError = error?.code === '60018' || error?.code === 60018

      if (isPerSymbolError) {
        logger.warn({
          msg: 'WebSocket per-symbol subscription error (channel/instId does not exist)',
          exchange: this.exchangeName,
          batchId: batch.id,
          instId: error?.msg?.match(/instId:([^,\s]+)/)?.[1],
          code: error?.code,
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
    for (const symbol of batch.symbols) {
      // OKX instId is unique per market type (BTC-USDT spot, BTC-USDT-SWAP linear, BTC-USD-SWAP inverse)
      // so no extra instType param needed for the books channel
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
      marketType: batch.marketType,
      symbolCount: batch.symbols.length,
    })
  }
}
