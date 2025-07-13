import { Market, Order, Balances, Dictionary } from 'ccxt'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'

export interface ExchangeConfig {
  apiKey: string
  apiSecret: string
  apiPass?: string
  options?: Record<string, any>
}

export interface RestClientInterface {
  // Market data
  loadMarkets(): Promise<Dictionary<Market>>
  getTradingMarkets(): Dictionary<Market>

  // Trading
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<Order>
  cancelOrder(id: string, symbol: string): Promise<Order>

  // Account
  fetchBalancesSnapshot?(): Promise<BalanceInfo[]>
  fetchPositionsSnapshot?(): Promise<PositionInfo[]>
  fetchOrdersSnapshot?(symbol?: string): Promise<OrderInfo[]>

  // Utility
  getExchangeId(): string
}
