import config from './utils/config'
import logger from './utils/logger'
import { BinanceWebSocketClient } from './adapters/websocket/binance'
import { BybitWebSocketClient } from './adapters/websocket/bybit'
import { OkxWebSocketClient } from './adapters/websocket/okx'
import { OrderbookManager } from './core/orderbook/orderbookManager'
import { ArbitrageEngine } from './core/arbitrage/arbitrageEngine'
import { BinanceExchange } from './adapters/rest'
import { BybitExchange } from './adapters/rest'
import { OkxExchange } from './adapters/rest'

async function main() {
  try {
    logger.info('Starting ArbiNet...', {
      environment: config.app.environment,
    })

    // Initialize exchanges
    const binance = new BinanceExchange({
      apiKey: config.exchanges.binance.apiKey,
      apiSecret: config.exchanges.binance.apiSecret,
    })

    const bybit = new BybitExchange({
      apiKey: config.exchanges.bybit.apiKey,
      apiSecret: config.exchanges.bybit.apiSecret,
    })

    const okx = new OkxExchange({
      apiKey: config.exchanges.okx.apiKey,
      apiSecret: config.exchanges.okx.apiSecret,
      apiPass: config.exchanges.okx.apiPass,
    })

    await Promise.all([
      binance.loadMarkets(),
      bybit.loadMarkets(),
      okx.loadMarkets(),
    ])

    // Fetch all USDT perpetual pairs
    const [binanceMarkets, bybitMarkets, okxMarkets] = await Promise.all([
      binance.getTradingMarkets(),
      bybit.getTradingMarkets(),
      okx.getTradingMarkets(),
    ])

    // Initialize orderbook manager
    const orderbookManager = new OrderbookManager()

    // Initialize arbitrage engine
    const exchangeConfigs = [
      {
        name: 'binance',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.binance.fees.maker,
          taker: config.exchanges.binance.fees.taker
        }
      },
      {
        name: 'bybit',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.bybit.fees.maker,
          taker: config.exchanges.bybit.fees.taker
        }
      },
      {
        name: 'okx',
        isHealthy: true,
        feeModel: {
          maker: config.exchanges.okx.fees.maker,
          taker: config.exchanges.okx.fees.taker
        }
      }
    ]

    const blacklistPairs = config.arbitrage.blacklistPairs || []
    const arbitrageEngine = new ArbitrageEngine(
      orderbookManager,
      blacklistPairs,
      exchangeConfigs
    )

    // Listen for arbitrage opportunities
    arbitrageEngine.on('opportunities', (opportunities) => {
      // logger.info('Found arbitrage opportunities:', opportunities)
      // TODO: Pass opportunities to trade execution engine
    })

    // Initialize WebSocket clients
    const binanceWs = new BinanceWebSocketClient({
      apiKey: config.exchanges.binance.apiKey,
      apiSecret: config.exchanges.binance.apiSecret,
      maxStreamsPerConnection: config.exchanges.binance.maxStreamsPerConnection,
      reconnectInterval: config.exchanges.binance.reconnectInterval,
    })
    const bybitWs = new BybitWebSocketClient({
      apiKey: config.exchanges.bybit.apiKey,
      apiSecret: config.exchanges.bybit.apiSecret,
      maxStreamsPerConnection: config.exchanges.bybit.maxStreamsPerConnection,
      reconnectInterval: config.exchanges.bybit.reconnectInterval,
    })
    const okxWs = new OkxWebSocketClient({
      apiKey: config.exchanges.okx.apiKey,
      apiSecret: config.exchanges.okx.apiSecret,
      apiPass: config.exchanges.okx.apiPass,
      maxStreamsPerConnection: config.exchanges.okx.maxStreamsPerConnection,
      reconnectInterval: config.exchanges.okx.reconnectInterval,
    })

    // Connect WebSocket updates to orderbook manager
    binanceWs.on('orderbookUpdate', update => {
      orderbookManager.updateOrderbook(update)
    })

    bybitWs.on('orderbookUpdate', update => {
      orderbookManager.updateOrderbook(update)
    })

    okxWs.on('orderbookUpdate', update => {
      orderbookManager.updateOrderbook(update)
    })

    // TODO: Initialize exchange adapters
    // TODO: Initialize orderbook manager
    // TODO: Initialize arbitrage engine
    // TODO: Initialize trade execution engine
    // TODO: Initialize trade monitor

    // Initialize WebSocket connections
    await Promise.all([
      binanceWs.initialize(binanceMarkets),
      bybitWs.initialize(bybitMarkets),
      okxWs.initialize(okxMarkets),
    ])

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Shutting down...')
      
      binanceWs.close()
      bybitWs.close()
      okxWs.close()
      
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
