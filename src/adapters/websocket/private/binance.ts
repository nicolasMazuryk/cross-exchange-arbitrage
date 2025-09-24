import { WebsocketClient } from 'binance'
import { BasePrivateWebSocketClient } from './base'
import { PrivateWebSocketMessageParser, WebSocketConfig } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../../types/exchange'
import logger from '../../../utils/logger'
import { getPositionSide, positionId } from '../../../utils/utils'

const EXCHANGE_NAME = 'binance'

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
      logger.info(`[${this.exchangeName}] Account WebSocket connection opened`)
      this.isConnected = true
    })

    this.client.on('close', () => {
        logger.warn(`[${this.exchangeName}] Account WebSocket connection closed`)
        this.isConnected = false
        this.handleConnectionError()
    })

    this.client.on('reply', (data: any) => {
        logger.info(`[${this.exchangeName}] WebSocket reply received:`, data)
      })

    this.client.on('reconnecting', (data: any) => {
      logger.info(`[${this.exchangeName}] Account WebSocket reconnecting...`, {
        wsKey: data?.wsKey,
      })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info(`[${this.exchangeName}] Account WebSocket reconnected`, {
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('error', (error: any) => {
        logger.error(`[${this.exchangeName}] Account WebSocket error:`, error)
        this.isConnected = false
        this.handleConnectionError()
    })

    this.client.on('message', (data: any) => {
        try {
          this.handleMessage(data)
        } catch (error) {
          logger.error(`[${this.exchangeName}] Error parsing Account WebSocket message:`, error)
        }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    this.client.subscribeUsdFuturesUserDataStream()
    logger.info(`[${this.exchangeName}] Subscribed to account WebSocket streams`)
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
            available: parseFloat(balance.cw)
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
          const side = size > 0 ? 'LONG' : 'SHORT' as PositionSide
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
              date: new Date()
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
        id: data.o.i,
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
        date: new Date(data.T)
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