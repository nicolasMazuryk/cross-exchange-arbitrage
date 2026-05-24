export enum MarketType {
  SPOT = 'spot',
  LINEAR_PERP = 'linear',   // Quote-asset-margined perpetual swap
  INVERSE_PERP = 'inverse', // Coin-margined perpetual swap
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderType = 'MARKET' | 'LIMIT'
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'FAILED' | 'UNKNOWN'
export type PositionSide = 'LONG' | 'SHORT'

export interface ExchangeMeta {
  name: string
  isHealthy: boolean
}
