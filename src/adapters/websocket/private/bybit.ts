import { WebsocketClient } from 'bybit-api'
import { BasePrivateWebSocketClient } from './base'
import { WebSocketConfig, PrivateWebSocketMessageParser } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderSide, OrderType, OrderStatus } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { MarketType } from '../../../types/exchange'
import { convertExchangeSymbolToUnifiedSymbol, getPositionSide, positionId } from '../../../utils/utils'

const EXCHANGE_NAME = 'bybit'

const logger = new Logger(`ws-private-${EXCHANGE_NAME}`)

export class BybitPrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BybitPrivateMessageParser

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new BybitPrivateMessageParser()
  }

  protected createClient(): WebsocketClient {
    return new WebsocketClient({
      key: this.config.apiKey,
      secret: this.config.apiSecret,
    })
  }

  protected setupEventHandlers(): void {
    this.client.on('open', () => {
      logger.debug({
        msg: 'Account WebSocket connection opened',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
      })
      this.isConnected = true
    })

    this.client.on('close', () => {
      logger.warn({
        msg: 'Account WebSocket connection closed',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('response', (data: any) => {
      logger.debug({
        msg: 'Account WebSocket reply received',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.response',
        exchange: this.exchangeName,
        data,
      })
    })

    this.client.on('reconnect', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnecting...',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.reconnect',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnected',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.reconnected',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('exception', (error: any) => {
      logger.error({
        msg: 'WebSocket connection error',
        function: 'BybitPrivateWebSocketClient.setupEventHandlers.exception',
        exchange: this.exchangeName,
        error,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('update', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error({
          msg: 'Error parsing Account WebSocket message',
          function: 'BybitPrivateWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          data,
          error,
        })
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    this.client.subscribeV5(['order', 'position', 'wallet'], 'linear')
    logger.info({
      msg: 'Subscribed to account WebSocket streams',
      function: 'BybitPrivateWebSocketClient.subscribeToAccountStreams',
      exchange: this.exchangeName,
    })
  }
}

class BybitPrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    const balances: BalanceInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const wallet of data.data) {
        balances.push({
          asset: wallet.coin[0].coin,
          total: parseFloat(wallet.totalEquity),
          available: parseFloat(wallet.totalAvailableBalance),
        })
      }
    }

    return balances
  }

  parsePositionUpdate(data: any): PositionInfo[] {
    const positions: PositionInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const position of data.data) {
        const symbol = convertExchangeSymbolToUnifiedSymbol(position.symbol, MarketType.FUTURES, 'USDT')
        const side = position.side === 'Buy' ? 'LONG' : 'SHORT'
        positions.push({
          id: positionId(symbol, side),
          symbol: symbol,
          side: side,
          size: Math.abs(parseFloat(position.size)),
          entryPrice: parseFloat(position.entryPrice) || 0,
          leverage: parseFloat(position.leverage) || 1,
          unrealizedPnL: parseFloat(position.unrealisedPnl) || 0,
          timestamp: Number(position.createdTime) || 0,
          date: new Date(Number(position.createdTime)),
        })
      }
    }

    return positions
  }

  parseOrderUpdate(data: any): OrderInfo[] {
    const orders: OrderInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const order of data.data) {
        orders.push({
          id: order.orderId,
          clientOrderId: order.orderLinkId,
          symbol: convertExchangeSymbolToUnifiedSymbol(order.symbol, MarketType.FUTURES, 'USDT'),
          exchange: EXCHANGE_NAME,
          orderSide: order.side.toUpperCase() as OrderSide,
          positionSide: getPositionSide(order.side!.toUpperCase() as OrderSide, order.reduceOnly!),
          type: order.orderType.toUpperCase() as OrderType,
          price: parseFloat(order.price) || 0,
          averagePrice: parseFloat(order.avgPrice) || 0,
          quantity: parseFloat(order.qty),
          status: this.normalizeOrderStatus(order.orderStatus),
          timestamp: parseInt(order.createdTime),
          date: new Date(parseInt(order.createdTime)),
        })
      }
    }

    return orders
  }

  isBalanceMessage(data: any): boolean {
    return data.topic === 'wallet'
  }

  isPositionMessage(data: any): boolean {
    return data.topic === 'position'
  }

  isOrderMessage(data: any): boolean {
    return data.topic === 'order'
  }

  private normalizeOrderStatus(bybitStatus: string): OrderStatus {
    switch (bybitStatus.toUpperCase()) {
      case 'NEW':
      case 'UNTRIGGERED':
      case 'TRIGGERED':
        return 'NEW'
      case 'PARTIALLYFILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELLED':
      case 'PARTIALLYFILLEDCANCELLED':
      case 'DEACTIVATED':
        return 'CANCELED'
      case 'REJECTED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
}
