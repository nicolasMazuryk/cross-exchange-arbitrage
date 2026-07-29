import http from 'http'
import { register } from 'prom-client'
import { stubLogger } from './stubLogger'

const logger = stubLogger('stub-health')

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

export interface HealthServerOptions {
  /** Port to bind. */
  port: number
  /** Logical name for log lines (e.g. 'trader'). */
  name: string
  /**
   * Extra routes keyed by pathname. `/up` and `/metrics` are always served;
   * pass `/healthz` (or any other) here to add it.
   */
  routes?: Record<string, RouteHandler>
}

/**
 * Start a tiny HTTP health/metrics server on Node's built-in `http`.
 *
 * Binds `0.0.0.0` (container-internal) — Kamal/host maps the published port to
 * loopback per the topology port table. Always serves:
 *   - `GET /up`      → `200 "OK"` (kamal-proxy health-gate / liveness)
 *   - `GET /metrics` → `200` prom-client `register.metrics()` text
 * plus any `routes` supplied by the caller.
 */
export function startHealthServer(opts: HealthServerOptions): Promise<http.Server> {
  const { port, name, routes = {} } = opts

  const server = http.createServer(async (req, res) => {
    const url = req.url ? req.url.split('?')[0] : '/'
    // Log every request EXCEPT the /metrics scrape (15s scrape would flood).
    // Emitted inside the OTel HTTP server span, so the logger's trace mixin
    // stamps trace_id/span_id — this is the log line Loki→Tempo correlation
    // pivots on (scripts/obs-smoke.sh, OBSERVABILITY.md walkthrough).
    if (url !== '/metrics') {
      logger.info({ msg: 'handled request', function: 'startHealthServer.handler', name, method: req.method, url })
    }
    try {
      if (url === '/up') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
        return
      }
      if (url === '/metrics') {
        const body = await register.metrics()
        res.writeHead(200, { 'Content-Type': register.contentType })
        res.end(body)
        return
      }
      const handler = routes[url]
      if (handler) {
        await handler(req, res)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    } catch (error) {
      logger.error({ msg: 'Health server request failed', function: 'startHealthServer.handler', url, error })
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      const extra = Object.keys(routes)
      logger.info({
        msg: 'Health server listening',
        function: 'startHealthServer',
        name,
        port,
        routes: ['/up', '/metrics', ...extra],
      })
      resolve(server)
    })
  })
}
