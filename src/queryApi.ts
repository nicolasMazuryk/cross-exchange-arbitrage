/**
 * Thin query-api stub.
 *
 * Boots a single server on 8080 (matches deploy.yml `app_port: 8080`) serving
 * `/up`, `/healthz`, and `/metrics`. The only app behind the public edge
 * (kamal-proxy) — its `/up` is the mandatory health-gate. No CH/Redpanda calls
 * in the stub (real query logic is datapipeline-owned).
 */
import http from 'http'
import { collectDefaultMetrics } from 'prom-client'
import { startHealthServer } from './stubs/health'
import { stubLogger } from './stubs/stubLogger'

const logger = stubLogger('query-api-stub')
const VERSION = process.env.npm_package_version || '1.0.0'
const PORT = Number(process.env.APP_PORT || process.env.PORT || 8080)

collectDefaultMetrics()

async function main(): Promise<void> {
  logger.info({ msg: 'query-api stub starting', function: 'queryApi.main', name: 'query-api', version: VERSION, node: process.version })

  const server = await startHealthServer({
    port: PORT,
    name: 'query-api',
    routes: {
      '/healthz': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      },
    },
  })

  installShutdown([server])
}

function installShutdown(servers: http.Server[]): void {
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ msg: 'Shutting down', function: 'queryApi.shutdown', signal })
    await Promise.allSettled(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logger.error({ msg: 'query-api stub fatal', function: 'queryApi.main', error })
  process.exit(1)
})
