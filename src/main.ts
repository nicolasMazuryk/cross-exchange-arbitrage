import config from './utils/config'
import logger from './utils/logger'
import { BinanceWebSocketClient } from './adapters/websocket/binance'
import { OrderbookManager } from './core/orderbook/orderbookManager'
import { BinanceExchange } from './adapters/rest'

async function main() {
  try {
    logger.info('Starting ArbiNet...', {
      environment: config.app.environment,
    })

    // Initialize Binance exchange
    const binance = new BinanceExchange({
      apiKey: config.exchanges.binance.apiKey,
      apiSecret: config.exchanges.binance.apiSecret
    })

    await binance.loadMarkets()

    // Fetch all USDT perpetual pairs
    const pairs = await binance.getUSDTPerpetualSymbols()

    // Initialize orderbook manager
    const orderbookManager = new OrderbookManager()

    // Initialize WebSocket client
    const wsClient = new BinanceWebSocketClient()

    // Connect WebSocket updates to orderbook manager
    wsClient.on('orderbookUpdate', update => {
      orderbookManager.updateOrderbook(update)
    })

    // TODO: Initialize exchange adapters
    // TODO: Initialize orderbook manager
    // TODO: Initialize arbitrage engine
    // TODO: Initialize trade execution engine
    // TODO: Initialize trade monitor

    // Initialize WebSocket connections
    await wsClient.initialize(pairs)

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Shutting down...')
      wsClient.close()
      process.exit(0)
    })

    logger.info('ArbiNet initialized successfully')
  } catch (error) {
    logger.error('Fatal error:', error)
    process.exit(1)
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  logger.error('Uncaught Exception', { error })
  process.exit(1)
})

// Handle unhandled promise rejections
process.on('unhandledRejection', reason => {
  logger.error('Unhandled Rejection', { reason })
  process.exit(1)
})

main()
