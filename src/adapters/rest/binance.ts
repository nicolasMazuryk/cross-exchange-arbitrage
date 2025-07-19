import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import logger from '../../utils/logger'

const EXCHANGE_NAME = 'binance'
const CCXT_EXCHANGE_NAME = 'binanceusdm'

export class BinanceExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }

  // Note: Binance doesn't require exchange-specific parameters for order creation
  // The base implementation will be used

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const { availableBalance, totalWalletBalance } = balances.info
      balanceInfos.push({
        asset: 'USDT',
        total: parseFloat(totalWalletBalance),
        available: parseFloat(availableBalance)
      })

      logger.debug(`[${this.exchangeId}] Fetched ${balanceInfos.length} balance entries`)
      return balanceInfos
    } catch (error) {
      logger.error(`Error fetching balance snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
// TODO: review response structure and normalize it once NEW Binance account is created
    try {
      const positions = await this.exchange.fetchPositions()
      const positionInfos: PositionInfo[] = []

      for (const position of positions) {
        if (position && typeof position === 'object') {
          const size = (position as any).contracts || 0
          if (size !== 0) {
            positionInfos.push({
              id: position.id || '',
              symbol: position.symbol || '',
              side: position.side!.toUpperCase() as PositionSide,
              size: Math.abs(size),
              entryPrice: (position as any).entryPrice || 0,
              leverage: (position as any).leverage || 1,
              unrealizedPnL: (position as any).unrealizedPnl || 0,
              timestamp: Date.now(),
              date: new Date(Date.now())
            })
          }
        }
      }

      logger.debug(`[${this.exchangeId}] Fetched ${positionInfos.length} position entries`)
      return positionInfos
    } catch (error) {
      logger.error(`Error fetching position snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    // TODO: review response structure and normalize it once NEW Binance account is created
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
      const orderInfos: OrderInfo[] = []

      for (const order of orders) {
        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          exchange: EXCHANGE_NAME,
          symbol: order.symbol || '',
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: order.side!.toUpperCase() as PositionSide,
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status || ''),
          timestamp: order.timestamp,
          date: new Date(order.timestamp)
        })
      }

      logger.debug(`[${this.exchangeId}] Fetched ${orderInfos.length} order entries`)
      return orderInfos
    } catch (error) {
      logger.error(`Error fetching order snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
// TODO: review response structure and normalize it once NEW Binance account is created
    switch (binanceStatus.toUpperCase()) {
      case 'NEW':
        return 'NEW'
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELED'
      case 'REJECTED':
      case 'EXPIRED':
        return 'FAILED'
      default:
        return 'NEW'
    }
  }
}
