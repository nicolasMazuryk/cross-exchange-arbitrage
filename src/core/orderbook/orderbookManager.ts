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
  firstUpdateId: number
  finalUpdateId: number
  prevFinalUpdateId: number
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
  private topOfBook: Map<string, Map<string, TopOfBook>> = new Map() // exchange -> symbol -> topOfBook
  private trackedPairs: Set<string>

  constructor() {
    super()
    this.trackedPairs = new Set(config.trackedPairs)
  }

  private handleSnapshotUpdate(
    exchange: string,
    symbol: string,
    bids: OrderBookLevel[],
    asks: OrderBookLevel[],
    finalUpdateId: number,
    timestamp: number
  ): void {
    const exchangeOrderbooks = this.orderbooks.get(exchange)!
    
    exchangeOrderbooks.set(symbol, {
      bids,
      asks,
      finalUpdateId,
      timestamp
    })
  }

  private handleDeltaUpdate(): void {}

  public updateOrderbook(update: OrderBookUpdate): void {
    const { exchange, symbol, bids, asks, firstUpdateId, finalUpdateId, prevFinalUpdateId, timestamp, type } = update

    // Initialize exchange maps if they don't exist
    if (!this.orderbooks.has(exchange)) {
      this.orderbooks.set(exchange, new Map())
      this.topOfBook.set(exchange, new Map())
    }

    const exchangeOrderbooks = this.orderbooks.get(exchange)!
    const exchangeTopOfBook = this.topOfBook.get(exchange)!

    // Process the update based on its type
    if (type === 'snapshot') {
      this.handleSnapshotUpdate(exchange, symbol, bids, asks, finalUpdateId, timestamp)
    }

    if (type === 'delta') {
      this.handleDeltaUpdate()
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
        timestamp
      }

      // Emit update only if top of book has changed
      if (
        !symbolTopOfBook ||
        symbolTopOfBook.bestBid.price !== bestBid.price ||
        symbolTopOfBook.bestAsk.price !== bestAsk.price
      ) {
        this.emit('topOfBookUpdate', newTopOfBook)
        exchangeTopOfBook.set(symbol, newTopOfBook)

        // Log updates for tracked pairs
        if (this.trackedPairs.has(symbol)) {
          logger.info(`Top of book update for ${exchange}:${symbol}:`, {
            bestBid: bestBid.price,
            bestBidQty: bestBid.quantity,
            bestAsk: bestAsk.price,
            bestAskQty: bestAsk.quantity,
            spread
          })
        }
      }
    }
  }

  public getOrderbook(exchange: string, symbol: string): OrderBook | undefined {
    return this.orderbooks.get(exchange)?.get(symbol)
  }

  public getTopOfBook(exchange: string, symbol: string): TopOfBook | undefined {
    return this.topOfBook.get(exchange)?.get(symbol)
  }

  public getAllOrderbooks(): Map<string, Map<string, OrderBook>> {
    return this.orderbooks
  }

  public getAllTopOfBooks(): Map<string, Map<string, TopOfBook>> {
    return this.topOfBook
  }
}
