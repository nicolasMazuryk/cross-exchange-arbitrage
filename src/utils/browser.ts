import { Worker } from 'worker_threads'
import { Logger } from './logger'
import { join } from 'path'
import type { WorkerRequest, WorkerResponse } from './browser.types'

const logger = new Logger('browser')

/**
 * Browser utility for fetching data from exchange endpoints protected by Cloudflare
 * Uses worker threads to offload CPU-intensive browser operations
 */
export class Browser {
  private worker: Worker | null = null
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }
  > = new Map()
  private requestIdCounter: number = 0

  private async getWorker(): Promise<Worker> {
    if (!this.worker) {
      const isTsNode = __filename.endsWith('.ts')
      const workerPath = join(__dirname, isTsNode ? 'browser.worker.ts' : 'browser.worker.js')
      this.worker = new Worker(workerPath, isTsNode ? { execArgv: ['-r', 'ts-node/register'] } : undefined)

      this.worker.on('message', (response: WorkerResponse) => {
        const pending = this.pendingRequests.get(response.id)
        if (pending) {
          clearTimeout(pending.timeoutId)
          this.pendingRequests.delete(response.id)
          if (response.success) {
            pending.resolve(response.data)
          } else {
            pending.reject(new Error(response.error || 'Unknown error occurred while fetching funding data via browser'))
          }
        }
      })

      this.worker.on('error', error => {
        logger.error({ msg: 'Worker error', function: 'Browser.getWorker', error })
      })

      this.worker.on('exit', code => {
        if (code !== 0) {
          logger.error({ msg: 'Worker exited', function: 'Browser.getWorker', code })
        }
        // Reject all pending requests if worker exits unexpectedly
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timeoutId)
          pending.reject(new Error('Worker exited unexpectedly'))
        }
        this.pendingRequests.clear()
        this.worker = null
      })
    }
    return this.worker
  }

  private async sendRequest(request: WorkerRequest): Promise<any> {
    const worker = await this.getWorker()
    const id = `req_${++this.requestIdCounter}_${Date.now()}`

    return new Promise((resolve, reject) => {
      // Timeout for requests (default 30s, or use request timeoutMs + buffer)
      const timeout = request.type === 'fetchJson' ? request.timeoutMs + 5000 : 30000
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, timeout)

      this.pendingRequests.set(id, { resolve, reject, timeoutId })
      worker.postMessage({ ...request, id })
    })
  }

  public async fetchJson(url: string, timeoutMs: number = 30000): Promise<any> {
    try {
      logger.trace({ msg: 'Fetching JSON data via browser', function: 'Browser.fetchJson', url, timeoutMs })
      const data = await this.sendRequest({
        type: 'fetchJson',
        url,
        timeoutMs,
        id: '', // Will be set by sendRequest
      })
      logger.trace({ msg: 'Successfully fetched and parsed JSON', function: 'Browser.fetchJson', url })
      return data
    } catch (error) {
      logger.error({ msg: 'Error fetching data via browser', function: 'Browser.fetchJson', url, timeoutMs, error })
      throw error
    }
  }

  /**
   * Close browser and cleanup resources
   */
  public async close(): Promise<void> {
    try {
      if (this.worker) {
        await this.sendRequest({
          type: 'close',
          id: '', // Will be set by sendRequest
        })
        await this.worker.terminate()
        this.worker = null
        logger.trace({ msg: 'Browser resources cleaned up successfully', function: 'Browser.close' })
      }
    } catch (error) {
      logger.error({ msg: 'Error closing browser', function: 'Browser.close', error })
      throw error
    }
  }

  /**
   * Check if browser is initialized
   */
  public isInitialized(): boolean {
    return this.worker !== null
  }
}

// Global browser instance
let globalBrowser: Browser | null = null

/**
 * Get or create the global browser instance
 */
export function getBrowser(): Browser {
  if (!globalBrowser) {
    globalBrowser = new Browser()
  }
  return globalBrowser
}

/**
 * Close the global browser instance
 */
export async function closeBrowser(): Promise<void> {
  try {
    if (globalBrowser) {
      await globalBrowser.close()
      globalBrowser = null
    }
  } catch (error) {
    logger.error({ msg: 'Error closing global browser instance', function: 'closeBrowser', error })
    throw error
  }
}

/**
 * Convenience function to fetch JSON from a URL
 */
export async function fetchJsonFromUrl(url: string): Promise<any> {
  try {
    const browser = getBrowser()
    return await browser.fetchJson(url)
  } catch (error) {
    logger.error({ msg: 'Error in fetchJsonFromUrl', function: 'fetchJsonFromUrl', url, error })
    throw error
  }
}
