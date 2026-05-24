/**
 * Phase 5 verification script.
 * Tests: plan-v5 changes — real funding, per-leg perp-only semantics.
 * Run: npx ts-node scripts/verify_phase5.ts
 */

import { MarketType } from '../src/types/exchange'
import { MarketMetadataService } from '../src/core/markets/marketMetadataService'
import { OrderbookManager, OrderBookUpdate } from '../src/core/orderbook/orderbookManager'
import { ArbitrageEngine, ArbitrageOpportunity } from '../src/core/arbitrage/arbitrageEngine'
import { ParsedFunding } from '../src/core/funding/types'

let totalPass = 0, totalFail = 0
function chk(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`)
  ok ? totalPass++ : totalFail++
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockMarket(symbol: string, id: string, opts: {
  spot?: boolean; swap?: boolean; linear?: boolean; inverse?: boolean; contractSize?: number
} = {}): any {
  const colonIdx = symbol.indexOf(':'), slashIdx = symbol.indexOf('/')
  const swap = opts.swap ?? colonIdx >= 0, spot = opts.spot ?? !swap
  const inverse = opts.inverse ?? false, linear = opts.linear ?? (swap && !inverse)
  const base = symbol.slice(0, slashIdx)
  const quote = colonIdx >= 0 ? symbol.slice(slashIdx + 1, colonIdx) : symbol.slice(slashIdx + 1)
  return {
    id, symbol, base, quote, active: true, spot, swap, linear, inverse, option: false, future: false,
    contractSize: opts.contractSize ?? 1,
    precision: { price: 0.01, amount: 0.001 },
    limits: { amount: { min: 0.00001, max: 1e6 }, price: { min: 0.01, max: 1e7 }, cost: { min: 1 } },
  }
}

function ob(exchange: string, symbol: string, mt: MarketType, ask: number, bid: number, id: number): OrderBookUpdate {
  return {
    type: 'snapshot', exchange, symbol, marketType: mt,
    bids: [{ price: bid, quantity: 10000, amount: bid * 10000 }],
    asks: [{ price: ask, quantity: 10000, amount: ask * 10000 }],
    timestamp: Date.now(), finalUpdateId: id, traceId: 'test',
  }
}

function makeFunding(exchange: string, symbol: string, rate: number, nextTs?: number): ParsedFunding {
  return {
    exchange, symbol, fundingRate: rate, fundingRatePercent: rate * 100,
    fundingInterval: 8,
    nextFundingTimestamp: nextTs ?? (Date.now() + 3600 * 1000),
    nextFundingDatetime: new Date(nextTs ?? (Date.now() + 3600 * 1000)),
  }
}

function buildFundingService(state: Map<string, Map<string, ParsedFunding>>) {
  return {
    state,
    getSymbolFundingData(ex: string, sym: string): ParsedFunding | undefined {
      return this.state.get(ex)?.get(sym)
    },
    generateFundingEvents(buyF: ParsedFunding, sellF: ParsedFunding, projHours: number) {
      const start = Math.min(buyF.nextFundingTimestamp, sellF.nextFundingTimestamp)
      const end = start + projHours * 3600 * 1000
      const buyEvts = this.generateExchangeFundingEvents(buyF, start, end)
      const sellEvts = this.generateExchangeFundingEvents(sellF, start, end)
      const map = new Map<number, { buyExchangeFundingRate: number; sellExchangeFundingRate: number }>()
      for (const e of buyEvts) {
        const cur = map.get(e.timestamp) ?? { buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }
        cur.buyExchangeFundingRate = e.fundingRate; map.set(e.timestamp, cur)
      }
      for (const e of sellEvts) {
        const cur = map.get(e.timestamp) ?? { buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }
        cur.sellExchangeFundingRate = e.fundingRate; map.set(e.timestamp, cur)
      }
      return [...map.entries()].map(([ts, v]) => ({ timestamp: ts, ...v })).sort((a, b) => a.timestamp - b.timestamp)
    },
    generateExchangeFundingEvents(f: ParsedFunding, start: number, end: number) {
      const events: { timestamp: number; fundingRate: number }[] = []
      const iMs = f.fundingInterval * 3600 * 1000
      let t = f.nextFundingTimestamp
      while (t < start) t += iMs
      while (t <= end) { events.push({ timestamp: t, fundingRate: f.fundingRate }); t += iMs }
      return events
    },
    isFundingSynchronizedEntry: () => true,
    findNextSyncTimestamp: () => 0,
    calculateCumulativeFundingRate: () => 0,
  } as any
}

function makeEngine(
  exchanges: string[],
  markets: Record<string, any[]>,
  fundingState: Map<string, Map<string, ParsedFunding>>,
  overrides: Record<string, any> = {},
  keepThresholds = false
): { engine: ArbitrageEngine; orderbookMgr: OrderbookManager } {
  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of exchanges) {
    metaMap.set(ex, new MarketMetadataService(ex, markets[ex] ?? [], [], ['linear', 'inverse', 'spot'], ['USDT', 'USD']))
  }
  const orderbookMgr = new OrderbookManager()
  const engine = new ArbitrageEngine(
    orderbookMgr, [],
    exchanges.map(name => ({ name, isHealthy: true })),
    metaMap, buildFundingService(fundingState),
  )
  ;(engine as any).minPersistenceMs = 0
  ;(engine as any).minConsecutiveSnapshots = 0
  ;(engine as any).minConfidenceScore = 0
  ;(engine as any).maxAnomalySpreadThresholdPercent = 100
  ;(engine as any).fundingStrategyEnabled = false
  ;(engine as any).spreadStrategyEnabled = true
  // Always open spread window
  ;(engine as any).spreadStrategyEntryWindowStart = 0
  ;(engine as any).spreadStrategyEntryWindowEnd = 0
  if (!keepThresholds) {
    ;(engine as any).spreadMinSpreadProfitPercent = -999
    ;(engine as any).spreadMinTotalProfitPercent = -999
    ;(engine as any).fundingMinFundingProfitPercent = -999
    ;(engine as any).fundingMinTotalProfitPercent = -999
  }
  for (const [k, v] of Object.entries(overrides)) {
    ;(engine as any)[k] = v
  }
  return { engine, orderbookMgr }
}

/**
 * Seed initial orderbooks for all legs, then drive one exchange with varying prices
 * to trigger topOfBookUpdate (which only fires on price change).
 *
 * legs: array of {exchange, symbol, mt, ask, bid} — seeded once (no emit, sets initial topOfBook)
 * drive: {exchange, symbol, mt, ask, bid} — driven N times with price+tick*i (triggers emit)
 */
function seedAndDrive(
  orderbookMgr: OrderbookManager,
  legs: Array<{ exchange: string; symbol: string; mt: MarketType; ask: number; bid: number }>,
  drive: { exchange: string; symbol: string; mt: MarketType; ask: number; bid: number },
  count = 5
): void {
  // Seed all legs at their prices (first update per exchange+symbol → no emit)
  for (const leg of legs) {
    orderbookMgr.updateOrderbook(ob(leg.exchange, leg.symbol, leg.mt, leg.ask, leg.bid, 1))
  }
  // Drive the trigger leg with slightly varying prices → topOfBookUpdate fires on each
  for (let i = 0; i < count; i++) {
    const tick = (i + 1) * 0.001 // offset so first driven price differs from seed
    orderbookMgr.updateOrderbook(ob(drive.exchange, drive.symbol, drive.mt, drive.ask + tick, drive.bid + tick, i + 10))
  }
}

// ─── Section 1: calculateFundingProjection ───────────────────────────────────

function runSection1(): void {
  console.log('\n══ 1. calculateFundingProjection per-leg semantics ══')

  const { engine } = makeEngine(['x'], { x: [] }, new Map())
  ;(engine as any).projectionHours = 10
  const proj = (buyF: any, sellF: any) => (engine as any).calculateFundingProjection(buyF, sellF)
  const nextTs = Date.now() + 3600 * 1000

  // spot+spot → empty projection
  const p0 = proj(undefined, undefined)
  chk('spot+spot: timeline.length=0', p0.timeline.length === 0)
  chk('spot+spot: totalProjectedFundingRate=0', p0.totalProjectedFundingRate === 0)
  chk('spot+spot: maxDrawdownFundingRate=0', p0.maxDrawdownFundingRate === 0)
  chk('spot+spot: averageHourlyFundingRate=0', p0.averageHourlyFundingRate === 0)

  // spot+perp: sell=perp, +rate → short receives → net = +rate
  const p1 = proj(undefined, makeFunding('ex', 'S', 0.001, nextTs))
  chk('spot+perp sell-perp: timeline non-empty', p1.timeline.length > 0, `len=${p1.timeline.length}`)
  chk('spot+perp sell-perp: netFundingRate = +0.001', Math.abs(p1.timeline[0].netFundingRate - 0.001) < 1e-10)
  chk('spot+perp sell-perp: buyExchangeFundingRate=0', p1.timeline[0].buyExchangeFundingRate === 0)
  chk('spot+perp sell-perp: sellExchangeFundingRate=0.001', p1.timeline[0].sellExchangeFundingRate === 0.001)

  // spot+perp: buy=perp, +rate → long pays → net = -rate
  const p2 = proj(makeFunding('ex', 'S', 0.001, nextTs), undefined)
  chk('spot+perp buy-perp: timeline non-empty', p2.timeline.length > 0)
  chk('spot+perp buy-perp: netFundingRate = -0.001', Math.abs(p2.timeline[0].netFundingRate + 0.001) < 1e-10)
  chk('spot+perp buy-perp: sellExchangeFundingRate=0', p2.timeline[0].sellExchangeFundingRate === 0)
  chk('spot+perp buy-perp: buyExchangeFundingRate=0.001', p2.timeline[0].buyExchangeFundingRate === 0.001)

  // perp+perp: net = -buyRate + sellRate
  const p3 = proj(makeFunding('e1', 'S', 0.001, nextTs), makeFunding('e2', 'S', 0.003, nextTs))
  chk('perp+perp: timeline non-empty', p3.timeline.length > 0)
  chk('perp+perp: netFundingRate = 0.002', Math.abs(p3.timeline[0].netFundingRate - 0.002) < 1e-10, `got=${p3.timeline[0].netFundingRate}`)
  chk('perp+perp: buyExchangeFundingRate=0.001', p3.timeline[0].buyExchangeFundingRate === 0.001)
  chk('perp+perp: sellExchangeFundingRate=0.003', p3.timeline[0].sellExchangeFundingRate === 0.003)

  // perp+perp: negative net (buyRate > sellRate)
  const p4 = proj(makeFunding('e1', 'S', 0.005, nextTs), makeFunding('e2', 'S', 0.001, nextTs))
  chk('perp+perp negative: netFundingRate = -0.004', Math.abs(p4.timeline[0].netFundingRate + 0.004) < 1e-10)
}

// ─── Section 2: estimateProfit handles empty timeline ────────────────────────

function runSection2(): void {
  console.log('\n══ 2. estimateProfit: empty funding timeline (spot+spot) ══')

  const mms = new MarketMetadataService('ex', [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })], [], ['spot'], ['USDT'])
  const { engine } = makeEngine(['ex'], { ex: [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })] }, new Map())

  const emptyProj = { timeline: [], totalProjectedFundingRate: 0, maxDrawdownFundingRate: 0, averageHourlyFundingRate: 0 }
  const sim = { avgExecutionPrice: 100, avgNormalizedExecutionPrice: 100, slippagePercent: 0, hasError: false }
  const fakeBook: any = {
    bids: [{ price: 99, quantity: 10000, amount: 990000 }],
    asks: [{ price: 100, quantity: 10000, amount: 1000000 }],
    timestamp: Date.now(), exchange: 'ex', symbol: 'SOL/USDT', marketType: MarketType.SPOT,
  }

  try {
    const r = (engine as any).estimateProfit(100, 102, 0.2, 0.2, 0.2, 20, 'ex', 'ex', 'SOL/USDT', 'SOL/USDT', fakeBook, fakeBook, mms, mms, sim, sim, sim, sim, emptyProj)
    chk('empty timeline: no throw', true)
    chk('empty timeline: fundingProfitUsd=0', r.fundingProfitUsd === 0, `got=${r.fundingProfitUsd}`)
    chk('empty timeline: fundingProfitPercent=0', r.fundingProfitPercent === 0, `got=${r.fundingProfitPercent}`)
  } catch (e: any) {
    chk('empty timeline: no throw', false, e.message)
    chk('empty timeline: fundingProfitUsd=0', false)
    chk('empty timeline: fundingProfitPercent=0', false)
  }
}

// ─── Section 3: scanOrderbooksForSymbol funding guards ───────────────────────
// NOTE: topOfBookUpdate fires only when price changes vs previous snapshot.
// seedAndDrive() seeds at fixed prices (sets initial topOfBook, no emit),
// then drives with price+tick to trigger emits.

function runSection3(): void {
  console.log('\n══ 3. Funding data lookup + guard in scanOrderbooksForSymbol ══')
  const LINEAR = MarketType.LINEAR_PERP
  const SPOT   = MarketType.SPOT

  // ── 3a: perp+perp no funding → pair skipped ──
  {
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })] },
      new Map(),
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99 }
    )
    chk('3a perp+perp no-funding: 0 opportunities', opps.length === 0, `got=${opps.length}`)
  }

  // ── 3b: spot+perp (binance=spot buy, bybit=perp sell), bybit has funding ──
  {
    const nextTs = Date.now() + 3600 * 1000
    const fs = new Map([['bybit', new Map([['SOL/USDT:USDT', makeFunding('bybit', 'SOL/USDT:USDT', 0.002, nextTs)]])]])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT',      'SOLUSDT',     { spot: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDTSWAP', { swap: true, linear: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    // Binance (spot) is the cheap buy side; bybit (perp) is the expensive sell side
    // Seed both at their symbols, drive binance spot
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT',      mt: SPOT,   ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99 }
    )
    chk('3b spot+perp: opportunities emitted', opps.length > 0, `got=${opps.length}`)
    if (opps.length > 0) {
      const o = opps.find(x => x.buyMarketType === SPOT && x.sellMarketType === LINEAR)
        ?? opps.find(x => x.buyMarketType === LINEAR && x.sellMarketType === SPOT)
        ?? opps[0]
      chk('3b spot+perp: bothLegsArePerp=false', !o.bothLegsArePerp)
      const spotTs = o.buyMarketType === SPOT ? o.buyExchangeNextFundingTimestamp : o.sellExchangeNextFundingTimestamp
      const perpTs = o.buyMarketType !== SPOT ? o.buyExchangeNextFundingTimestamp : o.sellExchangeNextFundingTimestamp
      chk('3b spot+perp: spot leg nextFundingTs=0', spotTs === 0, `got=${spotTs}`)
      chk('3b spot+perp: perp leg nextFundingTs>0', perpTs > 0, `got=${perpTs}`)
      chk('3b spot+perp: targetFundingTs=perpTs', o.targetFundingTimestamp === perpTs,
        `target=${o.targetFundingTimestamp} perp=${perpTs}`)
    }
  }

  // ── 3c: spot+spot, no funding → not blocked by guard ──
  {
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })],
        bybit:   [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })] },
      new Map(),
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT', mt: SPOT, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99 }
    )
    chk('3c spot+spot no-funding: opportunities emitted (guard not triggered)', opps.length > 0, `got=${opps.length}`)
    if (opps.length > 0) {
      const o = opps[0]
      chk('3c spot+spot: bothLegsArePerp=false', !o.bothLegsArePerp)
      chk('3c spot+spot: fundingProfitPercent=0', o.fundingProfitPercent === 0, `fp=${o.fundingProfitPercent}`)
      chk('3c spot+spot: buyNextFundingTs=0', o.buyExchangeNextFundingTimestamp === 0)
      chk('3c spot+spot: sellNextFundingTs=0', o.sellExchangeNextFundingTimestamp === 0)
      chk('3c spot+spot: targetFundingTs=0', o.targetFundingTimestamp === 0)
      chk('3c spot+spot: strategy=spread', o.strategy === 'spread')
    }
  }

  // ── 3d: perp+perp with funding → timestamps and fundingProfit correct ──
  {
    const tsA = Date.now() + 2 * 3600 * 1000
    const tsB = Date.now() + 3 * 3600 * 1000
    const fs = new Map([
      ['binance', new Map([['SOL/USDT:USDT', makeFunding('binance', 'SOL/USDT:USDT', 0.001, tsA)]])],
      ['bybit',   new Map([['SOL/USDT:USDT', makeFunding('bybit',   'SOL/USDT:USDT', 0.003, tsB)]])],
    ])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99 }
    )
    chk('3d perp+perp with-funding: opportunities emitted', opps.length > 0, `got=${opps.length}`)
    if (opps.length > 0) {
      const o = opps.find(x => x.buyExchange === 'binance' && x.sellExchange === 'bybit') ?? opps[0]
      chk('3d perp+perp: bothLegsArePerp=true', o.bothLegsArePerp)
      chk('3d perp+perp: fundingProfitPercent≠0', o.fundingProfitPercent !== 0, `fp=${o.fundingProfitPercent}`)
      chk('3d perp+perp: buyNextFunding>0', o.buyExchangeNextFundingTimestamp > 0)
      chk('3d perp+perp: sellNextFunding>0', o.sellExchangeNextFundingTimestamp > 0)
      chk('3d perp+perp: targetFunding=min(buy,sell)',
        o.targetFundingTimestamp === Math.min(o.buyExchangeNextFundingTimestamp, o.sellExchangeNextFundingTimestamp),
        `target=${o.targetFundingTimestamp}`)
    }
  }
}

// ─── Section 4: determineStrategy new signature ──────────────────────────────

function runSection4(): void {
  console.log('\n══ 4. determineStrategy new signature (buyLegIsPerp, sellLegIsPerp) ══')

  // keepThresholds=true: config defaults (spread min 0.4%, total min -0.1%)
  const { engine } = makeEngine(['x'], { x: [] }, new Map(), {
    spreadStrategyEnabled: true,
    fundingStrategyEnabled: false,
    spreadStrategyEntryWindowStart: 0,
    spreadStrategyEntryWindowEnd: 0,
  }, true)
  const ds = (...args: any[]) => (engine as any).determineStrategy(...args)

  // goodProfit: spreadProfitPercent=2.0, costsPercent=0.5 → 2.0-0.5=1.5 >= 0.4 ✓; estimated=1.5 >= -0.1 ✓
  const goodProfit = {
    spreadProfitPercent: 2.0, estimatedProfitPercent: 1.5, costsPercent: 0.5,
    fundingProfitPercent: 0, fundingProfitUsd: 0, spreadProfitUsd: 40, estimatedProfitUsd: 30,
    costsUsd: 10, tradingFeesUsd: 5, tradingFeesPercent: 0.25, latencyPenalty: 0, confidenceScore: 0.9,
  }
  // badProfit: 0.1-0.5=-0.4 < 0.4 → fails spread; estimated=-2.0 < -0.1 → fails total
  const badProfit = { ...goodProfit, spreadProfitPercent: 0.1, estimatedProfitPercent: -2.0 }

  // futureFunding 1h ahead — spread window always open (entryWindowEnd=0)
  const futureFundingLow  = makeFunding('x', 'SOL/USDT:USDT', 0.001)
  const futureFundingHigh = makeFunding('x', 'SOL/USDT:USDT', 0.01) // high rate for funding validation
  const pastFunding       = makeFunding('x', 'SOL/USDT:USDT', 0.001, Date.now() - 10000)

  // spot+spot — bothLegsArePerp=false
  chk('spot+spot good → spread', ds(undefined, undefined, goodProfit, false).strategy === 'spread')
  {
    const r = ds(undefined, undefined, badProfit, false)
    chk('spot+spot bad → null', r.strategy === null, `strategy=${r.strategy}`)
    chk('spot+spot bad → reason string', typeof r.reason === 'string', r.reason)
  }

  // spot+perp (either leg spot) — bothLegsArePerp=false
  // Non-perp branch ignores funding timestamps entirely; past funding does NOT cause rejection.
  chk('spot+perp (sell-perp) good → spread', ds(undefined, futureFundingLow, goodProfit, false).strategy === 'spread')
  chk('spot+perp (sell-perp) past funding → spread (funding ts ignored)', ds(undefined, pastFunding, goodProfit, false).strategy === 'spread')
  chk('spot+perp (sell-perp) bad profit → null', ds(undefined, futureFundingLow, badProfit, false).strategy === null)

  // spot+perp buy-perp
  chk('spot+perp (buy-perp) good → spread', ds(futureFundingLow, undefined, goodProfit, false).strategy === 'spread')
  chk('spot+perp (buy-perp) past funding → spread (funding ts ignored)', ds(pastFunding, undefined, goodProfit, false).strategy === 'spread')

  // perp+perp — bothLegsArePerp=true
  chk('perp+perp good → spread', ds(futureFundingLow, futureFundingLow, goodProfit, true).strategy === 'spread')
  chk('perp+perp one-past → null', ds(pastFunding, futureFundingLow, goodProfit, true).strategy === null)

  // funding window — use different buy/sell rates so net rate passes validation
  // net = -buyRate + sellRate = -0.001 + 0.01 = 0.009 = 0.9% > minFundingProfitPercent(0.1%) ✓
  ;(engine as any).fundingStrategyEnabled = true
  ;(engine as any).fundingStrategyEntryWindowStart = 9999999 // always in window
  ;(engine as any).fundingStrategyEntryWindowEnd = 0
  {
    const r = ds(futureFundingLow, futureFundingHigh, goodProfit, true)
    chk('perp+perp funding window → funding/sync', r.strategy === 'funding' && r.variant === 'sync',
      `strategy=${r.strategy} variant=${r.variant}`)
  }
  // spot+perp in funding window: non-perp branch → spread only (funding strategy requires bothLegsArePerp)
  {
    const r = ds(undefined, futureFundingHigh, goodProfit, false)
    chk('spot+perp funding window → spread (not funding)', r.strategy === 'spread',
      `strategy=${r.strategy} variant=${r.variant}`)
  }
  ;(engine as any).fundingStrategyEnabled = false
}

// ─── Section 5: validatePersistence divide-by-zero guard ─────────────────────

function runSection5(): void {
  console.log('\n══ 5. validatePersistence divide-by-zero guard ══')

  const { engine } = makeEngine(['a'], { a: [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })] }, new Map())
  const vp = (pair: string, be: string, se: string, profit: any, spread: number, updating: string) =>
    (engine as any).validatePersistence(pair, be, se, 100, 102, profit, spread, updating)

  const zeroFP = {
    spreadProfitPercent: 0.5, fundingProfitPercent: 0, estimatedProfitPercent: 0.3,
    costsPercent: 0.2, fundingProfitUsd: 0, spreadProfitUsd: 5, estimatedProfitUsd: 3, costsUsd: 2,
    tradingFeesUsd: 1, tradingFeesPercent: 0.1, latencyPenalty: 0, confidenceScore: 0.9,
  }

  vp('P::a::b', 'a', 'b', zeroFP, 0.5, 'a') // creates candidate
  try {
    const r = vp('P::a::b', 'a', 'b', zeroFP, 0.5, 'b') // would NaN/Infinity before fix
    chk('zero-funding: no throw', true)
    chk('zero-funding: candidate not incorrectly reset', r.isValid || r.reason === 'Building persistence',
      `isValid=${r.isValid} reason=${r.reason}`)
  } catch (e: any) {
    chk('zero-funding: no throw', false, e.message)
    chk('zero-funding: candidate not incorrectly reset', false)
  }

  // Non-zero funding: >20% drop → reset
  const { engine: e2 } = makeEngine(['a'], { a: [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })] }, new Map())
  const vp2 = (pair: string, be: string, se: string, profit: any, spread: number, updating: string) =>
    (e2 as any).validatePersistence(pair, be, se, 100, 102, profit, spread, updating)
  vp2('Q::a::b', 'a', 'b', { ...zeroFP, fundingProfitPercent: 1.0 }, 0.5, 'a')
  const r2 = vp2('Q::a::b', 'a', 'b', { ...zeroFP, fundingProfitPercent: 0.5 }, 0.5, 'b')
  chk('non-zero funding drop >20%: candidate reset', !r2.isValid, `isValid=${r2.isValid} reason=${r2.reason}`)
}

// ─── Section 6: End-to-end opportunity shape ─────────────────────────────────

function runSection6(): void {
  console.log('\n══ 6. End-to-end: opportunity shape per market combo ══')

  const LINEAR = MarketType.LINEAR_PERP
  const SPOT   = MarketType.SPOT
  const nextTs = Date.now() + 2 * 3600 * 1000

  // perp+perp
  {
    const fs = new Map([
      ['binance', new Map([['SOL/USDT:USDT', makeFunding('binance', 'SOL/USDT:USDT', 0.001, nextTs)]])],
      ['bybit',   new Map([['SOL/USDT:USDT', makeFunding('bybit',   'SOL/USDT:USDT', 0.003, nextTs + 3600000)]])],
    ])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99 }
    )
    const o = opps[0]
    if (o) {
      chk('[perp+perp] bothLegsArePerp=true', o.bothLegsArePerp)
      chk('[perp+perp] fundingProfitPercent≠0', o.fundingProfitPercent !== 0, `fp=${o.fundingProfitPercent}`)
      chk('[perp+perp] buyNextFunding>0', o.buyExchangeNextFundingTimestamp > 0)
      chk('[perp+perp] sellNextFunding>0', o.sellExchangeNextFundingTimestamp > 0)
      chk('[perp+perp] targetFunding=min(buy,sell)',
        o.targetFundingTimestamp === Math.min(o.buyExchangeNextFundingTimestamp, o.sellExchangeNextFundingTimestamp))
      chk('[perp+perp] strategy=spread', o.strategy === 'spread')
    } else {
      chk('[perp+perp] at least one opportunity', false, `opps=${opps.length}`)
    }
  }

  // spot+perp: binance=spot(buy), bybit=perp(sell)
  {
    const fs = new Map([['bybit', new Map([['SOL/USDT:USDT', makeFunding('bybit', 'SOL/USDT:USDT', 0.002, nextTs)]])]])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT',      'SOLUSDT',     { spot: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDTSWAP', { swap: true, linear: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT',      mt: SPOT,   ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99 }
    )
    const o = opps[0]
    if (o) {
      chk('[spot+perp] bothLegsArePerp=false', !o.bothLegsArePerp)
      chk('[spot+perp] one leg SPOT', o.buyMarketType === SPOT || o.sellMarketType === SPOT)
      const spotTs = o.buyMarketType === SPOT ? o.buyExchangeNextFundingTimestamp : o.sellExchangeNextFundingTimestamp
      const perpTs = o.buyMarketType !== SPOT ? o.buyExchangeNextFundingTimestamp : o.sellExchangeNextFundingTimestamp
      chk('[spot+perp] spot leg nextFundingTs=0', spotTs === 0, `got=${spotTs}`)
      chk('[spot+perp] perp leg nextFundingTs>0', perpTs > 0, `got=${perpTs}`)
      chk('[spot+perp] targetFundingTs=perpTs', o.targetFundingTimestamp === perpTs)
      chk('[spot+perp] strategy=spread', o.strategy === 'spread')
    } else {
      chk('[spot+perp] at least one opportunity', false, `opps=${opps.length}`)
    }
  }

  // spot+spot
  {
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })],
        bybit:   [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })] },
      new Map(),
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT', mt: SPOT, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99 }
    )
    const o = opps[0]
    if (o) {
      chk('[spot+spot] bothLegsArePerp=false', !o.bothLegsArePerp)
      chk('[spot+spot] fundingProfitPercent=0', o.fundingProfitPercent === 0, `fp=${o.fundingProfitPercent}`)
      chk('[spot+spot] fundingProfitUsd=0', o.fundingProfitUsd === 0)
      chk('[spot+spot] buyNextFundingTs=0', o.buyExchangeNextFundingTimestamp === 0)
      chk('[spot+spot] sellNextFundingTs=0', o.sellExchangeNextFundingTimestamp === 0)
      chk('[spot+spot] targetFundingTs=0', o.targetFundingTimestamp === 0)
      chk('[spot+spot] strategy=spread', o.strategy === 'spread')
    } else {
      chk('[spot+spot] at least one opportunity', false, `opps=${opps.length}`)
    }
  }
}

// ─── Section 7: Sign correctness ─────────────────────────────────────────────

function runSection7(): void {
  console.log('\n══ 7. Sign correctness: spot+perp fundingProfitPercent direction ══')

  const LINEAR = MarketType.LINEAR_PERP
  const SPOT   = MarketType.SPOT
  const nextTs = Date.now() + 3600 * 1000

  // spot-buy + perp-sell, positive rate → short perp receives → fundingProfitPercent > 0
  {
    const fs = new Map([['bybit', new Map([['SOL/USDT:USDT', makeFunding('bybit', 'SOL/USDT:USDT', 0.01, nextTs)]])]])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT',      'SOLUSDT',     { spot: true })],
        bybit:   [mockMarket('SOL/USDT:USDT', 'SOLUSDTSWAP', { swap: true, linear: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT',      mt: SPOT,   ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT', mt: SPOT, ask: 100, bid: 99 }
    )
    const o = opps.find(x => x.buyMarketType === SPOT && x.sellMarketType === LINEAR)
    if (o) {
      chk('spot-buy perp-sell positive rate: fundingProfitPercent > 0', o.fundingProfitPercent > 0, `fp=${o.fundingProfitPercent}`)
    } else {
      chk('spot-buy perp-sell: spot+perp opp emitted', opps.some(x => x.buyMarketType === SPOT || x.sellMarketType === SPOT),
        `total=${opps.length}`)
    }
  }

  // perp-buy + spot-sell, positive rate → long perp pays → fundingProfitPercent < 0
  {
    const fs = new Map([['binance', new Map([['SOL/USDT:USDT', makeFunding('binance', 'SOL/USDT:USDT', 0.01, nextTs)]])]])
    const { engine, orderbookMgr } = makeEngine(
      ['binance', 'bybit'],
      { binance: [mockMarket('SOL/USDT:USDT', 'SOLUSDT',     { swap: true, linear: true })],
        bybit:   [mockMarket('SOL/USDT',       'SOLUSDTSPOT', { spot: true })] },
      fs,
    )
    const opps: ArbitrageOpportunity[] = []
    engine.on('opportunities', o => opps.push(...o))
    // bybit (spot) is cheaper/more expensive? For perp-buy + spot-sell:
    // buy on binance (perp, cheaper), sell on bybit (spot, pricier)
    seedAndDrive(orderbookMgr,
      [
        { exchange: 'bybit',   symbol: 'SOL/USDT',      mt: SPOT,   ask: 103, bid: 102 },
        { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99  },
      ],
      { exchange: 'binance', symbol: 'SOL/USDT:USDT', mt: LINEAR, ask: 100, bid: 99 }
    )
    const o = opps.find(x => x.buyMarketType === LINEAR && x.sellMarketType === SPOT)
    if (o) {
      chk('perp-buy spot-sell positive rate: fundingProfitPercent < 0', o.fundingProfitPercent < 0, `fp=${o.fundingProfitPercent}`)
    } else {
      chk('perp-buy spot-sell: spot+perp opp emitted', opps.some(x => x.buyMarketType === SPOT || x.sellMarketType === SPOT),
        `total=${opps.length}`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

;(async () => {
  runSection1()
  runSection2()
  runSection3()
  runSection4()
  runSection5()
  runSection6()
  runSection7()

  console.log('\n══ Summary ══')
  console.log(`Total: ${totalPass}/${totalPass + totalFail} passed  ${totalFail > 0 ? `(${totalFail} FAILED)` : '✓ all green'}`)
  process.exit(totalFail > 0 ? 1 : 0)
})()
