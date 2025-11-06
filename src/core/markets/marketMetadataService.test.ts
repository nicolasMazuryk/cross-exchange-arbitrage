import { MarketMetadataService, MarketMetadata } from './marketMetadataService'
import * as ccxt from 'ccxt'

// Mock market data for testing
const createMockMarket = (symbol: string, contractSize?: number, precision?: any): ccxt.Market => {
  const defaultContractSize = contractSize || 1
  const defaultPrecision = precision || { price: 8, amount: 8 }

  return {
    id: symbol,
    symbol,
    base: symbol.split('/')[0],
    baseId: symbol.split('/')[0],
    quote: 'USDT',
    quoteId: 'USDT',
    active: true,
    contract: true,
    swap: true,
    linear: true,
    future: false,
    inverse: false,
    contractSize: defaultContractSize,
    precision: defaultPrecision,
    limits: {
      amount: {
        min: 0.001,
        max: undefined,
      },
      price: {
        min: 0.0001,
        max: 1000000,
      },
      cost: {
        min: 1,
        max: undefined,
      },
    },
    info: {},
    type: 'swap',
    spot: false,
    margin: false,
    option: false,
    settle: 'USDT',
    settleId: 'USDT',
    expiry: undefined,
    expiryDatetime: undefined,
    strike: undefined,
    optionType: undefined,
    created: undefined,
  }
}

describe('MarketMetadataService', () => {
  let service: MarketMetadataService

  beforeEach(() => {
    const mockMarkets = [
      createMockMarket('PEPE/USDT', 1, { price: 8, amount: 0.1 }),
      createMockMarket('1000PEPE/USDT', 1000, { price: 8, amount: 100 }),
      createMockMarket('MOG/USDT', 1, { price: 8, amount: 0.1 }),
      createMockMarket('1000MOG/USDT', 1000, { price: 8, amount: 100 }),
      createMockMarket('BTC/USDT', 1, { price: 2, amount: 0.001 }),
    ]

    service = new MarketMetadataService('binance', mockMarkets, [])
  })

  describe('Symbol Normalization', () => {
    it('should normalize scaled symbols correctly', () => {
      expect(service.normalizeSymbol('1000PEPE/USDT')).toBe('PEPE/USDT')
      expect(service.normalizeSymbol('1000MOG/USDT')).toBe('MOG/USDT')
      expect(service.normalizeSymbol('PEPE/USDT')).toBe('PEPE/USDT')
      expect(service.normalizeSymbol('BTC/USDT')).toBe('BTC/USDT')
    })

    it('should handle multiple digit prefixes', () => {
      expect(service.normalizeSymbol('10000PEPE/USDT')).toBe('PEPE/USDT')
      expect(service.normalizeSymbol('500MOG/USDT')).toBe('MOG/USDT')
    })

    it('should handle symbols with :USDT suffix', () => {
      expect(service.normalizeSymbol('1000000BABYDOGE/USDT:USDT')).toBe('BABYDOGE/USDT:USDT')
      expect(service.normalizeSymbol('1000PEPE/USDT:USDT')).toBe('PEPE/USDT:USDT')
      expect(service.normalizeSymbol('BABYDOGE/USDT:USDT')).toBe('BABYDOGE/USDT:USDT')
    })

    it('should handle different quote assets', () => {
      expect(service.normalizeSymbol('1000BTC/ETH')).toBe('BTC/ETH')
      expect(service.normalizeSymbol('500ETH/BTC')).toBe('ETH/BTC')
      expect(service.normalizeSymbol('1000PEPE/BUSD')).toBe('PEPE/BUSD')
      expect(service.normalizeSymbol('BTC/ETH')).toBe('BTC/ETH')
    })
  })

  describe('Price Scale Detection', () => {
    it('should detect price scale from symbol names', () => {
      expect(service.getPriceScale('PEPE/USDT')).toBe(1)
      expect(service.getPriceScale('1000PEPE/USDT')).toBe(1000)
      expect(service.getPriceScale('BTC/USDT')).toBe(1)
      expect(service.getPriceScale('1000BTC/ETH')).toBe(1000)
      expect(service.getPriceScale('500ETH/BTC')).toBe(500)
    })
  })

  describe('Price Normalization', () => {
    it('should normalize prices to base scale', () => {
      const basePrice = 0.000012825

      // Regular symbol (no scale)
      expect(service.normalizePrice(0.000012825, 'PEPE/USDT')).toBe(basePrice)

      // Scaled symbol
      expect(service.normalizePrice(0.012825, '1000PEPE/USDT')).toBe(basePrice)
    })

    it('should denormalize prices to exchange scale', () => {
      const basePrice = 0.000012825

      // Regular symbol (no scale)
      expect(service.denormalizePrice(basePrice, 'PEPE/USDT')).toBe(basePrice)

      // Scaled symbol
      expect(service.denormalizePrice(basePrice, '1000PEPE/USDT')).toBe(0.012825)
    })
  })

  describe('Amount Normalization', () => {
    it('should normalize amounts to base units', () => {
      // Regular symbol
      expect(service.normalizeAmount(1000, 'PEPE/USDT')).toBe(1000)

      // Scaled symbol: 1 contract * 1000 contractSize / 1000 priceScale = 1 base unit
      expect(service.normalizeAmount(1, '1000PEPE/USDT')).toBe(1)
    })

    it('should denormalize amounts to exchange-specific contracts', () => {
      const baseAmount = 1000

      // Regular symbol
      expect(service.denormalizeAmount(baseAmount, 'PEPE/USDT')).toBe(1000)

      // Scaled symbol: 1000 base units * 1000 priceScale / 1000 contractSize = 1000 contracts
      expect(service.denormalizeAmount(baseAmount, '1000PEPE/USDT')).toBe(1000)
    })
  })

  describe('Precision Rounding', () => {
    it('should round amount to correct precision', () => {
      // PEPE/USDT has 0.1 step precision
      expect(service.roundAmount(123.456789, 'PEPE/USDT')).toBe(123.5)
      expect(service.roundAmount(123.456789, '1000PEPE/USDT')).toBe(100)

      // BTC/USDT has 0.001 step precision
      expect(service.roundAmount(1.23456789, 'BTC/USDT')).toBe(1.235)
    })
  })

  describe('Metadata Access', () => {
    it('should get metadata for symbols', () => {
      const metadata = service.getMetadata('PEPE/USDT')
      expect(metadata).toBeDefined()
      expect(metadata?.normalizedSymbol).toBe('PEPE/USDT')
      expect(metadata?.contractSize).toBe(1)
    })

    it('should get metadata for scaled symbols', () => {
      const metadata = service.getMetadata('1000PEPE/USDT')
      expect(metadata).toBeDefined()
      expect(metadata?.normalizedSymbol).toBe('PEPE/USDT')
      expect(metadata?.contractSize).toBe(1000)
    })

    it('should return undefined for unknown symbols', () => {
      expect(service.getMetadata('UNKNOWN/USDT')).toBeUndefined()
    })
  })

  describe('Symbol Management', () => {
    it('should get available symbols', () => {
      const symbols = service.getAvailableSymbols()
      expect(symbols).toContain('PEPE/USDT')
      expect(symbols).toContain('1000PEPE/USDT')
      expect(symbols).toContain('MOG/USDT')
      expect(symbols).toContain('1000MOG/USDT')
      expect(symbols).toContain('BTC/USDT')
    })
  })

  describe('Order Parameter Conversion', () => {
    it('should convert normalized values to exchange-specific order parameters', () => {
      const normalizedAmount = 1000 // 1K base units
      const normalizedPrice = 0.000012825 // base price

      // Test regular symbol order parameters
      const regularParams = service.getExchangeOrderParams(normalizedAmount, normalizedPrice, 'PEPE/USDT')
      expect(regularParams.amount).toBe(1000)
      expect(regularParams.price).toBe(0.000012825)

      // Test scaled symbol order parameters
      const scaledParams = service.getExchangeOrderParams(normalizedAmount, normalizedPrice, '1000PEPE/USDT')
      expect(scaledParams.amount).toBe(1000) // 1000 base units * 1000 priceScale / 1000 contractSize
      expect(scaledParams.price).toBe(0.012825)
    })
  })

  describe('Ignored Markets', () => {
    it('should filter out ignored markets during initialization', () => {
      const mockMarkets = [
        createMockMarket('BTC/USDT', 1, { price: 2, amount: 0.001 }),
        createMockMarket('ETH/USDT', 1, { price: 2, amount: 0.01 }),
        createMockMarket('MOG/USDT', 1, { price: 8, amount: 0.1 }),
      ]

      const ignoredMarkets = ['ETH/USDT', 'MOG/USDT']
      const serviceWithIgnored = new MarketMetadataService('binance', mockMarkets, ignoredMarkets)

      // Should only have BTC/USDT available
      const availableSymbols = serviceWithIgnored.getAvailableSymbols()
      expect(availableSymbols).toHaveLength(1)
      expect(availableSymbols).toContain('BTC/USDT')
      expect(availableSymbols).not.toContain('ETH/USDT')
      expect(availableSymbols).not.toContain('MOG/USDT')

      // Should not have symbol mappings for ignored markets
      const symbolMappings = serviceWithIgnored.getSymbolMappings()
      expect(symbolMappings.has('BTC/USDT')).toBe(true)
      expect(symbolMappings.has('ETH/USDT')).toBe(false)
      expect(symbolMappings.has('MOG/USDT')).toBe(false)
    })

    it('should work with empty ignored markets list', () => {
      const mockMarkets = [
        createMockMarket('BTC/USDT', 1, { price: 2, amount: 0.001 }),
        createMockMarket('ETH/USDT', 1, { price: 2, amount: 0.01 }),
      ]

      const serviceWithEmptyIgnored = new MarketMetadataService('binance', mockMarkets, [])

      // Should have all markets available
      const availableSymbols = serviceWithEmptyIgnored.getAvailableSymbols()
      expect(availableSymbols).toHaveLength(2)
      expect(availableSymbols).toContain('BTC/USDT')
      expect(availableSymbols).toContain('ETH/USDT')
    })
  })
})
