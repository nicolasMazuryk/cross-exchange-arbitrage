import { WebsocketClient } from 'okx-api'
import { BasePrivateWebSocketClient } from './base'
import { WebSocketConfig, PrivateWebSocketMessageParser } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide, MarketType } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { convertExchangeSymbolToUnifiedSymbol } from '../../../utils/utils'

const EXCHANGE_NAME = 'okx'

const logger = new Logger(`ws-private-${EXCHANGE_NAME}`)

export class OKXPrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: OKXPrivateMessageParser

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new OKXPrivateMessageParser()
  }

  protected createClient(): WebsocketClient {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error('API key and secret are required for OKX WebSocket client')
    }

    return new WebsocketClient({
      accounts: [{
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        apiPass: this.config.apiPass || '',
      }]
    })
  }

  protected setupEventHandlers(): void {
    this.client.on('open', () => {
      logger.debug({ msg: 'Account WebSocket connection opened', function: 'OKXPrivateWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName })
      this.isConnected = true
    })

    this.client.on('close', () => {
      logger.warn({
        msg: 'Account WebSocket connection closed',
        function: 'OKXPrivateWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('response', (data: any) => {
      logger.debug({ msg: 'Account WebSocket reply received', function: 'OKXPrivateWebSocketClient.setupEventHandlers.response',
        exchange: this.exchangeName,
        data, })
    })

    this.client.on('reconnect', (data: any) => {
      logger.info({ msg: 'Account WebSocket reconnecting...', function: 'OKXPrivateWebSocketClient.setupEventHandlers.reconnect',
          exchange: this.exchangeName,
          wsKey: data?.wsKey })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info({ msg: 'Account WebSocket reconnected', function: 'OKXPrivateWebSocketClient.setupEventHandlers.reconnected',
          exchange: this.exchangeName,
          wsKey: data?.wsKey })
      this.isConnected = true
    })

    this.client.on('error', (error: any) => {
      logger.error({ msg: 'Account WebSocket error', function: 'OKXPrivateWebSocketClient.setupEventHandlers.error',
          exchange: this.exchangeName,
          error })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('update', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error({ msg: 'Error parsing Account WebSocket message', function: 'OKXPrivateWebSocketClient.setupEventHandlers.update',
            exchange: this.exchangeName,
            data,
            error })
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    this.client.subscribe([
      {
        channel: 'account',
        instType: 'SWAP'
      },
      {
        channel: 'positions',
        instType: 'SWAP'
      },
      {
        channel: 'orders',
        instType: 'SWAP'
      }
    ])
    logger.info({ msg: 'Subscribed to account WebSocket streams', function: 'OKXPrivateWebSocketClient.subscribeToAccountStreams',
        exchange: this.exchangeName })
  }
}

class OKXPrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    const balances: BalanceInfo[] = []
    
    if (data.data && Array.isArray(data.data)) {
      for (const account of data.data) {
        if (account.details && Array.isArray(account.details)) {
          for (const detail of account.details) {
            balances.push({
              asset: detail.ccy,
              total: parseFloat(detail.cashBal),
              available: parseFloat(detail.availBal)
            })
          }
        }
      }
    }

    return balances
  }

  parsePositionUpdate(data: any, restClient: RestClientInterface): PositionInfo[] {
    const positions: PositionInfo[] = []
    
    if (data.data && Array.isArray(data.data)) {
      // Get trading markets to access contractSize
      const markets = restClient.getTradingMarkets()
      
      for (const position of data.data) {
        const symbol = convertExchangeSymbolToUnifiedSymbol(position.instId, MarketType.FUTURES, 'USDT')
        const contracts = Math.abs(parseFloat(position.pos))
        const contractSize = markets[symbol]?.contractSize || 1
        // Calculate real position size: contracts * contractSize
        const size = contracts * contractSize

        positions.push({
          id: position.posId,
          symbol: symbol,
          side: position.posSide.toUpperCase(),
          size: size,
          entryPrice: parseFloat(position.avgPx) || 0,
          leverage: parseFloat(position.lever) || 1,
          unrealizedPnL: parseFloat(position.upl) || 0,
          timestamp: Number(position.cTime) || 0,
          date: new Date(Number(position.cTime))
        })
      }
    }

    return positions
  }

  parseOrderUpdate(data: any, restClient: RestClientInterface): OrderInfo[] {
    const orders: OrderInfo[] = []
    
    if (data.data && Array.isArray(data.data)) {        
      for (const order of data.data) {
        const symbol = convertExchangeSymbolToUnifiedSymbol(order.instId, MarketType.FUTURES, 'USDT')
        const contracts = Math.abs(parseFloat(order.sz))
        const contractSize = restClient.getTradingMarkets()[symbol]?.contractSize || 1
        // Calculate real position size: contracts * contractSize
        const size = contracts * contractSize

        orders.push({
          id: order.ordId,
          clientOrderId: order.clOrdId,
          symbol: symbol,
          exchange: EXCHANGE_NAME,
          orderSide: order.side.toUpperCase() as OrderSide,
          positionSide: order.posSide.toUpperCase() as PositionSide,
          type: order.ordType.toUpperCase() as OrderType,
          price: parseFloat(order.px) || 0,
          averagePrice: parseFloat(order.avgPx) || 0,
          quantity: size,
          status: this.normalizeOrderStatus(order.state),
          timestamp: parseInt(order.cTime),
          date: new Date(parseInt(order.cTime))
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

  private normalizeOrderStatus(okxStatus: string): OrderStatus {
    switch (okxStatus) {
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