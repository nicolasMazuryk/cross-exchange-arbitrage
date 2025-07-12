import { createOrchestrator } from './core/orchestration'
import logger from './utils/logger'

async function main() {
  try {
    logger.info('🚀 Starting ArbiNet...')
    
    // Create and initialize the orchestrator with default configuration
    const orchestrator = await createOrchestrator()
    
    orchestrator.on('arbitrageOpportunities', (opportunities) => {
      logger.info('💰 Arbitrage opportunities detected:', opportunities)
      // TODO: Handle arbitrage opportunities
    })
    
    orchestrator.on('accountUpdate', (update) => {
      logger.debug('📊 Account state update:', update)
      // TODO: Handle account updates
    })
    
    logger.info('✅ ArbiNet startup complete')
  } catch (error) {
    logger.error('❌ Fatal error during startup:', error)
    process.exit(1)
  }
}

// Start the application
main()
