/**
 * Funding Rate Types and Schema
 *
 * This module defines the types and interfaces for handling perpetual funding rates
 * across different exchanges, with normalization to a common schema.
 */

export interface RawFundingRate {
  symbol: string // Exchange-native symbol (e.g., BTCUSDT, BTC/USDT:USDT)
  fundingRate?: number // Signed decimal per exchange's interval (e.g., 0.0001 = 1 bps)
  fundingIntervalHours?: number // If provided by exchange (1, 2, 4, 8, etc.)
  nextFundingTime?: number // ms epoch timestamp
  timestamp?: number // When this data was fetched (ms epoch)
}

/**
 * Parsed Funding Data Interface
 *
 * This interface represents the normalized funding data structure
 * that will be returned by the browser-based funding fetchers.
 */

export interface ParsedFunding {
  exchange: string
  symbol: string
  fundingRate: number
  fundingRatePercent: number
  fundingInterval: number
  nextFundingTimestamp: number
  nextFundingDatetime: Date
}

export interface FundingConfig {
  fetchIntervalMs: number // How often to fetch funding rates using browser automation
  maxDataAgeMs: number // Maximum age of funding data before considering stale
  supportedExchanges: string[] // Exchanges that support funding rate fetching
  // Funding Arbitrage Projection Settings
  projectionHours: number // number of hours to project funding profitability
}
