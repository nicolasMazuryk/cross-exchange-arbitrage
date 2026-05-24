import * as ccxt from 'ccxt'
import { MarketType } from '../../types/exchange'
import { marketTypeFromCcxtMarket } from '../../utils/utils'
import { Logger } from '../../utils/logger'

const logger = new Logger('market-metadata-service')

export interface MarketMetadata {
  symbol: string // Unified CCXT symbol (e.g., BTC/USDT:USDT)
  normalizedSymbol: string // Cross-exchange normalized symbol (e.g., PEPEUSDT)
  marketType: MarketType
  contractSize: number
  pricePrecision: number
  amountPrecision: number
  minPrice?: number
  maxPrice?: number
  minAmount?: number
  maxAmount?: number
  minCost?: number
  base: string   // Base asset (e.g., BTC)
  quote: string  // Quote asset (e.g., USDT, USDC)
  settle: string // Settle asset (e.g., USDT for linear, BTC for inverse)
  nativeId: string // Exchange-native symbol id (= ccxt market.id, e.g., BTCUSDT, BTC-USDT-SWAP)
}

export class MarketMetadataService {
  private exchangeId: string
  private markets: Map<string, MarketMetadata> = new Map()
  private symbolMappings: Map<string, string> = new Map()
  private baseQuoteMarkets: Map<string, Array<{ marketType: MarketType; symbol: string }>> = new Map()
  // Keys: `${marketType}:${market.id}` — always qualified to avoid spot/perp collision
  private nativeIdToUnified: Map<string, string> = new Map()
  private ignoredMarkets: string[]
  private enabledMarketTypes?: string[]
  private enabledQuoteCurrencies?: string[]

  constructor(
    exchangeId: string,
    markets: ccxt.Market[],
    ignoredMarkets: string[] = [],
    enabledMarketTypes?: string[],
    enabledQuoteCurrencies?: string[]
  ) {
    this.exchangeId = exchangeId
    this.ignoredMarkets = ignoredMarkets
    this.enabledMarketTypes = enabledMarketTypes
    this.enabledQuoteCurrencies = enabledQuoteCurrencies
    this.initializeMarkets(markets)
  }

  private initializeMarkets(markets: ccxt.Market[]): void {
    for (const market of markets) {
      if (!market) continue
      if (!this.isTradableMarket(market)) continue
      if (this.ignoredMarkets.includes(market.symbol)) continue

      const mt = marketTypeFromCcxtMarket(market)

      if (this.enabledMarketTypes?.length && !this.enabledMarketTypes.includes(mt)) continue
      if (this.enabledQuoteCurrencies?.length && !this.enabledQuoteCurrencies.includes(market.quote)) continue

      const normalizedSymbol = this.normalizeSymbol(market.symbol)
      const metadata: MarketMetadata = {
        symbol: market.symbol,
        normalizedSymbol,
        marketType: mt,
        contractSize: market.contractSize || 1,
        pricePrecision: market.precision?.price || 8,
        amountPrecision: market.precision?.amount || 8,
        minPrice: market.limits?.price?.min,
        maxPrice: market.limits?.price?.max,
        minAmount: market.limits?.amount?.min,
        maxAmount: market.limits?.amount?.max,
        minCost: market.limits?.cost?.min,
        base: market.base || '',
        quote: market.quote || '',
        settle: market.settle || market.quote || '',
        nativeId: market.id || '',
      }

      this.markets.set(market.symbol, metadata)
      this.symbolMappings.set(normalizedSymbol, market.symbol)

      // Build native-id reverse lookup
      if (market.id) {
        this.nativeIdToUnified.set(`${mt}:${market.id}`, market.symbol)
      }

      const bq = this.normalizeBaseQuote(market.symbol)
      if (!this.baseQuoteMarkets.has(bq)) this.baseQuoteMarkets.set(bq, [])
      this.baseQuoteMarkets.get(bq)!.push({ marketType: mt, symbol: market.symbol })
    }
  }

  private isTradableMarket(market: ccxt.Market): boolean {
    if (!market) return false
    if (market.option) return false
    if (market.future && !market.swap) return false
    if (!market.active) return false
    if (market.spot) return true
    if (market.swap && (market.linear || market.inverse)) return true
    return false
  }

  /**
   * Get metadata for a specific symbol
   */
  getMetadata(symbol: string): MarketMetadata | undefined {
    return this.markets.get(symbol)
  }

  getSymbolMappings(): Map<string, string> {
    return this.symbolMappings
  }

  /**
   * Look up metadata by native exchange id (= ccxt market.id, e.g., BTCUSDT, BTC-USDT-SWAP).
   * Pass marketType to disambiguate exchanges that reuse the same id across spot and perps.
   */
  getMetadataByNativeId(nativeId: string, marketType: MarketType): MarketMetadata | undefined {
    const unified = this.nativeIdToUnified.get(`${marketType}:${nativeId}`)
    return unified ? this.markets.get(unified) : undefined
  }

  /**
   * Return the quote currency for a unified symbol (e.g., 'USDT' for 'BTC/USDT:USDT').
   */
  getQuoteFor(symbol: string): string | undefined {
    return this.markets.get(symbol)?.quote
  }

  /**
   * Normalize symbol names across exchanges
   * Handles variations like 1000PEPE/USDT → PEPE/USDT, 1000000BABYDOGE/USDT:USDT → BABYDOGE/USDT:USDT
   * Supports any numeric prefix and any quote asset after the slash
   */
  normalizeSymbol(displaySymbol: string): string {
    if (displaySymbol.startsWith('1000') || displaySymbol.startsWith('1000000')) {
      // Remove common prefixes that indicate contract size
      const normalized = displaySymbol
        .replace(/^(\d+)([A-Z]+)\/([A-Z]+:[A-Z]+)$/, (match, p1, p2, p3) => p2 + '/' + p3) // 1000000BABYDOGE/USDT:USDT → BABYDOGE/USDT:USDT
        .replace(/^(\d+)([A-Z]+)\/([A-Z]+)$/, (match, p1, p2, p3) => p2 + '/' + p3) // 1000PEPE/USDT → PEPE/USDT
        .replace(/^(\d+)([A-Z]+)([A-Z]+)$/, (match, p1, p2, p3) => p2 + p3) // 1000PEPEUSDT → PEPEUSDT (fallback)
      return normalized
    }

    return displaySymbol
  }

  /**
   * Get exchange-specific symbol from normalized symbol
   */
  denormalizeSymbol(normalizedSymbol: string): string | undefined {
    return this.symbolMappings.get(normalizedSymbol)
  }

  /**
   * Strip settle suffix and 1000-prefix to get a cross-market-type base/quote key.
   * BTC/USDT:USDT → BTC/USDT, 1000PEPE/USDT:USDT → PEPE/USDT, BTC/USD:BTC → BTC/USD
   */
  normalizeBaseQuote(symbol: string): string {
    const colonIdx = symbol.indexOf(':')
    const baseQuotePart = colonIdx >= 0 ? symbol.slice(0, colonIdx) : symbol
    return this.normalizeSymbol(baseQuotePart)
  }

  /**
   * Return all (marketType, symbol) pairs registered for a given base/quote key.
   */
  getMarketsForBaseQuote(baseQuote: string): Array<{ marketType: MarketType; symbol: string }> {
    return this.baseQuoteMarkets.get(baseQuote) || []
  }

  /**
   * Extract price scale multiplier from symbol name
   * Examples: 1000PEPE/USDT → 1000, 1000000BABYDOGE/USDT → 1000000, PEPE/USDT → 1
   */
  getPriceScale(symbol: string): number {
    if (symbol.startsWith('1000')) {
      const match = symbol.match(/^(\d+)([A-Z]+)\//)
      if (match) {
        return parseInt(match[1], 10)
      }
    }
    return 1
  }

  /**
   * Normalize price to base scale (remove price scale multiplier)
   * Examples: 0.012825 (1000PEPE) → 0.000012825 (PEPE)
   */
  normalizePrice(price: number, symbol: string): number {
    const priceScale = this.getPriceScale(symbol)
    return price / priceScale
  }

  /**
   * Denormalize price to exchange scale (apply price scale multiplier)
   * Examples: 0.000012825 (PEPE) → 0.012825 (1000PEPE)
   */
  denormalizePrice(normalizedPrice: number, symbol: string): number {
    const priceScale = this.getPriceScale(symbol)
    return normalizedPrice * priceScale
  }

  /**
   * Normalize contract amount to base units considering contract size and precision
   * Converts exchange-specific contract amounts to normalized base asset amounts
   */
  normalizeAmount(contractAmount: number, symbol: string, markPrice?: number): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({
        msg: 'Failed to normalize amount - metadata not found',
        function: 'MarketMetadataService.normalizeAmount',
        exchange: this.exchangeId,
        symbol,
        contractAmount,
        error,
      })
      throw error
    }

    const priceScale = this.getPriceScale(symbol)

    // Inverse perp: contractSize is in USD; base units = (contracts * contractSize) / markPrice
    if (metadata.marketType === MarketType.INVERSE_PERP && markPrice !== undefined && markPrice > 0) {
      return (contractAmount * metadata.contractSize / markPrice) * priceScale
    }

    // Linear / spot: base units = contracts * contractSize
    const baseAssetAmount = contractAmount * metadata.contractSize
    return baseAssetAmount * priceScale
  }

  /**
   * Denormalize base asset amount to exchange-specific contract amount
   * Converts normalized base asset amounts to exchange-specific contract amounts
   */
  denormalizeAmount(normalizedAmount: number, symbol: string, markPrice?: number): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({
        msg: 'Failed to denormalize amount - metadata not found',
        function: 'MarketMetadataService.denormalizeAmount',
        exchange: this.exchangeId,
        symbol,
        normalizedAmount,
        error,
      })
      throw error
    }

    const priceScale = this.getPriceScale(symbol)

    // Inverse perp: contractSize is in USD; contracts = (base * markPrice) / contractSize
    if (metadata.marketType === MarketType.INVERSE_PERP && markPrice !== undefined && markPrice > 0) {
      const scaledBase = normalizedAmount / priceScale
      const contractAmount = (scaledBase * markPrice) / metadata.contractSize
      return this.roundAmount(contractAmount, symbol)
    }

    // Linear / spot: contracts = base / contractSize
    const scaledAmount = normalizedAmount / priceScale
    const contractAmount = scaledAmount / metadata.contractSize
    return this.roundAmount(contractAmount, symbol)
  }

  /**
   * Round amount to valid precision for the exchange
   */
  roundAmount(amount: number, symbol: string): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({
        msg: 'Failed to round amount - metadata not found',
        function: 'MarketMetadataService.roundAmount',
        exchange: this.exchangeId,
        symbol,
        amount,
        error,
      })
      throw error
    }

    const precision = metadata.amountPrecision
    // For step-based precision (e.g., 0.1, 1000), round to the nearest step
    const rounded = Math.round(amount / precision) * precision

    // Count decimals in precision (e.g. 0.001 → 3 decimals)
    const decimals = precision.toString().split('.')[1]?.length || 0

    return Number(rounded.toFixed(decimals))
  }

  /**
   * Get all available symbols for this exchange
   */
  getAvailableSymbols(): string[] {
    return Array.from(this.markets.keys())
  }

  /**
   * Get exchange-specific order parameters from normalized values
   * Useful for placing orders with normalized amounts/prices
   */
  getExchangeOrderParams(
    normalizedAmount: number,
    normalizedPrice: number,
    symbol: string
  ): { amount: number; price: number } {
    return {
      amount: this.denormalizeAmount(normalizedAmount, symbol),
      price: this.denormalizePrice(normalizedPrice, symbol),
    }
  }
}

/**
 * Resolve a native exchange symbol id to a unified CCXT symbol.
 * Tries metadata lookup first; if no match, attempts suffix-based construction
 * using enabledQuotes sorted longest-first to avoid ambiguous short-quote matches.
 * Returns undefined when neither approach succeeds.
 */
export function parseNativeSymbolToUnified(
  nativeId: string,
  marketType: MarketType,
  metadata: MarketMetadataService,
  enabledQuotes: string[]
): string | undefined {
  const meta = metadata.getMetadataByNativeId(nativeId, marketType)
  if (meta) return meta.symbol
  const sortedQuotes = [...enabledQuotes].sort((a, b) => b.length - a.length)
  for (const quote of sortedQuotes) {
    if (nativeId.endsWith(quote)) {
      const base = nativeId.slice(0, -quote.length)
      if (!base) continue
      if (marketType === MarketType.SPOT) return `${base}/${quote}`
      if (marketType === MarketType.INVERSE_PERP) return `${base}/${quote}:${base}`
      return `${base}/${quote}:${quote}`
    }
  }
  return undefined
}
