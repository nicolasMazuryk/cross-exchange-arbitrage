import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type IntervalHistogram,
  type EventLoopUtilization,
} from 'node:perf_hooks'
import { Logger } from '../../utils/logger'
import { hotPathCounters } from './hotPathCounters'
import { workerSamples } from './workerSamples'

const logger = new Logger('performance-monitor')

const NS_PER_MS = 1_000_000
const US_PER_MS = 1_000

/**
 * Numeric summary of one flush interval — what an ingest worker ships to main
 * (via onSample → `metrics` message) so the main sample line can fold in
 * per-worker health under exchange labels. Only per-thread signals (ELU,
 * event-loop delay, GC) — process.cpuUsage() is process-wide, so CPU percent
 * would be identical noise on every worker.
 */
export interface PerfSample {
  eluPct: number
  elMeanMs: number
  elP50Ms: number
  elP99Ms: number
  elMaxMs: number
  gcCount: number
  gcTotalPauseMs: number
  gcMaxPauseMs: number
}

/**
 * Periodically samples process health (event-loop delay/utilization, GC pauses, CPU)
 * and emits one structured log line per interval. All sources are Node built-ins
 * (`node:perf_hooks` / `process`) — no new dependencies. Memory/heap is out of scope.
 *
 * Mirrors the periodic-service pattern (FundingService / AccountSyncService):
 * `isRunning` guard, `setInterval` on a field, `start()`/`stop()`, `clearInterval` in stop.
 */
export class PerformanceMonitor {
  private readonly intervalMs: number
  // Distinguishes samples when multiple monitors run (e.g. per ingest worker).
  private readonly label?: string
  private isRunning = false
  private flushTimer?: NodeJS.Timeout

  // Event-loop delay histogram (nanoseconds), reset each flush.
  private elDelay?: IntervalHistogram

  // GC accumulators, reset each flush.
  private gcObserver?: PerformanceObserver
  private gcCount = 0
  private gcTotalPauseMs = 0
  private gcMaxPauseMs = 0
  private gcByKindMs: Record<string, number> = {}

  // Baselines diffed each flush.
  private lastCpu: NodeJS.CpuUsage = { user: 0, system: 0 }
  private lastElu?: EventLoopUtilization

  // Called with each flushed sample — ingest workers use it to post their
  // sample to the main thread (folded into main's line via workerSamples).
  private readonly onSample?: (sample: PerfSample) => void

  constructor(intervalMs: number, label?: string, onSample?: (sample: PerfSample) => void) {
    this.intervalMs = intervalMs
    this.label = label
    this.onSample = onSample
  }

  public start(): void {
    try {
      if (this.isRunning) {
        logger.warn({ msg: 'PerformanceMonitor is already running', function: 'PerformanceMonitor.start' })
        return
      }
      this.isRunning = true

      // Event-loop delay histogram.
      this.elDelay = monitorEventLoopDelay({ resolution: 1 })
      this.elDelay.enable()

      // GC observer — accumulate count / pause / by-kind until each flush.
      this.gcObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const pauseMs = entry.duration
          this.gcCount += 1
          this.gcTotalPauseMs += pauseMs
          if (pauseMs > this.gcMaxPauseMs) this.gcMaxPauseMs = pauseMs
          const kind = gcKindName((entry as { detail?: { kind?: number } }).detail?.kind)
          this.gcByKindMs[kind] = (this.gcByKindMs[kind] ?? 0) + pauseMs
        }
      })
      this.gcObserver.observe({ entryTypes: ['gc'] })

      // Seed baselines.
      this.lastCpu = process.cpuUsage()
      this.lastElu = performance.eventLoopUtilization()

      this.flushTimer = setInterval(() => this.flush(), this.intervalMs)
      // Never keep the process alive on the monitor's account.
      this.flushTimer.unref()

      logger.info({
        msg: 'PerformanceMonitor started',
        function: 'PerformanceMonitor.start',
        intervalMs: this.intervalMs,
      })
    } catch (error) {
      logger.error({ msg: 'Failed to start PerformanceMonitor', function: 'PerformanceMonitor.start', error })
      throw error
    }
  }

  private flush(): void {
    try {
      // CPU — diff vs baseline, normalize to percent of wall-clock.
      const cpu = process.cpuUsage(this.lastCpu)
      const userPct = round2((cpu.user / US_PER_MS / this.intervalMs) * 100)
      const systemPct = round2((cpu.system / US_PER_MS / this.intervalMs) * 100)

      // Event-loop utilization — diff vs baseline.
      const eluNow = performance.eventLoopUtilization()
      const eluDiff = performance.eventLoopUtilization(eluNow, this.lastElu)
      const eluPct = round4(eluDiff.utilization)
      const maxEventLoopActiveMs = round2(eluDiff.active)

      // Event-loop delay histogram (ns → ms).
      const el = this.elDelay
      const elMeanMs = el ? round2(el.mean / NS_PER_MS) : 0
      const elP50Ms = el ? round2(el.percentile(50) / NS_PER_MS) : 0
      const elP99Ms = el ? round2(el.percentile(99) / NS_PER_MS) : 0
      const elMaxMs = el ? round2(el.max / NS_PER_MS) : 0

      // GC — snapshot accumulators.
      const gcCount = this.gcCount
      const gcTotalPauseMs = round2(this.gcTotalPauseMs)
      const gcMaxPauseMs = round2(this.gcMaxPauseMs)
      const gcByKindMs = Object.fromEntries(Object.entries(this.gcByKindMs).map(([k, v]) => [k, round2(v)]))

      // Hot-path counter deltas accumulated since the previous flush.
      const counters = hotPathCounters.drain()

      // Per-ingest-worker samples fed by IngestWorkerHost since the previous
      // flush (empty inside workers — each thread has its own registry).
      const workers = workerSamples.drain()

      logger.info({
        msg: 'process performance sample',
        function: 'PerformanceMonitor.flush',
        ...(this.label && { label: this.label }),
        intervalMs: this.intervalMs,
        eluPct,
        maxEventLoopActiveMs,
        elMeanMs,
        elP50Ms,
        elP99Ms,
        elMaxMs,
        gcCount,
        gcTotalPauseMs,
        gcMaxPauseMs,
        gcByKindMs,
        userPct,
        systemPct,
        counters,
        ...(workers && { workers }),
      })

      this.onSample?.({
        eluPct,
        elMeanMs,
        elP50Ms,
        elP99Ms,
        elMaxMs,
        gcCount,
        gcTotalPauseMs,
        gcMaxPauseMs,
      })

      // Reset for next interval.
      el?.reset()
      this.gcCount = 0
      this.gcTotalPauseMs = 0
      this.gcMaxPauseMs = 0
      this.gcByKindMs = {}
      this.lastCpu = process.cpuUsage()
      this.lastElu = eluNow
    } catch (error) {
      logger.error({ msg: 'Error during performance flush', function: 'PerformanceMonitor.flush', error })
    }
  }

  public stop(): void {
    try {
      if (!this.isRunning) {
        logger.warn({ msg: 'PerformanceMonitor is not running', function: 'PerformanceMonitor.stop' })
        return
      }
      this.isRunning = false

      if (this.flushTimer) {
        clearInterval(this.flushTimer)
        this.flushTimer = undefined
      }
      this.elDelay?.disable()
      this.gcObserver?.disconnect()
      this.gcObserver = undefined

      logger.info({ msg: 'PerformanceMonitor stopped', function: 'PerformanceMonitor.stop' })
    } catch (error) {
      logger.error({ msg: 'Error stopping PerformanceMonitor', function: 'PerformanceMonitor.stop', error })
      throw error
    }
  }
}

/** Map V8 GC kind bitflag (perf_hooks gc entry `detail.kind`) to a readable name. */
function gcKindName(kind?: number): string {
  switch (kind) {
    case 1:
      return 'minor'
    case 2:
      return 'major'
    case 4:
      return 'incremental'
    case 8:
      return 'weakcb'
    default:
      return 'unknown'
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
