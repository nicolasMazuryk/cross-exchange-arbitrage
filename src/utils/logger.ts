import pino from 'pino'
import path from 'path'
import { trace, context as otelContext } from '@opentelemetry/api'
import { TraceContext } from './traceContext'
import { yamlConfig } from './config'

/**
 * Deferred real-app OTel hook (parity with the stub logger). When the real app
 * is run under the OTel preload (`src/stubs/telemetry.ts`), this emits the
 * active span's `trace_id`/`span_id` as snake_case hex so the SAME Loki derived
 * field (`'"trace_id":"(\w+)"'`) pivots a log line to its Tempo trace. No-op
 * when no OTLP/span is active — today's `npm start` output is unchanged (the
 * AsyncLocalStorage camelCase `traceId` from TraceContext is untouched).
 */
function otelTraceMixin(): Record<string, string> {
  const span = trace.getSpanContext(otelContext.active())
  if (!span || !span.traceId) return {}
  return { trace_id: span.traceId, span_id: span.spanId }
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface LogData {
  [key: string]: any
}

const LOG_LEVEL = yamlConfig.app.logLevel as LogLevel
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

const SIGNAL_MARKER = '🔸'
const ANSI_SIGNAL = '\x1b[1m\x1b[35m' // bold magenta — dev pretty only
const ANSI_RESET = '\x1b[0m'

const serializers = {
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,
}

const createBaseLogger = () => {
  if (!IS_PRODUCTION) {
    return pino({
      level: LOG_LEVEL,
      mixin: otelTraceMixin,
      serializers,
      transport: {
        targets: [
          {
            target: 'pino-pretty',
            level: LOG_LEVEL,
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
              singleLine: true,
            },
          },
          {
            target: 'pino/file',
            level: 'error',
            options: {
              destination: path.join(process.cwd(), 'logs', 'error.log'),
              ignore: 'pid,hostname',
              mkdir: true,
            },
          },
          {
            target: 'pino/file',
            level: LOG_LEVEL,
            options: {
              destination: path.join(process.cwd(), 'logs', 'combined.log'),
              ignore: 'pid,hostname',
              mkdir: true,
            },
          },
        ],
      },
    })
  }

  // Production mode: JSON output for centralized logging
  return pino({
    level: LOG_LEVEL,
    mixin: otelTraceMixin,
    serializers,
    transport: {
      targets: [
        {
          target: 'pino/file',
          level: LOG_LEVEL,
          options: {
            destination: 1, // stdout - includes errors since error level is higher than LOG_LEVEL
            ignore: 'pid,hostname',
          },
        },
        {
          target: 'pino/file',
          level: 'error',
          options: {
            destination: 2, // stderr
            ignore: 'pid,hostname',
          },
        },
        {
          target: 'pino/file',
          level: 'error',
          options: {
            destination: path.join(process.cwd(), 'logs', 'error.log'),
            ignore: 'pid,hostname',
            mkdir: true,
          },
        },
        {
          target: 'pino/file',
          level: LOG_LEVEL,
          options: {
            destination: path.join(process.cwd(), 'logs', 'combined.log'),
            ignore: 'pid,hostname',
            mkdir: true,
          },
        },
        // Add centralized logging transport here (e.g., Datadog, ELK, Loki)
        // {
        //   target: 'pino-datadog-transport',
        //   options: {
        //     apiKey: process.env.DATADOG_API_KEY,
        //     service: 'arbinet',
        //   },
        // },
      ],
    },
  })
}

const baseLogger = createBaseLogger()

/**
 * Provides high-performance, non-blocking logging with automatic trace context injection.
 * All logs are structured JSON and include traceId, spanId, and trigger for full traceability.
 */
export class Logger {
  private logger: pino.Logger
  private module: string

  // Sticky per-column max widths, shared across all signal() lines so they
  // align into a single table regardless of which Logger instance emits them.
  private static signalColMeta: { width: number }[] = []

  constructor(module: string, childLogger?: pino.Logger) {
    this.module = module
    this.logger = childLogger || baseLogger.child({ module })
  }

  private enrichWithContext(data: LogData): LogData {
    const traceFields = TraceContext.getTraceFields()
    return {
      ...traceFields,
      ...data,
    }
  }

  fatal(data: LogData): void {
    this.logger.fatal(this.enrichWithContext(data))
  }
  error(data: LogData): void {
    this.logger.error(this.enrichWithContext(data))
  }
  warn(data: LogData): void {
    this.logger.warn(this.enrichWithContext(data))
  }
  info(data: LogData): void {
    this.logger.info(this.enrichWithContext(data))
  }
  debug(data: LogData): void {
    this.logger.debug(this.enrichWithContext(data))
  }
  trace(data: LogData): void {
    this.logger.trace(this.enrichWithContext(data))
  }

  /**
   * Dedicated inline log for arbitrage opportunities and trades. Each arg is a
   * column; columns are padded to a sticky max width (shared across all signal
   * lines) and joined with ` | ` so successive lines align like a table on one
   * line. Numbers right-align (floats fixed to 4 decimals); strings left-align.
   * Bypasses `enrichWithContext` — no trace fields, no `module` binding (emits
   * via `baseLogger`) so pino-pretty appends nothing. ANSI color is dev-only so
   * prod log files stay clean JSON.
   */
  signal(...args: any[]): void {
    const cells = args.map((a) => {
      const numeric = typeof a === 'number'
      let s: string
      if (numeric) s = Number.isInteger(a) ? String(a) : a.toFixed(4)
      else if (a !== null && typeof a === 'object') s = JSON.stringify(a)
      else s = String(a)
      return { s, numeric }
    })
    const meta = Logger.signalColMeta
    const body = cells
      .map(({ s, numeric }, i) => {
        const m = meta[i] || (meta[i] = { width: 0 })
        if (s.length > m.width) m.width = s.length
        return numeric ? s.padStart(m.width) : s.padEnd(m.width)
      })
      .join(' | ')
    const label = `${SIGNAL_MARKER}`
    const msg = IS_PRODUCTION ? `${label} ${body}` : `${ANSI_SIGNAL}${label}${ANSI_RESET} ${body}`
    baseLogger.info({ msg })
  }

  child(bindings: LogData): Logger {
    return new Logger(this.module, this.logger.child(bindings))
  }
  setLevel(level: LogLevel): void {
    this.logger.level = level
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger('app')

/**
 * Export for backward compatibility (will be deprecated)
 */
export default logger
