import { OrderSide, OrderType, OrderStatus, PositionSide } from './exchange'

export interface BalanceInfo {
  asset: string
  total: number
  available: number
}

export interface PositionInfo {
  id: string
  symbol: string
  side: PositionSide
  size: number
  entryPrice: number
  leverage: number
  unrealizedPnL: number
  timestamp: number
  date: Date
}

export interface OrderInfo {
  id: string
  clientOrderId: string
  exchange: string
  symbol: string
  orderSide: OrderSide
  positionSide: PositionSide
  type: OrderType
  price: number
  averagePrice: number
  quantity: number
  status: OrderStatus
  timestamp: number
  date: Date
  expectedPrice?: number
  leverage?: number
  latencyMs?: number
  feesUsd?: number
  slippagePercent?: number
}

export interface AccountState {
  balances: BalanceInfo[]
  positions: PositionInfo[]
  orders: OrderInfo[]
}

export interface AccountStateUpdate {
  exchange: string
  type: 'balance' | 'position' | 'order'
  data: BalanceInfo[] | PositionInfo[] | OrderInfo[]
  timestamp: number
  traceId: string
}
