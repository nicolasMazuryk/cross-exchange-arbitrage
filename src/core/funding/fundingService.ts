import { EventEmitter } from 'events'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ParsedFunding } from './types'
import { closeBrowser } from '../../utils/browser'
import { RestClientInterface } from '../../adapters/rest/types'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import { FundingConfig } from './types'

const logger = new Logger('funding-service')

export class FundingService extends EventEmitter {
  private readonly exchangeAdapters: Map<string, RestClientInterface>
  private readonly marketMetadataServices: Map<string, MarketMetadataService>
  private readonly fundingConfig: FundingConfig
  private readonly state: Map<string, Map<string, ParsedFunding>>
  private fetchInterval?: NodeJS.Timeout
  private isRunning: boolean = false

  constructor(
    exchangeAdapters: Map<string, RestClientInterface>,
    marketMetadataServices: Map<string, MarketMetadataService>,
    fundingConfig: FundingConfig
  ) {
    super()
    this.exchangeAdapters = exchangeAdapters
    this.marketMetadataServices = marketMetadataServices
    this.fundingConfig = fundingConfig
    this.state = new Map()
  }

  /**
   * Start the funding service
   */
  public start(): void {
    try {
      if (this.isRunning) {
        logger.warn({
          msg: 'FundingService is already running',
          function: 'FundingService.start',
        })
        return
      }

      this.isRunning = true
      logger.info({
        msg: 'Starting FundingService',
        function: 'FundingService.start',
        exchangeCount: this.exchangeAdapters.size,
        fetchIntervalSeconds: this.fundingConfig.fetchIntervalMs / 1000,
      })

      const fetchWithTrace = async (contextName: string) => {
        try {
          TraceContext.runWithTrace(contextName, async () => {
            await this.fetchAllFundingRates()
          })
        } catch (error) {
          logger.error({
            msg: `Error fetching funding rates during "${contextName}"`,
            function: 'FundingService.start',
            error,
          })
        }
      }

      // Initial fetch
      fetchWithTrace('funding-fetch-initial')

      // Set up periodic fetching
      this.fetchInterval = setInterval(() => {
        fetchWithTrace('funding-fetch-periodic')
      }, this.fundingConfig.fetchIntervalMs)

      logger.info({
        msg: 'FundingService started successfully',
        function: 'FundingService.start',
        intervalMs: this.fundingConfig.fetchIntervalMs,
      })
    } catch (error) {
      logger.fatal({
        msg: 'Failed to start FundingService',
        function: 'FundingService.start',
        error,
      })
      throw error
    }
  }

  /**
   * Stop the funding service
   */
  public stop(): void {
    try {
      if (!this.isRunning) {
        logger.warn({
          msg: 'FundingService is not running',
          function: 'FundingService.stop',
        })
        return
      }

      this.isRunning = false
      if (this.fetchInterval) {
        clearInterval(this.fetchInterval)
        this.fetchInterval = undefined
      }

      // Close browser resources
      closeBrowser().catch(error => {
        logger.error({
          msg: 'Error closing browser resources during FundingService stop',
          function: 'FundingService.stop',
          error,
        })
      })

      logger.info({
        msg: 'FundingService stopped successfully',
        function: 'FundingService.stop',
      })
    } catch (error) {
      logger.error({
        msg: 'Error stopping FundingService',
        function: 'FundingService.stop',
        error,
      })
      throw error
    }
  }

  /**
   * Fetch funding rates from all supported exchanges
   */
  private async fetchAllFundingRates(): Promise<void> {
    try {
      const promises = Array.from(this.exchangeAdapters.keys()).map(exchangeName =>
        this.fetchExchangeFundingRates(exchangeName)
      )

      const results = await Promise.allSettled(promises)

      // Log any failed fetches
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const exchangeName = Array.from(this.exchangeAdapters.keys())[index]
          logger.error({
            msg: 'Failed to fetch funding rates for exchange',
            function: 'FundingService.fetchAllFundingRates',
            exchange: exchangeName,
            error: result.reason,
          })
        }
      })

      this.emit('fundingDataUpdated', this.state)
    } catch (error) {
      logger.error({
        msg: 'Error fetching funding rates from all exchanges',
        function: 'FundingService.fetchAllFundingRates',
        exchangeCount: this.exchangeAdapters.size,
        error,
      })
    }
  }

  /**
   * Compare symbols between funding data and market metadata for a specific exchange
   */
  private compareSymbolsConsistency(exchangeName: string): void {
    const marketMetadataService = this.marketMetadataServices.get(exchangeName)
    const fundingData = this.state.get(exchangeName)

    if (!marketMetadataService || !fundingData) return

    const marketSymbols = marketMetadataService.getAvailableSymbols()
    const fundingSymbols = Array.from(fundingData.keys())

    if (fundingSymbols.length !== marketSymbols.length) {
      const fundingOnly = fundingSymbols.filter(symbol => !marketSymbols.includes(symbol))
      const marketOnly = marketSymbols.filter(symbol => !fundingSymbols.includes(symbol))

      logger.warn({
        msg: 'Symbol count mismatch',
        function: 'FundingService.compareSymbolsConsistency',
        exchange: exchangeName,
        fundingCount: fundingSymbols.length,
        marketCount: marketSymbols.length,
        fundingOnlyCount: fundingOnly.length,
        marketOnlyCount: marketOnly.length,
      })

      if (fundingOnly.length > 0) {
        logger.warn({
          msg: 'Funding symbols not in market metadata',
          function: 'FundingService.compareSymbolsConsistency',
          exchange: exchangeName,
          fundingOnly,
        })
      }
      if (marketOnly.length > 0) {
        logger.warn({
          msg: 'Market metadata symbols not in funding',
          function: 'FundingService.compareSymbolsConsistency',
          exchange: exchangeName,
          marketOnly,
        })
      }
    }
  }

  /**
   * Fetch funding rates for a specific exchange
   */
  private async fetchExchangeFundingRates(exchangeName: string): Promise<void> {
    try {
      logger.trace({
        msg: 'Fetching funding rates',
        function: 'FundingService.fetchExchangeFundingRates',
        exchange: exchangeName,
      })

      const exchangeAdapter = this.exchangeAdapters.get(exchangeName)
      if (!exchangeAdapter || !exchangeAdapter.fetchFundingData) {
        logger.error({
          msg: 'No funding data adapter available',
          function: 'FundingService.fetchExchangeFundingRates',
          exchange: exchangeName,
        })
        return
      }

      // Fetch and parse funding data using the exchange adapter
      const parsedFunding = await exchangeAdapter.fetchFundingData()

      // Update state
      this.state.set(exchangeName, parsedFunding)

      logger.debug({
        msg: 'Fetched funding rates',
        function: 'FundingService.fetchExchangeFundingRates',
        exchange: exchangeName,
        symbolCount: parsedFunding.size,
      })

      // this.compareSymbolsConsistency(exchangeName)
    } catch (error) {
      logger.error({
        msg: 'Error fetching funding rates',
        function: 'FundingService.fetchExchangeFundingRates',
        exchange: exchangeName,
        error,
      })

      // Update state with empty map on error
      this.state.set(exchangeName, new Map())
    }
  }

  /**
   * Get funding data for a specific symbol and exchange
   */
  public getSymbolFundingData(exchange: string, symbol: string): ParsedFunding | undefined {
    const exchangeFunding = this.state.get(exchange)
    if (!exchangeFunding || exchangeFunding.size === 0) {
      return undefined
    }

    const symbolFunding = exchangeFunding.get(symbol)
    if (!symbolFunding) {
      return undefined
    }

    return symbolFunding
  }

  /**
   * Get all funding data for a specific exchange
   */
  public getExchangeFundingData(exchange: string): Map<string, ParsedFunding> | undefined {
    const exchangeFunding = this.state.get(exchange)
    if (!exchangeFunding || exchangeFunding.size === 0) {
      return undefined
    }

    return exchangeFunding
  }

  /**
   * Compare symbols between funding data and market metadata, returns both data and report
   */
  public compareFundingSymbolsWithMarketMetadataSymbols(): {
    data: Map<string, { fundingOnly: string[]; marketOnly: string[]; matched: string[] }>
    report: string
  } {
    const comparison = new Map<string, { fundingOnly: string[]; marketOnly: string[]; matched: string[] }>()
    let report = '\n=== Symbol Comparison Report ===\n'

    for (const [exchangeName, marketMetadataService] of this.marketMetadataServices) {
      const fundingData = this.state.get(exchangeName)
      const marketSymbols = marketMetadataService.getAvailableSymbols()
      const fundingSymbols = fundingData ? Array.from(fundingData.keys()) : []

      const fundingOnly = fundingSymbols.filter(symbol => !marketSymbols.includes(symbol))
      const marketOnly = marketSymbols.filter(symbol => !fundingSymbols.includes(symbol))
      const matched = fundingSymbols.filter(symbol => marketSymbols.includes(symbol))

      comparison.set(exchangeName, { fundingOnly, marketOnly, matched })

      report += `\n[${exchangeName}]:\n`
      report += `  Matched: ${matched.length}, Funding only: ${fundingOnly.length}, Market only: ${marketOnly.length}\n`
      if (fundingOnly.length > 0) report += `  Funding only: ${fundingOnly.join(', ')}\n`
      if (marketOnly.length > 0) report += `  Market only: ${marketOnly.join(', ')}\n`
    }

    return { data: comparison, report }
  }

  /**
   * Get service state
   */
  public getState(): Map<string, Map<string, ParsedFunding>> {
    return this.state
  }

  /**
   * Check if funding times are synchronized between exchanges for entry
   */
  public isFundingSynchronizedEntry(buyFunding: ParsedFunding, sellFunding: ParsedFunding): boolean {
    return buyFunding.nextFundingTimestamp === sellFunding.nextFundingTimestamp
  }

  /**
   * Check if funding times are synchronized between exchanges for exit
   */
  public isFundingSynchronizedExit(buyFunding: ParsedFunding, sellFunding: ParsedFunding): boolean {
    return (
      buyFunding.nextFundingTimestamp === sellFunding.nextFundingTimestamp &&
      buyFunding.fundingInterval === sellFunding.fundingInterval
    )
  }

  /**
   * Find the next synchronization timestamp for ASYNC funding
   * Returns the timestamp when both exchanges will have funding events at the same time
   */
  public findNextSyncTimestamp(buyFunding: ParsedFunding, sellFunding: ParsedFunding): number {
    const now = Date.now()
    const buyIntervalMs = buyFunding.fundingInterval * 60 * 60 * 1000
    const sellIntervalMs = sellFunding.fundingInterval * 60 * 60 * 1000

    let buyTime = buyFunding.nextFundingTimestamp
    let sellTime = sellFunding.nextFundingTimestamp

    // Move forward until we find a sync point (max 100 iterations to prevent infinite loop)
    for (let i = 0; i < 100; i++) {
      if (buyTime === sellTime && buyTime >= now) {
        return buyTime
      }

      if (buyTime < sellTime) {
        buyTime += buyIntervalMs
      } else {
        sellTime += sellIntervalMs
      }
    }

    // Fallback: return far future if no sync found
    return now + 24 * 60 * 60 * 1000 // 24 hours from now
  }

  /**
   * Calculate cumulative funding rate until a target timestamp (excluding the target event itself)
   */
  public calculateCumulativeFundingRate(
    targetTimestamp: number,
    fundingEvents: Array<{ timestamp: number; buyExchangeFundingRate: number; sellExchangeFundingRate: number }>
  ): number {
    let cumulativeFundingRate = 0

    for (const event of fundingEvents) {
      // Only count events before the target timestamp (exclude the target event itself)
      if (event.timestamp < targetTimestamp) {
        const buyFundingImpact = -event.buyExchangeFundingRate
        const sellFundingImpact = event.sellExchangeFundingRate
        cumulativeFundingRate += buyFundingImpact + sellFundingImpact
      } else {
        break
      }
    }

    return cumulativeFundingRate
  }

  /**
   * Generate funding events considering asynchronous funding schedules
   */
  public generateFundingEvents(
    buyFunding: ParsedFunding,
    sellFunding: ParsedFunding,
    projectionHours: number
  ): Array<{ timestamp: number; buyExchangeFundingRate: number; sellExchangeFundingRate: number }> {
    const events: Array<{ timestamp: number; buyExchangeFundingRate: number; sellExchangeFundingRate: number }> = []

    // Use the first next closest funding event time as startTime
    const startTime = Math.min(buyFunding.nextFundingTimestamp, sellFunding.nextFundingTimestamp)
    const endTime = startTime + projectionHours * 60 * 60 * 1000

    // Generate buy exchange funding events
    const buyEvents = this.generateExchangeFundingEvents(buyFunding, startTime, endTime)
    // Generate sell exchange funding events
    const sellEvents = this.generateExchangeFundingEvents(sellFunding, startTime, endTime)

    // Merge and sort all events by timestamp
    const allEvents = new Map<number, { buyExchangeFundingRate: number; sellExchangeFundingRate: number }>()

    // Add buy exchange events
    for (const event of buyEvents) {
      const existing = allEvents.get(event.timestamp) || { buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }
      existing.buyExchangeFundingRate = event.fundingRate
      allEvents.set(event.timestamp, existing)
    }

    // Add sell exchange events
    for (const event of sellEvents) {
      const existing = allEvents.get(event.timestamp) || { buyExchangeFundingRate: 0, sellExchangeFundingRate: 0 }
      existing.sellExchangeFundingRate = event.fundingRate
      allEvents.set(event.timestamp, existing)
    }

    // Convert to array and sort by timestamp
    for (const [timestamp, funding] of allEvents) {
      events.push({
        timestamp,
        buyExchangeFundingRate: funding.buyExchangeFundingRate,
        sellExchangeFundingRate: funding.sellExchangeFundingRate,
      })
    }

    return events.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Generate funding events for a single exchange
   */
  public generateExchangeFundingEvents(
    funding: ParsedFunding,
    startTime: number,
    endTime: number
  ): Array<{ timestamp: number; fundingRate: number }> {
    const events: Array<{ timestamp: number; fundingRate: number }> = []
    const intervalMs = funding.fundingInterval * 60 * 60 * 1000 // Convert hours to milliseconds

    // Find the first funding event after start time
    let nextFundingTime = funding.nextFundingTimestamp
    while (nextFundingTime < startTime) {
      nextFundingTime += intervalMs
    }

    // Generate events until end time
    while (nextFundingTime <= endTime) {
      events.push({
        timestamp: nextFundingTime,
        fundingRate: funding.fundingRate,
      })
      nextFundingTime += intervalMs
    }

    return events
  }
}
