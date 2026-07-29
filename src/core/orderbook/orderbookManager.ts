import { EventEmitter } from 'events'
import { Logger } from '../../utils/logger'
import config from '../../utils/config'
import { MarketType } from '../../types/exchange'
import { getMarketTypeFromUnifiedSymbol } from '../../utils/utils'
import { applyDeltaInPlace, applySnapshotInPlace } from './bookMerge'
import { hotPathCounters } from '../monitoring/hotPathCounters'

const logger = new Logger('orderbook-manager')

export interface OrderBookLevel {
  price: number
  quantity: number
  amount: number
}

export interface OrderBookUpdate {
  type: 'snapshot' | 'delta'
  exchange: string
  symbol: string
  marketType: MarketType
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: number
  firstUpdateId?: number
  finalUpdateId: number
  sequence?: number
  prevFinalUpdateId?: number
  // Unpopulated on the hot path; trace context is created at opportunity emission.
  traceId?: string
}

export interface OrderBook {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  finalUpdateId: number
  timestamp: number
}

/**
 * HOT-PATH CONTRACT: one persistent TopOfBook object per (exchange, symbol) is
 * mutated in place on every update, and `bestBid`/`bestAsk` reference live
 * book levels that are themselves mutated in place. An emitted TopOfBook is
 * valid only during the synchronous emit tick — consumers must copy any field
 * they retain and must not hold the object (or its levels) across ticks.
 */
export interface TopOfBook {
  exchange: string
  symbol: string
  marketType: MarketType
  bestBid: OrderBookLevel
  bestAsk: OrderBookLevel
  spreadPercent: number
  timestamp: number
  // Unpopulated on the hot path; trace context is created at opportunity emission.
  traceId?: string
}

export class OrderbookManager extends EventEmitter {
  // Protected so BookMirror (Phase 2 ingest) can maintain the same stores while
  // presenting the identical public surface to consumers.
  protected orderbooks: Map<string, Map<string, OrderBook>> = new Map() // exchange -> symbol -> orderbook
  protected topOfBooks: Map<string, Map<string, TopOfBook>> = new Map() // exchange -> symbol -> topOfBook
  private trackedPairs: Set<string>

  constructor() {
    super()
    this.trackedPairs = new Set(config.trackedPairs)
  }

  public updateOrderbook(update: OrderBookUpdate): void {
    try {
      const { exchange, symbol, bids, asks, timestamp, type } = update

      // Filter out updates with empty bids and asks arrays
      if (bids.length === 0 && asks.length === 0) {
        return
      }

      hotPathCounters.inc('ob_updates')

      // Initialize exchange maps if they don't exist
      if (!this.orderbooks.has(exchange)) {
        this.orderbooks.set(exchange, new Map())
        this.topOfBooks.set(exchange, new Map())
      }

      const exchangeOrderbooks = this.orderbooks.get(exchange)!
      const exchangeTopOfBook = this.topOfBooks.get(exchange)!

      // Process the update based on its type
      if (type === 'snapshot') {
        let book = exchangeOrderbooks.get(symbol)
        if (!book) {
          book = { bids: [], asks: [], finalUpdateId: 0, timestamp: 0 }
          exchangeOrderbooks.set(symbol, book)
        }
        applySnapshotInPlace(book, update)
      } else if (type === 'delta') {
        this.handleDeltaUpdate(update)
      }

      // Get the updated orderbook
      const updatedOrderbook = exchangeOrderbooks.get(symbol)
      if (!updatedOrderbook) {
        // Orderbook doesn't exist yet (e.g., delta received before snapshot)
        return
      }

      const bestBid = updatedOrderbook.bids[0]
      const bestAsk = updatedOrderbook.asks[0]

      if (bestBid && bestAsk) {
        const spreadPercent = ((bestAsk.price - bestBid.price) / bestBid.price) * 100
        const topOfBook = exchangeTopOfBook.get(symbol)

        if (!topOfBook) {
          // First top-of-book for this symbol: allocate the persistent object; no emit
          // (matches previous behavior — emission requires a prior top to compare against).
          exchangeTopOfBook.set(symbol, {
            exchange,
            symbol,
            marketType: update.marketType,
            bestBid,
            bestAsk,
            spreadPercent,
            timestamp,
          })
          return
        }

        // In-place quantity updates leave the top level object (and its price)
        // unchanged; the top price only moves via insert/delete/snapshot, which
        // replace the level object — so this compare stays valid.
        const topPriceChanged =
          topOfBook.bestBid.price !== bestBid.price || topOfBook.bestAsk.price !== bestAsk.price

        topOfBook.marketType = update.marketType
        topOfBook.bestBid = bestBid
        topOfBook.bestAsk = bestAsk
        topOfBook.spreadPercent = spreadPercent
        topOfBook.timestamp = timestamp

        if (topPriceChanged) {
          hotPathCounters.inc('tob_emits')
          this.emit('topOfBookUpdate', topOfBook)
        }
      }
    } catch (error) {
      logger.error({
        msg: 'Failed to update orderbook',
        event: 'orderbook_update_failed',
        function: 'OrderbookManager.updateOrderbook',
        exchange: update.exchange,
        symbol: update.symbol,
        updateType: update.type,
        updateId: update.finalUpdateId,
        timestamp: update.timestamp,
        error,
      })
    }
  }

  private handleDeltaUpdate(update: OrderBookUpdate): void {
    const { exchange, symbol, bids, asks, finalUpdateId, timestamp } = update
    const exchangeOrderbooks = this.orderbooks.get(exchange)!
    const symbolOrderbook = exchangeOrderbooks.get(symbol)

    if (!symbolOrderbook) {
      logger.warn({
        msg: 'Received delta update for non-existent orderbook',
        function: 'OrderbookManager.handleDeltaUpdate',
        exchange,
        symbol,
        finalUpdateId,
        timestamp,
      })
      return
    }

    // If this is a snapshot re-broadcast (same update ID), treat it as a snapshot
    if (finalUpdateId === symbolOrderbook.finalUpdateId) {
      logger.warn({
        msg: 'Received snapshot re-broadcast',
        function: 'OrderbookManager.handleDeltaUpdate',
        exchange,
        symbol,
        finalUpdateId,
        timestamp,
      })
      applySnapshotInPlace(symbolOrderbook, update)
      return
    }

    // Merge deltas into the stored book in place — no copy, no sort
    applyDeltaInPlace(symbolOrderbook.bids, bids, true)
    applyDeltaInPlace(symbolOrderbook.asks, asks, false)
    symbolOrderbook.finalUpdateId = finalUpdateId
    symbolOrderbook.timestamp = timestamp
  }

  /**
   * Drop an exchange's books (post-reconnect reset). Books rebuild from fresh
   * snapshots; consumers already skip missing books. With `marketType` set,
   * only that type's books are dropped (split ingest workers reset their own
   * slice without nuking a sibling worker's books) — market type is derived
   * from the unified symbol, so books never need to store it.
   */
  public clearExchangeBooks(exchange: string, marketType?: MarketType): void {
    if (!marketType) {
      this.orderbooks.get(exchange)?.clear()
      this.topOfBooks.get(exchange)?.clear()
      return
    }
    for (const store of [this.orderbooks.get(exchange), this.topOfBooks.get(exchange)]) {
      if (!store) continue
      for (const symbol of store.keys()) {
        if (getMarketTypeFromUnifiedSymbol(symbol) === marketType) store.delete(symbol)
      }
    }
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
