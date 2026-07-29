import { Worker } from 'worker_threads'
import { join } from 'path'
import { Logger } from '../utils/logger'
import { BookMirror } from '../core/orderbook/bookMirror'
import { hotPathCounters } from '../core/monitoring/hotPathCounters'
import { workerSamples } from '../core/monitoring/workerSamples'
import { WebSocketConfig } from '../adapters/websocket/types'
import { MainToWorker, MarketLite, IngestSettings, WorkerToMain, BookMessage } from './protocol'

const logger = new Logger('ingest-worker-host')

const READY_TIMEOUT_MS = 60_000
const SHUTDOWN_GRACE_MS = 5_000
const RESTART_BACKOFF_INITIAL_MS = 1_000
const RESTART_BACKOFF_MAX_MS = 30_000
// A worker that stayed up this long is considered healthy — backoff resets.
const STABLE_UPTIME_MS = 60_000

/**
 * Main-thread host for one per-exchange ingest worker. Spawns the worker
 * (ts-node in dev, compiled dist in prod — same pattern as utils/browser.ts),
 * performs the init handshake, routes book messages into the shared
 * BookMirror, and restarts the worker with exponential backoff on exit/fatal
 * (init payload is cached; the mirror gets a resetBooks first so consumers
 * never read a dead exchange's stale books).
 */
export class IngestWorkerHost {
  private worker?: Worker
  private startedAt = 0
  private restartAttempts = 0
  private restartTimer?: NodeJS.Timeout
  private isShuttingDown = false
  // `exchange` or `exchange:marketType` for split workers (Phase 3).
  private readonly label: string

  constructor(
    private readonly exchange: string,
    private readonly wsConfig: WebSocketConfig,
    private readonly markets: MarketLite[],
    private readonly ingest: IngestSettings,
    private readonly mirror: BookMirror
  ) {
    this.label = wsConfig.marketType ? `${exchange}:${wsConfig.marketType}` : exchange
  }

  /** Drop this worker's slice of the mirror — split workers must not nuke a sibling's books. */
  private resetMirrorBooks(): void {
    this.mirror.clearExchangeBooks(this.exchange, this.wsConfig.marketType)
  }

  /** Spawn the worker and resolve once it reports ready (WS connected + subscribed). */
  public async start(): Promise<void> {
    await this.spawn()
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isTsNode = __filename.endsWith('.ts')
      const workerPath = join(__dirname, isTsNode ? 'ingestWorker.ts' : 'ingestWorker.js')
      const worker = new Worker(workerPath, isTsNode ? { execArgv: ['-r', 'ts-node/register'] } : undefined)
      this.worker = worker
      this.startedAt = Date.now()

      let settled = false
      const readyTimeout = setTimeout(() => {
        if (settled) return
        settled = true
        logger.error({
          msg: 'Ingest worker ready timeout',
          function: 'IngestWorkerHost.spawn',
          worker: this.label,
          timeoutMs: READY_TIMEOUT_MS,
        })
        worker.terminate().catch(() => {})
        reject(new Error(`Ingest worker for ${this.exchange} did not become ready within ${READY_TIMEOUT_MS}ms`))
      }, READY_TIMEOUT_MS)

      worker.on('message', (msg: WorkerToMain) => {
        switch (msg.type) {
          case 'book':
            this.handleBook(msg)
            break
          case 'ready':
            if (!settled) {
              settled = true
              clearTimeout(readyTimeout)
              logger.info({
                msg: 'Ingest worker ready',
                function: 'IngestWorkerHost.spawn',
                worker: this.label,
                marketCount: this.markets.length,
              })
              resolve()
            }
            break
          case 'status':
            if (msg.event === 'resetBooks') {
              this.resetMirrorBooks()
              logger.warn({
                msg: 'Ingest worker reset books (reconnect)',
                function: 'IngestWorkerHost.onStatus',
                worker: this.label,
                batchId: msg.batchId,
              })
            }
            break
          case 'metrics':
            // Folded into the main "process performance sample" line under
            // this worker's label (PerformanceMonitor drains workerSamples).
            if (msg.counters) workerSamples.add(this.label, msg.counters)
            if (msg.perf) workerSamples.set(this.label, { ...msg.perf })
            break
          case 'fatal':
            logger.error({
              msg: 'Ingest worker fatal error',
              function: 'IngestWorkerHost.onFatal',
              worker: this.label,
              workerError: msg.error,
            })
            workerSamples.add(this.label, { fatal: 1 })
            // Worker exits itself after posting fatal; restart happens in the exit handler.
            break
        }
      })

      worker.on('error', error => {
        logger.error({
          msg: 'Ingest worker thread error',
          function: 'IngestWorkerHost.onError',
          worker: this.label,
          error,
        })
      })

      worker.on('exit', code => {
        if (this.worker === worker) this.worker = undefined
        if (this.isShuttingDown) return
        logger.error({
          msg: 'Ingest worker exited unexpectedly — scheduling restart',
          function: 'IngestWorkerHost.onExit',
          worker: this.label,
          code,
          uptimeMs: Date.now() - this.startedAt,
        })
        // Consumers must not read the dead worker's frozen books.
        this.resetMirrorBooks()
        if (!settled) {
          settled = true
          clearTimeout(readyTimeout)
          reject(new Error(`Ingest worker for ${this.exchange} exited during startup (code ${code})`))
          return
        }
        this.scheduleRestart()
      })

      const init: MainToWorker = {
        type: 'init',
        exchange: this.exchange,
        markets: this.markets,
        wsConfig: this.wsConfig,
        ingest: this.ingest,
      }
      worker.postMessage(init)
    })
  }

  private handleBook(msg: BookMessage): void {
    const now = Date.now()
    hotPathCounters.inc('book_msgs_in')
    // Worker→main hop latency (same clock domain) and exchange-event→apply
    // end-to-end latency (cross clock domain — indicative only).
    hotPathCounters.inc('ingest_hop_ms_sum', now - msg.postedAt)
    hotPathCounters.inc('ingest_e2e_ms_sum', now - msg.timestamp)
    this.mirror.applyBook(msg)
  }

  private scheduleRestart(): void {
    if (this.isShuttingDown || this.restartTimer) return

    // A long healthy run resets the backoff ladder.
    if (Date.now() - this.startedAt >= STABLE_UPTIME_MS) this.restartAttempts = 0
    const delay = Math.min(RESTART_BACKOFF_INITIAL_MS * 2 ** this.restartAttempts, RESTART_BACKOFF_MAX_MS)
    this.restartAttempts++

    logger.warn({
      msg: 'Restarting ingest worker',
      function: 'IngestWorkerHost.scheduleRestart',
      worker: this.label,
      attempt: this.restartAttempts,
      delayMs: delay,
    })

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.spawn().catch(error => {
        logger.error({
          msg: 'Ingest worker restart failed — will retry',
          function: 'IngestWorkerHost.scheduleRestart',
          worker: this.label,
          error,
        })
        this.scheduleRestart()
      })
    }, delay)
    this.restartTimer.unref()
  }

  /** Graceful shutdown: ask the worker to close its WS clients, then terminate if it lingers. */
  public async close(): Promise<void> {
    this.isShuttingDown = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const worker = this.worker
    if (!worker) return

    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()))
    try {
      worker.postMessage({ type: 'shutdown' } as MainToWorker)
    } catch {
      // Worker already dead — terminate below is a no-op.
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS)),
    ])
    if (timedOut) {
      logger.warn({
        msg: 'Ingest worker did not exit within grace period — terminating',
        function: 'IngestWorkerHost.close',
        worker: this.label,
        graceMs: SHUTDOWN_GRACE_MS,
      })
      await worker.terminate()
    }
    logger.info({ msg: 'Ingest worker host closed', function: 'IngestWorkerHost.close', worker: this.label })
  }
}
