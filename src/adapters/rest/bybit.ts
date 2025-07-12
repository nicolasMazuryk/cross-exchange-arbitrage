import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import logger from '../../utils/logger'
import { getPositionSide, positionId } from '../../utils/utils'

const CCXT_EXCHANGE_NAME = 'bybit'

export class BybitExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    // TODO: review response structure and normalize it for all assets
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const { totalAvailableBalance, totalEquity } = balances.info.result.list[0]

      balanceInfos.push({
        asset: 'USDT',
        total: parseFloat(totalEquity),
        available: parseFloat(totalAvailableBalance)
      })

      logger.debug(`[${this.exchangeId}] Fetched ${balanceInfos.length} balance entries`)
      return balanceInfos
    } catch (error) {
      logger.error(`Error fetching balance snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
    try {
      const positions = await this.exchange.fetchPositions()
      const positionInfos: PositionInfo[] = []

      for (const position of positions) {
        const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp } = position  
            positionInfos.push({
              id: positionId(symbol, side!.toUpperCase() as PositionSide),
              symbol: symbol,
              side: side!.toUpperCase() as PositionSide,
              size: Math.abs(position.contracts! * position.contractSize!),
              entryPrice: entryPrice!,
              leverage: Number(leverage) || 1,
              unrealizedPnL: unrealizedPnl!,
              timestamp: timestamp!,
              date: new Date(timestamp!)
              // liquidationPrice: liqPrice,
              // notional: notional,
            })
      }

      logger.debug(`[${this.exchangeId}] Fetched ${positionInfos.length} position entries`)
      return positionInfos
    } catch (error) {
      logger.error(`Error fetching position snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
      const orderInfos: OrderInfo[] = []

      for (const order of orders) {
        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          symbol: order.symbol || '',
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: getPositionSide(order.side!.toUpperCase() as OrderSide, order.reduceOnly!),
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status!),
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

  private normalizeOrderStatus(bybitStatus: string): OrderStatus {
    switch (bybitStatus.toUpperCase()) {
      // case 'NEW':
      // case 'UNTRIGGERED':
      //   return 'NEW'
      // case 'PARTIALLYFILLED':
      //   return 'PARTIALLY_FILLED'
      // case 'FILLED':
      //   return 'FILLED'
      // case 'CANCELLED':
      // case 'PARTIALLYFILLEDCANCELLED':
      // case 'DEACTIVATED':
      //   return 'CANCELED'
      // case 'REJECTED':
      //   return 'FAILED'
      // default:
      //   return 'UNKNOWN'

      case 'OPEN':
        return 'NEW'
      case 'CLOSED':
        return 'FILLED'
      case 'CANCELED':
        return 'CANCELED'
      case 'REJECTED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
}
