import { BaseExchange } from './base'
import { ExchangeConfig } from './types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide } from '../../types/exchange'
import { ParsedFunding } from '../../core/funding/types'
import { fetchJsonFromUrl } from '../../utils/browser'
import logger from '../../utils/logger'
import { getPositionSide, positionId } from '../../utils/utils'

const EXCHANGE_NAME = 'binance'
const CCXT_EXCHANGE_NAME = 'binanceusdm'
const FUNDING_ENDPOINT = 'https://www.binance.com/bapi/futures/v1/public/future/common/get-funding-info'

export class BinanceExchange extends BaseExchange {
  constructor(config: ExchangeConfig) {
    super(EXCHANGE_NAME, CCXT_EXCHANGE_NAME, config)
  }

  // Note: Binance doesn't require exchange-specific parameters for order creation
  // The base implementation will be used

  async fetchBalancesSnapshot(): Promise<BalanceInfo[]> {
    try {
      const balances = await this.exchange.fetchBalance()
      const balanceInfos: BalanceInfo[] = []

      const { availableBalance, totalWalletBalance } = balances.info
      balanceInfos.push({
        asset: 'USDT',
        total: parseFloat(totalWalletBalance),
        available: parseFloat(availableBalance)
      })

      logger.debug(`[${this.exchangeId}] Fetched ${balanceInfos.length} balance entries`)
      return balanceInfos
    } catch (error) {
      logger.error(`Error fetching balance snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchPositionsSnapshot(): Promise<PositionInfo[]> {
// TODO: review response structure and normalize it once NEW Binance account is created
    try {
      const positions = await this.exchange.fetchPositions()
      const positionInfos: PositionInfo[] = []

      for (const position of positions) {
        const { symbol, side, entryPrice, leverage, unrealizedPnl, timestamp } = position  
            positionInfos.push({
              id: positionId(symbol, side!.toUpperCase() as PositionSide),
              symbol: symbol,
              side: side!.toUpperCase() as PositionSide,
              size: Math.abs(position.contracts! * position.contractSize!),
              entryPrice: entryPrice!,
              leverage: Number(leverage) || 1,
              unrealizedPnL: unrealizedPnl!,
              timestamp: timestamp!,
              date: new Date(timestamp!)
              // liquidationPrice: liqPrice,
              // notional: notional,
            })
      }

      logger.debug(`[${this.exchangeId}] Fetched ${positionInfos.length} position entries`)
      return positionInfos
    } catch (error) {
      logger.error(`Error fetching position snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  async fetchOrdersSnapshot(symbol?: string): Promise<OrderInfo[]> {
    // TODO: review response structure and normalize it once NEW Binance account is created
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol)
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
          date: new Date(order.timestamp)
        })
      }

      logger.debug(`[${this.exchangeId}] Fetched ${orderInfos.length} order entries`)
      return orderInfos
    } catch (error) {
      logger.error(`Error fetching order snapshot on ${this.exchangeId}:`, error)
      throw error
    }
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
// TODO: review response structure and normalize it once NEW Binance account is created
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

  /**
   * Fetch funding data from Binance by combining browser data (funding interval) with ccxt data (funding rate and datetime)
   */
  async fetchFundingData(): Promise<Map<string, ParsedFunding>> {
    try {
      if (!FUNDING_ENDPOINT) {
        logger.warn(`[${this.exchangeId}] No funding endpoint configured`)
        return new Map()
      }

      const [rawJson, ccxtFundingRates] = await Promise.all([
        fetchJsonFromUrl(FUNDING_ENDPOINT),
        this.exchange.fetchFundingRates(undefined, { subType: 'linear' })
      ])
      
      if (!rawJson || !rawJson.data || !Array.isArray(rawJson.data)) {
        logger.warn(`[${this.exchangeId}] Invalid Binance funding data structure`)
        return new Map()
      }

      // Filter symbols in rawJson.data to only ones that end with 'USDT'
      const usdtSymbolsIntervalData = rawJson.data
        .filter((item: any) => 
          item.symbol && item.symbol.endsWith('USDT') && item.fundingIntervalHours !== undefined)
        .map((item: any) => ({
          ...item,
          symbol: item.symbol.replace('USDT', '/USDT:USDT')
        }))

      const fundingData = new Map<string, ParsedFunding>()
      
      for (const item of usdtSymbolsIntervalData) {
        const ccxtFundingData = ccxtFundingRates[item.symbol]

        if (!ccxtFundingData || typeof ccxtFundingData.fundingRate !== 'number' || isNaN(ccxtFundingData.fundingRate) || !ccxtFundingData.fundingTimestamp || !ccxtFundingData.fundingDatetime) {
          logger.warn(`[${this.exchangeId}] Invalid Binance funding data values: ${item.symbol}`)
          continue
        }
        
        const parsedFunding: ParsedFunding = {
          exchange: EXCHANGE_NAME,
          symbol: item.symbol,
          fundingRate: ccxtFundingData.fundingRate,
          fundingRatePercent: ccxtFundingData.fundingRate * 100,
          fundingInterval: item.fundingIntervalHours,
          nextFundingTimestamp: ccxtFundingData.fundingTimestamp,
          nextFundingDatetime: new Date(ccxtFundingData.fundingDatetime)
        }
        
        fundingData.set(item.symbol, parsedFunding)
      }

      logger.debug(`[${this.exchangeId}] Parsed ${fundingData.size} funding rates`)
      return fundingData
    } catch (error) {
      logger.error(`[${this.exchangeId}] Error fetching funding data:`, error)
      return new Map()
    }
  }
}

