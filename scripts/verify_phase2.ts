/**
 * Phase 2 verification script.
 * Tests: normalizeBaseQuote, getMarketsForBaseQuote, public WS marketType tagging,
 * OrderbookManager propagation, private WS dispatch, ArbitrageEngine cross-market legs,
 * and determineStrategy bothLegsArePerp gate.
 * Run: npx ts-node scripts/verify_phase2.ts
 */
import '../src/utils/network'
import { MarketType } from '../src/types/exchange'
import { MarketMetadataService } from '../src/core/markets/marketMetadataService'
import { OrderbookManager, OrderBookUpdate } from '../src/core/orderbook/orderbookManager'
import { ArbitrageEngine, ArbitrageOpportunity } from '../src/core/arbitrage/arbitrageEngine'
import { BinancePublicWebSocketClient } from '../src/adapters/websocket/binance'
import { BybitPublicWebSocketClient } from '../src/adapters/websocket/bybit'
import { OkxPublicWebSocketClient } from '../src/adapters/websocket/okx'
import { BitgetPublicWebSocketClient } from '../src/adapters/websocket/bitget'
import { BinancePrivateWebSocketClient } from '../src/adapters/websocket/private/binance'
import { BybitPrivateWebSocketClient } from '../src/adapters/websocket/private/bybit'
import { OKXPrivateWebSocketClient } from '../src/adapters/websocket/private/okx'
import { BitgetPrivateWebSocketClient } from '../src/adapters/websocket/private/bitget'
import { BinanceExchange } from '../src/adapters/rest/binance'
import { BybitExchange } from '../src/adapters/rest/bybit'
import { OkxExchange } from '../src/adapters/rest/okx'
import { BitgetExchange } from '../src/adapters/rest/bitget'
import config from '../src/utils/config'

// ─── Shared helpers ───────────────────────────────────────────────────────────

let totalPass = 0, totalFail = 0

function chk(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  (' + detail + ')' : ''}`)
  ok ? totalPass++ : totalFail++
}

function mockMarket(symbol: string, id: string, opts: {
  spot?: boolean; swap?: boolean; linear?: boolean; inverse?: boolean
  contractSize?: number; quote?: string
} = {}): any {
  const colonIdx = symbol.indexOf(':')
  const slashIdx = symbol.indexOf('/')
  const swap = opts.swap ?? colonIdx >= 0
  const spot = opts.spot ?? !swap
  const inverse = opts.inverse ?? false
  const linear = opts.linear ?? (swap && !inverse)
  const base = symbol.slice(0, slashIdx)
  const quotePart = colonIdx >= 0 ? symbol.slice(slashIdx + 1, colonIdx) : symbol.slice(slashIdx + 1)
  const quote = opts.quote ?? quotePart
  return {
    id, symbol, base, quote,
    active: true, spot, swap, linear, inverse,
    option: false, future: false,
    contractSize: opts.contractSize ?? 1,
    precision: { price: 0.01, amount: 0.01 },
    limits: { amount: { min: 0.01, max: 1e6 }, price: { min: 0.01, max: 1e7 }, cost: { min: 1 } },
  }
}

function obUpdate(
  exchange: string, symbol: string, mt: MarketType,
  ask: number, bid: number, id: number,
): OrderBookUpdate {
  return {
    type: 'snapshot', exchange, symbol, marketType: mt,
    bids: [{ price: bid, quantity: 1000, amount: bid * 1000 }],
    asks: [{ price: ask, quantity: 1000, amount: ask * 1000 }],
    timestamp: Date.now(), finalUpdateId: id, traceId: 'test',
  }
}

const STUB_WS_CFG = { apiKey: 'k', apiSecret: 's', apiPass: 'p', maxStreamsPerConnection: 100, reconnectInterval: 5000 }

const STUB_REST = {
  getTradingMarkets: () => ({
    'BTC/USDT:USDT': { contractSize: 1 }, 'BTC/USD:BTC': { contractSize: 0.01 },
    'BTC/USDT': { contractSize: 1 }, 'SOL/USDT:USDT': { contractSize: 1 },
  }),
  getAllMarkets: () => ({}),
} as any

function prePopulateMap(client: any, entries: [MarketType, string, string][]): void {
  const m = (client as any).marketIdAndTypeToUnified as Map<string, string>
  for (const [mt, id, unified] of entries) {
    m.set(`${mt}:${id}`, unified)
  }
}

// ─── Section 1: normalizeBaseQuote + getMarketsForBaseQuote ──────────────────

async function runSection1(): Promise<void> {
  console.log('\n══ 1. normalizeBaseQuote + getMarketsForBaseQuote ══')
  let p = 0, f = 0
  const pass = () => p++
  const fail = () => f++

  const mms = new MarketMetadataService('test', [
    mockMarket('BTC/USDT',      'BTCUSDT',     { spot: true }),
    mockMarket('BTC/USDT:USDT', 'BTCUSDTSWAP', { swap: true, linear: true }),
    mockMarket('BTC/USD:BTC',   'BTCUSD',      { swap: true, inverse: true, quote: 'USD' }),
  ])

  // normalizeBaseQuote unit cases
  console.log('\n── normalizeBaseQuote ──')
  for (const [input, expected] of [
    ['BTC/USDT',              'BTC/USDT'],
    ['BTC/USDT:USDT',         'BTC/USDT'],
    ['BTC/USD:BTC',           'BTC/USD'],
    ['1000PEPE/USDT:USDT',    'PEPE/USDT'],
    ['1000000BABYDOGE/USDT',  'BABYDOGE/USDT'],
    ['ETH/USDC:USDC',         'ETH/USDC'],
  ] as [string, string][]) {
    const got = mms.normalizeBaseQuote(input)
    const ok = got === expected
    console.log(`  ${ok ? '✓' : '✗'} '${input}' → '${got}' (expected '${expected}')`)
    ok ? (pass(), totalPass++) : (fail(), totalFail++)
  }

  // getMarketsForBaseQuote unit cases
  console.log('\n── getMarketsForBaseQuote (hand-crafted) ──')
  {
    const entries = mms.getMarketsForBaseQuote('BTC/USDT')
    const hasSpot   = entries.some(e => e.marketType === MarketType.SPOT && e.symbol === 'BTC/USDT')
    const hasLinear = entries.some(e => e.marketType === MarketType.LINEAR_PERP && e.symbol === 'BTC/USDT:USDT')
    const ok = entries.length === 2 && hasSpot && hasLinear
    console.log(`  ${ok ? '✓' : '✗'} getMarketsForBaseQuote('BTC/USDT') → ${entries.length} entries spot=${hasSpot} linear=${hasLinear}`)
    ok ? (pass(), totalPass++) : (fail(), totalFail++)
  }
  {
    const entries = mms.getMarketsForBaseQuote('BTC/USD')
    const hasInverse = entries.some(e => e.marketType === MarketType.INVERSE_PERP && e.symbol === 'BTC/USD:BTC')
    const ok = entries.length === 1 && hasInverse
    console.log(`  ${ok ? '✓' : '✗'} getMarketsForBaseQuote('BTC/USD') → ${entries.length} entries inverse=${hasInverse}`)
    ok ? (pass(), totalPass++) : (fail(), totalFail++)
  }
  {
    const entries = mms.getMarketsForBaseQuote('UNKNOWN/XYZ')
    const ok = entries.length === 0
    console.log(`  ${ok ? '✓' : '✗'} getMarketsForBaseQuote('UNKNOWN/XYZ') → ${entries.length} entries`)
    ok ? (pass(), totalPass++) : (fail(), totalFail++)
  }

  // Live cross-market check
  const restExchanges = [
    { name: 'binance', client: new BinanceExchange({ apiKey: config.exchanges.binance.apiKey, apiSecret: config.exchanges.binance.apiSecret }) },
    { name: 'bybit',   client: new BybitExchange({ apiKey: config.exchanges.bybit.apiKey, apiSecret: config.exchanges.bybit.apiSecret }) },
    { name: 'okx',     client: new OkxExchange({ apiKey: config.exchanges.okx.apiKey, apiSecret: config.exchanges.okx.apiSecret, apiPass: config.exchanges.okx.apiPass }) },
    { name: 'bitget',  client: new BitgetExchange({ apiKey: config.exchanges.bitget.apiKey, apiSecret: config.exchanges.bitget.apiSecret, apiPass: config.exchanges.bitget.apiPass }) },
  ]

  console.log('\n── getMarketsForBaseQuote (live REST) ──')
  for (const { name, client } of restExchanges) {
    try {
      await client.loadMarkets()
      const cfg = config.exchanges[name as keyof typeof config.exchanges] as any
      const lmms = new MarketMetadataService(
        name, Object.values(client.getAllMarkets()),
        cfg.ignoredMarkets ?? [], cfg.enabledMarketTypes, cfg.enabledQuoteCurrencies,
      )
      const entries = lmms.getMarketsForBaseQuote('BTC/USDT')
      const hasSpot   = entries.some(e => e.marketType === MarketType.SPOT)
      const hasLinear = entries.some(e => e.marketType === MarketType.LINEAR_PERP)
      const ok = hasSpot && hasLinear
      const mapSize = (lmms as any).baseQuoteMarkets.size
      console.log(`  ${ok ? '✓' : '✗'} ${name}: BTC/USDT has spot=${hasSpot} linear=${hasLinear} (${entries.length} entries, map=${mapSize})`)
      ok ? (pass(), totalPass++) : (fail(), totalFail++)
    } catch (err: any) {
      console.log(`  ✗ ${name}: ${err.message}`)
      fail(); totalFail++
    }
  }

  console.log(`\nSection 1: ${p} passed, ${f} failed`)
}

// ─── Section 2: Public WS parsers tag marketType ─────────────────────────────

function runSection2(): void {
  console.log('\n══ 2. Public WS parsers tag marketType ══')
  const now = Date.now()

  function testParser(label: string, parser: any, fixture: any, mt: MarketType, expectedSym: string): void {
    const r = parser.parseOrderBookUpdate(fixture, mt)
    const ok = r.marketType === mt && r.symbol === expectedSym
    console.log(`  ${ok ? '✓' : '✗'} ${label}: marketType=${r.marketType} symbol=${r.symbol}`)
    ok ? totalPass++ : totalFail++
  }

  // ── Binance ──
  {
    const c = new BinancePublicWebSocketClient(STUB_WS_CFG)
    prePopulateMap(c, [
      [MarketType.SPOT,         'BTCUSDT', 'BTC/USDT'],
      [MarketType.LINEAR_PERP,  'BTCUSDT', 'BTC/USDT:USDT'],
      [MarketType.INVERSE_PERP, 'BTCUSD',  'BTC/USD:BTC'],
    ])
    const parser = (c as any).messageParser
    const spotFix = { e: 'depthUpdate', s: 'BTCUSDT', E: now, U: 1, u: 2, pu: 0, a: [['50001', '0.1']], b: [['50000', '0.1']] }
    const invFix  = { e: 'depthUpdate', s: 'BTCUSD',  E: now, U: 3, u: 4, pu: 2, a: [['50001', '0.01']], b: [['50000', '0.01']] }
    testParser('binance/spot',    parser, spotFix, MarketType.SPOT,          'BTC/USDT')
    testParser('binance/linear',  parser, spotFix, MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    testParser('binance/inverse', parser, invFix,  MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }

  // ── Bybit ──
  {
    const c = new BybitPublicWebSocketClient(STUB_WS_CFG)
    prePopulateMap(c, [
      [MarketType.SPOT,         'BTCUSDT', 'BTC/USDT'],
      [MarketType.LINEAR_PERP,  'BTCUSDT', 'BTC/USDT:USDT'],
      [MarketType.INVERSE_PERP, 'BTCUSD',  'BTC/USD:BTC'],
    ])
    const parser = (c as any).messageParser
    const spotFix = { topic: 'orderbook.50.BTCUSDT', type: 'snapshot', ts: now, data: { s: 'BTCUSDT', a: [['50001', '0.1']], b: [['50000', '0.1']], u: 1, seq: 1 } }
    const invFix  = { topic: 'orderbook.50.BTCUSD',  type: 'snapshot', ts: now, data: { s: 'BTCUSD',  a: [['50001', '0.01']], b: [['50000', '0.01']], u: 2, seq: 2 } }
    testParser('bybit/spot',    parser, spotFix, MarketType.SPOT,          'BTC/USDT')
    testParser('bybit/linear',  parser, spotFix, MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    testParser('bybit/inverse', parser, invFix,  MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }

  // ── OKX ──
  {
    const c = new OkxPublicWebSocketClient(STUB_WS_CFG)
    prePopulateMap(c, [
      [MarketType.SPOT,         'BTC-USDT',      'BTC/USDT'],
      [MarketType.LINEAR_PERP,  'BTC-USDT-SWAP', 'BTC/USDT:USDT'],
      [MarketType.INVERSE_PERP, 'BTC-USD-SWAP',  'BTC/USD:BTC'],
    ])
    const parser = (c as any).messageParser
    const mkFix = (instId: string, seqId: number) => ({
      arg: { channel: 'books', instId },
      action: 'snapshot',
      data: [{ ts: String(now), asks: [['50001', '0.1', '', '']], bids: [['50000', '0.1', '', '']], seqId }],
    })
    testParser('okx/spot',    parser, mkFix('BTC-USDT',      1), MarketType.SPOT,          'BTC/USDT')
    testParser('okx/linear',  parser, mkFix('BTC-USDT-SWAP', 2), MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    testParser('okx/inverse', parser, mkFix('BTC-USD-SWAP',  3), MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }

  // ── Bitget ──
  {
    const c = new BitgetPublicWebSocketClient(STUB_WS_CFG)
    prePopulateMap(c, [
      [MarketType.SPOT,         'BTCUSDT', 'BTC/USDT'],
      [MarketType.LINEAR_PERP,  'BTCUSDT', 'BTC/USDT:USDT'],
      [MarketType.INVERSE_PERP, 'BTCUSD',  'BTC/USD:BTC'],
    ])
    const parser = (c as any).messageParser
    const spotFix = { arg: { channel: 'books5', instId: 'BTCUSDT' }, data: [{ ts: String(now), asks: [['50001', '0.1']], bids: [['50000', '0.1']], seq: '1' }] }
    const invFix  = { arg: { channel: 'books5', instId: 'BTCUSD'  }, data: [{ ts: String(now), asks: [['50001', '0.01']], bids: [['50000', '0.01']], seq: '2' }] }
    testParser('bitget/spot',    parser, spotFix, MarketType.SPOT,          'BTC/USDT')
    testParser('bitget/linear',  parser, spotFix, MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    testParser('bitget/inverse', parser, invFix,  MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }
}

// ─── Section 3: OrderbookManager propagates marketType to TopOfBook ──────────

function runSection3(): void {
  console.log('\n══ 3. OrderbookManager propagates marketType to TopOfBook ══')
  for (const mt of [MarketType.SPOT, MarketType.LINEAR_PERP, MarketType.INVERSE_PERP]) {
    const sym = mt === MarketType.SPOT ? 'BTC/USDT' : mt === MarketType.LINEAR_PERP ? 'BTC/USDT:USDT' : 'BTC/USD:BTC'
    const mgr = new OrderbookManager()
    let emitted: any = null
    mgr.on('topOfBookUpdate', (tob: any) => { emitted = tob })
    mgr.updateOrderbook(obUpdate('binance', sym, mt, 50001, 50000, 1))
    mgr.updateOrderbook(obUpdate('binance', sym, mt, 50002, 50001, 2))
    const ok = emitted?.marketType === mt
    console.log(`  ${ok ? '✓' : '✗'} ${mt}: emitted=${emitted !== null} topOfBook.marketType=${emitted?.marketType}`)
    ok ? totalPass++ : totalFail++
  }
}

// ─── Section 4: Private WS parser dispatch ───────────────────────────────────

function runSection4(): void {
  console.log('\n══ 4. Private WS parser dispatch ══')

  function assertItem(label: string, items: any[], expectedMt: MarketType, expectedSym: string): void {
    const item = items[0]
    const ok = item?.marketType === expectedMt && item?.symbol === expectedSym
    console.log(`  ${ok ? '✓' : '✗'} ${label}: marketType=${item?.marketType} symbol=${item?.symbol}`)
    ok ? totalPass++ : totalFail++
  }

  // ── Bybit ──
  {
    const parser = (new BybitPrivateWebSocketClient(STUB_WS_CFG, STUB_REST) as any).messageParser
    const mkPos = (cat: string, sym: string) => ({
      topic: 'position', category: cat,
      data: [{ symbol: sym, side: 'Buy', size: '0.1', entryPrice: '200', leverage: '10', unrealisedPnl: '5', createdTime: '1700000000000' }],
    })
    const mkOrd = (cat: string, sym: string) => ({
      topic: 'order', category: cat,
      data: [{ orderId: 'o1', orderLinkId: 'c1', symbol: sym, side: 'Buy', orderType: 'Limit', price: '200', avgPrice: '200', qty: '0.1', orderStatus: 'New', createdTime: '1700000000000', reduceOnly: false }],
    })
    assertItem('bybit/position/linear',  parser.parsePositionUpdate(mkPos('linear',  'SOLUSDT')), MarketType.LINEAR_PERP,  'SOL/USDT:USDT')
    assertItem('bybit/position/inverse', parser.parsePositionUpdate(mkPos('inverse', 'SOLUSD')),  MarketType.INVERSE_PERP, 'SOL/USD:SOL')
    assertItem('bybit/position/spot',    parser.parsePositionUpdate(mkPos('spot',    'SOLUSDT')), MarketType.SPOT,         'SOL/USDT')
    assertItem('bybit/order/linear',     parser.parseOrderUpdate(mkOrd('linear',  'SOLUSDT')),    MarketType.LINEAR_PERP,  'SOL/USDT:USDT')
    assertItem('bybit/order/inverse',    parser.parseOrderUpdate(mkOrd('inverse', 'SOLUSD')),     MarketType.INVERSE_PERP, 'SOL/USD:SOL')
  }

  // ── OKX ──
  {
    const parser = (new OKXPrivateWebSocketClient(STUB_WS_CFG, STUB_REST) as any).messageParser
    const mkPos = (instId: string) => ({
      arg: { channel: 'positions', instType: 'ANY' },
      data: [{ instId, pos: '1', avgPx: '50000', lever: '10', upl: '100', cTime: '1700000000000', posId: 'p1', posSide: 'long' }],
    })
    const mkOrd = (instId: string) => ({
      arg: { channel: 'orders', instType: 'ANY' },
      data: [{ instId, ordId: 'o1', clOrdId: 'c1', side: 'buy', posSide: 'long', ordType: 'limit', px: '50000', avgPx: '50000', sz: '1', state: 'live', cTime: '1700000000000' }],
    })
    assertItem('okx/position/linear',  parser.parsePositionUpdate(mkPos('BTC-USDT-SWAP'), STUB_REST), MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    assertItem('okx/position/inverse', parser.parsePositionUpdate(mkPos('BTC-USD-SWAP'),  STUB_REST), MarketType.INVERSE_PERP, 'BTC/USD:BTC')
    assertItem('okx/order/linear',     parser.parseOrderUpdate(mkOrd('BTC-USDT-SWAP'), STUB_REST),    MarketType.LINEAR_PERP,  'BTC/USDT:USDT')
    assertItem('okx/order/inverse',    parser.parseOrderUpdate(mkOrd('BTC-USD-SWAP'),  STUB_REST),    MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }

  // ── Bitget ──
  {
    const parser = (new BitgetPrivateWebSocketClient(STUB_WS_CFG, STUB_REST) as any).messageParser
    const mkPos = (instType: string, instId: string) => ({
      arg: { instType },
      data: [{ instId, holdSide: 'long', total: '0.1', openPriceAvg: '200', leverage: '10', unrealizedPL: '5', cTime: '1700000000000' }],
    })
    assertItem('bitget/position/linear',  parser.parsePositionUpdate(mkPos('USDT-FUTURES', 'SOLUSDT')), MarketType.LINEAR_PERP,  'SOL/USDT:USDT')
    assertItem('bitget/position/inverse', parser.parsePositionUpdate(mkPos('COIN-FUTURES', 'SOLUSD')),  MarketType.INVERSE_PERP, 'SOL/USD:SOL')
    assertItem('bitget/position/spot',    parser.parsePositionUpdate(mkPos('SPOT',         'SOLUSDT')), MarketType.SPOT,         'SOL/USDT')
  }

  // ── Binance ──
  {
    const parser = (new BinancePrivateWebSocketClient(STUB_WS_CFG, STUB_REST) as any).messageParser
    // Balance: spot outboundAccountPosition
    const balSpot = parser.parseBalanceUpdate({ e: 'outboundAccountPosition', B: [{ a: 'USDT', f: '1000', l: '0' }] })
    const okBalSpot = balSpot[0]?.marketType === MarketType.SPOT
    console.log(`  ${okBalSpot ? '✓' : '✗'} binance/balance/spot: marketType=${balSpot[0]?.marketType}`)
    okBalSpot ? totalPass++ : totalFail++
    // Balance: USDM
    const balLinear = parser.parseBalanceUpdate({ e: 'ACCOUNT_UPDATE', wsKey: 'usdMFutures_userData', a: { B: [{ a: 'USDT', wb: '1000', cw: '900' }], P: [] } })
    const okBalLinear = balLinear[0]?.marketType === MarketType.LINEAR_PERP
    console.log(`  ${okBalLinear ? '✓' : '✗'} binance/balance/linear: marketType=${balLinear[0]?.marketType}`)
    okBalLinear ? totalPass++ : totalFail++
    // Balance: CoinM
    const balInverse = parser.parseBalanceUpdate({ e: 'ACCOUNT_UPDATE', wsKey: 'coinMFutures_userData', a: { B: [{ a: 'BTC', wb: '0.1', cw: '0.09' }], P: [] } })
    const okBalInverse = balInverse[0]?.marketType === MarketType.INVERSE_PERP
    console.log(`  ${okBalInverse ? '✓' : '✗'} binance/balance/inverse: marketType=${balInverse[0]?.marketType}`)
    okBalInverse ? totalPass++ : totalFail++
    // Order: spot executionReport
    const ordSpot = parser.parseOrderUpdate({ e: 'executionReport', s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', p: '50000', L: '50000', q: '0.001', X: 'NEW', i: 1, c: 'c1', T: 1700000000000 })
    assertItem('binance/order/spot', ordSpot, MarketType.SPOT, 'BTC/USDT')
    // Order: USDM ORDER_TRADE_UPDATE
    const ordLinear = parser.parseOrderUpdate({ e: 'ORDER_TRADE_UPDATE', wsKey: 'usdMFutures_userData', o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', p: '50000', ap: '50000', q: '0.001', X: 'NEW', i: 2, c: 'c2', R: false }, T: 1700000000000 })
    assertItem('binance/order/linear', ordLinear, MarketType.LINEAR_PERP, 'BTC/USDT:USDT')
    // Order: CoinM ORDER_TRADE_UPDATE
    const ordInverse = parser.parseOrderUpdate({ e: 'ORDER_TRADE_UPDATE', wsKey: 'coinMFutures_userData', o: { s: 'BTCUSD_PERP', S: 'BUY', o: 'LIMIT', p: '50000', ap: '50000', q: '100', X: 'NEW', i: 3, c: 'c3', R: false }, T: 1700000000000 })
    assertItem('binance/order/inverse', ordInverse, MarketType.INVERSE_PERP, 'BTC/USD:BTC')
    // Position: USDM ACCOUNT_UPDATE
    const posLinear = parser.parsePositionUpdate({ e: 'ACCOUNT_UPDATE', wsKey: 'usdMFutures_userData', a: { B: [], P: [{ s: 'BTCUSDT', pa: '0.001', ep: '50000', up: '10' }] } })
    assertItem('binance/position/linear', posLinear, MarketType.LINEAR_PERP, 'BTC/USDT:USDT')
    // Position: CoinM ACCOUNT_UPDATE
    const posInverse = parser.parsePositionUpdate({ e: 'ACCOUNT_UPDATE', wsKey: 'coinMFutures_userData', a: { B: [], P: [{ s: 'BTCUSD_PERP', pa: '100', ep: '50000', up: '-5' }] } })
    assertItem('binance/position/inverse', posInverse, MarketType.INVERSE_PERP, 'BTC/USD:BTC')
  }
}

// ─── Section 5: ArbitrageEngine cross-market-type legs ───────────────────────

function runSection5(): void {
  console.log('\n══ 5. ArbitrageEngine cross-market-type legs ══')

  const EXCHANGES = ['binance', 'bybit', 'okx']
  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of EXCHANGES) {
    metaMap.set(ex, new MarketMetadataService(ex, [
      mockMarket('SOL/USDT',      'SOLUSDT',     { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOLUSDTSWAP', { swap: true, linear: true }),
    ], [], undefined, undefined))
  }

  const orderbookMgr = new OrderbookManager()

  const stubFunding = {
    generateFundingEvents: (_b: any, _s: any, _h: number) => [{ timestamp: Date.now(), buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }],
    isFundingSynchronizedEntry: () => false,
    findNextSyncTimestamp: () => 0,
    calculateCumulativeFundingRate: () => 0,
    getSymbolFundingData: (exchange: string, symbol: string) => ({
      exchange, symbol, fundingRate: 0, fundingRatePercent: 0,
      fundingInterval: 4, nextFundingTimestamp: Date.now() + 3_600_000, nextFundingDatetime: new Date(),
    }),
    generateExchangeFundingEvents: (_f: any, _s: number, _e: number) => [],
  } as any

  const engine = new ArbitrageEngine(
    orderbookMgr, [],
    EXCHANGES.map(name => ({ name, isHealthy: true })),
    metaMap, stubFunding,
  )
  // Make validation trivially pass so structural assertions can run
  ;(engine as any).minPersistenceMs = 0
  ;(engine as any).minConsecutiveSnapshots = 3
  ;(engine as any).spreadMinSpreadProfitPercent = -999
  ;(engine as any).spreadMinTotalProfitPercent = -999
  ;(engine as any).minConfidenceScore = 0
  ;(engine as any).maxAnomalySpreadThresholdPercent = 100
  ;(engine as any).fundingStrategyEnabled = false

  const opportunities: ArbitrageOpportunity[] = []
  engine.on('opportunities', (opps: ArbitrageOpportunity[]) => opportunities.push(...opps))

  // Phase A: Seed initial orderbooks for all exchanges × both market types (no topOfBook emit — first update)
  for (const ex of EXCHANGES) {
    orderbookMgr.updateOrderbook(obUpdate(ex, 'SOL/USDT',      MarketType.SPOT,        200.00, 199.90, 1))
    orderbookMgr.updateOrderbook(obUpdate(ex, 'SOL/USDT:USDT', MarketType.LINEAR_PERP, 203.00, 202.90, 1))
  }

  // Phase B: Drive ≥ 3 binance SPOT updates (price changes slightly each time → topOfBookUpdate emits → engine scans)
  for (let i = 1; i <= 4; i++) {
    const d = i * 0.01
    orderbookMgr.updateOrderbook(obUpdate('binance', 'SOL/USDT', MarketType.SPOT, 200.00 + d, 199.90 + d, i + 1))
  }

  console.log(`  (${opportunities.length} opportunities collected across all scans)`)

  if (opportunities.length === 0) {
    console.log('  ✗ No opportunities emitted — all 5 structural assertions skipped')
    totalFail += 5
    return
  }

  // Structural assertions
  const ok1 = opportunities.length > 0
  console.log(`  ${ok1 ? '✓' : '✗'} at least one opportunity emitted`)
  ok1 ? totalPass++ : totalFail++

  const hasCrossType = opportunities.some(o => o.buyMarketType !== o.sellMarketType)
  console.log(`  ${hasCrossType ? '✓' : '✗'} at least one opportunity has buyMarketType !== sellMarketType`)
  hasCrossType ? totalPass++ : totalFail++

  const allBothLegsCorrect = opportunities.every(o =>
    o.bothLegsArePerp === (o.buyMarketType !== MarketType.SPOT && o.sellMarketType !== MarketType.SPOT)
  )
  console.log(`  ${allBothLegsCorrect ? '✓' : '✗'} all: bothLegsArePerp === (buyMT≠SPOT && sellMT≠SPOT)`)
  allBothLegsCorrect ? totalPass++ : totalFail++

  const noSameExSameType = opportunities.every(o => !(o.buyExchange === o.sellExchange && o.buyMarketType === o.sellMarketType))
  console.log(`  ${noSameExSameType ? '✓' : '✗'} no opportunity has same-exchange same-marketType`)
  noSameExSameType ? totalPass++ : totalFail++

  const hasSameExDiffType = opportunities.some(o => o.buyExchange === o.sellExchange && o.buyMarketType !== o.sellMarketType)
  console.log(`  ${hasSameExDiffType ? '✓' : '✗'} at least one opportunity has same-exchange different-marketType`)
  hasSameExDiffType ? totalPass++ : totalFail++
}

// ─── Section 6: determineStrategy gate via bothLegsArePerp ───────────────────

function runSection6(): void {
  console.log('\n══ 6. determineStrategy gate via bothLegsArePerp ══')

  const mmsMin = new MarketMetadataService('binance', [mockMarket('SOL/USDT', 'SOLUSDT', { spot: true })], [], undefined, undefined)
  const engineMin = new ArbitrageEngine(
    new OrderbookManager(), [],
    [{ name: 'binance', isHealthy: true }],
    new Map([['binance', mmsMin]]),
    { generateFundingEvents: () => [{ timestamp: Date.now(), buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }], isFundingSynchronizedEntry: () => false, findNextSyncTimestamp: () => 0, calculateCumulativeFundingRate: () => 0 } as any,
  )

  const ds = (...args: any[]) => (engineMin as any).determineStrategy(...args)

  const dummyFunding = {
    exchange: 'binance', symbol: 'SOL/USDT:USDT', fundingRate: 0, fundingRatePercent: 0,
    fundingInterval: 4, nextFundingTimestamp: 1789148800000, nextFundingDatetime: new Date(),
  }

  const validProfit   = { spreadProfitPercent: 1.0, estimatedProfitPercent: 0.8, costsPercent: 0.2, fundingProfitPercent: 0, tradingFeesUsd: 0, tradingFeesPercent: 0, costsUsd: 0, spreadProfitUsd: 0, fundingProfitUsd: 0, estimatedProfitUsd: 0, latencyPenalty: 0, confidenceScore: 0.9 }
  const invalidProfit = { ...validProfit, spreadProfitPercent: 0.05, estimatedProfitPercent: -0.5 }

  // Case 1: bothLegsArePerp=false, spread validates → strategy='spread'
  const r1 = ds(dummyFunding, dummyFunding, validProfit, false)
  const ok1 = r1.strategy === 'spread' && r1.variant === 'spread'
  console.log(`  ${ok1 ? '✓' : '✗'} bothLegsArePerp=false + valid spread → strategy=${r1.strategy} variant=${r1.variant}`)
  ok1 ? totalPass++ : totalFail++

  // Case 2: bothLegsArePerp=false, spread fails → strategy=null with non-perp reason
  const r2 = ds(dummyFunding, dummyFunding, invalidProfit, false)
  const ok2 = r2.strategy === null && typeof r2.reason === 'string' && r2.reason.includes('Non-perp')
  console.log(`  ${ok2 ? '✓' : '✗'} bothLegsArePerp=false + invalid spread → strategy=${r2.strategy} reason='${r2.reason}'`)
  ok2 ? totalPass++ : totalFail++

  // Case 3: bothLegsArePerp=true, outdated funding → strategy=null with Outdated reason
  const pastFunding = { ...dummyFunding, nextFundingTimestamp: Date.now() - 10000 }
  const r3 = ds(pastFunding, pastFunding, validProfit, true)
  const ok3 = r3.strategy === null && typeof r3.reason === 'string' && r3.reason.includes('Outdated')
  console.log(`  ${ok3 ? '✓' : '✗'} bothLegsArePerp=true + outdated funding → strategy=${r3.strategy} reason='${r3.reason}'`)
  ok3 ? totalPass++ : totalFail++
}

// ─── Main ────────────────────────────────────────────────────────────────────
;(async () => {
  await runSection1()
  runSection2()
  runSection3()
  runSection4()
  runSection5()
  runSection6()

  console.log('\n══ Summary ══')
  console.log(`Total: ${totalPass}/${totalPass + totalFail} passed  ${totalFail > 0 ? `(${totalFail} FAILED)` : '✓ all green'}`)
  process.exit(totalFail > 0 ? 1 : 0)
})()
