import { CronJob } from 'cron'
import { TrackedTrade, FundingFeeCollectedEvent } from '../trading/tradeMonitor'
import { RestClientInterface } from '../../adapters/rest/types'
import { State } from '../state/stateService'
import { FundingService } from './fundingService'
import { OrderbookManager } from '../orderbook/orderbookManager'
import { Logger } from '../../utils/logger'
import { TraceContext } from '../../utils/traceContext'
import { MarketType } from '../../types/exchange'
import { getMarketTypeFromUnifiedSymbol } from '../../utils/utils'

const logger = new Logger('funding-fee-collector')

export interface FundingRateHistory {
  symbol: string
  fundingRate: number
  actualTimestamp: number
  timestamp: number
  datetime: string
  info?: any
}

export interface FundingFeeHistory {
  symbol: string
  amount: number
  id: string
  code: string
  actualTimestamp: number
  timestamp: number
  datetime: string
  info?: any
}

export interface FundingRateAndFeeHistory {
  fundingRatePercent: number
  fundingFeeUsd: number
  actualTimestamp: number
  timestamp: number
  date: string
}

export class FundingFeeCollector {
  private readonly restClients: Map<string, RestClientInterface>
  private readonly state: State
  private readonly fundingService: FundingService
  private readonly cronPattern: string
  private readonly orderbookManager?: OrderbookManager
  private cronJob?: CronJob
  private isRunning: boolean = false

  constructor(
    restClients: Map<string, RestClientInterface>,
    state: State,
    fundingService: FundingService,
    cronPattern: string,
    orderbookManager?: OrderbookManager
  ) {
    this.restClients = restClients
    this.state = state
    this.fundingService = fundingService
    this.cronPattern = cronPattern
    this.orderbookManager = orderbookManager
  }

  /**
   * Start the funding fee collector with cron schedule
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn({
        msg: 'FundingFeeCollector is already running',
        function: 'FundingFeeCollector.start',
      })
      return
    }

    this.isRunning = true
    logger.info({
      msg: 'Starting FundingFeeCollector...',
      function: 'FundingFeeCollector.start',
      cronPattern: this.cronPattern,
    })

    // Create cron job
    this.cronJob = new CronJob(
      this.cronPattern,
      () => {
        TraceContext.runWithTrace('funding-fee-collection-cron', async () => {
          try {
            await this.collectFundingFees()
          } catch (error) {
            logger.error({
              msg: 'Error during funding fee collection',
              function: 'FundingFeeCollector.start',
              error,
            })
          }
        })
      },
      null, // onComplete
      false, // start
      'UTC' // timezone
    )

    // Start the cron job
    this.cronJob.start()

    // Initial run immediately
    TraceContext.runWithTrace('funding-fee-collection-initial', async () => {
      try {
        await this.collectFundingFees()
      } catch (error) {
        logger.error({
          msg: 'Error during initial funding fee collection',
          function: 'FundingFeeCollector.start',
          error,
        })
      }
    })

    logger.info({
      msg: 'FundingFeeCollector started successfully',
      function: 'FundingFeeCollector.start',
    })
  }

  /**
   * Stop the funding fee collector
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn({
        msg: 'FundingFeeCollector is not running',
        function: 'FundingFeeCollector.stop',
      })
      return
    }

    this.isRunning = false
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = undefined
    }

    logger.info({
      msg: 'FundingFeeCollector stopped successfully',
      function: 'FundingFeeCollector.stop',
    })
  }

  /**
   * Main collection workflow
   */
  private async collectFundingFees(): Promise<void> {
    try {
      logger.debug({
        msg: 'Starting funding fee collection cycle',
        function: 'FundingFeeCollector.collectFundingFees',
      })

      // Step 1: Query all tracked trades from Redis
      const allTrades = await this.state.getAllTrackedTrades()

      if (!allTrades || allTrades.length === 0) {
        logger.debug({
          msg: 'No tracked trades found',
          function: 'FundingFeeCollector.collectFundingFees',
        })
        return
      }

      // Step 2: Filter trades that need funding fee data
      const now = Date.now()
      const tradesToCollectFundingFees = this.filterTradesWithoutFundingFee(allTrades, now)

      // Step 3-5: Process each trade
      for (const trade of tradesToCollectFundingFees) {
        try {
          await this.collectFundingFeesForTrade(trade, now)
        } catch (error) {
          logger.error({
            msg: 'Failed to collect funding fees for a tracked trade',
            function: 'FundingFeeCollector.collectFundingFees',
            tradeId: trade.id,
            error,
          })
        }
      }
    } catch (error) {
      logger.error({
        msg: 'Error in funding fees collection cycle',
        function: 'FundingFeeCollector.collectFundingFees',
        error,
      })
      throw error
    }
  }

  /**
   * Filter trades that need funding fee data based on the logic specified
   */
  private filterTradesWithoutFundingFee(trades: TrackedTrade[], now: number): TrackedTrade[] {
    return trades.filter(trade => {
      if (trade.opportunity.isSpotSpot) return false

      const isBuyExchangeFundingDataNeeded = this.isExchangeFundingDataNeeded(
        trade.status,
        trade.buyExchangeNextFundingTimestamp,
        trade.exitTrade?.buyOrder?.timestamp,
        now
      )

      const isSellExchangeFundingDataNeeded = this.isExchangeFundingDataNeeded(
        trade.status,
        trade.sellExchangeNextFundingTimestamp,
        trade.exitTrade?.sellOrder?.timestamp,
        now
      )

      return isBuyExchangeFundingDataNeeded || isSellExchangeFundingDataNeeded
    })
  }

  /**
   * Determine if funding data is needed for an exchange
   */
  private isExchangeFundingDataNeeded(
    tradeStatus: 'open' | 'closed' | 'error',
    nextFundingTimestamp: number | undefined,
    closedTimestamp: number | undefined,
    now: number
  ): boolean {
    if (!nextFundingTimestamp) {
      return false
    }

    if (tradeStatus === 'open') {
      // OPEN: if nextFundingTimestamp < now - funding has occurred
      return nextFundingTimestamp < now
    } else if (tradeStatus === 'closed') {
      // CLOSED: if funding has occurred and trade was closed after funding
      return nextFundingTimestamp < now && nextFundingTimestamp < closedTimestamp!
    }

    return false
  }

  /**
   * Process funding data for a single trade
   */
  private async collectFundingFeesForTrade(trade: TrackedTrade, now: number): Promise<void> {
    if (trade.opportunity.isSpotSpot) return

    const isBuyExchangeFundingDataNeeded = this.isExchangeFundingDataNeeded(
      trade.status,
      trade.buyExchangeNextFundingTimestamp,
      trade.exitTrade?.buyOrder?.timestamp,
      now
    )

    const isSellExchangeFundingDataNeeded = this.isExchangeFundingDataNeeded(
      trade.status,
      trade.sellExchangeNextFundingTimestamp,
      trade.exitTrade?.sellOrder?.timestamp,
      now
    )

    const closedTimestamp = trade.status === 'closed' ? trade.exitTimestamp : undefined

    // Fetch funding data for both exchanges if needed
    const [buyExchangeFundingData, sellExchangeFundingData] = await Promise.all([
      isBuyExchangeFundingDataNeeded
        ? this.fetchExchangeFundingData(
            trade.opportunity.buyExchange,
            trade.opportunity.buyExchangeSymbol,
            trade.buyExchangeNextFundingTimestamp!,
            closedTimestamp
          )
        : Promise.resolve(null),
      isSellExchangeFundingDataNeeded
        ? this.fetchExchangeFundingData(
            trade.opportunity.sellExchange,
            trade.opportunity.sellExchangeSymbol,
            trade.sellExchangeNextFundingTimestamp!,
            closedTimestamp
          )
        : Promise.resolve(null),
    ])

    // Create a map of funding events by timestamp
    const fundingEventsMap = new Map<number, FundingFeeCollectedEvent>()

    // Initialize existing events
    if (trade.fundingEvents) {
      for (const event of trade.fundingEvents) {
        fundingEventsMap.set(event.fundingTimestamp, event)
      }
    }

    // Get all trades for proportional funding calculation
    const allTrades = await this.state.getAllTrackedTrades()

    // Process buy exchange funding data
    if (buyExchangeFundingData && isBuyExchangeFundingDataNeeded) {
      await this.processFundingDataForExchange(
        buyExchangeFundingData,
        trade,
        trade.buyExchangeNextFundingTimestamp!,
        fundingEventsMap,
        'buy',
        closedTimestamp,
        allTrades
      )
    }

    // Process sell exchange funding data
    if (sellExchangeFundingData && isSellExchangeFundingDataNeeded) {
      await this.processFundingDataForExchange(
        sellExchangeFundingData,
        trade,
        trade.sellExchangeNextFundingTimestamp!,
        fundingEventsMap,
        'sell',
        closedTimestamp,
        allTrades
      )
    }

    // Convert map back to sorted array
    const updatedFundingEvents = Array.from(fundingEventsMap.values())
      .filter(event => event.fundingTimestamp !== undefined)
      .sort((a, b) => a.fundingTimestamp - b.fundingTimestamp)

    // Calculate aggregate funding metrics
    const fundingMetrics = this.calculateFundingMetrics(updatedFundingEvents)

    // Calculate updated PnL including delta, funding fees, and trading fees
    const updatedPnLUsd = trade.deltaProfitUsd + fundingMetrics.fundingProfitUsd - trade.feesUsd.total
    const updatedPnLPercent = trade.deltaProfitPercent + fundingMetrics.fundingProfitPercent - trade.feesPercent.total

    // Update next funding timestamps from fundingService state if we populated new data
    let newBuyNextFundingTimestamp = trade.buyExchangeNextFundingTimestamp
    let newSellNextFundingTimestamp = trade.sellExchangeNextFundingTimestamp

    if (
      buyExchangeFundingData &&
      buyExchangeFundingData.combined.length > 0 &&
      isBuyExchangeFundingDataNeeded
    ) {
      const buyFundingData = this.fundingService.getSymbolFundingData(
        trade.opportunity.buyExchange,
        trade.opportunity.buyExchangeSymbol
      )

      if (!buyFundingData || buyFundingData.nextFundingTimestamp <= trade.buyExchangeNextFundingTimestamp!) {
        logger.error({
          msg: 'No funding data found for exchange:symbol. Next funding fee collection will be corrupted.',
          function: 'FundingFeeCollector.collectFundingFeesForTrade',
          tradeId: trade.id,
          exchange: trade.opportunity.buyExchange,
          symbol: trade.opportunity.buyExchangeSymbol,
          nextFundingTimestamp: newBuyNextFundingTimestamp,
          fundingData: buyExchangeFundingData,
          fundingEvents: updatedFundingEvents,
        })
        return
      }
      
      newBuyNextFundingTimestamp = buyFundingData.nextFundingTimestamp
    }

    if (
      sellExchangeFundingData &&
      sellExchangeFundingData.combined.length > 0 &&
      isSellExchangeFundingDataNeeded
    ) {
      const sellFundingData = this.fundingService.getSymbolFundingData(
        trade.opportunity.sellExchange,
        trade.opportunity.sellExchangeSymbol
      )

      if (!sellFundingData || sellFundingData.nextFundingTimestamp <= trade.sellExchangeNextFundingTimestamp!) {
        logger.error({
          msg: 'No funding data found for exchange:symbol. Next funding fee collection will be corrupted.',
          function: 'FundingFeeCollector.collectFundingFeesForTrade',
          tradeId: trade.id,
          exchange: trade.opportunity.sellExchange,
          symbol: trade.opportunity.sellExchangeSymbol,
          nextFundingTimestamp: newSellNextFundingTimestamp,
          fundingData: sellExchangeFundingData,
          fundingEvents: updatedFundingEvents,
        })
        return
      }
      
      newSellNextFundingTimestamp = sellFundingData.nextFundingTimestamp
    }

    // Update the trade with new funding data
    const updatedTrade: TrackedTrade = {
      ...trade,
      fundingEvents: updatedFundingEvents,
      buyExchangeNextFundingTimestamp: newBuyNextFundingTimestamp,
      sellExchangeNextFundingTimestamp: newSellNextFundingTimestamp,
      ...fundingMetrics,
      pnlUsd: updatedPnLUsd,
      pnlPercent: updatedPnLPercent,
      lastUpdateTimestamp: Date.now(),
    }

    // Save updated trade to Redis
    await this.state.saveTrackedTrade(updatedTrade)

    logger.info({
      msg: 'Funding fees collected for trade',
      function: 'FundingFeeCollector.collectFundingFeesForTrade',
      tradeId: trade.id,
      fundingEvents: updatedFundingEvents,
      buyExchangeNextFundingTimestamp: newBuyNextFundingTimestamp,
      sellExchangeNextFundingTimestamp: newSellNextFundingTimestamp,
      feesPercent: trade.feesPercent.total,
      slippagePercent: trade.slippagePercent.total,
      deltaProfitPercent: trade.deltaProfitPercent,
      fundingProfitPercent: fundingMetrics.fundingProfitPercent,
      pnlPercent: updatedPnLPercent,
    })
  }

  /**
   * Check if a timestamp is within the valid range for funding data collection
   */
  private isFundingEventInValidRange(
    timestamp: number,
    sinceTimestamp: number,
    closedTimestamp?: number
  ): boolean {
    const isAfterOrAt = timestamp >= sinceTimestamp
    const isBeforeClosed = !closedTimestamp || timestamp < closedTimestamp
    return isAfterOrAt && isBeforeClosed
  }

  /**
   * Fetch funding data (funding rate history and funding fees history) for an exchange
   */
  private async fetchExchangeFundingData(
    exchange: string,
    symbol: string,
    sinceTimestamp: number,
    closedTimestamp?: number
  ): Promise<{ fundingRateHistory: FundingRateHistory[]; fundingFeeHistory: FundingFeeHistory[]; combined: FundingRateAndFeeHistory[] } | null> {
    try {
      const restClient = this.restClients.get(exchange)
      if (!restClient) {
        logger.error({
          msg: 'REST client not found for exchange',
          function: 'FundingFeeCollector.fetchExchangeFundingData',
          exchange,
        })
        return null
      }

      // Fetch from 30 minutes earlier than the passed funding timestamp
      const since = sinceTimestamp - 30 * 60 * 1000

      // Fetch both funding rate history and funding fees history in parallel
      const [fundingRateHistorySince, fundingFeeHistorySince] = await Promise.all([
        restClient.fetchFundingRateHistory(symbol, since).catch(error => {
          logger.error({
            msg: 'Failed to fetch funding rate history',
            function: 'FundingFeeCollector.fetchExchangeFundingData',
            exchange,
            symbol,
            since,
            error,
          })
          return []
        }),
        restClient.fetchFundingFeeHistory(symbol, since).catch((error: any) => {
          logger.error({
            msg: 'Failed to fetch funding fees history',
            function: 'FundingFeeCollector.fetchExchangeFundingData',
            exchange,
            symbol,
            since,
            error,
          })
          return []
        }),
      ])

      if (fundingRateHistorySince.length === 0 || fundingFeeHistorySince.length === 0) {
        return null
      }

      const fundingRateHistory = fundingRateHistorySince.filter((data: FundingRateHistory) =>
        this.isFundingEventInValidRange(data.timestamp, sinceTimestamp, closedTimestamp)
      )
      const fundingFeeHistory = fundingFeeHistorySince.filter((data: FundingFeeHistory) =>
        this.isFundingEventInValidRange(data.timestamp, sinceTimestamp, closedTimestamp)
      )

      // Combine data by exact timestamp
      const combined = this.combineFundingRateAndFeeHistoryByTimestamp(exchange, symbol, fundingRateHistory, fundingFeeHistory)

      if (combined.length === 0) {
        return null
      }

      return {
        fundingRateHistory,
        fundingFeeHistory,
        combined,
      }
    } catch (error) {
      logger.error({
        msg: 'Error fetching funding rate and fee history',
        function: 'FundingFeeCollector.fetchExchangeFundingData',
        exchange,
        symbol,
        error,
      })
      return null
    }
  }

  /**
   * Combine funding rate and fee history by exact timestamp
   */
  private combineFundingRateAndFeeHistoryByTimestamp(
    exchange: string,
    symbol: string,
    rateHistory: FundingRateHistory[],
    feeHistory: FundingFeeHistory[]
  ): FundingRateAndFeeHistory[] {
    const combinedMap = new Map<number, FundingRateAndFeeHistory>()

    // Add fee data
    const isInverse = getMarketTypeFromUnifiedSymbol(symbol) === MarketType.INVERSE_PERP
    for (const fee of feeHistory) {
      let fundingFeeUsd = fee.amount
      // Inverse perp fees are denominated in base asset; convert to USD via current mid-price
      if (isInverse) {
        const topOfBook = this.orderbookManager?.getTopOfBook(exchange, symbol)
        if (topOfBook) {
          const midPrice = (topOfBook.bestBid.price + topOfBook.bestAsk.price) / 2
          fundingFeeUsd = fee.amount * midPrice
        } else {
          logger.warn({
            msg: 'No orderbook data for inverse perp fee USD conversion; storing base-asset amount',
            function: 'FundingFeeCollector.combineFundingRateAndFeeHistoryByTimestamp',
            exchange,
            symbol,
            baseAmount: fee.amount,
          })
        }
      }
      combinedMap.set(fee.timestamp, {
        fundingRatePercent: 0,
        fundingFeeUsd,
        actualTimestamp: fee.actualTimestamp,
        timestamp: fee.timestamp,
        date: fee.datetime,
      })
    }

    // Add rate data
    for (const rate of rateHistory) {
      const existing = combinedMap.get(rate.timestamp)
      if (existing) {
        // Apply the sign from fundingFeeUsd to fundingRatePercent
        const feeSign = Math.sign(existing.fundingFeeUsd)
        const rateValuePercent = Math.abs(rate.fundingRate * 100)
        existing.fundingRatePercent = feeSign * rateValuePercent
      } else {
        combinedMap.set(rate.timestamp, {
          fundingRatePercent: rate.fundingRate * 100,
          fundingFeeUsd: 0,
          actualTimestamp: 0,
          timestamp: rate.timestamp,
          date: rate.datetime,
        })
      }
    }

    for (const [timestamp, entry] of combinedMap.entries()) {
      const isRateZero = entry.fundingRatePercent === 0
      const isFeeZero = entry.fundingFeeUsd === 0
      if ((isRateZero && !isFeeZero) || (!isRateZero && isFeeZero)) {
        logger.error({
          msg: 'Inconsistent funding data: fundingRatePercent or fundingFeeUsd is zero but the other is non-zero',
          function: 'FundingFeeCollector.combineFundingRateAndFeeHistoryByTimestamp',
          exchange,
          symbol,
          fundingRatePercent: entry.fundingRatePercent,
          fundingFeeUsd: entry.fundingFeeUsd,
          timestamp,
          date: entry.date,
        })
        return []
      }
    }

    return Array.from(combinedMap.values()).sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Process funding data for a specific exchange and add to events map
   */
  private async processFundingDataForExchange(
    fundingData: { fundingRateHistory: FundingRateHistory[]; fundingFeeHistory: FundingFeeHistory[]; combined: FundingRateAndFeeHistory[] },
    currentTrade: TrackedTrade,
    nextFundingTimestamp: number,
    fundingEventsMap: Map<number, FundingFeeCollectedEvent>,
    exchangeType: 'buy' | 'sell',
    closedTimestamp: number | undefined,
    allTrades: TrackedTrade[]
  ): Promise<void> {
    // Filter combined data to only include those from (and including) nextFundingTimestamp onwards
    const relevantFundingData = fundingData.combined.filter(data =>
      this.isFundingEventInValidRange(data.timestamp, nextFundingTimestamp, closedTimestamp)
    )

    // Process each funding event
    for (const data of relevantFundingData) {
      const fundingTimestamp = data.timestamp
      let fundingEvent = fundingEventsMap.get(fundingTimestamp)

      if (!fundingEvent) {
        fundingEvent = {
          netFundingRatePercent: 0,
          buyExchangeFundingRatePercent: 0,
          sellExchangeFundingRatePercent: 0,
          netFundingFeeUsd: 0,
          buyExchangeFundingFeeUsd: 0,
          sellExchangeFundingFeeUsd: 0,
          buyExchangeActualFundingDate: '',
          sellExchangeActualFundingDate: '',
          fundingTimestamp,
          fundingDate: data.date
        }
        fundingEventsMap.set(fundingTimestamp, fundingEvent)
      }

      // Calculate proportional funding amount for this trade
      const proportionalFundingFeeUsd = this.calculateProportionalFunding(
        currentTrade,
        fundingTimestamp,
        data.fundingFeeUsd,
        allTrades
      )

      if (exchangeType === 'buy') {
        fundingEvent.buyExchangeFundingRatePercent = data.fundingRatePercent
        fundingEvent.buyExchangeFundingFeeUsd = proportionalFundingFeeUsd
        fundingEvent.buyExchangeActualFundingDate = new Date(data.actualTimestamp).toISOString()
      } else if (exchangeType === 'sell') {
        fundingEvent.sellExchangeFundingRatePercent = data.fundingRatePercent
        fundingEvent.sellExchangeFundingFeeUsd = proportionalFundingFeeUsd
        fundingEvent.sellExchangeActualFundingDate = new Date(data.actualTimestamp).toISOString()
      } else {
        logger.error({
          msg: 'Invalid exchange type for funding fee collection',
          function: 'FundingFeeCollector.processFundingDataForExchange',
          exchangeType,
          fundingTimestamp,
          actualTimestamp: data.actualTimestamp,
          fundingRatePercent: data.fundingRatePercent,
          fundingFeeUsd: data.fundingFeeUsd,
        })
        return
      }

      // Recalculate net values
      fundingEvent.netFundingRatePercent = fundingEvent.buyExchangeFundingRatePercent + fundingEvent.sellExchangeFundingRatePercent
      fundingEvent.netFundingFeeUsd = fundingEvent.buyExchangeFundingFeeUsd + fundingEvent.sellExchangeFundingFeeUsd
    }
  }

  /**
   * Calculate proportional funding for a trade based on its share of the total position
   */
  private calculateProportionalFunding(
    currentTrade: TrackedTrade,
    fundingTimestamp: number,
    totalFundingFeeUsd: number,
    allTrades: TrackedTrade[]
  ): number {
    // Find all trades that have the same exchange:symbol and include this funding timestamp
    const relevantTrades = allTrades.filter(trade => {
      // Check if trade was active at the funding timestamp
      const wasTradeActive = trade.entryTimestamp <= fundingTimestamp && 
        (!trade.exitTimestamp || trade.exitTimestamp >= fundingTimestamp)

      if (!wasTradeActive) {
        return false
      }

      // Check if this funding timestamp matches either exchange
      const matchesBuyExchange = trade.opportunity.buyExchange === currentTrade.opportunity.buyExchange && 
        trade.opportunity.buyExchangeSymbol === currentTrade.opportunity.buyExchangeSymbol
      const matchesSellExchange = trade.opportunity.sellExchange === currentTrade.opportunity.sellExchange && 
        trade.opportunity.sellExchangeSymbol === currentTrade.opportunity.sellExchangeSymbol

      return matchesBuyExchange || matchesSellExchange
    })

    if (relevantTrades.length === 0) {
      return totalFundingFeeUsd
    }

    // Calculate total normalized volume across all relevant trades
    const totalVolume = relevantTrades.reduce((sum, trade) => {
      return sum + trade.opportunity.normalizedVolume
    }, 0)

    if (totalVolume === 0) {
      return 0
    }

    // Calculate proportional share for current trade
    const currentTradeVolume = currentTrade.opportunity.normalizedVolume
    const proportionalShare = currentTradeVolume / totalVolume

    return totalFundingFeeUsd * proportionalShare
  }

  /**
   * Calculate aggregate funding metrics from funding events
   */
  private calculateFundingMetrics(fundingEvents: FundingFeeCollectedEvent[]): {
    fundingProfitUsd: number
    fundingProfitPercent: number
    fundingUsd: { buyExchange: number; sellExchange: number; net: number }
    fundingPercent: { buyExchange: number; sellExchange: number; net: number }
  } {
    let totalBuyExchangeUsd = 0
    let totalSellExchangeUsd = 0
    let totalNetUsd = 0

    let totalBuyExchangePercent = 0
    let totalSellExchangePercent = 0
    let totalNetPercent = 0

    for (const event of fundingEvents) {
      totalBuyExchangeUsd += event.buyExchangeFundingFeeUsd
      totalSellExchangeUsd += event.sellExchangeFundingFeeUsd
      totalNetUsd += event.netFundingFeeUsd

      totalBuyExchangePercent += event.buyExchangeFundingRatePercent
      totalSellExchangePercent += event.sellExchangeFundingRatePercent
      totalNetPercent += event.netFundingRatePercent
    }

    return {
      fundingProfitUsd: totalNetUsd,
      fundingProfitPercent: totalNetPercent,
      fundingUsd: {
        buyExchange: totalBuyExchangeUsd,
        sellExchange: totalSellExchangeUsd,
        net: totalNetUsd,
      },
      fundingPercent: {
        buyExchange: totalBuyExchangePercent,
        sellExchange: totalSellExchangePercent,
        net: totalNetPercent,
      },
    }
  }

}

