export enum MarketType { SPOT = 'spot', FUTURES = 'futures' }

export type OrderSide = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT'
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'FAILED' | 'UNKNOWN'
export type PositionSide = 'LONG' | 'SHORT'

export interface FeeModel {
  maker: number
  taker: number
}

export interface ExchangeMeta {
  name: string
  isHealthy: boolean
  feeModel: FeeModel
} 