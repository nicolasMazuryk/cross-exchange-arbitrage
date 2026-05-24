import { ArbitrageEngine, ArbitrageOpportunity } from '../core/arbitrage/arbitrageEngine'

interface TrackedOpportunity {
  legs: {
    buyExchange: string
    sellExchange: string
    buyMarketType: string
    sellMarketType: string
    buySymbol: string
    sellSymbol: string
  }
  current: number
  previous: number
  history: number[]
  spreadPercent: number
  fundingPercent: number
  costsPercent: number
  lastSeenMs: number
}

const PROFIT_THRESHOLD = 0.2
const STALE_MS = 1000
const HISTORY_CAP = 10

function makeKey(opp: ArbitrageOpportunity): string {
  return `${opp.normalizedPair}|${opp.buyExchange}:${opp.buyMarketType}->${opp.sellExchange}:${opp.sellMarketType}`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function fmt(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3) + '%'
}

export function startOpportunityTracker(engine: ArbitrageEngine): NodeJS.Timeout {
  const map = new Map<string, TrackedOpportunity>()

  engine.on('opportunities', (opps: ArbitrageOpportunity[]) => {
    const now = Date.now()
    for (const opp of opps) {
      if (opp.estimatedProfitPercent <= 0) continue
      const key = makeKey(opp)
      const existing = map.get(key)
      if (existing) {
        existing.current = opp.estimatedProfitPercent
        existing.spreadPercent = opp.spreadProfitPercent
        existing.fundingPercent = opp.fundingProfitPercent
        existing.costsPercent = opp.costsPercent
        existing.lastSeenMs = now
      } else {
        map.set(key, {
          legs: {
            buyExchange: opp.buyExchange,
            sellExchange: opp.sellExchange,
            buyMarketType: opp.buyMarketType,
            sellMarketType: opp.sellMarketType,
            buySymbol: opp.buyExchangeSymbol,
            sellSymbol: opp.sellExchangeSymbol,
          },
          current: opp.estimatedProfitPercent,
          previous: opp.estimatedProfitPercent,
          history: [opp.estimatedProfitPercent],
          spreadPercent: opp.spreadProfitPercent,
          fundingPercent: opp.fundingProfitPercent,
          costsPercent: opp.costsPercent,
          lastSeenMs: now,
        })
      }
    }
  })

  return setInterval(() => {
    const now = Date.now()

    for (const [key, entry] of map.entries()) {
      if (now - entry.lastSeenMs > STALE_MS) {
        map.delete(key)
        continue
      }
      entry.history.push(entry.current)
      if (entry.history.length > HISTORY_CAP) entry.history.shift()
    }

    const rows = [...map.entries()]
      .filter(([, e]) => e.current > PROFIT_THRESHOLD)
      .sort(([, a], [, b]) => b.current - a.current)

    if (rows.length === 0) {
      for (const entry of map.values()) entry.previous = entry.current
      return
    }

    process.stdout.write('\x1Bc')
    const header = [
      pad('pair', 12),
      pad('buy', 16),
      pad('sell', 16),
      pad('buySym', 18),
      pad('sellSym', 18),
      pad('spread%', 9),
      pad('funding%', 9),
      pad('costs%', 9),
      pad('profit%', 9),
      pad('Δ%', 9),
      pad('MA10%', 9),
    ].join(' ')
    console.log(header)
    console.log('-'.repeat(header.length))

    for (const [, e] of rows) {
      const delta = e.current - e.previous
      e.previous = e.current
      const ma10 = e.history.reduce((a, b) => a + b, 0) / e.history.length
      const buy = `${e.legs.buyExchange}/${e.legs.buyMarketType}`
      const sell = `${e.legs.sellExchange}/${e.legs.sellMarketType}`
      const pair = `${e.legs.buySymbol.split('/')[0]}`
      console.log(
        [
          pad(pair, 12),
          pad(buy, 16),
          pad(sell, 16),
          pad(e.legs.buySymbol, 18),
          pad(e.legs.sellSymbol, 18),
          pad(fmt(e.spreadPercent), 9),
          pad(fmt(e.fundingPercent), 9),
          pad(fmt(-e.costsPercent), 9),
          pad(fmt(e.current), 9),
          pad(fmt(delta), 9),
          pad(fmt(ma10), 9),
        ].join(' ')
      )
    }
  }, 1000)
}
