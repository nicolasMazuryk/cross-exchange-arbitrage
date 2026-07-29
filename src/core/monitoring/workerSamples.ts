/**
 * Main-thread registry of per-ingest-worker samples. IngestWorkerHost feeds it
 * from worker `metrics` messages (counters + perf summary, keyed by worker
 * label like `bybit` or `bybit:spot`); the main PerformanceMonitor drains it
 * once per flush so each "process performance sample" log line carries a
 * `workers` object alongside the main-thread numbers.
 *
 * Counters `add` (multiple worker intervals may land between main flushes);
 * perf gauges `set` (latest sample wins).
 */
class WorkerSampleRegistry {
  private samples: Map<string, Record<string, number>> = new Map()

  private entry(worker: string): Record<string, number> {
    let fields = this.samples.get(worker)
    if (fields === undefined) {
      fields = {}
      this.samples.set(worker, fields)
    }
    return fields
  }

  /** Additive merge — for per-interval counter deltas. */
  public add(worker: string, counters: Record<string, number>): void {
    const fields = this.entry(worker)
    for (const [name, value] of Object.entries(counters)) {
      fields[name] = (fields[name] ?? 0) + value
    }
  }

  /** Overwriting merge — for point-in-time perf gauges. */
  public set(worker: string, gauges: Record<string, number>): void {
    Object.assign(this.entry(worker), gauges)
  }

  public drain(): Record<string, Record<string, number>> | undefined {
    if (this.samples.size === 0) return undefined
    const snapshot: Record<string, Record<string, number>> = {}
    for (const [worker, fields] of this.samples) {
      snapshot[worker] = fields
    }
    this.samples.clear()
    return snapshot
  }
}

export const workerSamples = new WorkerSampleRegistry()
