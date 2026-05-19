import dns from 'node:dns'
dns.setDefaultResultOrder('ipv4first')

import { createOrchestrator } from './core/orchestration'
import config from './utils/config'
import { Logger } from './utils/logger'
import { TraceContext } from './utils/traceContext'

const logger = new Logger('main')

async function main() {
  // Wrap entire application lifecycle in a trace context
  TraceContext.runWithTrace('main', async traceId => {
    try {
      logger.info({
        msg: `Starting ${config.app.name}...`,
        version: config.app.version,
        environment: process.env.NODE_ENV,
        logLevel: config.app.logLevel,
        nodeVersion: process.version,
      })

      // Create and initialize the orchestrator with default configuration
      const orchestrator = await createOrchestrator()

      // orchestrator.on('arbitrageOpportunities', (opportunities) => {
      // TODO: Handle arbitrage opportunities
      // })

      // orchestrator.on('accountUpdate', (update) => {
      //   // logger.debug({ msg: 'Account state update:\', update)
      //   // TODO: Handle account updates
      // })

      logger.info({ msg: `${config.app.name} startup complete` })
    } catch (error) {
      logger.fatal({ msg: 'Fatal error during startup', error })
      process.exit(1)
    }
  })
}

// Start the application
main().catch((error: Error) => {
  console.error('Failed to start application:', error)
  logger.fatal({ msg: 'Failed to start application', error })
  process.exit(1)
})
