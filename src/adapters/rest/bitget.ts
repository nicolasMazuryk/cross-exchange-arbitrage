import { BaseExchange } from './base'
import { ExchangeConfig, ExchangeOrderParams } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { MarketType, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import { Logger } from '../../utils/logger'
import { getOrderSide, positionId, getMarketTypeFromUnifiedSymbol, quoteCurrenciesFor } from '../../utils/utils'

const EXCHANGE_NAME = 'bitget'
const CCXT_EXCHANGE_NAME = 'bitget'
const FUNDING_ENDPOINT = 'https://www.bitget.com/v1/mcp/contract/symbols?businessLine=10'

const logger = new Logger(`rest-${EXCHANGE_NAME}`)

export const BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE: Record<string, string> = {
  USDT: 'USDT-FUTURES',
  USDC: 'SUSDC-FUTURES',
}

export class BitgetExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  paramsForMarket(marketType: MarketType, ctx?: { symbol?: string; quote?: string }): Record<string, any> {
    if (marketType === MarketType.SPOT) return { productType: 'SPOT' }
    if (marketType === MarketType.INVERSE_PERP) return { productType: 'COIN-FUTURES', hedged: true }
    if (marketType === MarketType.LINEAR_PERP) {
      let quote = ctx?.quote
      if (!quote && ctx?.symbol) {
        try { quote = this.getMarketMetadataService().getQuoteFor(ctx.symbol) } catch (_) { /* metadata not yet initialised */ }
      }
      const productType = (quote && BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[quote]) ?? 'USDT-FUTURES'
      return { productType, hedged: true }
    }
    throw new Error(`unsupported market type: ${marketType}`)
  }

  protected getExchangeOrderParams(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    baseParams: ExchangeOrderParams = {}
  ): ExchangeOrderParams {
    return {
      ...baseParams,
      hedged: true, // Bitget requires hedged parameter
    }
  }

  protected getExchangeFundingFeeHistoryParams(symbol: string): any {
    const mt = getMarketTypeFromUnifiedSymbol(symbol)
    return { subType: mt === MarketType.INVERSE_PERP ? 'inverse' : 'linear' }
  }

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const skipKeys = new Set(['info', 'free', 'used', 'total', 'datetime', 'timestamp'])
      for (const [asset, entry] of Object.entries(balances)) {
        if (skipKeys.has(asset)) continue
        const b = entry as any
        const total = b?.total ?? 0
        if (total > 0) balanceInfos.push({ asset, total, available: b?.free ?? 0 })
      }

      if (balanceInfos.length === 0) {
        logger.warn({
          msg: 'No balance entries returned by exchange',
          function: 'BitgetExchange.fetchBalancesSnapshot',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
      }

      logger.debug({
        msg: 'Fetched balance snapshot',
        function: 'BitgetExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: balanceInfos.length,
      })
      return balanceInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch balance snapshot from exchange',
        function: 'BitgetExchange.fetchBalancesSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
    try {
      const positions = await this.exchange.fetchPositions()
      const positionInfos: PositionInfo[] = []

      for (const position of positions) {
        const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp, contracts, contractSize } = position
        const size = Math.abs(contracts! * contractSize!)
        positionInfos.push({
          id: positionId(symbol, side!.toUpperCase() as PositionSide),
          symbol: symbol,
          side: side!.toUpperCase() as PositionSide,
          size: size,
          entryPrice: entryPrice!,
          leverage: Number(leverage) || 1,
          unrealizedPnL: unrealizedPnl!,
          timestamp: timestamp!,
          date: new Date(timestamp!),
          marketType: getMarketTypeFromUnifiedSymbol(symbol),
        })
      }

      logger.debug({
        msg: 'Fetched positions snapshot',
        function: 'BitgetExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: positionInfos.length,
      })
      return positionInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch positions snapshot from exchange',
        function: 'BitgetExchange.fetchPositionsSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        error,
      })
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
      const orderInfos: OrderInfo[] = []

      for (const order of orders) {
        orderInfos.push({
          id: order.id || '',
          clientOrderId: order.clientOrderId || '',
          exchange: EXCHANGE_NAME,
          symbol: order.symbol || '',
          orderSide: getOrderSide(order.info.posSide, order.info.tradeSide),
          positionSide: order.info.posSide.toUpperCase() as PositionSide,
          type: order.type!.toUpperCase() as OrderType,
          price: order.price || 0,
          averagePrice: order.average || 0,
          quantity: order.amount,
          status: this.normalizeOrderStatus(order.status || ''),
          timestamp: order.timestamp,
          date: new Date(order.timestamp),
        })
      }

      logger.debug({
        msg: 'Fetched orders snapshot',
        function: 'BitgetExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        count: orderInfos.length,
      })
      return orderInfos
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch orders snapshot from exchange',
        function: 'BitgetExchange.fetchOrdersSnapshot',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        symbol: symbol || 'all',
        error,
      })
      throw error
    }
  }

  private normalizeOrderStatus(bitgetStatus: string): OrderStatus {
    switch (bitgetStatus.toUpperCase()) {
      case 'OPEN':
        return 'NEW'
      case 'CLOSED':
        return 'FILLED'
      case 'CANCELED':
        return 'CANCELED'
      case 'REJECTED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }

  /**
   * Fetch funding data from Bitget
   * URL: https://www.bitget.com/v1/mcp/contract/symbols?businessLine=10
   * Response structure: {"code":"200","data":{"listDTOS":[{"symbolDTOList":[{"baseSymbol":"BTC","flv":"-0.003","fuv":"0.003","lsfRc":8}]}]}}
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      if (!FUNDING_ENDPOINT) {
        logger.error({
          msg: 'No funding endpoint configured',
          function: 'BitgetExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      const quotes = quoteCurrenciesFor(EXCHANGE_NAME)

      const [rawJson, inverseFundingRates, ...ccxtFundingRatesList] = await Promise.all([
        fetchJsonFromUrl(FUNDING_ENDPOINT),
        this.exchange.fetchFundingRates(undefined, { subType: 'inverse', productType: 'COIN-FUTURES' }),
        ...quotes
          .filter(q => BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[q])
          .map(q => this.exchange.fetchFundingRates(undefined, { subType: 'linear', productType: BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[q] })),
      ])

      if (
        !rawJson ||
        !rawJson.data ||
        !rawJson.data.listDTOS ||
        !Array.isArray(rawJson.data.listDTOS) ||
        !rawJson.data.listDTOS[0].symbolDTOList ||
        !Array.isArray(rawJson.data.listDTOS[0].symbolDTOList)
      ) {
        logger.error({
          msg: 'Invalid funding data structure received from Bitget',
          function: 'BitgetExchange.fetchFundingData',
          exchange: EXCHANGE_NAME,
          exchangeId: this.exchangeId,
        })
        return new Map()
      }

      const ccxtFundingRates = Object.assign({}, ...ccxtFundingRatesList)
      const ccxtFundingRatesValues = Object.values(ccxtFundingRates)

      const quotesSet = new Set(quotes)
      const metadata = this.getMarketMetadataService()

      // Extract and filter symbols for all enabled quote currencies
      const usdtSymbolsFundingData = rawJson.data.listDTOS[0].symbolDTOList
        .filter(
          (item: any) =>
            item.symbolDisplayName &&
            quotesSet.has(item.pricedSymbol?.toUpperCase()) &&
            item.lsfRc !== undefined
        )
        .flatMap((item: any) => {
          const q = item.pricedSymbol?.toUpperCase()
          if (!q) {
            logger.warn({
              msg: 'Funding symbol missing pricedSymbol, skipping',
              function: 'BitgetExchange.fetchFundingData',
              exchange: EXCHANGE_NAME,
              symbolDisplayName: item.symbolDisplayName,
            })
            return []
          }
          const meta = metadata.getMetadataByNativeId(item.symbolDisplayName, MarketType.LINEAR_PERP)
          return [{
            ...item,
            symbol: meta?.symbol ?? `${item.baseSymbol}/${q}:${q}`,
          }]
        })

      const fundingData = new Map<string, ParsedFunding>()

      for (const item of usdtSymbolsFundingData) {
        // Find the ccxt funding data for the item. CCXT return inconsistent symbol format, so we need to find based on "info" property.
        const ccxtFundingData = ccxtFundingRatesValues.find(
          (ccxtFundingData: any) => ccxtFundingData.info.symbol === `${item.baseSymbol}${item.pricedSymbol}`
        ) as any
        // Calculate next funding time (Bitget doesn't provide this directly)
        const fundingInterval = parseInt(item.lsfRc)
        const intervalMs = fundingInterval * 60 * 60 * 1000
        const now = Date.now()
        const nextFundingTimestamp = Math.ceil(now / intervalMs) * intervalMs

        if (
          !ccxtFundingData ||
          typeof ccxtFundingData.fundingRate !== 'number' ||
          isNaN(ccxtFundingData.fundingRate) ||
          !fundingInterval ||
          !nextFundingTimestamp
        ) {
          logger.warn({
            msg: 'Invalid funding data values for symbol',
            function: 'BitgetExchange.fetchFundingData',
            exchange: EXCHANGE_NAME,
            exchangeId: this.exchangeId,
            symbol: item.symbol,
            hasCcxtData: !!ccxtFundingData,
            fundingRate: ccxtFundingData?.fundingRate,
            fundingInterval: item.lsfRc,
          })
          continue
        }

        const parsedFunding: ParsedFunding = {
          exchange: EXCHANGE_NAME,
          symbol: item.symbol,
          fundingRate: ccxtFundingData.fundingRate,
          fundingRatePercent: ccxtFundingData.fundingRate * 100,
          fundingInterval,
          nextFundingTimestamp,
          nextFundingDatetime: new Date(nextFundingTimestamp),
        }

        fundingData.set(item.symbol, parsedFunding)
      }

      // Add inverse (COIN-FUTURES) funding rates fetched via CCXT
      const inverseIntervalHours = 8
      const inverseIntervalMs = inverseIntervalHours * 60 * 60 * 1000
      for (const [unifiedSymbol, rateData] of Object.entries(inverseFundingRates)) {
        if (!rateData || typeof (rateData as any).fundingRate !== 'number' || isNaN((rateData as any).fundingRate)) continue
        const rate = rateData as any
        const nextFundingTimestamp = Math.ceil(Date.now() / inverseIntervalMs) * inverseIntervalMs
        fundingData.set(unifiedSymbol, {
          exchange: EXCHANGE_NAME,
          symbol: unifiedSymbol,
          fundingRate: rate.fundingRate,
          fundingRatePercent: rate.fundingRate * 100,
          fundingInterval: inverseIntervalHours,
          nextFundingTimestamp,
          nextFundingDatetime: new Date(nextFundingTimestamp),
        })
      }

      logger.debug({
        msg: 'Parsed funding rates',
        function: 'BitgetExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        count: fundingData.size,
      })
      return fundingData
    } catch (error) {
      logger.error({
        msg: 'Failed to fetch funding data from exchange',
        function: 'BitgetExchange.fetchFundingData',
        exchange: EXCHANGE_NAME,
        exchangeId: this.exchangeId,
        endpoint: FUNDING_ENDPOINT,
        error,
      })
      return new Map()
    }
  }
}
