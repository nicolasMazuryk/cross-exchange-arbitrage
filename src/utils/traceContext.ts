import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'

export interface TraceCtx {
  traceId: string
  spanId: string
  trigger: string
  parentSpanId?: string
  metadata?: Record<string, any>
}

const asyncLocalStorage = new AsyncLocalStorage<TraceCtx>()

/**
 * TraceContext
 *
 * Provides context propagation for distributed tracing using AsyncLocalStorage.
 * Ensures traceId and spanId are automatically attached to all logs within
 * a traced operation, enabling end-to-end reconstruction of arbitrage cycles.
 */
export class TraceContext {
  static getContext(): TraceCtx | undefined {
    return asyncLocalStorage.getStore()
  }

  static async runWithTrace<T>(
    trigger: string,
    callback: (traceId: string) => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const traceId = randomUUID()
    const spanId = randomUUID()

    const context: TraceCtx = {
      traceId,
      spanId,
      trigger,
      metadata,
    }

    return asyncLocalStorage.run(context, () => callback(traceId))
  }

  static runWithExistingTrace<T>(
    traceId: string,
    trigger: string,
    callback: () => T,
    metadata?: Record<string, any>
  ): T {
    const spanId = randomUUID()

    const context: TraceCtx = {
      traceId,
      spanId,
      trigger,
      metadata,
    }

    return asyncLocalStorage.run(context, callback)
  }

  static async runWithSpan<T>(callback: (spanId: string) => Promise<T>): Promise<T> {
    const currentContext = asyncLocalStorage.getStore()

    if (!currentContext) {
      throw new Error('Cannot create span without parent trace context')
    }

    const spanId = randomUUID()
    const newContext: TraceCtx = {
      ...currentContext,
      parentSpanId: currentContext.spanId,
      spanId,
    }

    return asyncLocalStorage.run(newContext, () => callback(spanId))
  }

  static updateMetadata(metadata: Record<string, any>): void {
    const currentContext = asyncLocalStorage.getStore()

    if (currentContext) {
      currentContext.metadata = {
        ...currentContext.metadata,
        ...metadata,
      }
    }
  }

  static getTraceFields(): Partial<TraceCtx> {
    const context = asyncLocalStorage.getStore()

    if (!context) {
      return {}
    }

    return {
      traceId: context.traceId,
      spanId: context.spanId,
      trigger: context.trigger,
      ...(context.parentSpanId && { parentSpanId: context.parentSpanId }),
    }
  }
}
