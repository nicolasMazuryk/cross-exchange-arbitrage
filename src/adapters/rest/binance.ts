import ccxt, { Exchange, Market, Dictionary } from 'ccxt'
import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { Logger } from '../../utils/logger'
import { getPositionSide, positionId, getMarketTypeFromUnifiedSymbol } from '../../utils/utils'
import appConfig from '../../utils/config'

const EXCHANGE_NAME = 'binance'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export class BinanceExchange extends BaseExchange {
  // Binance routes across three CCXT instances — one per market type.
  // this.exchange (from super) is the linear instance for methods that haven't been overridden.
  private spotCcxt: Exchange
  private linearCcxt: Exchange
  private inverseCcxt: Exchange
  private mergedMarkets: Dictionary<Market> = {}

  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, 'binanceusdm', config)
    this.linearCcxt = this.exchange
    this.spotCcxt = this.makeCcxtInstance('binance', config)
    this.inverseCcxt = this.makeCcxtInstance('binancecoinm', config)
  }

  private makeCcxtInstance(ccxtId: string, config: ExchangeConfig): Exchange {
    return new (ccxt as any)[ccxtId]({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      agent: config.options?.agent,
      options: {
        warnOnFetchOpenOrdersWithoutSymbol: false,
        ...config.options,
      },
    })
  }

  protected ccxtForSymbol(symbol: string): Exchange {
    const mt = getMarketTypeFromUnifiedSymbol(symbol)
    if (mt === MarketType.SPOT) return this.spotCcxt
    if (mt === MarketType.INVERSE_PERP) return this.inverseCcxt
    if (mt === MarketType.LINEAR_PERP) return this.linearCcxt
    throw new Error(`unsupported market type for symbol ${symbol}: ${mt}`)
  }

  protected clientForSymbol(symbol?: string): Exchange {
    return symbol ? this.ccxtForSymbol(symbol) : this.linearCcxt
  }

  protected allClients(): Exchange[] {
    return [this.spotCcxt, this.linearCcxt, this.inverseCcxt]
  }

  protected symbolMarketType(symbol: string): MarketType {
    return getMarketTypeFromUnifiedSymbol(symbol)
  }

  async loadMarkets(): Promise<Dictionary<Market>> {
    const [spot, linear, inverse] = await Promise.all([
      this.spotCcxt.loadMarkets(),
      this.linearCcxt.loadMarkets(),
      this.inverseCcxt.loadMarkets(),
    ])
    this.mergedMarkets = { ...spot, ...linear, ...inverse }
    logger.debug({
      msg: 'Loaded markets from all Binance CCXT instances',
      function: 'BinanceExchange.loadMarkets',
      exchange: EXCHANGE_NAME,
      spotCount: Object.keys(spot).length,
      linearCount: Object.keys(linear).length,
      inverseCount: Object.keys(inverse).length,
      total: Object.keys(this.mergedMarkets).length,
    })
    return this.mergedMarkets
  }

  getAllMarkets(): Dictionary<Market> {
    return this.mergedMarkets
  }

  protected getExchangeFundingFeeHistoryParams(symbol: string): any {
    const mt = getMarketTypeFromUnifiedSymbol(symbol)
    return { subType: mt === MarketType.INVERSE_PERP ? 'inverse' : 'linear' }
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const enabledMarketTypes = appConfig.exchanges.binance.enabledMarketTypes!
      const result: BalanceInfo[] = []

      if (enabledMarketTypes.includes(MarketType.LINEAR_PERP)) {
        const balances = await this.linearCcxt.fetchBalance()
        const assets: any[] = balances.info?.assets || []
        for (const asset of assets) {
          const total = parseFloat(asset.walletBalance || '0')
          const available = parseFloat(asset.availableBalance || '0')
          if (total > 0) result.push({ asset: asset.asset, total, available })
        }
      }

      if (enabledMarketTypes.includes(MarketType.INVERSE_PERP)) {
        const balances = await this.inverseCcxt.fetchBalance()
        const assets: any[] = balances.info?.assets || []
        for (const asset of assets) {
          const total = parseFloat(asset.walletBalance || '0')
          const available = parseFloat(asset.availableBalance || '0')
          if (total > 0) result.push({ asset: asset.asset, total, available })
        }
      }

      if (enabledMarketTypes.includes(MarketType.SPOT)) {
        const balances = await this.spotCcxt.fetchBalance()
        for (const [asset, total] of Object.entries(balances.total || {})) {
          const totalNum = typeof total === 'number' ? total : 0
          if (totalNum > 0) result.push({ asset, total: totalNum, available: ((balances.free as any)[asset] as number) || 0 })
        }
      }

      logger.debug({
        msg: 'Fetched balance entries from exchange',
        function: 'BinanceExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        count: result.length,
      })
      return result
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'BinanceExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        error,
      })
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
    try {
      const [linearPositions, inversePositions] = await Promise.all([
        this.linearCcxt.fetchPositions(),
        this.inverseCcxt.fetchPositions(),
      ])
      const positionInfos: PositionInfo[] = []
      for (const [positions, marketType] of [
        [linearPositions, MarketType.LINEAR_PERP],
        [inversePositions, MarketType.INVERSE_PERP],
      ] as [any[], MarketType][]) {
        for (const position of positions) {
          const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp } = position
          positionInfos.push({
            id: positionId(symbol, side!.toUpperCase() as PositionSide),
            symbol,
            side: side!.toUpperCase() as PositionSide,
            size: Math.abs(position.contracts! * position.contractSize!),
            entryPrice: entryPrice!,
            leverage: Number(leverage) || 1,
            unrealizedPnL: unrealizedPnl!,
            timestamp: timestamp!,
            date: new Date(timestamp!),
            marketType,
          })
        }
      }
      logger.debug({
        msg: 'Fetched positions snapshot',
        function: 'BinanceExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'BinanceExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        error,
      })
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    try {
      const instances: Exchange[] = symbol ? [this.ccxtForSymbol(symbol)] : this.allClients()
      const ordersPerInstance = await Promise.all(instances.map(inst => inst.fetchOpenOrders(symbol)))
      const orders = ordersPerInstance.flat()
      const orderInfos: OrderInfo[] = []
      for (const order of orders) {
        orderInfos.push({
          id: String(order.id!),
          clientOrderId: order.clientOrderId!,
          exchange: EXCHANGE_NAME,
          symbol: order.symbol!,
          orderSide: order.side!.toUpperCase() as OrderSide,
          positionSide: getPositionSide(order.side!.toUpperCase() as OrderSide, order.reduceOnly!),
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status!),
          timestamp: order.timestamp,
          date: new Date(order.timestamp),
        })
      }
      logger.debug({
        msg: 'Fetched order entries from exchange',
        function: 'BinanceExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'BinanceExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
    switch (binanceStatus.toUpperCase()) {
      case 'OPEN':
        return 'NEW'
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELED'
      case 'REJECTED':
      case 'EXPIRED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }

  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      const [linearRates, linearIntervals, inverseRates, inverseIntervals] = await Promise.all([
        this.linearCcxt.fetchFundingRates(undefined, { subType: 'linear' }),
        this.linearCcxt.fetchFundingIntervals(undefined, { subType: 'linear' }),
        this.inverseCcxt.fetchFundingRates(undefined, { subType: 'inverse' }),
        this.inverseCcxt.fetchFundingIntervals(undefined, { subType: 'inverse' }),
      ])

      const intervalMap = new Map<string, number>()
      for (const [sym, data] of Object.entries({ ...linearIntervals, ...inverseIntervals })) {
        const hours = (data as any)?.info?.fundingIntervalHours
        if (typeof hours === 'number') intervalMap.set(sym, hours)
      }

      const allRates = { ...linearRates, ...inverseRates }
      const fundingData = new Map<string, ParsedFunding>()

      for (const [symbol, rate] of Object.entries(allRates)) {
        const r = rate as any
        if (typeof r.fundingRate !== 'number' || isNaN(r.fundingRate) || !r.fundingTimestamp) {
          logger.warn({
            msg: 'Skipping symbol with invalid funding data',
            function: 'BinanceExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
            fundingRate: r.fundingRate,
            fundingTimestamp: r.fundingTimestamp,
          })
          continue
        }

        let fundingInterval = intervalMap.get(symbol)
        if (fundingInterval === undefined) {
          logger.warn({
            msg: 'No interval data for symbol, defaulting to 8h',
            function: 'BinanceExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            symbol,
          })
          fundingInterval = 8
        }

        fundingData.set(symbol, {
          exchange: EXCHANGE_NAME,
          symbol,
          fundingRate: r.fundingRate,
          fundingRatePercent: r.fundingRate * 100,
          fundingInterval,
          nextFundingTimestamp: r.fundingTimestamp,
          nextFundingDatetime: new Date(r.fundingDatetime ?? r.fundingTimestamp),
        })
      }

      logger.debug({
        msg: 'Parsed funding rates from exchange',
        function: 'BinanceExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'BinanceExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        error,
      })
      return new Map()
    }
  }
}
