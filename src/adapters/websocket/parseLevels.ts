import { OrderBookLevel } from '../../core/orderbook/orderbookManager'

/**
 * Parse raw [price, quantity] string tuples into OrderBookLevel[].
 *
 * Hot path: called once per side per WS frame. Indexed loop over a
 * preallocated array, one numeric conversion per field (`amount` reuses the
 * parsed values instead of re-running parseFloat).
 */
export function parseLevels(raw: Array<[string, string]>): OrderBookLevel[] {
  const levels: OrderBookLevel[] = new Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    // parseFloat (not unary +) keeps legacy semantics: malformed input becomes
    // NaN instead of silently coercing '' to 0 (0-quantity means delete-level).
    const price = parseFloat(raw[i][0])
    const quantity = parseFloat(raw[i][1])
    levels[i] = { price, quantity, amount: price * quantity }
  }
  return levels
}
