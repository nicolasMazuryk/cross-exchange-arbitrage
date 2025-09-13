import { EventEmitter } from 'events'
import { MarketMetadataService } from '../markets/marketMetadataService'
import { ParsedFunding } from './types'
import { closeBrowser } from '../../utils/browser'
import { RestClientInterface } from '../../adapters/rest/types'
import logger from '../../utils/logger'
import { FundingConfig } from './types'


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
    if (this.isRunning) {
      logger.warn('FundingService is already running')
      return
    }

    this.isRunning = true
    logger.info('Starting FundingService...')

    // Initial fetch
    this.fetchAllFundingRates()

    // Set up periodic fetching
    this.fetchInterval = setInterval(() => {
      this.fetchAllFundingRates()
    }, this.fundingConfig.fetchIntervalMs)

    logger.info(`FundingService started with ${this.fundingConfig.fetchIntervalMs / 1000}s interval`)
  }

  /**
   * Stop the funding service
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn('FundingService is not running')
      return
    }

    this.isRunning = false
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval)
      this.fetchInterval = undefined
    }

    // Close browser resources
    closeBrowser()

    logger.info('FundingService stopped')
  }

  /**
   * Fetch funding rates from all supported exchanges
   */
  private async fetchAllFundingRates(): Promise<void> {
    const promises = Array.from(this.exchangeAdapters.keys()).map(exchangeName => 
      this.fetchExchangeFundingRates(exchangeName)
    )

    try {
      await Promise.allSettled(promises)
      this.emit('fundingDataUpdated', this.state)
    } catch (error) {
      logger.error('Error in fetchAllFundingRates:', error)
    }
  }

  /**
   * Fetch funding rates for a specific exchange
   */
  private async fetchExchangeFundingRates(exchangeName: string): Promise<void> {
    try {
      logger.debug(`Fetching funding rates for ${exchangeName}...`)
      
      const exchangeAdapter = this.exchangeAdapters.get(exchangeName)
      if (!exchangeAdapter || !exchangeAdapter.fetchFundingData) {
        logger.warn(`No funding data adapter available for ${exchangeName}`)
        return
      }

      // Fetch and parse funding data using the exchange adapter
      const parsedFunding = await exchangeAdapter.fetchFundingData()
      
      // Update state
      this.state.set(exchangeName, parsedFunding)

      logger.debug(`[${exchangeName}] Fetched ${parsedFunding.size} funding rates`)
    } catch (error) {
      logger.error(`[${exchangeName}] Error fetching funding rates:`, error)
      
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
   * Get service state
   */
  public getState(): Map<string, Map<string, ParsedFunding>> {
    return this.state
  }
}
