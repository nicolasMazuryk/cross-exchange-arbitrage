import pino from 'pino'
import path from 'path'
import { TraceContext } from './traceContext'
import { yamlConfig } from './config'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface LogData {
  [key: string]: any
}

const LOG_LEVEL = yamlConfig.app.logLevel as LogLevel
const IS_PRODUCTION = yamlConfig.app.environment === 'production'

const serializers = {
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,
}

const createBaseLogger = () => {
  if (!IS_PRODUCTION) {
    return pino({
      level: LOG_LEVEL,
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
    serializers,
    transport: {
      targets: [
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
