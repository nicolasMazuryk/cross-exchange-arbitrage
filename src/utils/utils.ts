import { MarketType, PositionSide, OrderSide } from '../types/exchange'
import appConfig from './config'

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const STABLECOIN_QUOTES = new Set([
  'USD',    // US Dollar
  // Tier 1 – Dominant (>$1B market cap)
  'USDT',   // Tether (~$183B)
  'USDC',   // USD Coin (~$75B)
  'USDe',   // Ethena USDe (~$6B)
  'DAI',    // Dai (~$5.4B)
  'USD1',   // World Liberty Financial USD (~$4.7B)
  'PYUSD',  // PayPal USD (~$4.2B)
  'USDG',   // Global Dollar (~$1.76B)
  'RLUSD',  // Ripple USD (~$1.5B)
  'USDD',   // USDD (~$1.1B)

  // Tier 2 – Notable (<$1B)
  'U',      // United Stables
  'TUSD',   // TrueUSD
  'FDUSD',  // First Digital USD
  'USDf',   // Falcon USD
  'USDY',   // Ondo US Dollar Yield
  'USD0',   // Usual USD
  'GHO',    // GHO (Aave)
  'USDAI',  // USDai
  'FRAX',   // Legacy Frax Dollar
  'AUSD',   // Agora USD
  'GUSD',   // Gemini Dollar
  'FRXUSD', // Frax USD
  'DUSD',   // StandX DUSD
  'USDH',   // Hyperliquid USD
  'FIDD',   // Fidelity Digital Dollar
  'USDP',   // Pax Dollar
  'BUSD',   // Binance USD (deprecated)
  'CUSD',   // Celo Dollar
  'LUSD',   // Liquity USD
  'USDCV',  // USD CoinVertible
  'USDB',   // USDB
  'mUSD',   // MetaMask USD
  'USAT',   // Tether USAT
  'USDM',   // USDM
  'WUSD',   // Worldwide USD
  'USDQ',   // Quantoz USDQ
  'OUSD',   // Origin Dollar
  'USDR',   // StablR USD
  'USDL',   // Lift Dollar
  'USDV',   // Verified USD
  'XUSD',   // StraitsX XUSD
  'YUSD',   // Aegis YUSD
  'FEI',    // Fei USD
  'DJED',   // Djed
  'VAI',    // Vai
  'USDN',   // SMARDEX USDN
  'lisUSD', // lisUSD
  'MNEE',   // MNEE
])
export const isStablecoin = (q: string): boolean => STABLECOIN_QUOTES.has(q.toUpperCase())
export const quotesAreCompatible = (a: string, b: string): boolean => {
  const A = a.toUpperCase(), B = b.toUpperCase()
  return A === B || (isStablecoin(A) && isStablecoin(B))
}

export const quoteCurrenciesFor = (exchangeName: string): string[] => {
  const cfg = appConfig.exchanges[exchangeName as keyof typeof appConfig.exchanges]
  const enabled = cfg?.enabledQuoteCurrencies
  const disabled = new Set((cfg?.disabledQuoteCurrencies || []).map(q => q.toUpperCase()))
  const base = enabled && enabled.length > 0 ? enabled : [...STABLECOIN_QUOTES]
  return base.filter(q => !disabled.has(q.toUpperCase()))
}

export const convertExchangeSymbolToUnifiedSymbol = (
  exchangeSymbol: string,
  marketType: MarketType,
  quoteCurrency: string
): string => {
  // Handle OKX specific format: "BTC-USDT-SWAP" or "BTC-USD-SWAP"
  if (exchangeSymbol.includes('-SWAP')) {
    const parts = exchangeSymbol.split('-')
    const base = parts[0]
    const quote = parts[1]
    if (marketType === MarketType.INVERSE_PERP) return `${base}/${quote}:${base}`
    return `${base}/${quote}:${quote}`
  }

  // Handle standard format
  const base = exchangeSymbol.replace(quoteCurrency, '')
  if (marketType === MarketType.SPOT) return `${base}/${quoteCurrency}`
  if (marketType === MarketType.INVERSE_PERP) return `${base}/${quoteCurrency}:${base}`
  return `${base}/${quoteCurrency}:${quoteCurrency}`
}

export const convertUnifiedSymbolToExchangeSymbol = (unifiedSymbol: string): string =>
  unifiedSymbol.split(':')[0].replace('/', '')

export const getMarketTypeFromUnifiedSymbol = (unifiedSymbol: string): MarketType => {
  const colonIdx = unifiedSymbol.indexOf(':')
  if (colonIdx === -1) return MarketType.SPOT
  const settle = unifiedSymbol.slice(colonIdx + 1)
  const slashIdx = unifiedSymbol.indexOf('/')
  const base = unifiedSymbol.slice(0, slashIdx)
  return settle === base ? MarketType.INVERSE_PERP : MarketType.LINEAR_PERP
}

export const marketTypeFromCcxtMarket = (market: {
  spot?: boolean
  swap?: boolean
  linear?: boolean
  inverse?: boolean
}): MarketType => {
  if (market.spot) return MarketType.SPOT
  if (market.swap && market.inverse) return MarketType.INVERSE_PERP
  if (market.swap && market.linear) return MarketType.LINEAR_PERP
  throw new Error(`unable to determine MarketType from ccxt market: ${JSON.stringify(market)}`)
}

export const positionId = (symbol: string, side: PositionSide): string => {
  return `${symbol}-${side.toUpperCase()}`
}

export const getOrderSide = (posSide: string, tradeSide: string): OrderSide => {
  return (tradeSide.toUpperCase() === 'OPEN') === (posSide.toUpperCase() === 'LONG') ? 'BUY' : 'SELL'
}

export const getPositionSide = (orderSide: OrderSide, reduceOnly: boolean): PositionSide => {
  if (orderSide === 'BUY') return reduceOnly ? ('SHORT' as PositionSide) : ('LONG' as PositionSide)
  if (orderSide === 'SELL') return reduceOnly ? ('LONG' as PositionSide) : ('SHORT' as PositionSide)
  throw new Error(`Can't get position side for orderSide: ${orderSide} and reduceOnly: ${reduceOnly}`)
}

/**
 * Normalize timestamp to beginning of hour if it funding event occurs within the first minute of the hour
 * This handles cases where funding events occur with a delay of a few seconds
 */
export const normalizeFundingTimestamp = (timestamp: number): { normalizedTimestamp: number; actualTimestamp: number } => {
  const actualTimestamp = timestamp
  const date = new Date(timestamp)
  const minutes = date.getMinutes()

  // If timestamp is within the first minute (minutes === 0), normalize to beginning of hour
  if (minutes === 0) {
    // Set to beginning of the hour
    date.setMinutes(0)
    date.setSeconds(0)
    date.setMilliseconds(0)
    const normalizedTimestamp = date.getTime()
    return { normalizedTimestamp, actualTimestamp }
  }

  // Otherwise, keep the original timestamp
  return { normalizedTimestamp: timestamp, actualTimestamp: timestamp }
}
