import { WebsocketClient } from 'binance'
import { BasePrivateWebSocketClient } from './base'
import { PrivateWebSocketMessageParser, WebSocketConfig } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { getPositionSide, positionId } from '../../../utils/utils'

const EXCHANGE_NAME = 'binance'

const logger = new Logger(`ws-private-${EXCHANGE_NAME}`)

export class BinancePrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BinancePrivateMessageParser

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new BinancePrivateMessageParser()
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      wsUrl: this.config.wsUrl || 'wss://fstream.binance.com/ws',
    })
  }

  protected setupEventHandlers(): void {
    this.client.on('open', () => {
      logger.debug({
        msg: 'Account WebSocket connection opened',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
      })
      this.isConnected = true
    })

    this.client.on('close', () => {
      logger.warn({
        msg: 'Account WebSocket connection closed',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('reply', (data: any) => {
      logger.debug({
        msg: 'Account WebSocket reply received',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reply',
        exchange: this.exchangeName,
        data,
      })
    })

    this.client.on('reconnecting', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnecting...',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reconnecting',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnected',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reconnected',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('error', (error: any) => {
      logger.error({
        msg: 'Account WebSocket error',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.error',
        exchange: this.exchangeName,
        error,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('message', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error({
          msg: 'Error parsing Account WebSocket message',
          function: 'BinancePrivateWebSocketClient.setupEventHandlers.message',
          exchange: this.exchangeName,
          error,
        })
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    this.client.subscribeUsdFuturesUserDataStream()
    logger.info({
      msg: 'Subscribed to account WebSocket streams',
      function: 'BinancePrivateWebSocketClient.subscribeToAccountStreams',
      exchange: this.exchangeName,
    })
  }
}

class BinancePrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    if (data.e === 'ACCOUNT_UPDATE') {
      const balances: BalanceInfo[] = []

      // Parse balance updates
      if (data.a && data.a.B) {
        for (const balance of data.a.B) {
          balances.push({
            asset: balance.a,
            total: parseFloat(balance.wb),
            available: parseFloat(balance.cw),
          })
        }
      }

      return balances
    }
    return []
  }

  parsePositionUpdate(data: any): PositionInfo[] {
    if (data.e === 'ACCOUNT_UPDATE') {
      const positions: PositionInfo[] = []

      // Parse position updates
      if (data.a && data.a.P) {
        for (const position of data.a.P) {
          const size = parseFloat(position.pa)
          const side = size > 0 ? 'LONG' : ('SHORT' as PositionSide)
          if (size !== 0) {
            positions.push({
              id: positionId(position.s, side),
              symbol: position.s,
              side: side,
              size: size,
              entryPrice: parseFloat(position.ep),
              leverage: 1,
              unrealizedPnL: parseFloat(position.up),
              timestamp: Date.now(),
              date: new Date(),
            })
          }
        }
      }

      return positions
    }
    return []
  }

  parseOrderUpdate(data: any): OrderInfo[] {
    if (data.e === 'ORDER_TRADE_UPDATE') {
      const order: OrderInfo = {
        id: String(data.o.i),
        clientOrderId: data.o.c,
        symbol: data.o.s,
        exchange: EXCHANGE_NAME,
        orderSide: data.o.S.toUpperCase() as OrderSide,
        positionSide: getPositionSide(data.o.S.toUpperCase() as OrderSide, data.o.R),
        type: data.o.o.toUpperCase() as OrderType,
        price: parseFloat(data.o.p) || 0,
        averagePrice: parseFloat(data.o.ap) || 0,
        quantity: parseFloat(data.o.q),
        status: this.normalizeOrderStatus(data.o.X),
        timestamp: data.T,
        date: new Date(data.T),
      }

      return [order]
    }
    return []
  }

  isBalanceMessage(data: any): boolean {
    return data.e === 'ACCOUNT_UPDATE' && data.a && data.a.B
  }

  isPositionMessage(data: any): boolean {
    return data.e === 'ACCOUNT_UPDATE' && data.a && data.a.P
  }

  isOrderMessage(data: any): boolean {
    return data.e === 'ORDER_TRADE_UPDATE'
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
    switch (binanceStatus) {
      case 'NEW':
        return 'NEW'
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELED':
        return 'CANCELED'
      case 'REJECTED':
      case 'EXPIRED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
}
