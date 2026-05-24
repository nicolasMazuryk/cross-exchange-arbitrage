import { WebsocketClient, WebsocketAPIClient, WS_KEY_MAP } from 'binance'
import { BasePrivateWebSocketClient } from './base'
import { PrivateWebSocketMessageParser, WebSocketConfig } from '../types'
import { RestClientInterface } from '../../rest/types'
import { BalanceInfo, PositionInfo, OrderInfo } from '../../../types/account'
import { OrderSide, OrderType, OrderStatus, PositionSide, MarketType } from '../../../types/exchange'
import { Logger } from '../../../utils/logger'
import { getPositionSide, positionId, quoteCurrenciesFor } from '../../../utils/utils'
import { parseNativeSymbolToUnified } from '../../../core/markets/marketMetadataService'

const EXCHANGE_NAME = 'binance'

const logger = new Logger(`ws-private-${EXCHANGE_NAME}`)

function isCoinmWsKey(wsKey: string): boolean {
  return wsKey?.includes('coinM') || wsKey?.includes('coinm') || wsKey?.includes('coin_')
}


function coinmSymbolToUnified(exchangeSymbol: string): string {
  // BTCUSD_PERP → BTC/USD:BTC, ETHUSD_PERP → ETH/USD:ETH
  const withoutPerp = exchangeSymbol.replace('_PERP', '')
  const base = withoutPerp.replace(/USD$/, '')
  return `${base}/USD:${base}`
}

export class BinancePrivateWebSocketClient extends BasePrivateWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BinancePrivateMessageParser
  private wsapi!: WebsocketAPIClient

  constructor(config: WebSocketConfig, restClient: RestClientInterface) {
    super(config, restClient)
    this.messageParser = new BinancePrivateMessageParser()
  }

  protected createClient(): WebsocketClient {
    this.wsapi = new WebsocketAPIClient({
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      beautify: false,
      attachEventListeners: false,
    })
    return this.wsapi.getWSClient()
  }

  protected setupEventHandlers(): void {
    let errorHandled = false

    this.client.on('open', () => {
      logger.debug({
        msg: 'Account WebSocket connection opened',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.open',
        exchange: this.exchangeName,
      })
      this.isConnected = true
    })

    this.client.on('close', () => {
      if (errorHandled) return
      errorHandled = true
      logger.warn({
        msg: 'Account WebSocket connection closed',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('reply', (data: any) => {
      logger.debug({
        msg: 'Account WebSocket reply received',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reply',
        exchange: this.exchangeName,
        data,
      })
    })

    this.client.on('reconnecting', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnecting...',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reconnecting',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = false
    })

    this.client.on('reconnected', (data: any) => {
      logger.info({
        msg: 'Account WebSocket reconnected',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.reconnected',
        exchange: this.exchangeName,
        wsKey: data?.wsKey,
      })
      this.isConnected = true
    })

    this.client.on('error', (error: any) => {
      if (errorHandled) return
      errorHandled = true

      logger.error({
        msg: 'Account WebSocket error',
        function: 'BinancePrivateWebSocketClient.setupEventHandlers.error',
        exchange: this.exchangeName,
        error,
      })
      this.isConnected = false
      this.handleConnectionError()
    })

    this.client.on('message', (data: any) => {
      try {
        this.handleMessage(data)
      } catch (error) {
        logger.error({
          msg: 'Error parsing Account WebSocket message',
          function: 'BinancePrivateWebSocketClient.setupEventHandlers.message',
          exchange: this.exchangeName,
          error,
        })
      }
    })
  }

  protected async subscribeToAccountStreams(): Promise<void> {
    await this.wsapi.subscribeUserDataStream(WS_KEY_MAP.mainWSAPI)
    this.client.subscribeUsdFuturesUserDataStream()
    this.client.subscribeCoinFuturesUserDataStream()
    logger.info({
      msg: 'Subscribed: spot via WS-API, usdm + coinm via listenKey',
      function: 'BinancePrivateWebSocketClient.subscribeToAccountStreams',
      exchange: this.exchangeName,
    })
  }
}

class BinancePrivateMessageParser implements PrivateWebSocketMessageParser {
  parseBalanceUpdate(data: any): BalanceInfo[] {
    const balances: BalanceInfo[] = []

    if (data.e === 'outboundAccountPosition' && data.B) {
      // Spot balance update
      for (const balance of data.B) {
        balances.push({
          asset: balance.a,
          total: parseFloat(balance.f) + parseFloat(balance.l),
          available: parseFloat(balance.f),
          marketType: MarketType.SPOT,
        })
      }
      return balances
    }

    if (data.e === 'ACCOUNT_UPDATE' && data.a?.B) {
      const marketType = isCoinmWsKey(data.wsKey || '')
        ? MarketType.INVERSE_PERP
        : MarketType.LINEAR_PERP
      for (const balance of data.a.B) {
        balances.push({
          asset: balance.a,
          total: parseFloat(balance.wb),
          available: parseFloat(balance.cw),
          marketType,
        })
      }
    }

    return balances
  }

  parsePositionUpdate(data: any, restClient: RestClientInterface): PositionInfo[] {
    if (data.e !== 'ACCOUNT_UPDATE' || !data.a?.P) return []

    const positions: PositionInfo[] = []
    const coinm = isCoinmWsKey(data.wsKey || '')

    for (const position of data.a.P) {
      const size = parseFloat(position.pa)
      const side = size > 0 ? 'LONG' : ('SHORT' as PositionSide)
      if (size === 0) continue

      const marketType = coinm ? MarketType.INVERSE_PERP : MarketType.LINEAR_PERP
      const metaPos = restClient.getMarketMetadataService().getMetadataByNativeId(position.s, marketType)
      let symbol: string
      if (metaPos) {
        symbol = metaPos.symbol
      } else if (coinm) {
        symbol = coinmSymbolToUnified(position.s)
      } else {
        const resolved = parseNativeSymbolToUnified(position.s, marketType, restClient.getMarketMetadataService(), quoteCurrenciesFor(EXCHANGE_NAME))
        if (!resolved) throw new Error(`BinanceWS: cannot resolve linear symbol '${position.s}' — not in metadata and no enabled quote suffix match`)
        symbol = resolved
      }

      positions.push({
        id: positionId(position.s, side),
        symbol,
        side,
        size,
        entryPrice: parseFloat(position.ep),
        leverage: 1,
        unrealizedPnL: parseFloat(position.up),
        timestamp: Date.now(),
        date: new Date(),
        marketType,
      })
    }

    return positions
  }

  parseOrderUpdate(data: any, restClient: RestClientInterface): OrderInfo[] {
    if (data.e === 'ORDER_TRADE_UPDATE') {
      const coinm = isCoinmWsKey(data.wsKey || '')
      const marketType = coinm ? MarketType.INVERSE_PERP : MarketType.LINEAR_PERP
      const metaOrder = restClient.getMarketMetadataService().getMetadataByNativeId(data.o.s, marketType)
      let symbol: string
      if (metaOrder) {
        symbol = metaOrder.symbol
      } else if (coinm) {
        symbol = coinmSymbolToUnified(data.o.s)
      } else {
        const resolved = parseNativeSymbolToUnified(data.o.s, marketType, restClient.getMarketMetadataService(), quoteCurrenciesFor(EXCHANGE_NAME))
        if (!resolved) throw new Error(`BinanceWS: cannot resolve linear order symbol '${data.o.s}' — not in metadata and no enabled quote suffix match`)
        symbol = resolved
      }
      return [
        {
          id: String(data.o.i),
          clientOrderId: data.o.c,
          symbol,
          exchange: EXCHANGE_NAME,
          orderSide: data.o.S.toUpperCase() as OrderSide,
          positionSide: getPositionSide(data.o.S.toUpperCase() as OrderSide, data.o.R),
          type: data.o.o.toUpperCase() as OrderType,
          price: parseFloat(data.o.p) || 0,
          averagePrice: parseFloat(data.o.ap) || 0,
          quantity: parseFloat(data.o.q),
          status: this.normalizeOrderStatus(data.o.X),
          timestamp: data.T,
          date: new Date(data.T),
          marketType,
        },
      ]
    }

    if (data.e === 'executionReport') {
      // Spot order
      const spotMeta = restClient.getMarketMetadataService().getMetadataByNativeId(data.s, MarketType.SPOT)
      let spotSymbol: string
      if (spotMeta) {
        spotSymbol = spotMeta.symbol
      } else {
        const resolved = parseNativeSymbolToUnified(data.s, MarketType.SPOT, restClient.getMarketMetadataService(), quoteCurrenciesFor(EXCHANGE_NAME))
        if (!resolved) throw new Error(`BinanceWS: cannot resolve spot order symbol '${data.s}' — not in metadata and no enabled quote suffix match`)
        spotSymbol = resolved
      }
      return [
        {
          id: String(data.i),
          clientOrderId: data.c,
          symbol: spotSymbol,
          exchange: EXCHANGE_NAME,
          orderSide: data.S.toUpperCase() as OrderSide,
          positionSide: 'LONG' as PositionSide,
          type: data.o.toUpperCase() as OrderType,
          price: parseFloat(data.p) || 0,
          averagePrice: parseFloat(data.L) || 0,
          quantity: parseFloat(data.q),
          status: this.normalizeOrderStatus(data.X),
          timestamp: data.T,
          date: new Date(data.T),
          marketType: MarketType.SPOT,
        },
      ]
    }

    return []
  }

  isBalanceMessage(data: any): boolean {
    return (
      (data.e === 'outboundAccountPosition' && !!data.B) ||
      (data.e === 'ACCOUNT_UPDATE' && !!data.a?.B)
    )
  }

  isPositionMessage(data: any): boolean {
    return data.e === 'ACCOUNT_UPDATE' && !!data.a?.P
  }

  isOrderMessage(data: any): boolean {
    return data.e === 'ORDER_TRADE_UPDATE' || data.e === 'executionReport'
  }

  private normalizeOrderStatus(binanceStatus: string): OrderStatus {
    switch (binanceStatus) {
      case 'NEW':
        return 'NEW'
      case 'PARTIALLY_FILLED':
        return 'PARTIALLY_FILLED'
      case 'FILLED':
        return 'FILLED'
      case 'CANCELED':
        return 'CANCELED'
      case 'REJECTED':
      case 'EXPIRED':
        return 'FAILED'
      default:
        return 'UNKNOWN'
    }
  }
}
