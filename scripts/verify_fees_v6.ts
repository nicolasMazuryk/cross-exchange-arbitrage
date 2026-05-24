/**
 * Fee-per-market-type verification (plan-v6).
 * Verifies: YAML-loaded per-type fees, getFees() routing, ArbitrageEngine fee math
 * for all market type combinations across all exchanges.
 *
 * Run: npx ts-node scripts/verify_fees_v6.ts
 */

import { MarketType } from '../src/types/exchange'
import { getFees } from '../src/utils/config'
import { ArbitrageEngine, ArbitrageOpportunity } from '../src/core/arbitrage/arbitrageEngine'
import { OrderbookManager, OrderBookUpdate } from '../src/core/orderbook/orderbookManager'
import { MarketMetadataService } from '../src/core/markets/marketMetadataService'
import { ParsedFunding } from '../src/core/funding/types'

let totalPass = 0, totalFail = 0
function chk(label: string, ok: boolean, detail = ''): void {
  const icon = ok ? '✓' : '✗'
  console.log(`  ${icon} ${label}${detail ? `  (${detail})` : ''}`)
  ok ? totalPass++ : totalFail++
}
function near(a: number, b: number, eps = 0.0001): boolean {
  return Math.abs(a - b) < eps
}

// ─── Section 1: getFees() per exchange × market type ─────────────────────────

console.log('\n══ 1. getFees() per exchange × market type ══')

const EXCHANGE_EXPECTED: Record<string, { spot: [number, number]; linear: [number, number]; inverse: [number, number] }> = {
  binance: { spot: [0.10, 0.10], linear: [0.02, 0.05], inverse: [0.02, 0.05] },
  bybit:   { spot: [0.10, 0.10], linear: [0.036, 0.10], inverse: [0.036, 0.10] },
  okx:     { spot: [0.10, 0.10], linear: [0.02, 0.05], inverse: [0.02, 0.05] },
  bitget:  { spot: [0.10, 0.10], linear: [0.036, 0.10], inverse: [0.036, 0.10] },
}

for (const [exchange, types] of Object.entries(EXCHANGE_EXPECTED)) {
  for (const [mt, [expectedMaker, expectedTaker]] of Object.entries(types)) {
    const fees = getFees(exchange, mt)
    chk(`${exchange} ${mt} maker=${expectedMaker}`, near(fees.maker, expectedMaker), `got ${fees.maker}`)
    chk(`${exchange} ${mt} taker=${expectedTaker}`, near(fees.taker, expectedTaker), `got ${fees.taker}`)
  }
}

// ─── Section 2: getFees() flat fallback (no marketType) mirrors linear ─────────

console.log('\n══ 2. getFees() flat fallback mirrors linear ══')

for (const [exchange] of Object.entries(EXCHANGE_EXPECTED)) {
  const flat = getFees(exchange)
  const linear = getFees(exchange, 'linear')
  chk(`${exchange} flat.maker === linear.maker`, near(flat.maker, linear.maker), `flat=${flat.maker} linear=${linear.maker}`)
  chk(`${exchange} flat.taker === linear.taker`, near(flat.taker, linear.taker), `flat=${flat.taker} linear=${linear.taker}`)
}

// ─── Section 3: getFees() unknown exchange → {0,0} ────────────────────────────

console.log('\n══ 3. getFees() unknown exchange → {0,0} ══')

const unknown = getFees('gateio_unknown_xyz', 'linear')
chk('unknown exchange maker=0', unknown.maker === 0, `got ${unknown.maker}`)
chk('unknown exchange taker=0', unknown.taker === 0, `got ${unknown.taker}`)

// ─── Section 4: ArbitrageEngine.estimateProfit fee math ──────────────────────
// Inject into private method via (engine as any).estimateProfit(...)
// Verify tradingFeesPercent for each combination.
//
// Formula: 4 × taker fee (entry-buy + entry-sell + exit-buy + exit-sell)
// where each leg uses its own exchange×marketType taker rate.

console.log('\n══ 4. ArbitrageEngine.estimateProfit fee math per market-type combo ══')

function mockMarket(symbol: string, id: string, opts: {
  spot?: boolean; swap?: boolean; linear?: boolean; inverse?: boolean
} = {}): any {
  const colonIdx = symbol.indexOf(':'), slashIdx = symbol.indexOf('/')
  const swap = opts.swap ?? colonIdx >= 0, spot = opts.spot ?? !swap
  const inverse = opts.inverse ?? false, linear = opts.linear ?? (swap && !inverse)
  const base = symbol.slice(0, slashIdx)
  const quote = colonIdx >= 0 ? symbol.slice(slashIdx + 1, colonIdx) : symbol.slice(slashIdx + 1)
  return {
    id, symbol, base, quote, active: true, spot, swap, linear, inverse, option: false, future: false,
    contractSize: 1,
    precision: { price: 0.01, amount: 0.001 },
    limits: { amount: { min: 0.00001, max: 1e6 }, price: { min: 0.01, max: 1e7 }, cost: { min: 1 } },
  }
}

function stubFundingService() {
  return {
    getSymbolFundingData: () => undefined,
    generateFundingEvents: () => [],
    isFundingSynchronizedEntry: () => false,
    findNextSyncTimestamp: () => 0,
    calculateCumulativeFundingRate: () => 0,
  } as any
}

function buildEngine(buyExchange: string, sellExchange: string): ArbitrageEngine {
  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of [buyExchange, sellExchange]) {
    metaMap.set(ex, new MarketMetadataService(ex, [
      mockMarket('SOL/USDT', 'SOLUSDT', { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOL_USDT', { swap: true, linear: true }),
      mockMarket('SOL/USD:SOL', 'SOL_USD', { swap: true, inverse: true }),
    ], [], ['linear', 'inverse', 'spot'], ['USDT', 'USD']))
  }
  const engine = new ArbitrageEngine(
    new OrderbookManager(), [],
    [buyExchange, sellExchange].filter((v, i, a) => a.indexOf(v) === i).map(name => ({ name, isHealthy: true })),
    metaMap,
    stubFundingService()
  )
  return engine
}

// Stub simulation result at price P
function sim(price: number) {
  return { avgExecutionPrice: price, avgNormalizedExecutionPrice: price, slippagePercent: 0, hasError: false }
}

// Stub orderbook at price P (ask=P, bid=P)
function ob(price: number): any {
  return {
    asks: [{ price, quantity: 10000, amount: price * 10000 }],
    bids: [{ price, quantity: 10000, amount: price * 10000 }],
    timestamp: Date.now(),
  }
}

// Build a minimal FundingProjection with no funding profit
const noFundingProjection: any = { timeline: [], totalProjectedFundingRate: 0, maxDrawdownFundingRate: 0, averageHourlyFundingRate: 0 }

interface FeeScenario {
  label: string
  buyExchange: string
  sellExchange: string
  buyMT: MarketType
  sellMT: MarketType
  // expected total trading fees percent = (entry+exit) on both legs
  // = (buyTaker/100 + sellTaker/100) * 2  (in percent of orderAmountUsd)
  // where each fee is taker% applied to normalizedVolume * price / orderAmountUsd * 100
  // With price=100, normalizedVolume=1, orderAmountUsd=100:
  //   each leg fee = price * vol * (taker/100) / orderAmountUsd * 100 = taker
  //   total 4 legs = (buyTaker + sellTaker) * 2
  expectedTotalFeePercent: number
}

const SCENARIOS: FeeScenario[] = [
  // linear×linear
  { label: 'binance(linear) × bybit(linear)',  buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  { label: 'binance(linear) × okx(linear)',    buyExchange: 'binance', sellExchange: 'okx',     buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.05 + 0.05) * 2 },
  { label: 'bybit(linear)   × bitget(linear)', buyExchange: 'bybit',   sellExchange: 'bitget',  buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.10 + 0.10) * 2 },
  // spot×spot
  { label: 'binance(spot) × bybit(spot)',       buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.SPOT,        sellMT: MarketType.SPOT,        expectedTotalFeePercent: (0.10 + 0.10) * 2 },
  { label: 'okx(spot)     × bitget(spot)',      buyExchange: 'okx',     sellExchange: 'bitget',  buyMT: MarketType.SPOT,        sellMT: MarketType.SPOT,        expectedTotalFeePercent: (0.10 + 0.10) * 2 },
  // inverse×inverse
  { label: 'binance(inverse) × bybit(inverse)', buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.INVERSE_PERP, sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  { label: 'okx(inverse) × bitget(inverse)',    buyExchange: 'okx',     sellExchange: 'bitget',  buyMT: MarketType.INVERSE_PERP, sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  // cross: spot × linear
  { label: 'binance(spot) × bybit(linear)',     buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.SPOT,        sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.10 + 0.10) * 2 },
  { label: 'binance(linear) × bybit(spot)',     buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.SPOT,        expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  { label: 'okx(spot)     × binance(linear)',   buyExchange: 'okx',     sellExchange: 'binance', buyMT: MarketType.SPOT,        sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.10 + 0.05) * 2 },
  // cross: spot × inverse
  { label: 'binance(spot) × bybit(inverse)',    buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.SPOT,        sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.10 + 0.10) * 2 },
  { label: 'okx(spot) × binance(inverse)',      buyExchange: 'okx',     sellExchange: 'binance', buyMT: MarketType.SPOT,        sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.10 + 0.05) * 2 },
  // cross: linear × inverse
  { label: 'binance(linear) × bybit(inverse)',  buyExchange: 'binance', sellExchange: 'bybit',   buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  { label: 'okx(linear) × bitget(inverse)',     buyExchange: 'okx',     sellExchange: 'bitget',  buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.05 + 0.10) * 2 },
  // same-exchange (edge: both legs same exchange)
  { label: 'binance(spot) × binance(linear)',   buyExchange: 'binance', sellExchange: 'binance', buyMT: MarketType.SPOT,        sellMT: MarketType.LINEAR_PERP, expectedTotalFeePercent: (0.10 + 0.05) * 2 },
  { label: 'bybit(linear) × bybit(inverse)',    buyExchange: 'bybit',   sellExchange: 'bybit',   buyMT: MarketType.LINEAR_PERP, sellMT: MarketType.INVERSE_PERP, expectedTotalFeePercent: (0.10 + 0.10) * 2 },
]

// With price=100, normalizedVolume=1, orderAmountUsd=100:
//   entryBuyFee = 100 * 1 * (buyTaker/100)
//   entrySellFee = 100 * 1 * (sellTaker/100)
//   exitBuyFee  = same
//   exitSellFee = same
//   totalFeeUsd = 2 * 100 * (buyTaker + sellTaker) / 100
//   totalFeePercent = totalFeeUsd / 100 * 100 = 2 * (buyTaker + sellTaker)
// This matches expectedTotalFeePercent above.

const PRICE = 100
const VOL = 1
const ORDER_USD = 100

for (const sc of SCENARIOS) {
  const engine = buildEngine(sc.buyExchange, sc.sellExchange)
  const ep = (engine as any).estimateProfit
  if (typeof ep !== 'function') {
    chk(`${sc.label}: estimateProfit callable`, false, 'method not found')
    continue
  }
  const buyMeta = (engine as any).marketMetadataServices.get(sc.buyExchange)
  const sellMeta = (engine as any).marketMetadataServices.get(sc.sellExchange)
  const s = sim(PRICE)
  try {
    const result = (engine as any).estimateProfit(
      PRICE,   // normalizedBuyPrice
      PRICE,   // normalizedSellPrice (same → spreadProfitUsd=0)
      VOL,     // normalizedVolume
      VOL,     // buyExchangeVolume
      VOL,     // sellExchangeVolume
      ORDER_USD,
      sc.buyExchange,
      sc.sellExchange,
      sc.buyMT === MarketType.SPOT ? 'SOL/USDT' : sc.buyMT === MarketType.LINEAR_PERP ? 'SOL/USDT:USDT' : 'SOL/USD:SOL',
      sc.sellMT === MarketType.SPOT ? 'SOL/USDT' : sc.sellMT === MarketType.LINEAR_PERP ? 'SOL/USDT:USDT' : 'SOL/USD:SOL',
      ob(PRICE),  // buyBook
      ob(PRICE),  // sellBook
      buyMeta,
      sellMeta,
      s, s, s, s,  // entry+exit simulations (same price, zero slippage)
      noFundingProjection,
      sc.buyMT,
      sc.sellMT,
    )
    const got = result.tradingFeesPercent
    chk(`${sc.label}: tradingFeesPercent=${sc.expectedTotalFeePercent.toFixed(3)}`, near(got, sc.expectedTotalFeePercent, 0.001), `got ${got.toFixed(4)}`)
  } catch (err: any) {
    chk(`${sc.label}: no error`, false, err.message)
  }
}

// ─── Section 5: inverse-fee equals linear (same values per exchange) ────────

console.log('\n══ 5. inverse fees equal linear per exchange ══')

for (const [exchange] of Object.entries(EXCHANGE_EXPECTED)) {
  const linear = getFees(exchange, 'linear')
  const inverse = getFees(exchange, 'inverse')
  chk(`${exchange}: inverse.maker === linear.maker`, near(inverse.maker, linear.maker))
  chk(`${exchange}: inverse.taker === linear.taker`, near(inverse.taker, linear.taker))
}

// ─── Section 6: spot fees != linear fees (spot is higher) ────────────────────

console.log('\n══ 6. spot fees > linear fees (correct direction) ══')

for (const [exchange, types] of Object.entries(EXCHANGE_EXPECTED)) {
  const spot = getFees(exchange, 'spot')
  const linear = getFees(exchange, 'linear')
  chk(`${exchange}: spot.taker(${spot.taker}) >= linear.taker(${linear.taker})`, spot.taker >= linear.taker)
  chk(`${exchange}: spot.taker=0.10`, near(spot.taker, 0.10))
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`)
console.log(`Result: ${totalPass} passed, ${totalFail} failed`)
if (totalFail > 0) process.exit(1)
