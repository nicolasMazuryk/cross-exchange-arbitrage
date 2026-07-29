/**
 * Dependency-free counter registry for hot-path instrumentation.
 *
 * `inc()` is allocation-free after the first call per counter name, so it is
 * safe to call per WebSocket frame. `drain()` returns the accumulated counts
 * and resets them; PerformanceMonitor drains once per flush interval so every
 * "process performance sample" log line carries per-interval deltas.
 *
 * Module-level singleton: one registry per thread (each Phase 2 ingest worker
 * gets its own instance alongside its own labeled PerformanceMonitor).
 */
class HotPathCounters {
  private counters: Map<string, number> = new Map()

  public inc(name: string, n = 1): void {
    const current = this.counters.get(name)
    this.counters.set(name, current === undefined ? n : current + n)
  }

  public drain(): Record<string, number> {
    if (this.counters.size === 0) return {}
    const snapshot: Record<string, number> = {}
    for (const [name, value] of this.counters) {
      snapshot[name] = value
    }
    this.counters.clear()
    return snapshot
  }
}

export const hotPathCounters = new HotPathCounters()
