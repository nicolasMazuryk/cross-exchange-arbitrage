import { MarketType, PositionSide, OrderSide } from '../types/exchange'

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const convertExchangeSymbolToUnifiedSymbol = (
  exchangeSymbol: string,
  marketType: MarketType,
  quoteCurrency: string = 'USDT'
): string => {
  // Handle OKX specific format: "BTC-USDT-SWAP" -> "BTC/USDT:USDT"
  if (exchangeSymbol.includes('-SWAP')) {
    const [base, quote] = exchangeSymbol.split('-')
    return `${base}/${quote}:${quote}`
  }

  // Handle standard format
  const base = exchangeSymbol.replace(quoteCurrency, '')
  return marketType === MarketType.SPOT ? `${base}/${quoteCurrency}` : `${base}/${quoteCurrency}:${quoteCurrency}`
}

export const convertUnifiedSymbolToExchangeSymbol = (unifiedSymbol: string): string =>
  unifiedSymbol.split(':')[0].replace('/', '')

export const getMarketTypeFromUnifiedSymbol = (unifiedSymbol: string): MarketType =>
  unifiedSymbol.includes(':') ? MarketType.FUTURES : MarketType.SPOT

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
