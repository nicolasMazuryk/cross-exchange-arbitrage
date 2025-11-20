import Redis from 'ioredis'
import { Logger } from '../../utils/logger'
import { TrackedTrade } from '../trading/tradeMonitor'
import config from '../../utils/config'

const logger = new Logger('state')

export interface AppState {
  trackedTrades: TrackedTrade[]
  lastUpdateTimestamp: number
}

export class State {
  private redis: Redis | null = null
  private readonly keyPrefix: string
  private isConnected = false

  constructor() {
    this.keyPrefix = config.redis.keyPrefix
  }

  /**
   * Initialize Redis connection
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.redis) {
      logger.warn({ msg: 'Redis already connected', function: 'State.connect' })
      return
    }

    try {
      this.redis = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      })

      this.redis.on('error', error => {
        logger.error({ msg: 'Redis connection error', function: 'State.connect', error })
        this.isConnected = false
      })

      this.redis.on('connect', () => {
        logger.info({ msg: 'Redis connecting...', function: 'State.connect' })
      })

      this.redis.on('ready', () => {
        logger.info({ msg: 'Redis connection ready', function: 'State.connect' })
        this.isConnected = true
      })

      this.redis.on('close', () => {
        logger.warn({ msg: 'Redis connection closed', function: 'State.connect' })
        this.isConnected = false
      })

      // Wait for connection to be ready
      await this.redis.ping()
      this.isConnected = true

      logger.info({ msg: 'Redis state service connected', function: 'State.connect' })
    } catch (error) {
      logger.error({ msg: 'Failed to connect to Redis', function: 'State.connect', error })
      this.isConnected = false
      throw error
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit()
      this.redis = null
      this.isConnected = false
      logger.info({ msg: 'Redis state service disconnected', function: 'State.disconnect' })
    }
  }

  /**
   * Check if Redis is connected
   */
  isRedisConnected(): boolean {
    return this.isConnected && this.redis !== null
  }

  /**
   * Generic set method to save data to Redis
   */
  async set<T>(key: string, value: T): Promise<void> {
    if (!this.isRedisConnected() || !this.redis) {
      logger.error({ msg: 'Redis not connected, skipping set', function: 'State.set', key })
      return
    }

    try {
      const fullKey = `${this.keyPrefix}${key}`
      const serialized = JSON.stringify(value)

      await this.redis.set(fullKey, serialized)

      logger.debug({ msg: `"${key}" saved to Redis`, function: 'State.set', key: fullKey })
    } catch (error) {
      logger.error({ msg: `"${key}" failed to save to Redis`, function: 'State.set', key, error })
      throw error
    }
  }

  /**
   * Generic get method to load data from Redis
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isRedisConnected() || !this.redis) {
      logger.error({ msg: 'Redis not connected, returning null', function: 'State.get', key })
      return null
    }

    try {
      const fullKey = `${this.keyPrefix}${key}`
      const serialized = await this.redis.get(fullKey)

      if (!serialized) {
        logger.debug({ msg: 'No data found in Redis', function: 'State.get', key: fullKey })
        return null
      }

      const value: T = JSON.parse(serialized)

      logger.debug({ msg: `"${key}" loaded from Redis`, function: 'State.get', key: fullKey })

      return value
    } catch (error) {
      logger.error({ msg: `"${key}" failed to load from Redis`, function: 'State.get', key, error })
      return null
    }
  }

  /**
   * Delete a key from Redis
   */
  async delete(key: string): Promise<void> {
    if (!this.isRedisConnected() || !this.redis) {
      logger.error({ msg: 'Redis not connected, skipping delete', function: 'State.delete', key })
      return
    }

    try {
      const fullKey = `${this.keyPrefix}${key}`
      await this.redis.del(fullKey)

      logger.debug({ msg: `"${key}" deleted from Redis`, function: 'State.delete', key: fullKey })
    } catch (error) {
      logger.error({ msg: `"${key}" failed to delete from Redis`, function: 'State.delete', key, error })
      throw error
    }
  }

  /**
   * Save a tracked trade to Redis
   */
  async saveTrackedTrade(trade: TrackedTrade): Promise<void> {
    const key = `tracked-trades:${trade.id}`
    await this.set<TrackedTrade>(key, trade)
    logger.debug({ msg: 'Tracked trade saved', function: 'State.saveTrackedTrade', tradeId: trade.id })
  }

  /**
   * Load a tracked trade from Redis
   */
  async loadTrackedTrade(tradeId: string): Promise<TrackedTrade | null> {
    const key = `tracked-trades:${tradeId}`
    return await this.get<TrackedTrade>(key)
  }

  /**
   * Load all tracked trades from Redis
   */
  async getAllTrackedTrades(): Promise<TrackedTrade[]> {
    if (!this.isRedisConnected() || !this.redis) {
      logger.error({ msg: 'Redis not connected, returning empty trades', function: 'State.getAllTrackedTrades' })
      return []
    }

    try {
      const pattern = `${this.keyPrefix}tracked-trades:*`
      const keys = await this.redis.keys(pattern)

      if (keys.length === 0) {
        logger.debug({ msg: 'No tracked trades found in Redis', function: 'State.getAllTrackedTrades' })
        return []
      }

      const trades: TrackedTrade[] = []
      for (const key of keys) {
        const serialized = await this.redis.get(key)
        if (serialized) {
          try {
            const trade: TrackedTrade = JSON.parse(serialized)
            trades.push(trade)
          } catch (error) {
            logger.error({ msg: 'Failed to parse tracked trade', function: 'State.getAllTrackedTrades', key, error })
          }
        }
      }

      logger.debug({
        msg: 'Tracked trades loaded from Redis',
        function: 'State.getAllTrackedTrades',
        tradeCount: trades.length,
      })

      return trades
    } catch (error) {
      logger.error({ msg: 'Failed to load tracked trades from Redis', function: 'State.getAllTrackedTrades', error })
      return []
    }
  }

  /**
   * Load only open tracked trades from Redis (filters by status === 'open')
   */
  async getAllOpenTrackedTrades(): Promise<TrackedTrade[]> {
    const allTrades = await this.getAllTrackedTrades()
    const openTrades = allTrades.filter(trade => trade.status === 'open')

    logger.info({
      msg: 'Open tracked trades loaded from Redis',
      function: 'State.getAllOpenTrackedTrades',
      totalTrades: allTrades.length,
      openTrades: openTrades.length,
    })

    return openTrades
  }

  /**
   * Update a tracked trade in Redis
   */
  async updateTrackedTrade(trade: TrackedTrade): Promise<void> {
    const key = `tracked-trades:${trade.id}`
    await this.set<TrackedTrade>(key, trade)
    logger.debug({
      msg: 'Tracked trade updated',
      function: 'State.updateTrackedTrade',
      tradeId: trade.id,
      status: trade.status,
    })
  }

  /**
   * Remove a tracked trade from Redis (legacy method, prefer updateTrackedTrade)
   */
  async removeTrackedTrade(tradeId: string): Promise<void> {
    const key = `tracked-trades:${tradeId}`
    await this.delete(key)
    logger.debug({ msg: 'Tracked trade removed', function: 'State.removeTrackedTrade', tradeId })
  }
}
