import { OrderbookManager, OrderBook, OrderBookLevel, TopOfBook } from './orderbookManager'
import { BookMessage } from '../../ingest/protocol'
import { hotPathCounters } from '../monitoring/hotPathCounters'
import { MarketType } from '../../types/exchange'
import { getMarketTypeFromUnifiedSymbol } from '../../utils/utils'
import { Logger } from '../../utils/logger'

const logger = new Logger('book-mirror')

/**
 * Main-thread read mirror of the per-exchange ingest workers' books.
 *
 * Extends OrderbookManager so every consumer (ArbitrageEngine, TradeExecutor,
 * TradeMonitor, FundingFeeCollector) keeps its existing type and call surface:
 * `getOrderbook`, `getTopOfBook`, `getAllOrderbooks`, `getAllTopOfBooks`,
 * `on('topOfBookUpdate')`. Only the write path differs — books arrive as flat
 * Float64Array messages from workers (already gated on top-price change) and
 * are decoded by mutating persistent level objects (Phase 1 technique), so the
 * steady-state main-thread allocation per message is zero.
 *
 * The Phase 1 hot-path contract carries over unchanged: emitted TopOfBook and
 * its levels are valid only during the synchronous emit tick.
 */
export class BookMirror extends OrderbookManager {
  // exchange:symbol -> last applied worker seq (detects reordering; reset with books)
  private lastSeq: Map<string, number> = new Map()

  public applyBook(msg: BookMessage): void {
    try {
      const { exchange, symbol, timestamp } = msg
      const seqKey = `${exchange}:${symbol}`
      const prevSeq = this.lastSeq.get(seqKey)
      if (prevSeq !== undefined && msg.seq <= prevSeq) {
        // postMessage is ordered, so this only fires on a worker restart that
        // wasn't preceded by resetBooks — apply anyway after logging.
        logger.warn({
          msg: 'Out-of-order book message',
          function: 'BookMirror.applyBook',
          exchange,
          symbol,
          seq: msg.seq,
          prevSeq,
        })
      }
      this.lastSeq.set(seqKey, msg.seq)

      if (!this.orderbooks.has(exchange)) {
        this.orderbooks.set(exchange, new Map())
        this.topOfBooks.set(exchange, new Map())
      }
      const exchangeOrderbooks = this.orderbooks.get(exchange)!
      const exchangeTopOfBooks = this.topOfBooks.get(exchange)!

      let book = exchangeOrderbooks.get(symbol)
      if (!book) {
        book = { bids: [], asks: [], finalUpdateId: 0, timestamp: 0 }
        exchangeOrderbooks.set(symbol, book)
      }
      decodeSideInPlace(book.bids, msg.bids)
      decodeSideInPlace(book.asks, msg.asks)
      book.finalUpdateId = msg.seq
      book.timestamp = timestamp

      const bestBid = book.bids[0]
      const bestAsk = book.asks[0]
      if (!bestBid || !bestAsk) return

      const spreadPercent = ((bestAsk.price - bestBid.price) / bestBid.price) * 100
      let topOfBook = exchangeTopOfBooks.get(symbol)
      if (!topOfBook) {
        topOfBook = {
          exchange,
          symbol,
          marketType: msg.marketType,
          bestBid,
          bestAsk,
          spreadPercent,
          timestamp,
        }
        exchangeTopOfBooks.set(symbol, topOfBook)
      } else {
        topOfBook.marketType = msg.marketType
        topOfBook.bestBid = bestBid
        topOfBook.bestAsk = bestAsk
        topOfBook.spreadPercent = spreadPercent
        topOfBook.timestamp = timestamp
      }

      // The worker already applied the top-price-change gate — every book
      // message represents a top change, so emit unconditionally.
      hotPathCounters.inc('tob_emits')
      this.emit('topOfBookUpdate', topOfBook)
    } catch (error) {
      logger.error({
        msg: 'Failed to apply book message',
        function: 'BookMirror.applyBook',
        exchange: msg.exchange,
        symbol: msg.symbol,
        seq: msg.seq,
        error,
      })
    }
  }

  public override clearExchangeBooks(exchange: string, marketType?: MarketType): void {
    super.clearExchangeBooks(exchange, marketType)
    const prefix = `${exchange}:`
    for (const key of this.lastSeq.keys()) {
      if (!key.startsWith(prefix)) continue
      if (marketType && getMarketTypeFromUnifiedSymbol(key.slice(prefix.length)) !== marketType) continue
      this.lastSeq.delete(key)
    }
    logger.info({ msg: 'Mirror books reset', function: 'BookMirror.clearExchangeBooks', exchange, marketType })
  }
}

/**
 * Decode a flat [p0,q0,p1,q1,...] side into the persistent level array,
 * mutating existing level objects. Allocates only when the side grows past
 * its previous high-water mark.
 */
function decodeSideInPlace(target: OrderBookLevel[], flat: Float64Array): void {
  const n = flat.length >>> 1
  for (let i = 0; i < n; i++) {
    const price = flat[i * 2]
    const quantity = flat[i * 2 + 1]
    let level = target[i]
    if (level === undefined) {
      level = { price: 0, quantity: 0, amount: 0 }
      target[i] = level
    }
    level.price = price
    level.quantity = quantity
    level.amount = price * quantity
  }
  if (target.length > n) target.length = n
}

// Re-export consumer-facing types for convenience at the ingest boundary.
export type { OrderBook, TopOfBook }
