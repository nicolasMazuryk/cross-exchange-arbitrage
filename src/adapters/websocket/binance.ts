import { EventEmitter } from 'events'
import { BasePublicWebSocketClient } from './base'
import { WebSocketConfig, PublicWebSocketMessageParser, StreamBatch } from './types'
import { MarketType } from '../../types/exchange'
import { OrderBookUpdate } from '../../core/orderbook/orderbookManager'
import { Logger } from '../../utils/logger'
import { parseLevels } from './parseLevels'

const EXCHANGE_NAME = 'binance'
const HEARTBEAT_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000 // 2_000

const logger = new Logger(`ws-${EXCHANGE_NAME}`)

// Wraps a native ws connection to the Binance combined stream endpoint.
// Exposes an EventEmitter interface so the base class cleanup (removeAllListeners/closeAll) works.
class BinanceCombinedStreamClient extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  private static readonly WS = require('ws')
  private ws: any = null
  private url: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pingTimeoutTimer: NodeJS.Timeout | null = null

  setUrl(url: string): void {
    this.url = url
  }

  connect(): void {
    if (!this.url) throw new Error('URL not set before connect()')
    const ws = new BinanceCombinedStreamClient.WS(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.startHeartbeat()
      this.emit('open')
    })
    ws.on('pong', () => this.clearPingTimeout())
    ws.on('close', () => {
      this.stopHeartbeat()
      if (this.ws === ws) this.emit('close')
    })
    ws.on('error', (err: any) => {
      this.stopHeartbeat()
      if (this.ws === ws) this.emit('error', err)
    })
    ws.on('message', (raw: any) => {
      try {
        const envelope = JSON.parse(raw.toString())
        this.emit('message', envelope)
      } catch (err) {
        logger.warn({ msg: 'Unparseable WS frame', function: 'BinanceCombinedStreamClient.connect', error: err, raw: raw.toString().slice(0, 200) })
      }
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return
      this.ws.ping()
      this.pingTimeoutTimer = setTimeout(() => {
        logger.warn({ msg: 'Binance WS pong timeout — closing dead connection', function: 'BinanceCombinedStreamClient.heartbeat' })
        if (this.ws) this.ws.terminate()
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private clearPingTimeout(): void {
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
  }

  private stopHeartbeat(): void {
    this.clearPingTimeout()
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  close(): void {
    this.stopHeartbeat()
    const ws = this.ws
    if (!ws) return
    this.ws = null
    ws.removeAllListeners()
    try {
      ws.close()
    } catch {
      // ignore errors on already-closed socket
    }
  }

  closeAll(): void {
    this.close()
  }
}

class BinanceMessageParser implements PublicWebSocketMessageParser {
  constructor(private getUnifiedSymbol: (marketId: string, marketType: MarketType) => string) {}

  isOrderBookMessage(envelope: any, marketType: MarketType): boolean {
    const data = envelope?.data ?? envelope
    if (marketType === MarketType.SPOT) {
      return Array.isArray(data?.bids) && Array.isArray(data?.asks) && typeof data?.lastUpdateId === 'number'
    }
    return data?.e === 'depthUpdate'
  }

  parseOrderBookUpdate(envelope: any, marketType: MarketType): OrderBookUpdate {
    const data = envelope?.data ?? envelope
    const stream: string | undefined = envelope?.stream
    const nativeIdFromStream = stream ? stream.split('@')[0].toUpperCase() : undefined

    if (marketType === MarketType.SPOT) {
      return {
        type: 'snapshot',
        exchange: EXCHANGE_NAME,
        symbol: this.getUnifiedSymbol(nativeIdFromStream!, marketType),
        marketType,
        timestamp: Date.now(),
        asks: parseLevels(data.asks),
        bids: parseLevels(data.bids),
        finalUpdateId: data.lastUpdateId,
      }
    }

    return {
      type: 'snapshot',
      exchange: EXCHANGE_NAME,
      symbol: this.getUnifiedSymbol(data.s, marketType),
      marketType,
      timestamp: data.T ?? data.E,
      asks: parseLevels(data.a),
      bids: parseLevels(data.b),
      firstUpdateId: data.U,
      finalUpdateId: data.u,
      prevFinalUpdateId: data.pu,
    }
  }
}

export class BinancePublicWebSocketClient extends BasePublicWebSocketClient {
  protected readonly exchangeName = EXCHANGE_NAME
  protected readonly messageParser: BinanceMessageParser

  constructor(config: WebSocketConfig) {
    super(config)
    this.messageParser = new BinanceMessageParser((id, mt) => this.getUnifiedSymbol(id, mt))
  }

  protected createClient(): BinanceCombinedStreamClient {
    return new BinanceCombinedStreamClient()
  }

  protected setupEventHandlers(batch: StreamBatch): void {
    // Guard against both 'close' and 'error' both triggering reconnect for the same failure
    let errorHandled = false

    batch.client.on('open', () => {
      // logger.info({
      //   msg: 'WebSocket connection opened',
      //   function: 'BinancePublicWebSocketClient.setupEventHandlers.open',
      //   exchange: this.exchangeName,
      //   batchId: batch.id,
      //   symbolCount: batch.symbols.length,
      // })
      batch.isConnected = true
    })

    batch.client.on('close', async () => {
      if (errorHandled) return
      errorHandled = true
      logger.warn({
        msg: 'WebSocket connection closed',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.close',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('error', async (error: any) => {
      if (errorHandled) return
      errorHandled = true
      logger.error({
        msg: 'WebSocket connection error',
        function: 'BinancePublicWebSocketClient.setupEventHandlers.error',
        exchange: this.exchangeName,
        batchId: batch.id,
        symbolCount: batch.symbols.length,
        error,
      })
      batch.isConnected = false
      await this.handleConnectionError(batch)
    })

    batch.client.on('message', (data: any) => {
      try {
        if (this.messageParser.isOrderBookMessage(data, batch.marketType)) {
          const update = this.messageParser.parseOrderBookUpdate(data, batch.marketType)
          this.emit('orderbookUpdate', update)
        }
      } catch (error) {
        logger.error({
          msg: 'Error parsing WebSocket message',
          function: 'BinancePublicWebSocketClient.setupEventHandlers.message',
          exchange: this.exchangeName,
          batchId: batch.id,
          messageType: data?.e,
          symbol: data?.s,
          error,
        })
      }
    })
  }

  protected async subscribeToSymbols(batch: StreamBatch): Promise<void> {
    const baseUrl =
      batch.marketType === MarketType.SPOT
        ? 'wss://stream.binance.com:9443'
        : batch.marketType === MarketType.INVERSE_PERP
          ? 'wss://dstream.binance.com'
          : 'wss://fstream.binance.com'

    const streams = batch.symbols.map(s => `${s.toLowerCase()}@depth5@100ms`).join('/')
    const url = `${baseUrl}/stream?streams=${streams}`

    batch.client.setUrl(url)
    batch.client.connect()

    logger.info({
      msg: 'Subscribed to symbols',
      function: 'BinancePublicWebSocketClient.subscribeToSymbols',
      exchange: this.exchangeName,
      batchId: batch.id,
      marketType: batch.marketType,
      symbolCount: batch.symbols.length,
    })
  }
}
