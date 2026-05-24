/**
 * Verification script for multi-quote-asset support changes.
 * Tests all scenarios from the plan: helpers, symbol parsing, compat guard,
 * Bitget product-type routing, WS quote parsers, funding fallback removal.
 */

import { quotesAreCompatible, isStablecoin, STABLECOIN_QUOTES, quoteCurrenciesFor } from '../src/utils/utils'
import { parseNativeSymbolToUnified, MarketMetadataService } from '../src/core/markets/marketMetadataService'
import { BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE } from '../src/adapters/rest/bitget'
import { MarketType } from '../src/types/exchange'

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(label: string, actual: any, expected: any): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    console.error(`      expected: ${JSON.stringify(expected)}`)
    console.error(`      actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

// ─── A. STABLECOIN_QUOTES + isStablecoin ─────────────────────────────────────

section('A. isStablecoin')

check('USDT is stablecoin', isStablecoin('USDT'), true)
check('USDC is stablecoin', isStablecoin('USDC'), true)
check('USD is stablecoin', isStablecoin('USD'), true)
check('BUSD is stablecoin', isStablecoin('BUSD'), true)
check('FDUSD is stablecoin', isStablecoin('FDUSD'), true)
check('DAI is stablecoin', isStablecoin('DAI'), true)
check('EUR is NOT stablecoin', isStablecoin('EUR'), false)
check('BTC is NOT stablecoin', isStablecoin('BTC'), false)
check('ETH is NOT stablecoin', isStablecoin('ETH'), false)
check('usdt lowercase works', isStablecoin('usdt'), true)
check('usdc lowercase works', isStablecoin('usdc'), true)
check('set has USDT', STABLECOIN_QUOTES.has('USDT'), true)
check('set does not have EUR', STABLECOIN_QUOTES.has('EUR'), false)

// ─── B. quotesAreCompatible ────────────────────────────────────────────────────

section('B. quotesAreCompatible')

// Same-quote exact matches
check('USDT == USDT', quotesAreCompatible('USDT', 'USDT'), true)
check('BTC == BTC', quotesAreCompatible('BTC', 'BTC'), true)
check('EUR == EUR', quotesAreCompatible('EUR', 'EUR'), true)
check('ETH == ETH', quotesAreCompatible('ETH', 'ETH'), true)

// USD-equivalent group
check('USDT ~ USDC (both USD-equiv)', quotesAreCompatible('USDT', 'USDC'), true)
check('USDC ~ USDT', quotesAreCompatible('USDC', 'USDT'), true)
check('USD ~ USDT', quotesAreCompatible('USD', 'USDT'), true)
check('USDT ~ USD (inverse perp)', quotesAreCompatible('USDT', 'USD'), true)
check('USDC ~ USD', quotesAreCompatible('USDC', 'USD'), true)
check('BUSD ~ USDT', quotesAreCompatible('BUSD', 'USDT'), true)
check('FDUSD ~ USDC', quotesAreCompatible('FDUSD', 'USDC'), true)
check('DAI ~ USDT', quotesAreCompatible('DAI', 'USDT'), true)

// Incompatible cross-quote pairs
check('EUR != USDT (incompatible)', quotesAreCompatible('EUR', 'USDT'), false)
check('BTC != USDT (incompatible)', quotesAreCompatible('BTC', 'USDT'), false)
check('ETH != BTC (incompatible)', quotesAreCompatible('ETH', 'BTC'), false)
check('EUR != USD (incompatible)', quotesAreCompatible('EUR', 'USD'), false)
check('BTC != USD (incompatible)', quotesAreCompatible('BTC', 'USD'), false)
check('ETH != USDT (incompatible)', quotesAreCompatible('ETH', 'USDT'), false)

// Case insensitivity
check('usdt ~ USDC (case-insensitive)', quotesAreCompatible('usdt', 'USDC'), true)
check('EUR != usdt (case-insensitive)', quotesAreCompatible('EUR', 'usdt'), false)

// ─── C. BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE constant ─────────────────────────

section('C. BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE')

check('USDT → USDT-FUTURES', BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE['USDT'], 'USDT-FUTURES')
check('USDC → SUSDC-FUTURES', BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE['USDC'], 'SUSDC-FUTURES')
check('BTC → undefined (not in map)', BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE['BTC'], undefined)
check('USD → undefined (inverse handled separately)', BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE['USD'], undefined)
check('EUR → undefined', BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE['EUR'], undefined)

// ─── D. parseNativeSymbolToUnified — metadata-hit path ─────────────────────────

section('D. parseNativeSymbolToUnified — metadata hit path')

// Build a minimal metadata service with known symbols
const mkMarket = (id: string, symbol: string, type: 'spot' | 'swap', linear: boolean, base: string, quote: string, settle: string) => ({
  id,
  symbol,
  spot: type === 'spot',
  swap: type === 'swap',
  future: false,
  option: false,
  active: true,
  linear: type === 'swap' ? linear : undefined,
  inverse: type === 'swap' ? !linear : undefined,
  base,
  quote,
  settle,
  contractSize: 1,
  precision: { price: 0.01, amount: 0.001 },
  limits: { price: { min: 0 }, amount: { min: 0.001 }, cost: { min: 5 } },
} as any)

const markets: any[] = [
  mkMarket('BTCUSDT', 'BTC/USDT:USDT', 'swap', true, 'BTC', 'USDT', 'USDT'),
  mkMarket('BTCUSDC', 'BTC/USDC:USDC', 'swap', true, 'BTC', 'USDC', 'USDC'),
  mkMarket('BTCUSD_PERP', 'BTC/USD:BTC', 'swap', false, 'BTC', 'USD', 'BTC'),
  mkMarket('BTCUSDT', 'BTC/USDT', 'spot', false, 'BTC', 'USDT', 'USDT'),
  mkMarket('ETHUSDT', 'ETH/USDT:USDT', 'swap', true, 'ETH', 'USDT', 'USDT'),
  mkMarket('ETHBTC', 'ETH/BTC', 'spot', false, 'ETH', 'BTC', 'BTC'),
  mkMarket('BTC-USDT-SWAP', 'BTC/USDT:USDT', 'swap', true, 'BTC', 'USDT', 'USDT'), // OKX format
  mkMarket('BTC-USD-SWAP', 'BTC/USD:BTC', 'swap', false, 'BTC', 'USD', 'BTC'),     // OKX inverse
]

const svc = new MarketMetadataService('test', markets, [], undefined, undefined)

// Metadata-hit cases
check('BTCUSDT LINEAR_PERP via metadata', parseNativeSymbolToUnified('BTCUSDT', MarketType.LINEAR_PERP, svc, ['USDT', 'USDC']), 'BTC/USDT:USDT')
check('BTCUSDC LINEAR_PERP via metadata', parseNativeSymbolToUnified('BTCUSDC', MarketType.LINEAR_PERP, svc, ['USDT', 'USDC']), 'BTC/USDC:USDC')
check('BTCUSD_PERP INVERSE_PERP via metadata', parseNativeSymbolToUnified('BTCUSD_PERP', MarketType.INVERSE_PERP, svc, ['USDT']), 'BTC/USD:BTC')
check('BTC-USDT-SWAP LINEAR_PERP via metadata (OKX)', parseNativeSymbolToUnified('BTC-USDT-SWAP', MarketType.LINEAR_PERP, svc, ['USDT']), 'BTC/USDT:USDT')
check('BTC-USD-SWAP INVERSE_PERP via metadata (OKX)', parseNativeSymbolToUnified('BTC-USD-SWAP', MarketType.INVERSE_PERP, svc, ['USDT']), 'BTC/USD:BTC')

// ─── E. parseNativeSymbolToUnified — suffix-fallback path ──────────────────────

section('E. parseNativeSymbolToUnified — suffix fallback (no metadata)')

const emptySvc = new MarketMetadataService('test', [], [], undefined, undefined)

// LINEAR_PERP suffix construction
check('BTCUSDT LINEAR_PERP suffix fallback', parseNativeSymbolToUnified('BTCUSDT', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), 'BTC/USDT:USDT')
check('BTCUSDC LINEAR_PERP suffix fallback', parseNativeSymbolToUnified('BTCUSDC', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), 'BTC/USDC:USDC')
check('ETHUSDT LINEAR_PERP suffix fallback', parseNativeSymbolToUnified('ETHUSDT', MarketType.LINEAR_PERP, emptySvc, ['USDT']), 'ETH/USDT:USDT')
check('SOLUSDC LINEAR_PERP suffix fallback', parseNativeSymbolToUnified('SOLUSDC', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), 'SOL/USDC:USDC')

// SPOT suffix construction
check('BTCUSDT SPOT suffix fallback', parseNativeSymbolToUnified('BTCUSDT', MarketType.SPOT, emptySvc, ['USDT']), 'BTC/USDT')
check('ETHUSDC SPOT suffix fallback', parseNativeSymbolToUnified('ETHUSDC', MarketType.SPOT, emptySvc, ['USDT', 'USDC']), 'ETH/USDC')

// INVERSE_PERP — no suffix match (inverse uses USD, base-settled, not a suffix in the native symbol usually)
// e.g. Binance coinm: BTCUSD_PERP — no suffix in enabledQuotes ['USDT']
check('BTCUSD_PERP INVERSE_PERP no match → undefined', parseNativeSymbolToUnified('BTCUSD_PERP', MarketType.INVERSE_PERP, emptySvc, ['USDT']), undefined)

// Unknown symbol — no suffix match → undefined
check('DOGEXYZ unknown → undefined', parseNativeSymbolToUnified('DOGEXYZ', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), undefined)
check('empty string → undefined', parseNativeSymbolToUnified('', MarketType.LINEAR_PERP, emptySvc, ['USDT']), undefined)

// Longest-first ordering: USDCBTC where quote list has ['USDC', 'USDT']
// Should match USDC not USD (USD is not in list but USDC is)
check('SOLUSDC with [USDT,USDC] — USDC matches not confused with USDT', parseNativeSymbolToUnified('SOLUSDC', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), 'SOL/USDC:USDC')

// Edge: base becomes empty string (symbol = just the quote suffix)
check('USDT alone → undefined (empty base)', parseNativeSymbolToUnified('USDT', MarketType.LINEAR_PERP, emptySvc, ['USDT']), undefined)

// ─── F. quoteFromOkxInstId equivalent logic ────────────────────────────────────

section('F. OKX instId quote parsing (parts[1] approach)')

function quoteFromOkxInstId(instId: string): string | undefined {
  const parts = instId.split('-')
  return parts.length >= 2 ? parts[1] : undefined
}

check('BTC-USDT-SWAP → USDT', quoteFromOkxInstId('BTC-USDT-SWAP'), 'USDT')
check('BTC-USD-SWAP → USD (inverse)', quoteFromOkxInstId('BTC-USD-SWAP'), 'USD')
check('ETH-USDC-SWAP → USDC', quoteFromOkxInstId('ETH-USDC-SWAP'), 'USDC')
check('BTC-EUR-SWAP → EUR (exotic)', quoteFromOkxInstId('BTC-EUR-SWAP'), 'EUR')
check('BTC-USDT (spot) → USDT', quoteFromOkxInstId('BTC-USDT'), 'USDT')
check('BTCUSDT (no dashes) → undefined', quoteFromOkxInstId('BTCUSDT'), undefined)
check('empty string → undefined', quoteFromOkxInstId(''), undefined)
// The old code: '-USDT-' includes '-USD-'? No: 'BTC-USDT-SWAP'.includes('-USD-') → false
// Verify the NEW logic doesn't regress on inverse detection
check('USD swap yields USD not USDT', quoteFromOkxInstId('ETH-USD-SWAP') === 'USDT', false)
check('USD swap yields exactly USD', quoteFromOkxInstId('ETH-USD-SWAP'), 'USD')

// ─── G. bitgetInstTypeToQuote equivalent logic ─────────────────────────────────

section('G. Bitget instType → quote mapping')

function bitgetInstTypeToQuote(instType: string): string | undefined {
  const upper = instType.toUpperCase()
  if (upper === 'COIN-FUTURES' || upper === 'DMCBL' || upper === 'COIN_FUTURES') return 'USD'
  if (upper === 'USDT-FUTURES' || upper === 'UMCBL' || upper === 'USDT_FUTURES') return 'USDT'
  if (upper === 'SUSDC-FUTURES') return 'USDC'
  return undefined
}

check('COIN-FUTURES → USD', bitgetInstTypeToQuote('COIN-FUTURES'), 'USD')
check('DMCBL → USD', bitgetInstTypeToQuote('DMCBL'), 'USD')
check('COIN_FUTURES → USD', bitgetInstTypeToQuote('COIN_FUTURES'), 'USD')
check('USDT-FUTURES → USDT', bitgetInstTypeToQuote('USDT-FUTURES'), 'USDT')
check('UMCBL → USDT', bitgetInstTypeToQuote('UMCBL'), 'USDT')
check('USDT_FUTURES → USDT', bitgetInstTypeToQuote('USDT_FUTURES'), 'USDT')
check('SUSDC-FUTURES → USDC (new)', bitgetInstTypeToQuote('SUSDC-FUTURES'), 'USDC')
check('SPOT → undefined (unknown)', bitgetInstTypeToQuote('SPOT'), undefined)
check('SOMETHING → undefined', bitgetInstTypeToQuote('SOMETHING'), undefined)
check('lowercase coin-futures → USD', bitgetInstTypeToQuote('coin-futures'), 'USD')
check('lowercase susdc-futures → USDC', bitgetInstTypeToQuote('susdc-futures'), 'USDC')

// ─── H. categoryToQuote (Bybit) equivalent logic ──────────────────────────────

section('H. Bybit categoryToQuote mapping')

function categoryToQuote(category: string): string | undefined {
  if (category === 'inverse') return 'USD'
  return undefined
}

check('inverse → USD', categoryToQuote('inverse'), 'USD')
check('linear → undefined (requires metadata)', categoryToQuote('linear'), undefined)
check('spot → undefined (requires metadata)', categoryToQuote('spot'), undefined)
check('unknown → undefined', categoryToQuote('unknown'), undefined)

// ─── I. Bitget paramsForMarket routing via BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE ─

section('I. Bitget paramsForMarket routing')

function paramsForMarketSimulated(marketType: MarketType, ctx?: { symbol?: string; quote?: string }): Record<string, any> {
  if (marketType === MarketType.SPOT) return { productType: 'SPOT' }
  if (marketType === MarketType.INVERSE_PERP) return { productType: 'COIN-FUTURES', hedged: true }
  if (marketType === MarketType.LINEAR_PERP) {
    const quote = ctx?.quote
    const productType = (quote && BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[quote]) ?? 'USDT-FUTURES'
    return { productType, hedged: true }
  }
  throw new Error(`unsupported market type: ${marketType}`)
}

check('SPOT → SPOT', paramsForMarketSimulated(MarketType.SPOT), { productType: 'SPOT' })
check('INVERSE_PERP → COIN-FUTURES', paramsForMarketSimulated(MarketType.INVERSE_PERP), { productType: 'COIN-FUTURES', hedged: true })
check('LINEAR_PERP no ctx → USDT-FUTURES (default)', paramsForMarketSimulated(MarketType.LINEAR_PERP), { productType: 'USDT-FUTURES', hedged: true })
check('LINEAR_PERP ctx.quote=USDT → USDT-FUTURES', paramsForMarketSimulated(MarketType.LINEAR_PERP, { quote: 'USDT' }), { productType: 'USDT-FUTURES', hedged: true })
check('LINEAR_PERP ctx.quote=USDC → SUSDC-FUTURES', paramsForMarketSimulated(MarketType.LINEAR_PERP, { quote: 'USDC' }), { productType: 'SUSDC-FUTURES', hedged: true })
check('LINEAR_PERP ctx.quote=BTC → USDT-FUTURES (unmapped fallback)', paramsForMarketSimulated(MarketType.LINEAR_PERP, { quote: 'BTC' }), { productType: 'USDT-FUTURES', hedged: true })
check('LINEAR_PERP ctx.quote=EUR → USDT-FUTURES (unmapped fallback)', paramsForMarketSimulated(MarketType.LINEAR_PERP, { quote: 'EUR' }), { productType: 'USDT-FUTURES', hedged: true })

// ─── J. Bitget WS subscription instTypes derivation ──────────────────────────

section('J. Bitget WS perpInstTypes from enabledQuotes')

function derivePerpInstTypes(enabledQuotes: string[], enabledMarketTypes?: string[]): string[] {
  const perpInstTypes: string[] = []
  for (const quote of enabledQuotes) {
    const productType = BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[quote]
    if (productType && !perpInstTypes.includes(productType)) {
      perpInstTypes.push(productType)
    }
  }
  if (!enabledMarketTypes || enabledMarketTypes.includes(MarketType.INVERSE_PERP)) {
    perpInstTypes.push('COIN-FUTURES')
  }
  return perpInstTypes
}

check('USDT only → [USDT-FUTURES, COIN-FUTURES]', derivePerpInstTypes(['USDT']), ['USDT-FUTURES', 'COIN-FUTURES'])
check('USDT+USDC → [USDT-FUTURES, SUSDC-FUTURES, COIN-FUTURES]', derivePerpInstTypes(['USDT', 'USDC']), ['USDT-FUTURES', 'SUSDC-FUTURES', 'COIN-FUTURES'])
check('USDC only → [SUSDC-FUTURES, COIN-FUTURES]', derivePerpInstTypes(['USDC']), ['SUSDC-FUTURES', 'COIN-FUTURES'])
check('inverse disabled → no COIN-FUTURES', derivePerpInstTypes(['USDT'], ['linear']), ['USDT-FUTURES'])
check('USDT+BTC+USDC — BTC unmapped, still gets others', derivePerpInstTypes(['USDT', 'BTC', 'USDC']), ['USDT-FUTURES', 'SUSDC-FUTURES', 'COIN-FUTURES'])
check('duplicate quotes — no duplicate instTypes', derivePerpInstTypes(['USDT', 'USDT']), ['USDT-FUTURES', 'COIN-FUTURES'])

// ─── K. Arbitrage compat guard scenarios ──────────────────────────────────────

section('K. Arbitrage quote compat guard scenarios')

const scenarios: Array<{ buyQuote: string; sellQuote: string; shouldAllow: boolean; desc: string }> = [
  { buyQuote: 'USDT', sellQuote: 'USDT', shouldAllow: true, desc: 'USDT↔USDT (same exchange group)' },
  { buyQuote: 'USDT', sellQuote: 'USDC', shouldAllow: true, desc: 'USDT↔USDC (USD-equiv cross)' },
  { buyQuote: 'USDC', sellQuote: 'USD', shouldAllow: true, desc: 'USDC↔USD (linear↔inverse USD-equiv)' },
  { buyQuote: 'USDT', sellQuote: 'USD', shouldAllow: true, desc: 'USDT↔USD (linear↔inverse)' },
  { buyQuote: 'BUSD', sellQuote: 'USDT', shouldAllow: true, desc: 'BUSD↔USDT (both USD-equiv)' },
  { buyQuote: 'EUR', sellQuote: 'EUR', shouldAllow: true, desc: 'EUR↔EUR (exact match non-USD)' },
  { buyQuote: 'BTC', sellQuote: 'BTC', shouldAllow: true, desc: 'BTC↔BTC (exact match)' },
  { buyQuote: 'ETH', sellQuote: 'ETH', shouldAllow: true, desc: 'ETH↔ETH (exact match)' },
  { buyQuote: 'EUR', sellQuote: 'USDT', shouldAllow: false, desc: 'EUR↔USDT (incompatible)' },
  { buyQuote: 'BTC', sellQuote: 'USDT', shouldAllow: false, desc: 'BTC↔USDT (incompatible)' },
  { buyQuote: 'ETH', sellQuote: 'BTC', shouldAllow: false, desc: 'ETH↔BTC (incompatible)' },
  { buyQuote: 'EUR', sellQuote: 'USD', shouldAllow: false, desc: 'EUR↔USD (incompatible)' },
  { buyQuote: 'BTC', sellQuote: 'USDC', shouldAllow: false, desc: 'BTC↔USDC (incompatible)' },
]

for (const s of scenarios) {
  const compat = quotesAreCompatible(s.buyQuote, s.sellQuote)
  check(s.desc, compat, s.shouldAllow)
}

// ─── L. quoteCurrenciesFor defaults to full stablecoin list when not configured ─

section('L. quoteCurrenciesFor — unconfigured exchange')

// Unknown exchange has no cfg → enabled is undefined → defaults to full STABLECOIN_QUOTES
const result = quoteCurrenciesFor('nonexistent_exchange_xyz')
check('unknown exchange → full stablecoin list', Array.isArray(result) && result.length > 0, true)

// ─── M. trackedPairs merge (simulated) ────────────────────────────────────────

section('M. trackedPairsByQuote merge simulation')

function mergeTrackedPairs(trackedPairs: string[] = [], trackedPairsByQuote: Record<string, string[]> = {}): string[] {
  return [...trackedPairs, ...Object.values(trackedPairsByQuote).flat()]
}

check(
  'merge: base + by-quote',
  mergeTrackedPairs(['BTC/USDT:USDT'], { USDC: ['BTC/USDC:USDC', 'ETH/USDC:USDC'] }),
  ['BTC/USDT:USDT', 'BTC/USDC:USDC', 'ETH/USDC:USDC']
)
check(
  'merge: no trackedPairsByQuote → same as trackedPairs',
  mergeTrackedPairs(['BTC/USDT:USDT', 'ETH/USDT:USDT'], {}),
  ['BTC/USDT:USDT', 'ETH/USDT:USDT']
)
check(
  'merge: both empty → empty',
  mergeTrackedPairs([], {}),
  []
)
check(
  'merge: multi-quote groups flatten',
  mergeTrackedPairs([], { USDT: ['BTC/USDT:USDT'], USDC: ['BTC/USDC:USDC'], EUR: ['DOGE/EUR'] }),
  ['BTC/USDT:USDT', 'BTC/USDC:USDC', 'DOGE/EUR']
)

// ─── N. parseNativeSymbolToUnified — longest-first ordering ────────────────────

section('N. parseNativeSymbolToUnified longest-first ordering edge cases')

// 'USD' vs 'USDT' vs 'USDC' — ensure correct quote matched
// If enabledQuotes = ['USD', 'USDT'], symbol = 'BTCUSDT'
// sorted longest-first: ['USDT', 'USD'] (USDT len 4 > USD len 3)
// BTCUSDT.endsWith('USDT') → true → BTC/USDT:USDT ✓ (not BTC+T/USD:BTC+T)
check('BTCUSDT with [USD, USDT] — USDT matches not USD', parseNativeSymbolToUnified('BTCUSDT', MarketType.LINEAR_PERP, emptySvc, ['USD', 'USDT']), 'BTC/USDT:USDT')

// If enabledQuotes = ['USDT', 'USDC'], symbol = 'BTCUSDCE' (hypothetical)
// sorted: ['USDC', 'USDT'] (USDC len 4 = USDT len 4, both len 4 — sort stable)
// BTCUSDCE: doesn't endWith USDC (USDCE≠USDC) and doesn't endWith USDT → undefined
check('BTCUSDCE with [USDT, USDC] → undefined (no match)', parseNativeSymbolToUnified('BTCUSDCE', MarketType.LINEAR_PERP, emptySvc, ['USDT', 'USDC']), undefined)

// INVERSE_PERP with USD in enabledQuotes
check('ETHUSD INVERSE_PERP with [USD] → ETH/USD:ETH', parseNativeSymbolToUnified('ETHUSD', MarketType.INVERSE_PERP, emptySvc, ['USD']), 'ETH/USD:ETH')

// ─── O. getMetadataByNativeId — strict (no bare-id fallback) ─────────────────

section('O. getMetadataByNativeId strict — no bare-id fallback')

// svc has: BTCUSDT→LINEAR_PERP, BTCUSDT→SPOT, BTCUSDC→LINEAR_PERP, BTCUSD_PERP→INVERSE_PERP, etc.

// Exact match: qualified key should resolve
check('BTCUSDT LINEAR_PERP resolves', svc.getMetadataByNativeId('BTCUSDT', MarketType.LINEAR_PERP) !== undefined, true)
check('BTCUSDT SPOT resolves', svc.getMetadataByNativeId('BTCUSDT', MarketType.SPOT) !== undefined, true)
check('BTCUSD_PERP INVERSE_PERP resolves', svc.getMetadataByNativeId('BTCUSD_PERP', MarketType.INVERSE_PERP) !== undefined, true)

// Wrong marketType → undefined (no fallback to bare id)
check('BTCUSDT queried as INVERSE_PERP → undefined (no fallback)', svc.getMetadataByNativeId('BTCUSDT', MarketType.INVERSE_PERP), undefined)
check('BTCUSD_PERP queried as SPOT → undefined (no fallback)', svc.getMetadataByNativeId('BTCUSD_PERP', MarketType.SPOT), undefined)
check('BTCUSD_PERP queried as LINEAR_PERP → undefined (no fallback)', svc.getMetadataByNativeId('BTCUSD_PERP', MarketType.LINEAR_PERP), undefined)

// Nonexistent nativeId → undefined
check('XYZABC LINEAR_PERP → undefined (never registered)', svc.getMetadataByNativeId('XYZABC', MarketType.LINEAR_PERP), undefined)
check('empty string SPOT → undefined', svc.getMetadataByNativeId('', MarketType.SPOT), undefined)

// Correct metadata returned for matching key
const btcLinearMeta = svc.getMetadataByNativeId('BTCUSDT', MarketType.LINEAR_PERP)
check('BTCUSDT LINEAR_PERP → symbol BTC/USDT:USDT', btcLinearMeta?.symbol, 'BTC/USDT:USDT')
check('BTCUSDT LINEAR_PERP → marketType LINEAR_PERP', btcLinearMeta?.marketType, MarketType.LINEAR_PERP)

const btcSpotMeta = svc.getMetadataByNativeId('BTCUSDT', MarketType.SPOT)
check('BTCUSDT SPOT → symbol BTC/USDT', btcSpotMeta?.symbol, 'BTC/USDT')
check('BTCUSDT SPOT → marketType SPOT', btcSpotMeta?.marketType, MarketType.SPOT)

// Verify disambiguates spot vs linear for same native id
check('BTCUSDT SPOT and LINEAR_PERP resolve to different symbols',
  svc.getMetadataByNativeId('BTCUSDT', MarketType.SPOT)?.symbol !== svc.getMetadataByNativeId('BTCUSDT', MarketType.LINEAR_PERP)?.symbol, true)

// ─── P. validateSpreadEntry — behavior parity when spreadFundingProfitEnabled=false ──

section('P. validateSpreadEntry — disabled funding, pre-cleanup parity')

// Simulate the post-D2 validateSpreadEntry logic
function simulateValidateSpreadEntry(
  fundingRateDifferencePercent: number,
  profitEstimate: { spreadProfitPercent: number; costsPercent: number; estimatedProfitPercent: number },
  spreadFundingProfitEnabled: boolean,
  spreadMinSpreadProfitPercent: number,
  spreadMinTotalProfitPercent: number,
  spreadNegativeFundingMultiplier: number
): boolean {
  if (fundingRateDifferencePercent >= 0) {
    return (
      profitEstimate.spreadProfitPercent - profitEstimate.costsPercent >= spreadMinSpreadProfitPercent &&
      profitEstimate.estimatedProfitPercent >= spreadMinTotalProfitPercent
    )
  }
  const fundingAdj = spreadFundingProfitEnabled
    ? fundingRateDifferencePercent * spreadNegativeFundingMultiplier
    : 0
  return (
    profitEstimate.spreadProfitPercent - profitEstimate.costsPercent + fundingAdj >= spreadMinSpreadProfitPercent &&
    profitEstimate.estimatedProfitPercent >= spreadMinTotalProfitPercent
  )
}

// Simulate the old validateSpreadEntry early-return when disabled
function oldValidateSpreadEntryDisabled(
  profitEstimate: { spreadProfitPercent: number; costsPercent: number },
  spreadMinSpreadProfitPercent: number,
  spreadMinTotalProfitPercent: number
): boolean {
  const spreadOnlyProfit = profitEstimate.spreadProfitPercent - profitEstimate.costsPercent
  return spreadOnlyProfit >= spreadMinSpreadProfitPercent && spreadOnlyProfit >= spreadMinTotalProfitPercent
}

// When disabled, fundingProfitPercent=0 so estimatedProfitPercent = spreadProfitPercent - costsPercent
// and determineStrategy passes fundingDiff=fundingProfitPercent=0
const minSpread = 0.4
const minTotal = -0.1
const multiplier = 2

// Scenario 1: profitable spread, disabled → both should allow
{
  const est = { spreadProfitPercent: 0.5, costsPercent: 0.05, estimatedProfitPercent: 0.45 }
  const newResult = simulateValidateSpreadEntry(0, est, false, minSpread, minTotal, multiplier)
  const oldResult = oldValidateSpreadEntryDisabled(est, minSpread, minTotal)
  check('disabled, positive spread above threshold: new matches old', newResult, oldResult)
  check('disabled, positive spread above threshold: allows entry', newResult, true)
}

// Scenario 2: spread below threshold, disabled → both should reject
{
  const est = { spreadProfitPercent: 0.2, costsPercent: 0.05, estimatedProfitPercent: 0.15 }
  const newResult = simulateValidateSpreadEntry(0, est, false, minSpread, minTotal, multiplier)
  const oldResult = oldValidateSpreadEntryDisabled(est, minSpread, minTotal)
  check('disabled, spread below threshold: new matches old', newResult, oldResult)
  check('disabled, spread below threshold: rejects entry', newResult, false)
}

// Scenario 3: spread exactly at threshold, disabled
{
  const est = { spreadProfitPercent: 0.45, costsPercent: 0.05, estimatedProfitPercent: 0.40 }
  const newResult = simulateValidateSpreadEntry(0, est, false, minSpread, minTotal, multiplier)
  const oldResult = oldValidateSpreadEntryDisabled(est, minSpread, minTotal)
  check('disabled, spread exactly at threshold: new matches old', newResult, oldResult)
}

// Scenario 4: negative fundingDiff, disabled → multiplier NOT applied (adj=0)
{
  const est = { spreadProfitPercent: 0.5, costsPercent: 0.05, estimatedProfitPercent: 0.45 }
  const newDisabled = simulateValidateSpreadEntry(-0.3, est, false, minSpread, minTotal, multiplier)
  const newEnabled = simulateValidateSpreadEntry(-0.3, est, true, minSpread, minTotal, multiplier)
  check('negative funding disabled: no multiplier penalty, still allows', newDisabled, true)
  // enabled with negative large funding: multiplier applies — adj = -0.3 * 2 = -0.6 → 0.45 - 0.6 < 0.4 → reject
  check('negative funding enabled: multiplier applied, rejects', newEnabled, false)
  check('disabled vs enabled differ when funding is negative', newDisabled !== newEnabled, true)
}

// Scenario 5: zero fundingDiff always hits Case 1 regardless of enabled flag
{
  const est = { spreadProfitPercent: 0.5, costsPercent: 0.05, estimatedProfitPercent: 0.45 }
  const d = simulateValidateSpreadEntry(0, est, false, minSpread, minTotal, multiplier)
  const e = simulateValidateSpreadEntry(0, est, true, minSpread, minTotal, multiplier)
  check('zero fundingDiff: disabled and enabled agree', d, e)
}

// ─── Q. estimateProfit fundingProfitPercent — spot+perp vs spot+spot vs disabled ──

section('Q. estimateProfit fundingProfitPercent gate — spot+perp coverage')

// Simulate the post-D3 estimateProfit gate
// Gate: (isSpotSpot || !spreadFundingProfitEnabled) ? 0 : firstEvent.netFundingRate * 100
function simulateFundingProfitPercent(
  isSpotSpot: boolean,
  spreadFundingProfitEnabled: boolean,
  firstEventNetFundingRate: number | undefined
): number {
  return (isSpotSpot || !spreadFundingProfitEnabled)
    ? 0
    : (firstEventNetFundingRate !== undefined ? firstEventNetFundingRate * 100 : 0)
}

// spot+spot: always 0 regardless of flag or funding data
check('spot+spot, enabled, +funding → 0', simulateFundingProfitPercent(true, true, 0.001), 0)
check('spot+spot, disabled, +funding → 0', simulateFundingProfitPercent(true, false, 0.001), 0)
check('spot+spot, enabled, no event → 0', simulateFundingProfitPercent(true, true, undefined), 0)

// spot+perp (isSpotSpot=false, bothLegsArePerp=false):
// enabled → uses perp leg's funding rate
check('spot+perp, enabled, +0.1% net rate → 0.1', simulateFundingProfitPercent(false, true, 0.001), 0.1)
check('spot+perp, enabled, -0.05% net rate → -0.05', simulateFundingProfitPercent(false, true, -0.0005), -0.05)
check('spot+perp, enabled, no event → 0', simulateFundingProfitPercent(false, true, undefined), 0)
// disabled → 0 even with perp leg (reverted per reviewer comment)
check('spot+perp, disabled, +0.1% net rate → 0 (flag respected)', simulateFundingProfitPercent(false, false, 0.001), 0)
check('spot+perp, disabled, -0.05% net rate → 0 (flag respected)', simulateFundingProfitPercent(false, false, -0.0005), 0)

// perp+perp (isSpotSpot=false):
// enabled → uses combined net rate
check('perp+perp, enabled, +0.2% net rate → 0.2', simulateFundingProfitPercent(false, true, 0.002), 0.2)
check('perp+perp, disabled → 0', simulateFundingProfitPercent(false, false, 0.002), 0)

// determineStrategy passes fundingDiff = fundingProfitPercent (after D3 fix)
// Verify: when disabled, fundingDiff=0 → always hits Case 1 in validateSpreadEntry
{
  const fundingDiff = simulateFundingProfitPercent(false, false, 0.001) // 0 when disabled
  check('determineStrategy: disabled → fundingDiff=0 passed to validateSpreadEntry', fundingDiff, 0)
}

// Verify: spot+perp enabled, positive funding → fundingDiff > 0 → Case 1 (no multiplier)
{
  const fundingDiff = simulateFundingProfitPercent(false, true, 0.001) // 0.1
  check('determineStrategy: spot+perp enabled → fundingDiff=0.1', fundingDiff, 0.1)
  check('determineStrategy: spot+perp enabled → hits Case 1 (fundingDiff >= 0)', fundingDiff >= 0, true)
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('VERIFICATION FAILED')
  process.exit(1)
} else {
  console.log('ALL CHECKS PASSED ✓')
}
