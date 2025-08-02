import { EventEmitter } from 'events'
import logger from '../../utils/logger'
import config from '../../utils/config'

export interface OrderBookLevel {
  price: number
  quantity: number
  amount: number
}

export interface OrderBookUpdate {
  type: 'snapshot' | 'delta'
  exchange: string
  symbol: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: number
  firstUpdateId?: number
  finalUpdateId: number
  sequence?: number
  prevFinalUpdateId?: number
}

export interface OrderBook {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  finalUpdateId: number
  timestamp: number
}

export interface TopOfBook {
  exchange: string
  symbol: string
  bestBid: OrderBookLevel
  bestAsk: OrderBookLevel
  spread: number
  timestamp: number
}

export class OrderbookManager extends EventEmitter {
  private orderbooks: Map<string, Map<string, OrderBook>> = new Map() // exchange -> symbol -> orderbook
  private topOfBooks: Map<string, Map<string, TopOfBook>> = new Map() // exchange -> symbol -> topOfBook
  private trackedPairs: Set<string>

  constructor() {
    super()
    this.trackedPairs = new Set(config.trackedPairs)
  }

  public updateOrderbook(update: OrderBookUpdate): void {
    const { exchange, symbol, bids, asks, finalUpdateId, timestamp, type } = update

    // Initialize exchange maps if they don't exist
    if (!this.orderbooks.has(exchange)) {
      this.orderbooks.set(exchange, new Map())
      this.topOfBooks.set(exchange, new Map())
    }

    const exchangeOrderbooks = this.orderbooks.get(exchange)!
    const exchangeTopOfBook = this.topOfBooks.get(exchange)!

    // Process the update based on its type
    if (type === 'snapshot') {
      exchangeOrderbooks.set(symbol, { bids, asks, finalUpdateId, timestamp })
    } else if (type === 'delta') {
      this.handleDeltaUpdate(update)
    }

    // Get the updated orderbook
    const updatedOrderbook = exchangeOrderbooks.get(symbol)!
    const bestBid = updatedOrderbook.bids[0]
    const bestAsk = updatedOrderbook.asks[0]

    if (bestBid && bestAsk) {
      const symbolTopOfBook = exchangeTopOfBook.get(symbol)
      const spread = ((bestAsk.price - bestBid.price) / bestBid.price) * 100

      const newTopOfBook: TopOfBook = {
        exchange,
        symbol,
        bestBid,
        bestAsk,
        spread,
        timestamp,
      }
      exchangeTopOfBook.set(symbol, newTopOfBook)

      if (
        symbolTopOfBook &&
        (symbolTopOfBook.bestBid.price !== bestBid.price || symbolTopOfBook.bestAsk.price !== bestAsk.price)
      ) {
        this.emit('topOfBookUpdate', newTopOfBook)
      }
    }
  }

  private handleDeltaUpdate(update: OrderBookUpdate): void {
    const { exchange, symbol, bids, asks, finalUpdateId, timestamp } = update
    const exchangeOrderbooks = this.orderbooks.get(exchange)!
    const symbolOrderbook = exchangeOrderbooks.get(symbol)

    if (!symbolOrderbook) {
      logger.warn(`Received delta update for non-existent orderbook: ${exchange}:${symbol}`)
      return
    }

    // If this is a snapshot re-broadcast (same update ID), treat it as a snapshot
    if (finalUpdateId === symbolOrderbook.finalUpdateId) {
      logger.info(`Received snapshot re-broadcast for ${exchange}:${symbol}`)
      exchangeOrderbooks.set(symbol, { bids, asks, finalUpdateId, timestamp })
      return
    }

    // Process bids
    const updatedBids = this.processDeltaLevels(symbolOrderbook.bids, bids, true)

    // Process asks
    const updatedAsks = this.processDeltaLevels(symbolOrderbook.asks, asks, false)

    // Update the orderbook
    exchangeOrderbooks.set(symbol, {
      bids: updatedBids,
      asks: updatedAsks,
      finalUpdateId,
      timestamp,
    })
  }

  private processDeltaLevels(
    currentLevels: OrderBookLevel[],
    deltaLevels: OrderBookLevel[],
    isBid: boolean
  ): OrderBookLevel[] {
    const updatedLevels = [...currentLevels]

    for (const delta of deltaLevels) {
      const existingIndex = updatedLevels.findIndex(level => level.price === delta.price)

      if (delta.quantity === 0) {
        // Delete level if quantity is 0
        if (existingIndex !== -1) {
          updatedLevels.splice(existingIndex, 1)
        }
      } else if (existingIndex !== -1) {
        // Update existing level
        updatedLevels[existingIndex] = delta
      } else {
        // Insert new level
        updatedLevels.push(delta)
      }
    }

    // Sort bids in descending order, asks in ascending order
    return updatedLevels.sort((a, b) => {
      return isBid ? b.price - a.price : a.price - b.price
    })
  }

  public getOrderbook(exchange: string, symbol: string): OrderBook | undefined {
    return this.orderbooks.get(exchange)?.get(symbol)
  }

  public getTopOfBook(exchange: string, symbol: string): TopOfBook | undefined {
    return this.topOfBooks.get(exchange)?.get(symbol)
  }

  public getAllOrderbooks(): Map<string, Map<string, OrderBook>> {
    return this.orderbooks
  }

  public getAllTopOfBooks(): Map<string, Map<string, TopOfBook>> {
    return this.topOfBooks
  }
}
