import { WebsocketClientV2 } from 'bitget-api'
import { BasePrivateWebSocketClient } from './base'
import { WebSocketConfig, PrivateWebSocketMessageParser } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderType, OrderStatus, PositionSide, MarketType } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { convertExchangeSymbolToUnifiedSymbol, getOrderSide, positionId, quoteCurrenciesFor } from '../../../utils/utils'
import { BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE } from '../../rest/bitget'
import appConfig from '../../../utils/config'

function bitgetInstTypeToMarketType(instType: string): MarketType {
  const upper = instType.toUpperCase()
  if (upper === 'SPOT') return MarketType.SPOT
  if (upper === 'COIN-FUTURES' || upper === 'DMCBL' || upper === 'COIN_FUTURES') return MarketType.INVERSE_PERP
  if (upper === 'USDT-FUTURES' || upper === 'UMCBL' || upper === 'USDT_FUTURES') return MarketType.LINEAR_PERP
  throw new Error(`unknown bitget instType: ${instType}`)
}

function bitgetInstTypeToQuote(instType: string): string | undefined {
  const upper = instType.toUpperCase()
  if (upper === 'COIN-FUTURES' || upper === 'DMCBL' || upper === 'COIN_FUTURES') return 'USD'
  if (upper === 'USDT-FUTURES' || upper === 'UMCBL' || upper === 'USDT_FUTURES') return 'USDT'
  if (upper === 'SUSDC-FUTURES') return 'USDC'
  return undefined
}

const EXCHANGE_NAME = 'bitget'

const logger = new Logger(`ws-private-${EXCHANGE_NAME}`)

export class BitgetPrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BitgetPrivateMessageParser

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new BitgetPrivateMessageParser()
  }

  protected createClient(): WebsocketClientV2 {
    return new WebsocketClientV2({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      apiPass: this.config.apiPass,
    })
  }

  protected setupEventHandlers(): void {
    let errorHandled = false

    this.client.on('open', (data: any) => {
      logger.debug({
        msg: 'Account WebSocket connection opened',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('close', () => {
      if (errorHandled) return
      errorHandled = true
      logger.warn({
        msg: 'WebSocket connection closed',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('response', (data: any) => {
      logger.debug({
        msg: 'Account WebSocket reply received',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.response',
        exchange: this.exchangeName,
        data,
      })
    })

    this.client.on('reconnect', (data: any) => {
      logger.info({
        msg: 'WebSocket reconnecting',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.reconnect',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'WebSocket reconnected',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.reconnected',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('exception', (error: any) => {
      if (errorHandled) return
      errorHandled = true
      
      logger.error({
        msg: 'WebSocket error',
        function: 'BitgetPrivateWebSocketClient.setupEventHandlers.error',
        exchange: this.exchangeName,
        error,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('update', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error({
          msg: 'Error parsing Account WebSocket message',
          function: 'BitgetPrivateWebSocketClient.setupEventHandlers.update',
          exchange: this.exchangeName,
          error,
        })
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    // SPOT only supports account (balance) — positions/orders are futures-only on Bitget
    this.client.subscribeTopic('SPOT' as any, 'account', 'default')

    // Derive perp instTypes from config: use BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE for linear, COIN-FUTURES for inverse
    const enabledQuotes = quoteCurrenciesFor('bitget')
    const enabledMarketTypes = appConfig.exchanges.bitget.enabledMarketTypes
    const perpInstTypes: string[] = []
    for (const quote of enabledQuotes) {
      const productType = BITGET_LINEAR_PRODUCT_TYPE_FOR_QUOTE[quote]
      if (productType && !perpInstTypes.includes(productType)) {
        perpInstTypes.push(productType)
      } else if (!productType) {
        logger.warn({
          msg: 'No Bitget linear instType mapping for quote, skipping subscription',
          function: 'BitgetPrivateWebSocketClient.subscribeToAccountStreams',
          quote,
        })
      }
    }
    if (!enabledMarketTypes || enabledMarketTypes.includes(MarketType.INVERSE_PERP)) {
      perpInstTypes.push('COIN-FUTURES')
    }

    for (const instType of perpInstTypes) {
      this.client.subscribeTopic(instType as any, 'account', 'default')
      this.client.subscribeTopic(instType as any, 'positions', 'default')
      this.client.subscribeTopic(instType as any, 'orders', 'default')
    }

    logger.info({
      msg: 'Subscribed to account WebSocket streams',
      function: 'BitgetPrivateWebSocketClient.subscribeToAccountStreams',
      exchange: this.exchangeName,
      perpInstTypes,
    })
  }
}

class BitgetPrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    const balances: BalanceInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const wallet of data.data) {
        balances.push({
          asset: wallet.marginCoin,
          total: parseFloat(wallet.equity),
          available: parseFloat(wallet.maxOpenPosAvailable),
        })
      }
    }

    return balances
  }

  parsePositionUpdate(data: any, restClient: RestClientInterface): PositionInfo[] {
    const positions: PositionInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      if (!data.arg?.instType) throw new Error(`bitget private position update missing data.arg.instType: ${JSON.stringify(data)}`)
      const instType = data.arg.instType
      const marketType = bitgetInstTypeToMarketType(instType)

      for (const position of data.data) {
        const meta = restClient.getMarketMetadataService().getMetadataByNativeId(position.instId, marketType)
        let symbol: string
        if (meta) {
          symbol = meta.symbol
        } else {
          const quote = bitgetInstTypeToQuote(instType)
          if (!quote) {
            logger.warn({
              msg: 'Bitget WS: cannot resolve position symbol, unknown instType quote',
              function: 'BitgetPrivateMessageParser.parsePositionUpdate',
              instId: position.instId,
              instType,
            })
            continue
          }
          symbol = convertExchangeSymbolToUnifiedSymbol(position.instId, marketType, quote)
        }
        const positionSide = position.holdSide.toUpperCase() as PositionSide

        positions.push({
          id: positionId(symbol, positionSide),
          symbol: symbol,
          side: positionSide,
          size: Math.abs(parseFloat(position.total)),
          entryPrice: parseFloat(position.openPriceAvg) || 0,
          leverage: parseFloat(position.leverage) || 1,
          unrealizedPnL: parseFloat(position.unrealizedPL) || 0,
          timestamp: Number(position.cTime),
          date: new Date(Number(position.cTime)),
          marketType,
        })
      }
    }

    return positions
  }

  parseOrderUpdate(data: any, restClient: RestClientInterface): OrderInfo[] {
    const orders: OrderInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      if (!data.arg?.instType) throw new Error(`bitget private order update missing data.arg.instType: ${JSON.stringify(data)}`)
      const instType = data.arg.instType
      const marketType = bitgetInstTypeToMarketType(instType)

      for (const order of data.data) {
        const orderMeta = restClient.getMarketMetadataService().getMetadataByNativeId(order.instId, marketType)
        let orderSymbol: string
        if (orderMeta) {
          orderSymbol = orderMeta.symbol
        } else {
          const quote = bitgetInstTypeToQuote(instType)
          if (!quote) {
            logger.warn({
              msg: 'Bitget WS: cannot resolve order symbol, unknown instType quote',
              function: 'BitgetPrivateMessageParser.parseOrderUpdate',
              instId: order.instId,
              instType,
            })
            continue
          }
          orderSymbol = convertExchangeSymbolToUnifiedSymbol(order.instId, marketType, quote)
        }
        orders.push({
          id: order.orderId,
          clientOrderId: order.clientOid,
          symbol: orderSymbol,
          exchange: EXCHANGE_NAME,
          orderSide: getOrderSide(order.posSide, order.tradeSide),
          positionSide: order.posSide.toUpperCase() as PositionSide,
          type: order.orderType.toUpperCase() as OrderType,
          price: parseFloat(order.price) || 0,
          averagePrice: parseFloat(order.priceAvg) || 0,
          quantity: parseFloat(order.size),
          status: this.normalizeOrderStatus(order.status),
          timestamp: parseInt(order.cTime),
          date: new Date(Number(order.cTime)),
          marketType,
        })
      }
    }

    return orders
  }

  isBalanceMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'account'
  }

  isPositionMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'positions'
  }

  isOrderMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'orders'
  }

  private normalizeOrderStatus(bitgetStatus: string): OrderStatus {
    switch (bitgetStatus) {
      case 'live':
        return 'NEW'
      case 'partially_filled':
        return 'PARTIALLY_FILLED'
      case 'filled':
        return 'FILLED'
      case 'canceled':
        return 'CANCELED'
      case 'failed':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
}
