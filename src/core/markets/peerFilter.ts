import { Dictionary, Market } from 'ccxt'
import { MarketType } from '../../types/exchange'
import { marketTypeFromCcxtMarket } from '../../utils/utils'
import { MarketMetadataService } from './marketMetadataService'

/**
 * A single tradable market participating in peer counting.
 */
interface Leg {
  exchange: string
  marketType: MarketType
  symbol: string
}

export interface PeerFilterStats {
  minPeers: number
  enabled: boolean
  perExchange: Record<string, { before: number; after: number; dropped: number }>
  totalBefore: number
  totalAfter: number
  totalDropped: number
}

/**
 * Prune markets that lack enough arbitrage peers to ever form a spread pair.
 *
 * A peer of market m is any leg L (across ALL exchanges AND ALL market types) that shares m's
 * normalized base/quote and is NOT `(same exchange AND same market type)`. This mirrors the arb
 * engine's pairing rule (arbitrageEngine.ts: skip same-exchange + same-type), so it covers:
 *   - spot↔spot cross-exchange   (same type → peer must be a different exchange)
 *   - spot↔perp                  (different type → peer can be same OR different exchange)
 *   - perp↔perp cross-exchange   (same type → peer must be a different exchange)
 *
 * A market is kept iff it has at least `minPeers` peers. `minPeers <= 0` disables the filter and
 * returns the input unchanged.
 */
export function filterByPeerCount(
  marketsMap: Map<string, Dictionary<Market>>,
  metadataServices: Map<string, MarketMetadataService>,
  minPeers: number
): { pruned: Map<string, Dictionary<Market>>; stats: PeerFilterStats } {
  const perExchange: Record<string, { before: number; after: number; dropped: number }> = {}

  // Disabled path — keep everything.
  if (!minPeers || minPeers <= 0) {
    let total = 0
    for (const [exchange, markets] of marketsMap) {
      const count = Object.keys(markets).length
      perExchange[exchange] = { before: count, after: count, dropped: 0 }
      total += count
    }
    return {
      pruned: marketsMap,
      stats: { minPeers, enabled: false, perExchange, totalBefore: total, totalAfter: total, totalDropped: 0 },
    }
  }

  // Pass A — group every market by its normalized base/quote across all exchanges.
  const groups = new Map<string, Leg[]>()
  for (const [exchange, markets] of marketsMap) {
    const svc = metadataServices.get(exchange)
    if (!svc) continue
    for (const [symbol, market] of Object.entries(markets)) {
      if (!market) continue
      const bq = svc.normalizeBaseQuote(symbol)
      if (!bq) continue
      const marketType = marketTypeFromCcxtMarket(market)
      let legs = groups.get(bq)
      if (!legs) {
        legs = []
        groups.set(bq, legs)
      }
      legs.push({ exchange, marketType, symbol })
    }
  }

  // Pass B — keep each market iff it has >= minPeers peers in its group.
  const pruned = new Map<string, Dictionary<Market>>()
  let totalBefore = 0
  let totalAfter = 0
  for (const [exchange, markets] of marketsMap) {
    const before = Object.keys(markets).length
    totalBefore += before

    const svc = metadataServices.get(exchange)
    // No metadata service → cannot evaluate; keep the exchange's markets untouched.
    if (!svc) {
      pruned.set(exchange, markets)
      perExchange[exchange] = { before, after: before, dropped: 0 }
      totalAfter += before
      continue
    }

    const kept: Dictionary<Market> = {}
    for (const [symbol, market] of Object.entries(markets)) {
      if (!market) continue
      const bq = svc.normalizeBaseQuote(symbol)
      const marketType = marketTypeFromCcxtMarket(market)
      const legs = groups.get(bq) || []

      let peers = 0
      for (const leg of legs) {
        // A same-exchange + same-type leg (including the market itself) is never a peer.
        if (leg.exchange === exchange && leg.marketType === marketType) continue
        peers++
        if (peers >= minPeers) break
      }

      if (peers >= minPeers) kept[symbol] = market
    }

    const after = Object.keys(kept).length
    pruned.set(exchange, kept)
    perExchange[exchange] = { before, after, dropped: before - after }
    totalAfter += after
  }

  return {
    pruned,
    stats: {
      minPeers,
      enabled: true,
      perExchange,
      totalBefore,
      totalAfter,
      totalDropped: totalBefore - totalAfter,
    },
  }
}
