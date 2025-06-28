import { Dictionary, Market } from 'ccxt'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'

export interface WebSocketConfig {
  apiKey?: string
  apiSecret?: string
  apiPass?: string
  wsUrl?: string
  maxStreamsPerConnection: number
  reconnectInterval: number
  options?: Record<string, any>
}

export interface StreamBatch {
  id: number
  client: any
  symbols: string[]
  isConnected: boolean
}

export interface WebSocketClientInterface {
  initialize(markets: Dictionary<Market>): Promise<void>
  close(): void
  on(event: string, listener: (...args: any[]) => void): this
  emit(event: string, ...args: any[]): boolean
}

export interface WebSocketMessageParser {
  parseOrderBookUpdate(data: any): OrderBookUpdate
  isOrderBookMessage(data: any): boolean
} 