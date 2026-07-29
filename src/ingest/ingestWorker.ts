import { parentPort } from 'worker_threads'
import { Dictionary, Market } from 'ccxt'
import { Logger } from '../utils/logger'
import config from '../utils/config'
import { OrderbookManager, OrderBookUpdate, TopOfBook } from '../core/orderbook/orderbookManager'
import { PerformanceMonitor } from '../core/monitoring'
import {
  BinancePublicWebSocketClient,
  BybitPublicWebSocketClient,
  OkxPublicWebSocketClient,
  BitgetPublicWebSocketClient,
  BasePublicWebSocketClient,
} from '../adapters/websocket'
import { WebSocketConfig } from '../adapters/websocket/types'
import { MainToWorker, IngestSettings, WorkerToMain } from './protocol'

/**
 * Per-exchange ingest worker: owns the exchange's WS connections (vendor SDK
 * runs in this thread), parses frames with the unchanged adapter classes,
 * maintains full books via OrderbookManager (bookMerge + top-price-change
 * gate), and posts a compact top-`depth` book message to main on every
 * top-of-book price change. Parse + merge allocation churn lives on this
 * thread's heap, off the main loop.
 */

const logger = new Logger('ingest-worker')

const METRICS_INTERVAL_MS = 10_000

if (!parentPort) {
  throw new Error('ingestWorker must be run as a worker thread')
}
const port = parentPort

const CLIENT_FACTORIES: Record<string, (cfg: WebSocketConfig) => BasePublicWebSocketClient> = {
  binance: cfg => new BinancePublicWebSocketClient(cfg),
  bybit: cfg => new BybitPublicWebSocketClient(cfg),
  okx: cfg => new OkxPublicWebSocketClient(cfg),
  bitget: cfg => new BitgetPublicWebSocketClient(cfg),
}

let exchangeName = 'unknown'
let client: BasePublicWebSocketClient | undefined
let performanceMonitor: PerformanceMonitor | undefined
let metricsTimer: NodeJS.Timeout | undefined
let shuttingDown = false

// Worker-side monotonic sequence across all symbols of this exchange.
let seq = 0
// Lightweight protocol metrics (separate from hotPathCounters, which the
// worker's own labeled PerformanceMonitor drains).
let bookMsgsOut = 0
let obUpdatesIn = 0

function post(msg: WorkerToMain, transfer?: ArrayBuffer[]): void {
  port.postMessage(msg, transfer)
}

function encodeSide(levels: { price: number; quantity: number }[], depth: number): Float64Array {
  const n = Math.min(levels.length, depth)
  const flat = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    flat[i * 2] = levels[i].price
    flat[i * 2 + 1] = levels[i].quantity
  }
  return flat
}

async function handleInit(msg: Extract<MainToWorker, { type: 'init' }>): Promise<void> {
  exchangeName = msg.exchange
  const ingest: IngestSettings = msg.ingest

  // Rebuild the markets dictionary shape BasePublicWebSocketClient expects.
  const markets: Dictionary<Market> = {}
  for (const m of msg.markets) {
    markets[m.symbol] = m as unknown as Market
  }

  const factory = CLIENT_FACTORIES[exchangeName]
  if (!factory) {
    throw new Error(`No ingest client factory for exchange: ${exchangeName}`)
  }

  const orderbookManager = new OrderbookManager()
  client = factory(msg.wsConfig)

  client.on('orderbookUpdate', (update: OrderBookUpdate) => {
    obUpdatesIn++
    orderbookManager.updateOrderbook(update)
  })

  // Emitted only on top-price change (OrderbookManager gate) — same emit
  // cadence the in-process path had.
  orderbookManager.on('topOfBookUpdate', (topOfBook: TopOfBook) => {
    const book = orderbookManager.getOrderbook(topOfBook.exchange, topOfBook.symbol)
    if (!book) return
    const bids = encodeSide(book.bids, ingest.depth)
    const asks = encodeSide(book.asks, ingest.depth)
    bookMsgsOut++
    post(
      {
        type: 'book',
        exchange: topOfBook.exchange,
        symbol: topOfBook.symbol,
        marketType: topOfBook.marketType,
        bids,
        asks,
        timestamp: topOfBook.timestamp,
        seq: ++seq,
        postedAt: Date.now(),
      },
      [bids.buffer as ArrayBuffer, asks.buffer as ArrayBuffer]
    )
  })

  // Full-reconnect path (client recreation): local books may be stale until
  // fresh snapshots — drop them and tell main to do the same.
  client.on('connectionReset', ({ batchId }: { batchId: number }) => {
    orderbookManager.clearExchangeBooks(exchangeName)
    post({ type: 'status', exchange: exchangeName, event: 'resetBooks', batchId })
  })

  await client.initialize(markets)

  // Split workers (Phase 3) label themselves exchange:marketType.
  const workerLabel = msg.wsConfig.marketType ? `${exchangeName}:${msg.wsConfig.marketType}` : exchangeName
  if (config.performanceMonitor.enabled) {
    // onSample ships each flushed sample to main, which folds it into the main
    // "process performance sample" line under this worker's label.
    performanceMonitor = new PerformanceMonitor(config.performanceMonitor.intervalMs, `ingest:${workerLabel}`, perf =>
      post({ type: 'metrics', exchange: exchangeName, perf })
    )
    performanceMonitor.start()
  }

  metricsTimer = setInterval(() => {
    post({
      type: 'metrics',
      exchange: exchangeName,
      counters: { book_msgs_out: bookMsgsOut, ob_updates_in: obUpdatesIn },
    })
    bookMsgsOut = 0
    obUpdatesIn = 0
  }, METRICS_INTERVAL_MS)
  metricsTimer.unref()

  post({ type: 'ready', exchange: exchangeName })
  logger.info({
    msg: 'Ingest worker ready',
    function: 'ingestWorker.handleInit',
    worker: workerLabel,
    marketCount: msg.markets.length,
    depth: ingest.depth,
  })
}

function handleShutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ msg: 'Ingest worker shutting down', function: 'ingestWorker.handleShutdown', exchange: exchangeName })
  if (metricsTimer) clearInterval(metricsTimer)
  performanceMonitor?.stop()
  try {
    client?.close()
  } catch (error) {
    logger.error({ msg: 'Error closing WS client', function: 'ingestWorker.handleShutdown', exchange: exchangeName, error })
  }
  // Give pino transports a beat to flush before exiting.
  setTimeout(() => process.exit(0), 200)
}

port.on('message', (msg: MainToWorker) => {
  if (msg.type === 'init') {
    handleInit(msg).catch(error => {
      logger.error({ msg: 'Ingest worker init failed', function: 'ingestWorker.init', exchange: exchangeName, error })
      post({ type: 'fatal', exchange: exchangeName, error: String(error?.stack ?? error) })
      setTimeout(() => process.exit(1), 200)
    })
  } else if (msg.type === 'shutdown') {
    handleShutdown()
  }
})

process.on('uncaughtException', error => {
  logger.fatal({ msg: 'Ingest worker uncaught exception', function: 'ingestWorker', exchange: exchangeName, error })
  post({ type: 'fatal', exchange: exchangeName, error: String(error?.stack ?? error) })
  setTimeout(() => process.exit(1), 200)
})

process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  logger.fatal({ msg: 'Ingest worker unhandled rejection', function: 'ingestWorker', exchange: exchangeName, error })
  post({ type: 'fatal', exchange: exchangeName, error: String(error.stack ?? error) })
  setTimeout(() => process.exit(1), 200)
})
