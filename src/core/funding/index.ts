/**
 * Funding Rate Module
 *
 * This module provides funding rate arbitrage capabilities for the ArbiNet system.
 * It fetches real-time funding rates from supported exchanges, normalizes them to
 * a common schema, and integrates with the arbitrage engine to identify funding
 * opportunities.
 */

export { FundingService } from './fundingService'
export { FundingFeeCollector } from './fundingFeeCollector'
export * from './types'
