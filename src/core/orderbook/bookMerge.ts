import { OrderBook, OrderBookLevel, OrderBookUpdate } from './orderbookManager'
import { Logger } from '../../utils/logger'

const logger = new Logger('book-merge')

/**
 * In-place orderbook merge primitives.
 *
 * Hot path: called per WS delta frame. Levels arrays are kept sorted (bids
 * descending, asks ascending — the order exchanges deliver snapshots in), so
 * each delta level is located by binary search. A quantity change mutates the
 * existing level object (zero allocation); price add/remove uses splice.
 * No array copy, no sort.
 */

/** Binary search over a sorted side. Returns the index of `price`, or the
 * bitwise complement of the insertion point when absent. */
function findLevelIndex(levels: OrderBookLevel[], price: number, isBid: boolean): number {
  let lo = 0
  let hi = levels.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const midPrice = levels[mid].price
    if (midPrice === price) return mid
    // Bids sorted descending, asks ascending.
    const midComesFirst = isBid ? midPrice > price : midPrice < price
    if (midComesFirst) lo = mid + 1
    else hi = mid - 1
  }
  return ~lo
}

/** Apply delta levels to a sorted side in place. `quantity === 0` deletes the level. */
export function applyDeltaInPlace(levels: OrderBookLevel[], deltas: OrderBookLevel[], isBid: boolean): void {
  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i]
    // A NaN price would defeat the binary search and could land at index 0
    // as a poisoned top of book — drop malformed levels instead.
    if (!Number.isFinite(delta.price) || !Number.isFinite(delta.quantity)) continue
    const index = findLevelIndex(levels, delta.price, isBid)
    if (index >= 0) {
      if (delta.quantity === 0) {
        levels.splice(index, 1)
      } else {
        const level = levels[index]
        level.quantity = delta.quantity
        level.amount = delta.amount
      }
    } else if (delta.quantity !== 0) {
      levels.splice(~index, 0, delta)
    }
  }
}

/** Replace a stored book's contents from a snapshot without reallocating the OrderBook object. */
export function applySnapshotInPlace(book: OrderBook, update: OrderBookUpdate): void {
  book.bids = ensureSorted(update.bids, true, update)
  book.asks = ensureSorted(update.asks, false, update)
  book.finalUpdateId = update.finalUpdateId
  book.timestamp = update.timestamp
}

/**
 * The binary-search delta merge requires sorted sides. Exchanges deliver
 * snapshots sorted; this one cheap O(n) pass on the (rarer) snapshot path
 * self-heals a mis-sorted feed instead of silently corrupting every
 * subsequent delta merge for that book.
 */
function ensureSorted(levels: OrderBookLevel[], isBid: boolean, update: OrderBookUpdate): OrderBookLevel[] {
  for (let i = 1; i < levels.length; i++) {
    const inOrder = isBid ? levels[i].price < levels[i - 1].price : levels[i].price > levels[i - 1].price
    if (!inOrder) {
      logger.warn({
        msg: 'Snapshot side not sorted — re-sorting',
        function: 'ensureSorted',
        exchange: update.exchange,
        symbol: update.symbol,
        side: isBid ? 'bids' : 'asks',
        index: i,
      })
      return levels.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price))
    }
  }
  return levels
}
