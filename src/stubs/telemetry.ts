/**
 * OpenTelemetry + Pyroscope bootstrap for the thin app stubs.
 *
 * MUST be `--require`d BEFORE the entrypoint (after ts-node/register) so the
 * auto-instrumentations can monkey-patch `http`/`kafkajs`/`@clickhouse/client`
 * before those modules are first loaded by the stub. See docker-compose.dev.yml
 * `command:` and OBSERVABILITY.md.
 *
 * No-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Prod runs the stubs via the
 * Kamal command WITHOUT this preload, so prod is untouched — zero prod risk.
 * Dev compose sets the endpoint (http://alloy:4317) + PYROSCOPE_SERVER_ADDRESS
 * (http://alloy:4040), enabling traces → Tempo and continuous profiles →
 * Pyroscope, both via the single Alloy collector (prod parity).
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import Pyroscope from '@pyroscope/nodejs'

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'arbinet-stub'
const SERVICE_VERSION = process.env.npm_package_version || '1.0.0'
const HOST_LABEL = process.env.OTEL_HOST_LABEL || 'dev'

// Gate the entire bootstrap on the OTLP endpoint. Unset (prod / plain `npm
// start`) → this require() returns having done nothing.
if (!OTLP_ENDPOINT) {
  // eslint-disable-next-line no-console
  console.log('[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT unset — telemetry disabled')
} else {
  if (process.env.OTEL_DIAG_DEBUG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      // Mirror prod's host external_label so trace→log correlation (tag host)
      // and dashboards behave the same. Prod splits hot/core/obs; dev is "dev".
      host: HOST_LABEL,
    }),
    traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are pure noise for these stubs (ts-node reads thousands).
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  })

  sdk.start()
  // eslint-disable-next-line no-console
  console.log(`[telemetry] OTel started service=${SERVICE_NAME} → ${OTLP_ENDPOINT}`)

  // ---- Continuous profiling → Pyroscope (push model, Node SDK; no eBPF) ----
  const PYROSCOPE_SERVER = process.env.PYROSCOPE_SERVER_ADDRESS
  if (PYROSCOPE_SERVER) {
    Pyroscope.init({
      appName: process.env.PYROSCOPE_APPLICATION_NAME || SERVICE_NAME,
      serverAddress: PYROSCOPE_SERVER,
      tags: { host: HOST_LABEL },
    })
    Pyroscope.start()
    // eslint-disable-next-line no-console
    console.log(`[telemetry] Pyroscope profiling → ${PYROSCOPE_SERVER}`)
  }

  const shutdown = (signal: string) => {
    void Promise.allSettled([sdk.shutdown(), PYROSCOPE_SERVER ? Pyroscope.stop() : Promise.resolve()]).then(() => {
      // eslint-disable-next-line no-console
      console.log(`[telemetry] shut down on ${signal}`)
    })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}
