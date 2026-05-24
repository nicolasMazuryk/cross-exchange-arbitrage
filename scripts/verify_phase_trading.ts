/**
 * Trading-layer verification script (phase: trade executor + trade monitor).
 * Tests: getRequiredBalanceCurrency logic, validateTrade per-market-type currency,
 * position-validation skip for SPOT, rollback reduceOnly, exit order reduceOnly,
 * processTradeExitConditions funding bypass for non-perp.
 *
 * Run: npx ts-node scripts/verify_phase_trading.ts
 */

import { MarketType } from '../src/types/exchange'
import { TradeExecutor } from '../src/core/trading/tradeExecutor'
import { TradeMonitor } from '../src/core/trading/tradeMonitor'
import { AccountStateManager } from '../src/core/state/accountStateManager'
import { ArbitrageOpportunity } from '../src/core/arbitrage/arbitrageEngine'
import { OrderbookManager, OrderBookUpdate } from '../src/core/orderbook/orderbookManager'
import { MarketMetadataService } from '../src/core/markets/marketMetadataService'

let totalPass = 0, totalFail = 0
function chk(label: string, ok: boolean, detail = ''): void {
  const icon = ok ? '✓' : '✗'
  console.log(`  ${icon} ${label}${detail ? `  (${detail})` : ''}`)
  ok ? totalPass++ : totalFail++
}

// ─── Shared mock helpers ─────────────────────────────────────────────────────

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
    limits: { amount: { min: 0.001, max: 1e6 }, price: { min: 0.01, max: 1e7 }, cost: { min: 1 } },
  }
}

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'opp1',
    normalizedPair: 'SOL/USDT:USDT',
    buyExchangeSymbol: 'SOLUSDT',
    sellExchangeSymbol: 'SOLUSDT',
    buyExchange: 'binance',
    sellExchange: 'bybit',
    buyMarketType: MarketType.LINEAR_PERP,
    sellMarketType: MarketType.LINEAR_PERP,
    bothLegsArePerp: true,
    avgBuyNormalizedExecutionPrice: 100,
    avgSellNormalizedExecutionPrice: 103,
    normalizedVolume: 2,
    buyExchangeVolume: 2,
    sellExchangeVolume: 2,
    orderAmountUsd: 200,
    confidenceScore: 0.9,
    traceId: 'trace1',
    orderbookUpdateTimestamp: Date.now(),
    strategy: 'spread',
    strategyVariant: 'spread',
    buyExchangeNextFundingTimestamp: Date.now() + 3600000,
    sellExchangeNextFundingTimestamp: Date.now() + 3600000,
    targetFundingTimestamp: Date.now() + 3600000,
    costsUsd: 2, costsPercent: 1,
    tradingFeesUsd: 1, tradingFeesPercent: 0.5,
    spreadProfitUsd: 6, spreadProfitPercent: 3,
    fundingProfitUsd: 0, fundingProfitPercent: 0,
    estimatedProfitUsd: 4, estimatedProfitPercent: 2,
    crossExchangePriceSpreadPercent: 3,
    ...overrides,
  } as ArbitrageOpportunity
}

function makeMetadataService(exchangeId: string, markets: any[]): MarketMetadataService {
  return new MarketMetadataService(exchangeId, markets, [], ['linear', 'inverse', 'spot'], ['USDT', 'USD', 'BTC'])
}

// ─── Section 1: getRequiredBalanceCurrency logic ─────────────────────────────

function runSection1(): void {
  console.log('\n══ 1. getRequiredBalanceCurrency logic ══')

  // We test this indirectly through validateTrade. First verify the expected behavior:
  // SPOT buy  → quote currency (e.g. USDT for BTC/USDT)
  // SPOT sell → base currency (e.g. BTC for BTC/USDT)
  // LINEAR    → settle currency (e.g. USDT for BTC/USDT:USDT)
  // INVERSE   → base currency (e.g. BTC for BTC/USD:BTC)

  const cases: Array<[string, MarketType, boolean, string]> = [
    // [normalizedPair, marketType, isBuyLeg, expectedCurrency]
    ['BTC/USDT',      MarketType.SPOT,         true,  'USDT'],  // spot buy → quote
    ['BTC/USDT',      MarketType.SPOT,         false, 'BTC'],   // spot sell → base
    ['ETH/EUR',       MarketType.SPOT,         true,  'EUR'],   // spot buy → EUR quote
    ['ETH/EUR',       MarketType.SPOT,         false, 'ETH'],   // spot sell → ETH base
    ['BTC/USDT:USDT', MarketType.LINEAR_PERP,  true,  'USDT'],  // linear → settle = USDT
    ['BTC/USDT:USDT', MarketType.LINEAR_PERP,  false, 'USDT'],  // linear → settle = USDT
    ['SOL/USDC:USDC', MarketType.LINEAR_PERP,  true,  'USDC'],  // linear → settle = USDC
    ['BTC/USD:BTC',   MarketType.INVERSE_PERP, true,  'BTC'],   // inverse → base = BTC
    ['BTC/USD:BTC',   MarketType.INVERSE_PERP, false, 'BTC'],   // inverse → base = BTC
    ['ETH/USD:ETH',   MarketType.INVERSE_PERP, true,  'ETH'],   // inverse → base = ETH
  ]

  // Replicate the function locally to verify against expected values
  function getRequiredBalanceCurrency(normalizedPair: string, marketType: MarketType, isBuyLeg: boolean): string {
    const parts = normalizedPair.split(':')
    const [base, quote] = parts[0].split('/')
    const settle = parts[1] || quote
    switch (marketType) {
      case MarketType.SPOT:         return isBuyLeg ? quote : base
      case MarketType.LINEAR_PERP:  return settle
      case MarketType.INVERSE_PERP: return base
      default:                      return settle
    }
  }

  for (const [pair, mt, isBuy, expected] of cases) {
    const got = getRequiredBalanceCurrency(pair, mt, isBuy)
    chk(
      `${pair} ${mt} ${isBuy ? 'buy' : 'sell'} → ${expected}`,
      got === expected,
      `got=${got}`
    )
  }
}

// ─── Section 2: validateTrade calls getAvailableBalance with correct currency ─

async function runSection2(): Promise<void> {
  console.log('\n══ 2. validateTrade: per-market-type balance currency ══')

  const balanceCalls: Array<[string, string]> = []

  // Mock AccountStateManager that records getAvailableBalance calls
  const mockAccountState = {
    getAvailableBalance: (exchange: string, asset: string) => {
      balanceCalls.push([exchange, asset])
      return 999999  // always sufficient
    },
    getActiveOrders:            () => [],
    getPosition:                () => null,
    getOrder:                   () => null,
    getOrderByClientOrderId:    () => null,
    getOrders:                  () => [],
    getBalances:                () => [],
    getPositions:               () => [],
    isExchangeStateFresh:       () => true,
  } as unknown as AccountStateManager

  const mockOB = new OrderbookManager()
  const mockRestClients = new Map<string, any>()
  const metaMap = new Map<string, MarketMetadataService>()
  metaMap.set('binance', makeMetadataService('binance', [
    mockMarket('SOL/USDT',      'SOLUSDT',  { spot: true }),
    mockMarket('SOL/USDT:USDT', 'SOLUSDT',  { swap: true, linear: true }),
    mockMarket('SOL/USD:SOL',   'SOLUSD',   { swap: true, inverse: true }),
  ]))
  metaMap.set('bybit', makeMetadataService('bybit', [
    mockMarket('SOL/USDT',      'SOLUSDT',  { spot: true }),
    mockMarket('SOL/USDT:USDT', 'SOLUSDT',  { swap: true, linear: true }),
    mockMarket('SOL/USD:SOL',   'SOLUSD',   { swap: true, inverse: true }),
  ]))

  const executor = new TradeExecutor(mockAccountState, mockRestClients, mockOB, metaMap)

  const scenarios: Array<{
    label: string
    normalizedPair: string
    buyMarketType: MarketType
    sellMarketType: MarketType
    bothLegsArePerp: boolean
    expectedBuyCurrency: string
    expectedSellCurrency: string
  }> = [
    {
      label: 'linear+linear: both USDT',
      normalizedPair: 'SOL/USDT:USDT',
      buyMarketType: MarketType.LINEAR_PERP,
      sellMarketType: MarketType.LINEAR_PERP,
      bothLegsArePerp: true,
      expectedBuyCurrency: 'USDT',
      expectedSellCurrency: 'USDT',
    },
    {
      label: 'spot-buy + linear-sell: USDT buy, USDT sell',
      normalizedPair: 'SOL/USDT:USDT',  // normalizedPair is the perp form; buy leg is spot
      buyMarketType: MarketType.SPOT,
      sellMarketType: MarketType.LINEAR_PERP,
      bothLegsArePerp: false,
      // SPOT buy → quote of base/quote part = USDT
      expectedBuyCurrency: 'USDT',
      expectedSellCurrency: 'USDT',
    },
    {
      label: 'spot+spot BTC/USDT: USDT buy, BTC sell',
      normalizedPair: 'BTC/USDT',
      buyMarketType: MarketType.SPOT,
      sellMarketType: MarketType.SPOT,
      bothLegsArePerp: false,
      expectedBuyCurrency: 'USDT',
      expectedSellCurrency: 'BTC',
    },
    {
      label: 'inverse+inverse BTC/USD:BTC: BTC buy, BTC sell',
      normalizedPair: 'BTC/USD:BTC',
      buyMarketType: MarketType.INVERSE_PERP,
      sellMarketType: MarketType.INVERSE_PERP,
      bothLegsArePerp: true,
      expectedBuyCurrency: 'BTC',
      expectedSellCurrency: 'BTC',
    },
  ]

  for (const sc of scenarios) {
    balanceCalls.length = 0
    const opp = makeOpportunity({
      normalizedPair: sc.normalizedPair,
      buyMarketType: sc.buyMarketType,
      sellMarketType: sc.sellMarketType,
      bothLegsArePerp: sc.bothLegsArePerp,
    })

    await (executor as any).validateTrade('T001', { opportunity: opp, timestamp: Date.now() })

    const buyCall  = balanceCalls.find(([ex]) => ex === 'binance')
    const sellCall = balanceCalls.find(([ex]) => ex === 'bybit')

    chk(`${sc.label}: buy balance currency`, buyCall?.[1] === sc.expectedBuyCurrency, `got=${buyCall?.[1]} expected=${sc.expectedBuyCurrency}`)
    chk(`${sc.label}: sell balance currency`, sellCall?.[1] === sc.expectedSellCurrency, `got=${sellCall?.[1]} expected=${sc.expectedSellCurrency}`)
  }
}

// ─── Section 3: validateTrade skips position checks for SPOT ─────────────────

async function runSection3(): Promise<void> {
  console.log('\n══ 3. validateTrade: position checks skipped for SPOT legs ══')

  const getPositionCalls: Array<[string, string, string]> = []

  const mockAccountState = {
    getAvailableBalance: () => 999999,
    getActiveOrders:     () => [],
    getPosition: (exchange: string, symbol: string, side: string) => {
      getPositionCalls.push([exchange, symbol, side])
      return null
    },
    getOrder:                    () => null,
    getOrderByClientOrderId:     () => null,
    getOrders:                   () => [],
    getBalances:                 () => [],
    getPositions:                () => [],
    isExchangeStateFresh:        () => true,
  } as unknown as AccountStateManager

  const mockOB = new OrderbookManager()
  const mockRestClients = new Map<string, any>()
  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of ['binance', 'bybit']) {
    metaMap.set(ex, makeMetadataService(ex, [
      mockMarket('SOL/USDT', 'SOLUSDT', { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOLUSDTSWAP', { swap: true, linear: true }),
    ]))
  }

  const executor = new TradeExecutor(mockAccountState, mockRestClients, mockOB, metaMap)

  // Test 1: both SPOT → no getPosition calls
  getPositionCalls.length = 0
  await (executor as any).validateTrade('T002', {
    opportunity: makeOpportunity({
      normalizedPair: 'SOL/USDT',
      buyMarketType: MarketType.SPOT,
      sellMarketType: MarketType.SPOT,
      bothLegsArePerp: false,
    }),
    timestamp: Date.now(),
  })
  chk('spot+spot: no getPosition calls', getPositionCalls.length === 0, `calls=${getPositionCalls.length}`)

  // Test 2: spot buy + linear sell → getPosition only for sell leg (LINEAR)
  getPositionCalls.length = 0
  await (executor as any).validateTrade('T003', {
    opportunity: makeOpportunity({
      normalizedPair: 'SOL/USDT:USDT',
      buyMarketType: MarketType.SPOT,
      sellMarketType: MarketType.LINEAR_PERP,
      bothLegsArePerp: false,
    }),
    timestamp: Date.now(),
  })
  const hasCallForBuyExchange = getPositionCalls.some(([ex]) => ex === 'binance')
  const hasCallForSellExchange = getPositionCalls.some(([ex]) => ex === 'bybit')
  chk('spot-buy+linear-sell: no getPosition for buy (spot) exchange', !hasCallForBuyExchange, `calls=${JSON.stringify(getPositionCalls)}`)
  chk('spot-buy+linear-sell: getPosition called for sell (perp) exchange', hasCallForSellExchange)

  // Test 3: linear+linear → getPosition called for both
  getPositionCalls.length = 0
  await (executor as any).validateTrade('T004', {
    opportunity: makeOpportunity({
      normalizedPair: 'SOL/USDT:USDT',
      buyMarketType: MarketType.LINEAR_PERP,
      sellMarketType: MarketType.LINEAR_PERP,
      bothLegsArePerp: true,
    }),
    timestamp: Date.now(),
  })
  chk('linear+linear: getPosition called for both exchanges', getPositionCalls.length >= 2, `calls=${getPositionCalls.length}`)
}

// ─── Section 4: rollbackFailedTrade: correct reduceOnly per market type ───────

async function runSection4(): Promise<void> {
  console.log('\n══ 4. rollbackFailedTrade: reduceOnly per market type ══')

  const createOrderCalls: Array<{ exchange: string; symbol: string; side: string; reduceOnly: boolean | undefined }> = []

  function makeRestClient(exchangeName: string): any {
    return {
      createOrder: async (symbol: string, _type: string, side: string, _amt: number, _price: number | undefined, reduceOnly?: boolean) => {
        createOrderCalls.push({ exchange: exchangeName, symbol, side, reduceOnly })
        return { id: `order-${Date.now()}` }
      },
      cancelOrder: async () => ({ id: 'cancel' }),
    }
  }

  // Mock account state: both legs show as FILLED
  const mockAccountState = {
    getAvailableBalance: () => 999999,
    getActiveOrders:     () => [],
    getPosition:         () => null,
    getOrder:            (_ex: string, orderId: string): any => ({
      id: orderId, clientOrderId: orderId, exchange: _ex, symbol: 'SOLUSDT',
      orderSide: 'BUY', positionSide: 'LONG', type: 'MARKET', price: 100, averagePrice: 100,
      quantity: 2, status: 'FILLED', timestamp: Date.now(), date: new Date(),
    }),
    getOrderByClientOrderId: (exchange: string, clientOrderId: string): any => {
      if (clientOrderId.endsWith('BUY'))  return { id: 'o-buy',  clientOrderId, status: 'FILLED', symbol: 'SOLUSDT', exchange }
      if (clientOrderId.endsWith('SELL')) return { id: 'o-sell', clientOrderId, status: 'FILLED', symbol: 'SOLUSDT', exchange }
      return null
    },
    getOrders:    () => [],
    getBalances:  () => [],
    getPositions: () => [],
  } as unknown as AccountStateManager

  const mockOB = {
    getTopOfBook: () => ({ bestBid: { price: 100 }, bestAsk: { price: 101 } }),
    getOrderbook: () => null,
    on: () => {},
  } as unknown as OrderbookManager

  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of ['binance', 'bybit', 'okx']) {
    metaMap.set(ex, makeMetadataService(ex, [
      mockMarket('SOL/USDT', 'SOLUSDT', { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true }),
      mockMarket('SOL/USD:SOL', 'SOLUSD', { swap: true, inverse: true }),
    ]))
  }

  const scenarios: Array<{
    label: string
    buyMarketType: MarketType
    sellMarketType: MarketType
    expectedBuyReduceOnly: boolean
    expectedSellReduceOnly: boolean
  }> = [
    { label: 'linear+linear', buyMarketType: MarketType.LINEAR_PERP, sellMarketType: MarketType.LINEAR_PERP, expectedBuyReduceOnly: true,  expectedSellReduceOnly: true },
    { label: 'spot+spot',     buyMarketType: MarketType.SPOT,         sellMarketType: MarketType.SPOT,         expectedBuyReduceOnly: false, expectedSellReduceOnly: false },
    { label: 'spot+linear',   buyMarketType: MarketType.SPOT,         sellMarketType: MarketType.LINEAR_PERP,  expectedBuyReduceOnly: false, expectedSellReduceOnly: true },
    { label: 'linear+spot',   buyMarketType: MarketType.LINEAR_PERP,  sellMarketType: MarketType.SPOT,         expectedBuyReduceOnly: true,  expectedSellReduceOnly: false },
    { label: 'inverse+inverse', buyMarketType: MarketType.INVERSE_PERP, sellMarketType: MarketType.INVERSE_PERP, expectedBuyReduceOnly: true, expectedSellReduceOnly: true },
  ]

  for (const sc of scenarios) {
    createOrderCalls.length = 0

    const restClients = new Map<string, any>([
      ['binance', makeRestClient('binance')],
      ['bybit',   makeRestClient('bybit')],
    ])

    const executor = new TradeExecutor(mockAccountState, restClients, mockOB, metaMap)

    const opp = makeOpportunity({
      buyMarketType: sc.buyMarketType,
      sellMarketType: sc.sellMarketType,
      bothLegsArePerp: sc.buyMarketType !== MarketType.SPOT && sc.sellMarketType !== MarketType.SPOT,
    })

    await (executor as any).rollbackFailedTrade('T005', { opportunity: opp, timestamp: Date.now() }, restClients.get('binance'), restClients.get('bybit'))

    const buyClose  = createOrderCalls.find(c => c.exchange === 'binance' && c.side.toLowerCase() === 'sell')
    const sellClose = createOrderCalls.find(c => c.exchange === 'bybit'   && c.side.toLowerCase() === 'buy')

    chk(`${sc.label}: buy-close reduceOnly=${sc.expectedBuyReduceOnly}`,  buyClose?.reduceOnly  === sc.expectedBuyReduceOnly,  `got=${buyClose?.reduceOnly}`)
    chk(`${sc.label}: sell-close reduceOnly=${sc.expectedSellReduceOnly}`, sellClose?.reduceOnly === sc.expectedSellReduceOnly, `got=${sellClose?.reduceOnly}`)
  }
}

// ─── Section 5: TradeMonitor — spot trades bypass funding data guard ──────────

function runSection5(): Promise<void> {
  return new Promise(resolveSection5 => {
  console.log('\n══ 5. TradeMonitor: spot trades bypass funding data requirement ══')

  const orderbookMgr = new OrderbookManager()

  // FundingService that has no data for any symbol
  const noFundingService = {
    getSymbolFundingData: () => undefined,
    generateFundingEvents: () => [],
    isFundingSynchronizedExit: () => true,
    findNextSyncTimestamp: () => 0,
    calculateCumulativeFundingRate: () => 0,
  } as any

  const mockAccountState = {
    getAvailableBalance: () => 999999,
    getActiveOrders: () => [],
    getPosition: () => null,
    getOrder: () => null,
    getOrderByClientOrderId: () => null,
    getOrders: () => [],
    getBalances: () => [],
    getPositions: () => [],
  } as unknown as AccountStateManager

  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of ['binance', 'bybit']) {
    metaMap.set(ex, makeMetadataService(ex, [
      mockMarket('SOL/USDT', 'SOLUSDT', { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true }),
    ]))
  }

  const monitorConfig = {
    maxHoldTimeMs: 86400000,
    checkIntervalMs: 1000,
    exitMinPersistenceMs: 0,
    exitMinConsecutiveSnapshots: 0,
    exitCandidateCleanupMs: 60000,
    strategy: {
      funding: {
        enabled: false,
        exitWindowStart: 300, exitWindowEnd: 5,
        exitWindowStartTakeProfitStopLoss: 30, exitWindowEndTakeProfitStopLoss: 5,
        minFundingProfitPercent: 0.1, minFundingProfitAsyncSyncExitPercent: 0.05,
        takeProfitTargetPercent: 0.5,
        convergenceThresholdPercent: 0.02,
        spreadWideningThresholdPercent: 0.5,
      },
      spread: {
        enabled: true,
        exitWindowStart: 0, exitWindowEnd: 0,
        takeProfitTargetPercent: -999,
        convergenceThresholdPercent: -999,
        spreadWideningThresholdPercent: 999,
      },
    },
  }

  const mockState = {
    saveTrackedTrade: () => Promise.resolve(),
    updateTrackedTrade: () => Promise.resolve(),
    isRedisConnected: () => false,
  } as any

  const monitor = new TradeMonitor(mockAccountState, new Map(), orderbookMgr, metaMap, noFundingService, monitorConfig, mockState)

  // Track whether processTradeExitConditions was called past the funding guard
  let processedPastFundingGuard = false
  const origSimulate = (monitor as any).simulateExitSlippage.bind(monitor)
  ;(monitor as any).simulateExitSlippage = (trade: any) => {
    processedPastFundingGuard = true
    return origSimulate(trade)  // will return null (no orderbook), that's fine
  }

  // Add a spot+spot trade
  const buyOrder = { id: 'o1', clientOrderId: 'T001BUY', exchange: 'binance', symbol: 'SOL/USDT', orderSide: 'BUY', positionSide: 'LONG', type: 'MARKET', price: 100, averagePrice: 100, quantity: 2, status: 'FILLED', timestamp: Date.now() - 5000, date: new Date(), marketType: MarketType.SPOT } as any
  const sellOrder = { id: 'o2', clientOrderId: 'T001SELL', exchange: 'bybit', symbol: 'SOL/USDT', orderSide: 'SELL', positionSide: 'SHORT', type: 'MARKET', price: 103, averagePrice: 103, quantity: 2, status: 'FILLED', timestamp: Date.now() - 5000, date: new Date(), marketType: MarketType.SPOT } as any

  const spotOpp = makeOpportunity({
    normalizedPair: 'SOL/USDT',
    buyMarketType: MarketType.SPOT,
    sellMarketType: MarketType.SPOT,
    bothLegsArePerp: false,
    buyExchangeSymbol: 'SOL/USDT',
    sellExchangeSymbol: 'SOL/USDT',
    fundingProfitUsd: 0, fundingProfitPercent: 0,
    buyExchangeNextFundingTimestamp: 0,
    sellExchangeNextFundingTimestamp: 0,
    targetFundingTimestamp: 0,
    strategy: 'spread',
    strategyVariant: 'spread',
  })

  monitor.addTrade(spotOpp, { id: 'T001', success: true, latencyMs: 10, buyOrder, sellOrder, feesUsd: 0.1, feesPercent: 0.05, slippageUsd: 0.05, slippagePercent: 0.025 })

  monitor.start()

  // topOfBookUpdate fires only on price change vs previous state.
  // Seed initial state (no emit), then send a second update with different price (emits).
  orderbookMgr.updateOrderbook({
    type: 'snapshot', exchange: 'binance', symbol: 'SOL/USDT', marketType: MarketType.SPOT,
    bids: [{ price: 100, quantity: 100, amount: 10000 }],
    asks: [{ price: 101, quantity: 100, amount: 10100 }],
    timestamp: Date.now(), finalUpdateId: 1, traceId: 'test',
  })
  // Also seed bybit so getCurrentOrderbookPrices works for exit (in case exit is triggered)
  orderbookMgr.updateOrderbook({
    type: 'snapshot', exchange: 'bybit', symbol: 'SOL/USDT', marketType: MarketType.SPOT,
    bids: [{ price: 102, quantity: 100, amount: 10200 }],
    asks: [{ price: 103, quantity: 100, amount: 10300 }],
    timestamp: Date.now(), finalUpdateId: 1, traceId: 'test',
  })
  // Price change → topOfBookUpdate fires
  orderbookMgr.updateOrderbook({
    type: 'snapshot', exchange: 'binance', symbol: 'SOL/USDT', marketType: MarketType.SPOT,
    bids: [{ price: 101, quantity: 100, amount: 10100 }],
    asks: [{ price: 102, quantity: 100, amount: 10200 }],
    timestamp: Date.now(), finalUpdateId: 2, traceId: 'test',
  })

  // Give async handlers time to run
  setTimeout(() => {
    chk('spot trade: processTradeExitConditions reached past funding guard', processedPastFundingGuard)
    monitor.stop()
    resolveSection5()
  }, 500)
  }) // end Promise
}

// ─── Section 6: executeExitTrade — correct reduceOnly per leg ─────────────────

async function runSection6(): Promise<void> {
  console.log('\n══ 6. executeExitTrade: reduceOnly per leg market type ══')

  // getOrder returns FILLED immediately so monitorOrderConfirmation doesn't timeout
  const mockAccountState = {
    getAvailableBalance: () => 999999,
    getActiveOrders: () => [],
    getPosition: () => null,
    getOrder: (_exchange: string, orderId: string): any => ({
      id: orderId, clientOrderId: orderId, exchange: _exchange, symbol: 'SOL/USDT:USDT',
      orderSide: 'BUY', positionSide: 'LONG', type: 'MARKET', price: 100, averagePrice: 100,
      quantity: 2, status: 'FILLED', timestamp: Date.now(), date: new Date(),
    }),
    getOrderByClientOrderId: () => null,
    getOrders: () => [],
    getBalances: () => [],
    getPositions: () => [],
  } as unknown as AccountStateManager

  const orderbookMgr = new OrderbookManager()

  const metaMap = new Map<string, MarketMetadataService>()
  for (const ex of ['binance', 'bybit']) {
    metaMap.set(ex, makeMetadataService(ex, [
      mockMarket('SOL/USDT', 'SOLUSDT', { spot: true }),
      mockMarket('SOL/USDT:USDT', 'SOLUSDT', { swap: true, linear: true }),
    ]))
  }

  const monitorConfig = {
    maxHoldTimeMs: 86400000, checkIntervalMs: 1000,
    exitMinPersistenceMs: 0, exitMinConsecutiveSnapshots: 0, exitCandidateCleanupMs: 60000,
    strategy: {
      funding: { enabled: false, exitWindowStart: 300, exitWindowEnd: 5, exitWindowStartTakeProfitStopLoss: 30, exitWindowEndTakeProfitStopLoss: 5, minFundingProfitPercent: 0.1, minFundingProfitAsyncSyncExitPercent: 0.05, takeProfitTargetPercent: 0.5, convergenceThresholdPercent: 0.02, spreadWideningThresholdPercent: 0.5 },
      spread: { enabled: true, exitWindowStart: 0, exitWindowEnd: 0, takeProfitTargetPercent: -999, convergenceThresholdPercent: -999, spreadWideningThresholdPercent: 999 },
    },
  }

  const mockState = {
    saveTrackedTrade: () => Promise.resolve(),
    updateTrackedTrade: () => Promise.resolve(),
    isRedisConnected: () => false,
  } as any

  const noFundingService = {
    getSymbolFundingData: () => undefined,
    generateFundingEvents: () => [],
    isFundingSynchronizedExit: () => true,
  } as any

  const scenarios: Array<{
    label: string
    buyMarketType: MarketType
    sellMarketType: MarketType
    normalizedPair: string
    buyExchangeSymbol: string
    sellExchangeSymbol: string
    expectedBuyReduceOnly: boolean
    expectedSellReduceOnly: boolean
  }> = [
    { label: 'linear+linear', buyMarketType: MarketType.LINEAR_PERP, sellMarketType: MarketType.LINEAR_PERP, normalizedPair: 'SOL/USDT:USDT', buyExchangeSymbol: 'SOL/USDT:USDT', sellExchangeSymbol: 'SOL/USDT:USDT', expectedBuyReduceOnly: true,  expectedSellReduceOnly: true },
    { label: 'spot+spot',     buyMarketType: MarketType.SPOT,         sellMarketType: MarketType.SPOT,         normalizedPair: 'SOL/USDT',      buyExchangeSymbol: 'SOL/USDT',      sellExchangeSymbol: 'SOL/USDT',      expectedBuyReduceOnly: false, expectedSellReduceOnly: false },
    { label: 'spot+linear',   buyMarketType: MarketType.SPOT,         sellMarketType: MarketType.LINEAR_PERP,  normalizedPair: 'SOL/USDT:USDT', buyExchangeSymbol: 'SOL/USDT',      sellExchangeSymbol: 'SOL/USDT:USDT', expectedBuyReduceOnly: false, expectedSellReduceOnly: true },
    { label: 'linear+spot',   buyMarketType: MarketType.LINEAR_PERP,  sellMarketType: MarketType.SPOT,         normalizedPair: 'SOL/USDT:USDT', buyExchangeSymbol: 'SOL/USDT:USDT', sellExchangeSymbol: 'SOL/USDT',      expectedBuyReduceOnly: true,  expectedSellReduceOnly: false },
  ]

  for (const sc of scenarios) {
    // Per-scenario order call capture — fresh array each iteration
    const createOrderCalls: Array<{ exchange: string; side: string; reduceOnly: boolean | undefined }> = []

    function makeExitClient(exchangeName: string): any {
      return {
        createOrder: async (_sym: string, _type: string, side: string, _amt: number, _price?: number, reduceOnly?: boolean, _clientOrderId?: string) => {
          createOrderCalls.push({ exchange: exchangeName, side, reduceOnly })
          return { id: `exit-order-${Date.now()}` }
        },
      }
    }

    const restClients = new Map<string, any>([
      ['binance', makeExitClient('binance')],
      ['bybit',   makeExitClient('bybit')],
    ])

    const monitor = new TradeMonitor(mockAccountState, restClients, orderbookMgr, metaMap, noFundingService, monitorConfig, mockState)

    // Pre-populate orderbooks so getCurrentOrderbookPrices works
    orderbookMgr.updateOrderbook({
      type: 'snapshot', exchange: 'binance', symbol: sc.buyExchangeSymbol, marketType: sc.buyMarketType,
      bids: [{ price: 100, quantity: 100, amount: 10000 }],
      asks: [{ price: 101, quantity: 100, amount: 10100 }],
      timestamp: Date.now(), finalUpdateId: 1, traceId: 'test',
    })
    orderbookMgr.updateOrderbook({
      type: 'snapshot', exchange: 'bybit', symbol: sc.sellExchangeSymbol, marketType: sc.sellMarketType,
      bids: [{ price: 103, quantity: 100, amount: 10300 }],
      asks: [{ price: 104, quantity: 100, amount: 10400 }],
      timestamp: Date.now(), finalUpdateId: 1, traceId: 'test',
    })

    const buyOrder: any = { id: `o-buy-${sc.label}`, clientOrderId: `T-${sc.label}BUY`, exchange: 'binance', symbol: sc.buyExchangeSymbol, orderSide: 'BUY', positionSide: 'LONG', type: 'MARKET', price: 100, averagePrice: 100, quantity: 2, status: 'FILLED', timestamp: Date.now() - 1000, date: new Date(), marketType: sc.buyMarketType }
    const sellOrder: any = { id: `o-sell-${sc.label}`, clientOrderId: `T-${sc.label}SELL`, exchange: 'bybit', symbol: sc.sellExchangeSymbol, orderSide: 'SELL', positionSide: 'SHORT', type: 'MARKET', price: 103, averagePrice: 103, quantity: 2, status: 'FILLED', timestamp: Date.now() - 1000, date: new Date(), marketType: sc.sellMarketType }

    const opp = makeOpportunity({
      normalizedPair: sc.normalizedPair,
      buyMarketType: sc.buyMarketType,
      sellMarketType: sc.sellMarketType,
      buyExchangeSymbol: sc.buyExchangeSymbol,
      sellExchangeSymbol: sc.sellExchangeSymbol,
      bothLegsArePerp: sc.buyMarketType !== MarketType.SPOT && sc.sellMarketType !== MarketType.SPOT,
      fundingProfitUsd: 0, fundingProfitPercent: 0,
      buyExchangeNextFundingTimestamp: 0,
      sellExchangeNextFundingTimestamp: 0,
      targetFundingTimestamp: 0,
      strategy: 'spread',
      strategyVariant: 'spread',
    })

    const tradeId = `T-exit-${sc.label}`
    const trackedTrade: any = {
      id: tradeId,
      status: 'open',
      strategy: 'spread',
      strategyVariant: 'spread',
      entryDate: new Date().toISOString(),
      entryTimestamp: Date.now() - 1000,
      opportunity: opp,
      entryTrade: { id: tradeId, success: true, latencyMs: 10, buyOrder, sellOrder, feesUsd: 0.1, feesPercent: 0.05, slippageUsd: 0.05, slippagePercent: 0.025 },
      lastUpdateTimestamp: Date.now(),
      fundingEvents: [],
      feesUsd: { entry: 0.1, exit: 0, total: 0.1 },
      slippageUsd: { entry: 0.05, exit: 0, total: 0.05 },
      fundingUsd: { buyExchange: 0, sellExchange: 0, net: 0 },
      deltaUsd: { buyExchange: 0, sellExchange: 0, net: 0 },
      feesPercent: { entry: 0.05, exit: 0, total: 0.05 },
      slippagePercent: { entry: 0.025, exit: 0, total: 0.025 },
      fundingPercent: { buyExchange: 0, sellExchange: 0, net: 0 },
      deltaPercent: { buyExchange: 0, sellExchange: 0, net: 0 },
      deltaProfitUsd: 0, fundingProfitUsd: 0, pnlUsd: 0,
      deltaProfitPercent: 0, fundingProfitPercent: 0, pnlPercent: 0,
    }

    try {
      await (monitor as any).executeExitTrade(trackedTrade, {
        avgBuyExecutionPrice: 100, avgSellExecutionPrice: 103,
        avgBuyNormalizedExecutionPrice: 100, avgSellNormalizedExecutionPrice: 103,
        buySlippagePercent: 0, sellSlippagePercent: 0, totalSlippagePercent: 0,
      }, 'manual', 'binance', Date.now())
    } catch (err: any) {
      chk(`${sc.label}: exit trade no error`, false, err.message)
      continue
    }

    const buySide  = createOrderCalls.find(c => c.exchange === 'binance' && c.side.toLowerCase() === 'sell')
    const sellSide = createOrderCalls.find(c => c.exchange === 'bybit'   && c.side.toLowerCase() === 'buy')

    chk(`${sc.label}: exit buy-leg reduceOnly=${sc.expectedBuyReduceOnly}`,  buySide?.reduceOnly  === sc.expectedBuyReduceOnly,  `got=${buySide?.reduceOnly}`)
    chk(`${sc.label}: exit sell-leg reduceOnly=${sc.expectedSellReduceOnly}`, sellSide?.reduceOnly === sc.expectedSellReduceOnly, `got=${sellSide?.reduceOnly}`)
  }
}

function printSummary(): void {
  console.log('\n══ Summary ══')
  console.log(`Total: ${totalPass}/${totalPass + totalFail} passed  ${totalFail > 0 ? `(${totalFail} FAILED)` : '✓ all green'}`)
  process.exit(totalFail > 0 ? 1 : 0)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

;(async () => {
  runSection1()
  await runSection2()
  await runSection3()
  await runSection4()
  await runSection5()
  await runSection6()
  printSummary()
})()
