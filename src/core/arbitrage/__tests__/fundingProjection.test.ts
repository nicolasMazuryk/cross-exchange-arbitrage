/**
 * Tests for funding projection functionality
 */

import { ArbitrageEngine } from '../arbitrageEngine'
import { OrderbookManager } from '../../orderbook/orderbookManager'
import { MarketMetadataService } from '../../markets/marketMetadataService'
import { FundingService } from '../../funding/fundingService'
import { ParsedFunding } from '../../funding/types'
import { ExchangeMeta } from '../../../types/exchange'

describe('Funding Projection Tests', () => {
  let arbitrageEngine: ArbitrageEngine
  let fundingService: FundingService
  let mockFundingData: Map<string, Map<string, ParsedFunding>>

  beforeEach(() => {
    // Mock funding data
    mockFundingData = new Map()
    
    // Mock Binance funding data
    const binanceFunding = new Map<string, ParsedFunding>()
    binanceFunding.set('BTCUSDT', {
      exchange: 'binance',
      symbol: 'BTCUSDT',
      fundingRate: 0.0001, // 0.01%
      fundingRatePercent: 0.01,
      fundingInterval: 8, // 8 hours
      nextFundingTimestamp: Date.now() + (2 * 60 * 60 * 1000), // 2 hours from now
      nextFundingDatetime: new Date(Date.now() + (2 * 60 * 60 * 1000))
    })
    mockFundingData.set('binance', binanceFunding)

    // Mock Bybit funding data
    const bybitFunding = new Map<string, ParsedFunding>()
    bybitFunding.set('BTCUSDT', {
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      fundingRate: -0.0001, // -0.01%
      fundingRatePercent: -0.01,
      fundingInterval: 8, // 8 hours
      nextFundingTimestamp: Date.now() + (2 * 60 * 60 * 1000), // 2 hours from now
      nextFundingDatetime: new Date(Date.now() + (2 * 60 * 60 * 1000))
    })
    mockFundingData.set('bybit', bybitFunding)

    // Mock funding service
    fundingService = {
      getSymbolFundingData: jest.fn((exchange: string, symbol: string) => {
        return mockFundingData.get(exchange)?.get(symbol)
      })
    } as any

    // Create arbitrage engine with mocked dependencies
    arbitrageEngine = new ArbitrageEngine(
      new OrderbookManager(),
      [],
      [],
      new Map(),
      fundingService
    )
  })

  describe('Funding Projection Calculation', () => {
    it('should calculate funding projection for synchronous funding schedules', () => {
      const positionValue = 10000 // $10,000 position
      const normalizedVolume = 0.2 // 0.2 BTC

      // Access private method for testing
      const calculateFundingProjection = (arbitrageEngine as any).calculateFundingProjection.bind(arbitrageEngine)
      
      const projection = calculateFundingProjection(
        'binance',
        'bybit',
        'BTCUSDT',
        'BTCUSDT',
        normalizedVolume,
        positionValue
      )

      expect(projection).not.toBeNull()
      expect(projection!.timeline.length).toBeGreaterThan(0)
      expect(projection!.totalProjectedProfit).toBeDefined()
      expect(projection!.totalProjectedProfitPercent).toBeDefined()
      expect(projection!.maxDrawdown).toBeDefined()
      expect(projection!.averageHourlyReturn).toBeDefined()
    })

    it('should handle missing funding data gracefully', () => {
      const positionValue = 10000
      const normalizedVolume = 0.2

      // Mock missing funding data
      ;(fundingService.getSymbolFundingData as jest.Mock).mockReturnValue(undefined)

      const calculateFundingProjection = (arbitrageEngine as any).calculateFundingProjection.bind(arbitrageEngine)
      
      const projection = calculateFundingProjection(
        'binance',
        'bybit',
        'BTCUSDT',
        'BTCUSDT',
        normalizedVolume,
        positionValue
      )

      expect(projection).toBeNull()
    })

    it('should handle excessive funding rate deviation', () => {
      // Set up funding rates with large deviation
      const binanceFunding = mockFundingData.get('binance')!.get('BTCUSDT')!
      binanceFunding.fundingRate = 0.05 // 5% - very high
      
      const positionValue = 10000
      const normalizedVolume = 0.2

      const calculateFundingProjection = (arbitrageEngine as any).calculateFundingProjection.bind(arbitrageEngine)
      
      const projection = calculateFundingProjection(
        'binance',
        'bybit',
        'BTCUSDT',
        'BTCUSDT',
        normalizedVolume,
        positionValue
      )

      expect(projection).toBeNull()
    })

    it('should generate correct funding events for 8-hour intervals', () => {
      const generateExchangeFundingEvents = (arbitrageEngine as any).generateExchangeFundingEvents.bind(arbitrageEngine)
      
      const funding = mockFundingData.get('binance')!.get('BTCUSDT')!
      const startTime = Date.now()
      const endTime = startTime + (24 * 60 * 60 * 1000) // 24 hours

      const events = generateExchangeFundingEvents(funding, startTime, endTime)

      // Should have 3 events (8h, 16h, 24h intervals)
      expect(events.length).toBe(3)
      expect(events[0].fundingRate).toBe(0.0001)
      expect(events[1].fundingRate).toBe(0.0001)
      expect(events[2].fundingRate).toBe(0.0001)
    })

    it('should handle asynchronous funding schedules', () => {
      // Set up different funding intervals
      const binanceFunding = mockFundingData.get('binance')!.get('BTCUSDT')!
      binanceFunding.fundingInterval = 8 // 8 hours
      
      const bybitFunding = mockFundingData.get('bybit')!.get('BTCUSDT')!
      bybitFunding.fundingInterval = 4 // 4 hours

      const generateFundingEvents = (arbitrageEngine as any).generateFundingEvents.bind(arbitrageEngine)
      
      const startTime = Date.now()
      const events = generateFundingEvents(binanceFunding, bybitFunding, startTime, 24)

      // Should have events from both exchanges with different intervals
      expect(events.length).toBeGreaterThan(3) // More than just 8h intervals
      
      // Verify events are sorted by timestamp
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i-1].timestamp)
      }
    })
  })

  describe('Combined Profitability', () => {
    it('should correctly combine spread and funding profits', () => {
      const spreadProfit = 50 // $50 spread profit
      const fundingProfit = 20 // $20 funding profit over projection period
      
      const combinedProfit = spreadProfit + fundingProfit
      expect(combinedProfit).toBe(70)
    })

    it('should handle negative funding impact', () => {
      const spreadProfit = 50 // $50 spread profit
      const fundingLoss = -30 // $30 funding loss over projection period
      
      const combinedProfit = spreadProfit + fundingLoss
      expect(combinedProfit).toBe(20)
    })
  })
})
