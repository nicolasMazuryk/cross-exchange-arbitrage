/**
 * Thin spread-computer stub.
 *
 * Boots, serves `/up` + `/metrics` on 9464. No-op consumer (real ob.ticks →
 * spreads.live logic is datapipeline-owned). Exposes a `stub_spread_up` gauge
 * so the warm-service target shows up in Prometheus.
 */
import http from 'http'
import { Gauge, collectDefaultMetrics } from 'prom-client'
import { startHealthServer } from './stubs/health'
import { stubLogger } from './stubs/stubLogger'

const logger = stubLogger('spread-computer-stub')
const VERSION = process.env.npm_package_version || '1.0.0'
const PORT = Number(process.env.METRICS_PORT || process.env.PORT || 9464)

collectDefaultMetrics()
const spreadUp = new Gauge({ name: 'stub_spread_up', help: 'spread-computer stub liveness (1 = up)' })

async function main(): Promise<void> {
  logger.info({ msg: 'spread-computer stub starting', function: 'spreadComputer.main', name: 'spread-computer', version: VERSION, node: process.version })

  const server = await startHealthServer({ port: PORT, name: 'spread-computer' })
  spreadUp.set(1)
  logger.info({ msg: 'consuming ob.ticks (stub no-op)', function: 'spreadComputer.main' })

  installShutdown([server])
}

function installShutdown(servers: http.Server[]): void {
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    spreadUp.set(0)
    logger.info({ msg: 'Shutting down', function: 'spreadComputer.shutdown', signal })
    await Promise.allSettled(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logger.error({ msg: 'spread-computer stub fatal', function: 'spreadComputer.main', error })
  process.exit(1)
})
