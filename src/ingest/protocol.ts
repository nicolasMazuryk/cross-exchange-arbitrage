import { MarketType } from '../types/exchange'
import { WebSocketConfig } from '../adapters/websocket/types'
import { PerfSample } from '../core/monitoring'

/**
 * Message protocol between the main thread (IngestWorkerHost) and per-exchange
 * ingest workers (ingestWorker.ts).
 *
 * All messages are plain serializable data (structured clone), so this seam is
 * multi-process ready: swapping worker_threads postMessage for an IPC/socket
 * transport requires no protocol change — only the host/worker postMessage
 * call sites.
 */

/**
 * Projection of a ccxt Market — only what BasePublicWebSocketClient's
 * market-type logic needs (market.id, market.symbol, spot/swap/linear/inverse
 * flags). Avoids structured-cloning full ccxt Market objects into workers.
 */
export interface MarketLite {
  id: string
  symbol: string
  base: string
  quote: string
  type: string
  spot?: boolean
  swap?: boolean
  linear?: boolean
  inverse?: boolean
  contract?: boolean
}

export interface IngestSettings {
  /** Levels per side shipped to main in each book message (books are truncated to this). */
  depth: number
}

export type MainToWorker =
  | {
      type: 'init'
      exchange: string
      markets: MarketLite[]
      wsConfig: WebSocketConfig
      ingest: IngestSettings
    }
  | { type: 'shutdown' }

export interface BookMessage {
  type: 'book'
  exchange: string
  symbol: string
  marketType: MarketType
  /** Flat [p0,q0,p1,q1,...], top-`depth` levels, transferred buffers. */
  bids: Float64Array
  asks: Float64Array
  /** Exchange-provided event timestamp (ms). */
  timestamp: number
  /** Worker-side monotonic sequence — detects reordering/restart gaps per worker. */
  seq: number
  /** Worker wall-clock at postMessage (ms) — host computes hop latency from it. */
  postedAt: number
}

export type WorkerToMain =
  | { type: 'ready'; exchange: string }
  | BookMessage
  | { type: 'status'; exchange: string; event: 'connected' | 'disconnected' | 'resetBooks'; batchId?: number }
  // Counters are per-interval deltas; perf is the worker PerformanceMonitor's
  // latest sample (absent when the monitor is disabled). Host folds both into
  // the main "process performance sample" line under the worker's label.
  | { type: 'metrics'; exchange: string; counters?: Record<string, number>; perf?: PerfSample }
  | { type: 'fatal'; exchange: string; error: string }
