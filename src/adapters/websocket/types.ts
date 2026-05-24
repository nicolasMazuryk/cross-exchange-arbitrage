import { Dictionary, Market } from 'ccxt'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType } from '../../types/exchange'
import { RestClientInterface } from '../rest/types'

export interface WebSocketConfig {
  apiKey?: string
  apiSecret?: string
  apiPass?: string
  wsUrl?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
  options?: Record<string, any>
  marketType?: MarketType  // absent = handle all market types
}

export interface StreamBatch {
  id: number
  client: any
  symbols: string[]
  marketType: MarketType
  isConnected: boolean
}

export interface PublicWebSocketClientInterface {
  initialize(markets: Dictionary<Market>): Promise<void>
  close(): void
  on(event: string, listener: (...args: any[]) => void): this
  emit(event: string, ...args: any[]): boolean
}

export interface PrivateWebSocketClientInterface {
  readonly restClient: RestClientInterface
  initialize(): Promise<void>
  close(): void
  on(event: string, listener: (...args: any[]) => void): this
  emit(event: string, ...args: any[]): boolean
}

export interface PublicWebSocketMessageParser {
  parseOrderBookUpdate(data: any, marketType: MarketType): OrderBookUpdate
  isOrderBookMessage(data: any, marketType?: MarketType): boolean
}

export interface PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[]
  parsePositionUpdate(data: any, restClient: RestClientInterface): PositionInfo[]
  parseOrderUpdate(data: any, restClient: RestClientInterface): OrderInfo[]
  isBalanceMessage(data: any): boolean
  isPositionMessage(data: any): boolean
  isOrderMessage(data: any): boolean
}
