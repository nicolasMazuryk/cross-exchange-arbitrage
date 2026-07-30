import { WebsocketClientV3, WS_KEY_MAP } from 'bitget-api'
import { BasePrivateWebSocketClient } from './base'
import { WebSocketConfig, PrivateWebSocketMessageParser } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderType, OrderStatus, PositionSide, MarketType } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { convertExchangeSymbolToUnifiedSymbol, positionId } from '../../../utils/utils'

// V3/UTA payload items carry their own `category` field (SPOT | USDT-FUTURES | COIN-FUTURES | USDC-FUTURES)
// since subscriptions are no longer split per instType (everything subscribes under instType 'UTA').
function bitgetCategoryToMarketType(category: string): MarketType {
  const upper = category.toUpperCase()
  if (upper === 'SPOT') return MarketType.SPOT
  if (upper === 'COIN-FUTURES' || upper === 'DMCBL' || upper === 'COIN_FUTURES') return MarketType.INVERSE_PERP
  if (upper === 'USDT-FUTURES' || upper === 'USDC-FUTURES' || upper === 'UMCBL' || upper === 'USDT_FUTURES' || upper === 'USDC_FUTURES') return MarketType.LINEAR_PERP
  throw new Error(`unknown bitget category: ${category}`)
}

function bitgetCategoryToQuote(category: string): string | undefined {
  const upper = category.toUpperCase()
  if (upper === 'COIN-FUTURES' || upper === 'DMCBL' || upper === 'COIN_FUTURES') return 'USD'
  if (upper === 'USDT-FUTURES' || upper === 'UMCBL' || upper === 'USDT_FUTURES') return 'USDT'
  if (upper === 'USDC-FUTURES' || upper === 'USDC_FUTURES') return 'USDC'
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

  protected createClient(): WebsocketClientV3 {
    return new WebsocketClientV3({
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
    // V3/UTA: a single account spans all product types — every private topic subscribes under instType 'UTA'.
    const ACCOUNT_INST_TYPE = 'UTA'
    this.client.subscribe(
      (['account', 'position', 'order'] as const).map(topic => ({
        topic,
        payload: { instType: ACCOUNT_INST_TYPE },
      })),
      WS_KEY_MAP.v3Private
    )

    logger.info({
      msg: 'Subscribed to account WebSocket streams',
      function: 'BitgetPrivateWebSocketClient.subscribeToAccountStreams',
      exchange: this.exchangeName,
    })
  }
}

// Field names below follow bitget-api's V3 REST response DTOs (AccountAssetV3, CurrentPositionV3, OrderInfoV3) —
// the closest authoritative reference available (the package ships no WS-specific payload types for V3).
// TEMP-VERIFY: confirm these against a live UTA `update` event per channel before trusting them long-term.
class BitgetPrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    const balances: BalanceInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const wallet of data.data) {
        // TEMP-VERIFY: raw UTA account push payload
        logger.debug({ msg: 'TEMP-VERIFY raw balance update', function: 'BitgetPrivateMessageParser.parseBalanceUpdate', wallet })
        balances.push({
          asset: wallet.coin,
          total: parseFloat(wallet.equity),
          available: parseFloat(wallet.available),
        })
      }
    }

    return balances
  }

  parsePositionUpdate(data: any, restClient: RestClientInterface): PositionInfo[] {
    const positions: PositionInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const position of data.data) {
        // TEMP-VERIFY: raw UTA position push payload
        logger.debug({ msg: 'TEMP-VERIFY raw position update', function: 'BitgetPrivateMessageParser.parsePositionUpdate', position })

        if (!position.category) throw new Error(`bitget private position update missing category: ${JSON.stringify(position)}`)
        const marketType = bitgetCategoryToMarketType(position.category)

        const meta = restClient.getMarketMetadataService().getMetadataByNativeId(position.symbol, marketType)
        let symbol: string
        if (meta) {
          symbol = meta.symbol
        } else {
          const quote = bitgetCategoryToQuote(position.category)
          if (!quote) {
            logger.warn({
              msg: 'Bitget WS: cannot resolve position symbol, unknown category quote',
              function: 'BitgetPrivateMessageParser.parsePositionUpdate',
              nativeSymbol: position.symbol,
              category: position.category,
            })
            continue
          }
          symbol = convertExchangeSymbolToUnifiedSymbol(position.symbol, marketType, quote)
        }
        const positionSide = position.posSide.toUpperCase() as PositionSide
        const updatedTime = Number(position.updatedTime)

        positions.push({
          id: positionId(symbol, positionSide),
          symbol: symbol,
          side: positionSide,
          size: Math.abs(parseFloat(position.total)),
          entryPrice: parseFloat(position.avgPrice) || 0,
          leverage: parseFloat(position.leverage) || 1,
          unrealizedPnL: parseFloat(position.unrealisedPnl) || 0,
          timestamp: updatedTime,
          date: new Date(updatedTime),
          marketType,
        })
      }
    }

    return positions
  }

  parseOrderUpdate(data: any, restClient: RestClientInterface): OrderInfo[] {
    const orders: OrderInfo[] = []

    if (data.data && Array.isArray(data.data)) {
      for (const order of data.data) {
        // TEMP-VERIFY: raw UTA order push payload
        logger.debug({ msg: 'TEMP-VERIFY raw order update', function: 'BitgetPrivateMessageParser.parseOrderUpdate', order })

        if (!order.category) throw new Error(`bitget private order update missing category: ${JSON.stringify(order)}`)
        const marketType = bitgetCategoryToMarketType(order.category)

        const orderMeta = restClient.getMarketMetadataService().getMetadataByNativeId(order.symbol, marketType)
        let orderSymbol: string
        if (orderMeta) {
          orderSymbol = orderMeta.symbol
        } else {
          const quote = bitgetCategoryToQuote(order.category)
          if (!quote) {
            logger.warn({
              msg: 'Bitget WS: cannot resolve order symbol, unknown category quote',
              function: 'BitgetPrivateMessageParser.parseOrderUpdate',
              nativeSymbol: order.symbol,
              category: order.category,
            })
            continue
          }
          orderSymbol = convertExchangeSymbolToUnifiedSymbol(order.symbol, marketType, quote)
        }
        const updatedTime = parseInt(order.updatedTime)
        orders.push({
          id: order.orderId,
          clientOrderId: order.clientOid,
          symbol: orderSymbol,
          exchange: EXCHANGE_NAME,
          orderSide: order.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
          positionSide: order.posSide.toUpperCase() as PositionSide,
          type: order.orderType.toUpperCase() as OrderType,
          price: parseFloat(order.price) || 0,
          averagePrice: parseFloat(order.avgPrice) || 0,
          quantity: parseFloat(order.qty),
          status: this.normalizeOrderStatus(order.orderStatus),
          timestamp: updatedTime,
          date: new Date(updatedTime),
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
    return data.arg && data.arg.channel === 'position'
  }

  isOrderMessage(data: any): boolean {
    return data.arg && data.arg.channel === 'order'
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
