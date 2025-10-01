import { WebsocketClientV2 } from 'bitget-api'
import { BasePrivateWebSocketClient } from './base'
import { WebSocketConfig, PrivateWebSocketMessageParser } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderType, OrderStatus, PositionSide } from '../../../types/exchange'
import logger from '../../../utils/logger'
import { MarketType } from '../../../types/exchange'
import { convertExchangeSymbolToUnifiedSymbol, getOrderSide, positionId } from '../../../utils/utils'

const EXCHANGE_NAME = 'bitget'

export class BitgetPrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BitgetPrivateMessageParser

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new BitgetPrivateMessageParser()
  }

  protected createClient(): WebsocketClientV2 {
    return new WebsocketClientV2({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      apiPass: this.config.apiPass,
    })
  }

  protected setupEventHandlers(): void {
    this.client.on('open', (data: any) => {
      // logger.info(`[${this.exchangeName}] Account WebSocket connection opened: ${data.wsKey}`)
      this.isConnected = true
    })

    this.client.on('close', () => {
        logger.warn(`[${this.exchangeName}] Account WebSocket connection closed`)
        this.isConnected = false
        this.handleConnectionError()
    })

    this.client.on('response', (data: any) => {
        // logger.info(`[${this.exchangeName}] Account WebSocket reply received:`, data)
    })

    this.client.on('reconnect', (data: any) => {
        logger.info(`[${this.exchangeName}] Account WebSocket reconnecting...`, { wsKey: data?.wsKey })
        this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
        logger.info(`[${this.exchangeName}] Account WebSocket reconnected`, { wsKey: data?.wsKey })
        this.isConnected = true
    })

    this.client.on('exception', (error: any) => {
        logger.error(`[${this.exchangeName}] Account WebSocket error:`, JSON.stringify(error))
        this.isConnected = false
        this.handleConnectionError()
    })

    this.client.on('update', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error(`[${this.exchangeName}] Error parsing Account WebSocket message:`, error)
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    // Subscribe to account updates for USDT futures
    this.client.subscribeTopic('USDT-FUTURES', 'account', 'default')
    
    // Subscribe to positions updates for USDT futures
    this.client.subscribeTopic('USDT-FUTURES', 'positions', 'default')
    
    // Subscribe to orders updates for USDT futures
    this.client.subscribeTopic('USDT-FUTURES', 'orders', 'default')
    
    logger.info(`[${this.exchangeName}] Subscribed to account WebSocket streams`)
  }
}

class BitgetPrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
      const balances: BalanceInfo[] = []
      
      if (data.data && Array.isArray(data.data)) {
        for (const wallet of data.data) {
            balances.push({
              asset: wallet.marginCoin,
              total: parseFloat(wallet.equity),
              available: parseFloat(wallet.maxOpenPosAvailable)
            })
        }
      }

      return balances
  }

  parsePositionUpdate(data: any): PositionInfo[] {
    const positions: PositionInfo[] = []
      
    if (data.data && Array.isArray(data.data)) {
      for (const position of data.data) {
        const symbol = convertExchangeSymbolToUnifiedSymbol(position.instId, MarketType.FUTURES, 'USDT')
        const positionSide = position.holdSide.toUpperCase() as PositionSide

          positions.push({
            id: positionId(symbol, positionSide),
            symbol: symbol,
            side: positionSide,
            size: Math.abs(parseFloat(position.total)),
            entryPrice: parseFloat(position.openPriceAvg) || 0,
            leverage: parseFloat(position.leverage) || 1,
            unrealizedPnL: parseFloat(position.unrealizedPL) || 0,
            timestamp: Number(position.cTime),
            date: new Date(Number(position.cTime))
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
          clientOrderId: order.clientOid,
          symbol: convertExchangeSymbolToUnifiedSymbol(order.instId, MarketType.FUTURES, 'USDT'),
          exchange: EXCHANGE_NAME,
          orderSide: getOrderSide(order.posSide, order.tradeSide),
          positionSide: order.posSide.toUpperCase() as PositionSide,
          type: order.orderType.toUpperCase() as OrderType,
          price: parseFloat(order.price) || 0,
          averagePrice: parseFloat(order.priceAvg) || 0,
          quantity: parseFloat(order.size),
          status: this.normalizeOrderStatus(order.status),
          timestamp: parseInt(order.cTime),
          date: new Date(Number(order.cTime))
        })
      }
    }

    return orders
  }

  isBalanceMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'account'
  }

  isPositionMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'positions'
  }

  isOrderMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'orders'
  }

  private normalizeOrderStatus(bitgetStatus: string): OrderStatus {
    switch (bitgetStatus) {
      case 'live':
        return 'NEW'
      case 'partially_filled':
        return 'PARTIALLY_FILLED'
      case 'filled':
        return 'FILLED'
      case 'canceled':
        return 'CANCELED'
      case 'failed':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
} 