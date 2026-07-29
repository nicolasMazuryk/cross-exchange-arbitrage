import pino from 'pino'
import { trace, context } from '@opentelemetry/api'

/**
 * pino `mixin` injecting `trace_id`/`span_id` (snake_case hex) whenever an OTel
 * span is active, so each Loki log line carries the id Grafana's Loki derived
 * field (`matcherRegex: '"trace_id":"(\w+)"'`, copied verbatim from prod) pivots
 * on for log→trace correlation. Emits nothing when no span is active — output
 * without OTel is byte-identical to before.
 */
function traceContextMixin(): Record<string, string> {
  const span = trace.getSpanContext(context.active())
  if (!span || !span.traceId) return {}
  return { trace_id: span.traceId, span_id: span.spanId }
}

/**
 * Minimal, self-contained logger for the thin app stubs.
 *
 * Deliberately does NOT import `src/utils/logger.ts` — that module pulls in
 * `src/utils/config.ts`, which `readFileSync`s a YAML config at import time and
 * throws when `STRATEGY`/config is absent. The stub images carry no exchange
 * config, so a config-coupled logger would crash the container at boot. This
 * keeps the `{ msg, function, ... }` structured-log convention while staying
 * fully decoupled from the exchange config graph.
 */

export interface LogData {
  msg: string
  function?: string
  [key: string]: any
}

export interface StubLogger {
  info(data: LogData): void
  warn(data: LogData): void
  error(data: LogData): void
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production'
// When the local observability stack is wired (OTLP endpoint set), emit raw
// JSON even in dev: Alloy tails container stdout into Loki, and the derived
// field that pivots a log line to its Tempo trace matches `"trace_id":"hex"`
// JSON — pino-pretty's reformatting would hide it. Plain `npm start`/no-OTel
// dev keeps the colorized pretty stream.
const JSON_STDOUT = IS_PRODUCTION || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Inject trace_id/span_id from the active OTel span (no-op without a span).
  mixin: traceContextMixin,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  // Pretty for human dev; raw JSON in prod AND in dev-obs mode (no file
  // transports — thin image).
  ...(JSON_STDOUT
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname', singleLine: true },
        },
      }),
})

export function stubLogger(module: string): StubLogger {
  const child = base.child({ module })
  return {
    info: (data: LogData) => child.info(data),
    warn: (data: LogData) => child.warn(data),
    error: (data: LogData) => child.error(data),
  }
}
