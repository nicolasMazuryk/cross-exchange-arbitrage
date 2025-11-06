import * as ccxt from 'ccxt'
import { Logger } from '../../utils/logger'

const logger = new Logger('market-metadata-service')

export interface MarketMetadata {
  symbol: string              // Exchange-specific symbol (e.g., 1000PEPEUSDT)
  normalizedSymbol: string    // Cross-exchange normalized symbol (e.g., PEPEUSDT)
  contractSize: number
  pricePrecision: number
  amountPrecision: number
  minPrice?: number
  maxPrice?: number
  minAmount?: number
  maxAmount?: number
  minCost?: number
}

export class MarketMetadataService {
  private exchangeId: string
  private markets: Map<string, MarketMetadata> = new Map()
  private symbolMappings: Map<string, string> = new Map()
  private ignoredMarkets: string[]

  constructor(exchangeId: string, markets: ccxt.Market[], ignoredMarkets: string[] = []) {
    this.exchangeId = exchangeId
    this.ignoredMarkets = ignoredMarkets
    this.initializeMarkets(markets)
  }

  /**
   * Initialize markets metadata from ccxt markets data
   */
  private initializeMarkets(markets: ccxt.Market[]): void {
    for (const market of markets) {
      if (!market) continue
      
      // Only process USDT perpetual futures
      if (!this.isValidFuturesMarket(market)) {
        continue
      }

      // Check if this market is in the ignored list
      if (this.ignoredMarkets.includes(market.symbol)) {
        continue
      }

      const normalizedSymbol = this.normalizeSymbol(market.symbol)
      const metadata: MarketMetadata = {
        symbol: market.symbol,
        normalizedSymbol,
        contractSize: market.contractSize || 1,
        pricePrecision: market.precision?.price || 8,
        amountPrecision: market.precision?.amount || 8,
        minPrice: market.limits?.price?.min,
        maxPrice: market.limits?.price?.max,
        minAmount: market.limits?.amount?.min,
        maxAmount: market.limits?.amount?.max,
        minCost: market.limits?.cost?.min
      }

      this.markets.set(market.symbol, metadata)
      
      this.symbolMappings.set(normalizedSymbol, market.symbol)
    }
  }

  /**
   * Check if market is a valid USDT perpetual futures market
   */
  private isValidFuturesMarket(market: ccxt.Market): boolean {
    if (!market) return false
    
    const isActiveCondition = ['bitget'].includes(this.exchangeId) ? true : market.active
    
    return Boolean(
      isActiveCondition &&
      market.contract &&
      market.swap &&
      market.linear &&
      !market.future &&
      !market.inverse &&
      market.quote === 'USDT'
    )
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
   * Normalize symbol names across exchanges
   * Handles variations like 1000PEPE/USDT → PEPE/USDT, 1000000BABYDOGE/USDT:USDT → BABYDOGE/USDT:USDT
   * Supports any numeric prefix and any quote asset after the slash
   */
  normalizeSymbol(displaySymbol: string): string {
    if (displaySymbol.startsWith('1000') || displaySymbol.startsWith('1000000')) {
      // Remove common prefixes that indicate contract size
    const normalized = displaySymbol
      .replace(/^(\d+)([A-Z]+)\/([A-Z]+:[A-Z]+)$/, (match, p1, p2, p3) => p2 + '/' + p3)  // 1000000BABYDOGE/USDT:USDT → BABYDOGE/USDT:USDT
      .replace(/^(\d+)([A-Z]+)\/([A-Z]+)$/, (match, p1, p2, p3) => p2 + '/' + p3)  // 1000PEPE/USDT → PEPE/USDT
      .replace(/^(\d+)([A-Z]+)([A-Z]+)$/, (match, p1, p2, p3) => p2 + p3)     // 1000PEPEUSDT → PEPEUSDT (fallback)
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
  normalizeAmount(contractAmount: number, symbol: string): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({ msg: 'Failed to normalize amount - metadata not found', function: 'MarketMetadataService.normalizeAmount',
        exchange: this.exchangeId,
        symbol,
        contractAmount,
        error })
      throw error
    }

    // Convert contracts to base asset units
    const baseAssetAmount = contractAmount * metadata.contractSize

    // Apply price scale normalization
    const priceScale = this.getPriceScale(symbol)
    const normalizedAmount = baseAssetAmount * priceScale

    return normalizedAmount
  }

  /**
   * Denormalize base asset amount to exchange-specific contract amount
   * Converts normalized base asset amounts to exchange-specific contract amounts
   */
  denormalizeAmount(normalizedAmount: number, symbol: string): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({ msg: 'Failed to denormalize amount - metadata not found', function: 'MarketMetadataService.denormalizeAmount',
        exchange: this.exchangeId,
        symbol,
        normalizedAmount,
        error })
      throw error
    }

    // Apply price scale denormalization
    const priceScale = this.getPriceScale(symbol)
    const scaledAmount = normalizedAmount / priceScale

    // Convert base asset units to contracts
    const contractAmount = scaledAmount / metadata.contractSize

    // Round to exchange precision
    return this.roundAmount(contractAmount, symbol)
  }

  /**
   * Round amount to valid precision for the exchange
   */
  roundAmount(amount: number, symbol: string): number {
    const metadata = this.getMetadata(symbol)
    if (!metadata) {
      const error = new Error(`No metadata found for symbol: ${symbol}`)
      logger.error({ msg: 'Failed to round amount - metadata not found', function: 'MarketMetadataService.roundAmount',
        exchange: this.exchangeId,
        symbol,
        amount,
        error })
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
      price: this.denormalizePrice(normalizedPrice, symbol)
    }
  }
} 