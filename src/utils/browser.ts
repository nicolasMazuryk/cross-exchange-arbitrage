import { chromium, Browser as PlaywrightBrowser, BrowserContext, Page } from 'playwright'
import { Logger } from './logger'

const logger = new Logger('browser')

/**
 * Browser utility for fetching data from exchange endpoints protected by Cloudflare
 */
export class Browser {
  private browser: PlaywrightBrowser | null = null
  private context: BrowserContext | null = null

  /**
   * Initialize browser instance
   */
  private async initBrowser(): Promise<void> {
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({ 
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
            '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          ]
        })
        logger.trace({ msg: 'Browser instance launched successfully', function: 'Browser.initBrowser' })
      }
      
      if (!this.context) {
        this.context = await this.browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1920, height: 1080 },
          ignoreHTTPSErrors: true,
          javaScriptEnabled: true,
          locale: 'en-US',
          timezoneId: 'America/New_York',
          geolocation: { latitude: 40.7128, longitude: -74.0060 },
          permissions: ['geolocation'],
          extraHTTPHeaders: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1'
          }
        })
        logger.trace({ msg: 'Browser context created successfully', function: 'Browser.initBrowser' })
      }
    } catch (error) {
      logger.error({ msg: 'Failed to initialize browser', function: 'Browser.initBrowser',
        error, })
      throw error
    }
  }

  public async fetchJson(url: string, timeoutMs: number = 30000): Promise<any> {
    let page: Page | null = null
    
    try {
      await this.initBrowser()
      
      if (!this.context) {
        throw new Error('Browser context not initialized')
      }

      page = await this.context.newPage()
      logger.trace({ msg: 'Fetching JSON data via browser', function: 'Browser.fetchJson',
        url,
        timeoutMs })
      
      page.setDefaultTimeout(timeoutMs)
      
      // Simple navigation without stealth
      await page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: timeoutMs 
      })
      
      // Wait for content
    //   await page.waitForTimeout(1000)
      
      // Get the page content
      const content = await page.textContent('body')
      
      if (!content) {
        throw new Error('No content received from page')
      }
      
      // Try to parse as JSON
      try {
        const json = JSON.parse(content)
        logger.trace({ msg: 'Successfully fetched and parsed JSON', function: 'Browser.fetchJson',
          url, })
        return json
      } catch (parseError) {
        logger.error({ msg: 'Failed to parse JSON response', function: 'Browser.fetchJson',
          url,
          error: parseError, })
        throw parseError
      }
      
    } catch (error) {
      logger.error({ msg: 'Error fetching data via browser', function: 'Browser.fetchJson',
        url,
        timeoutMs,
        error, })
      throw error
    } finally {
      if (page) {
        await page.close().catch(err => {
          logger.error({ msg: 'Error closing browser page', function: 'Browser.fetchJson',
            url,
            error: err, })
        })
      }
    }
  }

  /**
   * Close browser and cleanup resources
   */
  public async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close()
        this.context = null
        logger.trace({ msg: 'Browser context closed', function: 'Browser.close' })
      }
      
      if (this.browser) {
        await this.browser.close()
        this.browser = null
        logger.trace({ msg: 'Browser instance closed', function: 'Browser.close' })
      }
      
      logger.trace({ msg: 'Browser resources cleaned up successfully', function: 'Browser.close' })
    } catch (error) {
      logger.error({ msg: 'Error closing browser', function: 'Browser.close',
        error, })
      throw error
    }
  }

  /**
   * Check if browser is initialized
   */
  public isInitialized(): boolean {
    return this.browser !== null && this.context !== null
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
    logger.error({ msg: 'Error closing global browser instance', function: 'closeBrowser',
      error, })
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
    logger.error({ msg: 'Error in fetchJsonFromUrl', function: 'fetchJsonFromUrl',
      url,
      error, })
    throw error
  }
}
