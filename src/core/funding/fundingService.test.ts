import { FundingService } from './fundingService'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { FundingConfig } from './types'
import * as ccxt from 'ccxt'

// Mock dependencies
jest.mock('../../utils/logger')
jest.mock('../../utils/config')

describe('FundingService', () => {
  let fundingService: FundingService
  let mockExchanges: Map<string, ccxt.Exchange>
  let mockExchangeAdapters: Map<string, any>
  let mockMarketMetadataServices: Map<string, MarketMetadataService>
  let fundingConfig: FundingConfig

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks()

    // Mock funding config
    fundingConfig = {
      fetchIntervalMs: 1000,
      maxDataAgeMs: 5000,
      supportedExchanges: ['binance', 'bybit', 'okx', 'bitget'],
      projectionHours: 20,
    }

    // Create mock exchanges
    mockExchanges = new Map()
    const mockBinance = {
      has: { fetchFundingRates: true },
      fetchFundingRates: jest.fn().mockResolvedValue({
        BTCUSDT: {
          symbol: 'BTCUSDT',
          fundingRate: 0.0001,
          fundingInterval: 8,
          nextFundingTime: Date.now() + 8 * 60 * 60 * 1000,
          timestamp: Date.now(),
        },
      }),
    } as any

    const mockBybit = {
      has: { fetchFundingRates: true },
      fetchFundingRates: jest.fn().mockResolvedValue({
        BTCUSDT: {
          symbol: 'BTCUSDT',
          fundingRate: -0.0001,
          fundingInterval: 8,
          nextFundingTime: Date.now() + 8 * 60 * 60 * 1000,
          timestamp: Date.now(),
        },
      }),
    } as any

    mockExchanges.set('binance', mockBinance)
    mockExchanges.set('bybit', mockBybit)

    // Create mock exchange adapters
    mockExchangeAdapters = new Map()
    const mockBinanceAdapter = {
      fetchFundingData: jest.fn().mockResolvedValue(
        new Map([
          [
            'BTCUSDT',
            {
              exchange: 'binance',
              symbol: 'BTCUSDT',
              fundingRate: 0.0001,
              fundingInterval: 8,
              nextFundingTimestamp: Date.now() + 8 * 60 * 60 * 1000,
              nextFundingDatetime: new Date(Date.now() + 8 * 60 * 60 * 1000),
            },
          ],
        ])
      ),
    } as any

    const mockBybitAdapter = {
      fetchFundingData: jest.fn().mockResolvedValue(
        new Map([
          [
            'BTCUSDT',
            {
              exchange: 'bybit',
              symbol: 'BTCUSDT',
              fundingRate: -0.0001,
              fundingInterval: 8,
              nextFundingTimestamp: Date.now() + 8 * 60 * 60 * 1000,
              nextFundingDatetime: new Date(Date.now() + 8 * 60 * 60 * 1000),
            },
          ],
        ])
      ),
    } as any

    mockExchangeAdapters.set('binance', mockBinanceAdapter)
    mockExchangeAdapters.set('bybit', mockBybitAdapter)

    // Create mock market metadata services
    mockMarketMetadataServices = new Map()
    const mockBinanceMetadata = {
      normalizeSymbol: jest.fn().mockImplementation((symbol: string) => {
        if (symbol === 'BTCUSDT') return 'BTCUSDT'
        return null
      }),
    } as any

    const mockBybitMetadata = {
      normalizeSymbol: jest.fn().mockImplementation((symbol: string) => {
        if (symbol === 'BTCUSDT') return 'BTCUSDT'
        return null
      }),
    } as any

    mockMarketMetadataServices.set('binance', mockBinanceMetadata)
    mockMarketMetadataServices.set('bybit', mockBybitMetadata)

    // Create funding service
    fundingService = new FundingService(mockExchangeAdapters, mockMarketMetadataServices, fundingConfig)
  })

  afterEach(() => {
    fundingService.stop()
  })

  describe('start and stop', () => {
    it('should start and stop the service', () => {
      expect(() => fundingService.start()).not.toThrow()
      expect(() => fundingService.stop()).not.toThrow()
    })

    it('should not start if already running', () => {
      fundingService.start()
      expect(() => fundingService.start()).not.toThrow() // Should not throw, just warn
    })
  })

  describe('funding data fetching', () => {
    it('should fetch funding rates from supported exchanges', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const state = fundingService.getState()
      expect(state.size).toBeGreaterThan(0)
      expect(state.has('binance')).toBe(true)
      expect(state.has('bybit')).toBe(true)
      expect(state.get('binance')!.size).toBeGreaterThan(0)
      expect(state.get('bybit')!.size).toBeGreaterThan(0)
    })

    it('should normalize funding rates correctly', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const binanceData = fundingService.getExchangeFundingData('binance')
      expect(binanceData).toBeDefined()
      expect(binanceData!.has('BTCUSDT')).toBe(true)

      const btcFunding = binanceData!.get('BTCUSDT')!
      expect(btcFunding.exchange).toBe('binance')
      expect(btcFunding.symbol).toBe('BTCUSDT')
      expect(btcFunding.fundingRate).toBe(0.0001)
      expect(btcFunding.interval).toBe(8) // 8 hours
    })

    it('should calculate derived rates correctly', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const binanceData = fundingService.getExchangeFundingData('binance')
      const btcFunding = binanceData!.get('BTCUSDT')!

      // For 8-hour interval, ratePer1h should be fundingRate / 8
      expect(btcFunding.ratePer1h).toBe(0.0001 / 8)

      // For 8-hour interval, ratePer8h should be fundingRate
      expect(btcFunding.ratePer8h).toBe(0.0001)
    })
  })

  describe('funding opportunities', () => {
    it('should find funding opportunities between exchanges', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const opportunities = fundingService.findFundingOpportunities()
      expect(opportunities.length).toBeGreaterThan(0)

      const btcOpportunity = opportunities.find(opp => opp.normalizedPair === 'BTCUSDT')
      expect(btcOpportunity).toBeDefined()
      expect(btcOpportunity!.longExchange).toBeDefined()
      expect(btcOpportunity!.shortExchange).toBeDefined()
      expect(btcOpportunity!.fundingDifferential).toBeDefined()
    })

    it('should calculate funding differential correctly', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const opportunities = fundingService.findFundingOpportunities()
      const btcOpportunity = opportunities.find(opp => opp.normalizedPair === 'BTCUSDT')

      if (btcOpportunity) {
        // Binance has +0.0001 (8h), Bybit has -0.0001 (8h)
        // Hourly rates: Binance = 0.0001/8 = 0.0000125, Bybit = -0.0001/8 = -0.0000125
        // Differential = shortRatePer1h - longRatePer1h
        // If Binance is long and Bybit is short: differential = -0.0000125 - 0.0000125 = -0.000025
        // If Bybit is long and Binance is short: differential = 0.0000125 - (-0.0000125) = 0.000025
        expect(Math.abs(btcOpportunity.fundingDifferential)).toBeCloseTo(0.000025, 5)
      }
    })
  })

  describe('health monitoring', () => {
    it('should have valid state when data is fresh', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const state = fundingService.getState()
      expect(state.size).toBeGreaterThan(0)
    })

    it('should get funding data for specific symbol and exchange', async () => {
      fundingService.start()

      // Wait for initial fetch
      await new Promise(resolve => setTimeout(resolve, 100))

      const fundingData = fundingService.getFundingData('binance', 'BTCUSDT')
      expect(fundingData).toBeDefined()
      expect(fundingData!.exchange).toBe('binance')
      expect(fundingData!.symbol).toBe('BTCUSDT')
    })
  })
})
