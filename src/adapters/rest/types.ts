import { Market, Order, Balances, Dictionary } from 'ccxt'

export interface ExchangeConfig {
  apiKey: string
  apiSecret: string
  apiPass?: string
  options?: Record<string, any>
}

export interface ExchangeInterface {
  // Market data
  loadMarkets(): Promise<Dictionary<Market>>
  getUSDTPerpetualSymbols(): Promise<string[]>

  // Trading
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<Order>
  cancelOrder(id: string, symbol: string): Promise<Order>

  // Account
  fetchBalance(): Promise<Balances>

  // Utility
  getExchangeId(): string
}
