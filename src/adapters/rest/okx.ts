import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide, MarketType } from '../../types/exchange'
import logger from '../../utils/logger'
import { convertExchangeSymbolToUnifiedSymbol, getPositionSide } from '../../utils/utils'

const EXCHANGE_NAME = 'okx'
const CCXT_EXCHANGE_NAME = 'okx'

export class OkxExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(CCXT_EXCHANGE_NAME, config)
  }

  protected getExchangeOrderParams(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    baseParams: ExchangeOrderParams = {}
  ): ExchangeOrderParams {
    return {
      ...baseParams,
      positionSide: getPositionSide(side as OrderSide, baseParams.reduceOnly!).toLowerCase()
    }
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      balanceInfos.push({
        asset: 'USDT',
        total: balances['USDT'].total || 0,
        available: balances['USDT'].free || 0
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
            positionInfos.push({
              id: position.id!,
              symbol: position.symbol,
              side: position.side!.toUpperCase() as PositionSide,
              size: Math.abs(position.contracts! * position.contractSize!),
              entryPrice: position.entryPrice || 0,
              leverage: position.leverage || 1,
              unrealizedPnL: position.unrealizedPnl || 0,
              timestamp: position.timestamp || 0,
              date: new Date(position.timestamp || 0)
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
        const contractSize = this.getTradingMarkets()[order.symbol]?.contractSize || 1
        const size = order.amount * contractSize

        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          exchange: EXCHANGE_NAME,
          symbol: order.symbol || '',
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: order.info.posSide!.toUpperCase() as PositionSide,
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: size,
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

  private normalizeOrderStatus(okxStatus: string): OrderStatus {
    switch (okxStatus.toUpperCase()) {
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