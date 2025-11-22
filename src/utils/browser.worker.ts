import { parentPort } from 'worker_threads'
import { chromium, Browser as PlaywrightBrowser, BrowserContext, Page } from 'playwright'
import type { WorkerRequest, WorkerResponse } from './browser.types'

let browser: PlaywrightBrowser | null = null
let context: BrowserContext | null = null

async function initBrowser(): Promise<void> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-http2',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-pings',
        '--disable-logging',
        '--disable-permissions-api',
        '--disable-presentation-api',
        '--disable-print-preview',
        '--disable-speech-api',
        '--disable-file-system',
        '--disable-notifications',
        '--disable-geolocation',
        '--disable-media-session',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ],
    })
  }

  if (!context) {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.006 },
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Upgrade-Insecure-Requests': '1',
        DNT: '1',
      },
    })
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  await initBrowser()

  if (!context) {
    throw new Error('Browser context not initialized')
  }

  const page: Page = await context.newPage()

  try {
    page.setDefaultTimeout(timeoutMs)

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: timeoutMs,
    })

    const content = await page.textContent('body')

    if (!content) {
      throw new Error('No content received from page')
    }

    const json = JSON.parse(content)
    return json
  } finally {
    await page.close().catch(() => {
      // Ignore errors when closing page
    })
  }
}

async function close(): Promise<void> {
  if (context) {
    await context.close()
    context = null
  }

  if (browser) {
    await browser.close()
    browser = null
  }
}

if (parentPort) {
  parentPort.on('message', async (request: WorkerRequest) => {
    const response: WorkerResponse = {
      id: request.id,
      success: false,
    }

    try {
      if (request.type === 'fetchJson') {
        const data = await fetchJson(request.url, request.timeoutMs)
        response.success = true
        response.data = data
      } else if (request.type === 'close') {
        await close()
        response.success = true
      }

      parentPort?.postMessage(response)
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error)
      parentPort?.postMessage(response)
    }
  })
}

