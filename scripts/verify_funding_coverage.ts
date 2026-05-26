/**
 * Verification script: confirms all 4 exchange funding adapters return correct data
 * after migration from Playwright/UI scraping to CCXT-only APIs.
 *
 * Checks:
 * - Binance: linear + inverse coverage, BTC/USD:BTC inverse present, interval data
 * - OKX: nextFundingTimestamp is in the future (not past)
 * - Bybit: USDC perp coverage (BNB/USDC:USDC or similar), linear + inverse counts
 * - Bitget: inverse + USDT-FUTURES counts, nextFundingTimestamp in future
 */

import * as dotenv from 'dotenv'
dotenv.config()

import appConfig from '../src/utils/config'
import { BinanceExchange } from '../src/adapters/rest/binance'
import { OkxExchange } from '../src/adapters/rest/okx'
import { BybitExchange } from '../src/adapters/rest/bybit'
import { BitgetExchange } from '../src/adapters/rest/bitget'
import { ExchangeConfig } from '../src/adapters/rest/types'

const now = Date.now()

function pass(msg: string) { console.log(`  ✅ ${msg}`) }
function fail(msg: string) { console.log(`  ❌ ${msg}`) }
function info(msg: string) { console.log(`  ℹ️  ${msg}`) }

function makeConfig(name: string): ExchangeConfig {
  const cfg = (appConfig.exchanges as any)[name]
  return {
    apiKey: cfg?.apiKey ?? process.env[`${name.toUpperCase()}_API_KEY`] ?? '',
    apiSecret: cfg?.apiSecret ?? process.env[`${name.toUpperCase()}_API_SECRET`] ?? '',
    apiPass: cfg?.apiPass ?? process.env[`${name.toUpperCase()}_API_PASS`],
  }
}

async function checkBinance() {
  console.log('\n=== Binance ===')
  const ex = new BinanceExchange(makeConfig('binance'))
  const data = await ex.fetchFundingData()
  info(`Total symbols: ${data.size}`)

  const linear = [...data.values()].filter(d => d.symbol.includes(':USDT') || d.symbol.includes(':USDC'))
  const inverse = [...data.values()].filter(d => !d.symbol.includes(':USDT') && !d.symbol.includes(':USDC') && d.symbol.includes(':'))
  const tokenized = [...data.values()].filter(d => /^[A-Z]+\/[A-Z]+:[A-Z]+$/.test(d.symbol) && !['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','DOT','LINK','MATIC','NEAR','ATOM','LTC','BCH','UNI','AAVE','MKR','COMP','SNX','YFI','SUSHI','CRV','BAL','REN','OCEAN','BAND','KNC','ZRX','ENJ','CHZ','SAND','MANA','GALA','AXS','ALICE','TLM','FARM','QUICK','ALPHA','RUNE','DYDX','LIT','PERP','RAY','SRM','FIDA','MAPS','OXY','MEDIA','COPE','LIKE','SLND','PORT','STEP','TULIP','SNY','MER','SLIM','ATP','LARIX','ACLAIM','TEST','FLOKI','PEPE','SHIB','BONE','LEASH','BABYDOGE','SAMO','WOOF','MYRO','WIF','BONK','MEME','BOME','SLERF','MOTHER','MOG','POPCAT','CAT','RATS','ORDI','SATS','TRAC','CSPR','AR','FLUX','RNDR','OCEAN','FET','AGIX','CTXC','NMR','GRT','LPT','API3','BAND','CELR','SKL','LRC','DUSK','STORJ','ZIL','COTI','HBAR','ONE','IOTA','ELF','ONT','QTUM','NEO','ZEC','DASH','DGB','SC','ZEN','ARDR','STMX','WAN','DOCK','VITE','BEAM','MINA','FLOW','ROSE','CELO','LUNA','KAVA','BAND','ANKR','TWT','WIN','BTT','CELR','CHR','COCOS','COS','DREP','DUSK','ERD','MATIC','FOR','FRM','HOT','IRIS','KAVA','LEND','LIT','MBL','MDT','NULS','OGN','PERL','POLY','STORM','TROY','VITE','WIN','WTC','XEM','XVSA','XVS','ZIL','AKRO','AVA','BDOT','BETH','BUSD','BZRX','CREAM','CVP','DEFI','ERN','FRONT','HARD','JST','KSM','LINA','LIT','LUNA','MDX','MIR','OM','OXT','PNT','REEF','RUNE','SFP','SXP','TKO','TRB','TRU','TWT','VELO','WNXM','WOO','YFI','YFII'].includes(d.symbol.split('/')[0]))

  info(`Linear perps: ${linear.length}`)
  info(`Inverse perps: ${inverse.length}`)

  linear.length > 0 ? pass(`Linear perp coverage present`) : fail(`No linear perps found`)
  inverse.length > 0 ? pass(`Inverse perp coverage present`) : fail(`No inverse perps found`)

  // Check BTC/USD:BTC (inverse)
  const btcInverse = data.get('BTC/USD:BTC')
  btcInverse
    ? pass(`BTC/USD:BTC (inverse) present — rate=${btcInverse.fundingRatePercent.toFixed(4)}%, interval=${btcInverse.fundingInterval}h, next=${new Date(btcInverse.nextFundingTimestamp).toISOString()}`)
    : fail(`BTC/USD:BTC (inverse) NOT present`)

  // Check BTC/USDT:USDT (linear)
  const btcLinear = data.get('BTC/USDT:USDT')
  btcLinear
    ? pass(`BTC/USDT:USDT (linear) present — rate=${btcLinear.fundingRatePercent.toFixed(4)}%, interval=${btcLinear.fundingInterval}h`)
    : fail(`BTC/USDT:USDT (linear) NOT present`)

  // Verify intervals are numeric and reasonable
  const badIntervals = [...data.values()].filter(d => isNaN(d.fundingInterval) || d.fundingInterval <= 0 || d.fundingInterval > 24)
  badIntervals.length === 0
    ? pass(`All fundingInterval values are valid (1–24h)`)
    : fail(`${badIntervals.length} symbols have invalid fundingInterval: ${badIntervals.slice(0, 3).map(d => `${d.symbol}=${d.fundingInterval}`).join(', ')}`)

  // Check nextFundingTimestamp is in the future for at least 90% of symbols
  const future = [...data.values()].filter(d => d.nextFundingTimestamp > now)
  const pct = (future.length / data.size * 100).toFixed(1)
  future.length / data.size > 0.9
    ? pass(`${pct}% of nextFundingTimestamp values are in the future`)
    : fail(`Only ${pct}% of nextFundingTimestamp values are in the future — likely using wrong timestamp field`)
}

async function checkOkx() {
  console.log('\n=== OKX ===')
  const ex = new OkxExchange(makeConfig('okx'))
  const data = await ex.fetchFundingData()
  info(`Total symbols: ${data.size}`)

  const linear = [...data.values()].filter(d => d.symbol.includes(':USDT') || d.symbol.includes(':USDC'))
  info(`Linear perps: ${linear.length}`)
  linear.length > 0 ? pass(`Linear perp coverage present`) : fail(`No linear perps found`)

  const btc = data.get('BTC/USDT:USDT')
  btc
    ? pass(`BTC/USDT:USDT present — rate=${btc.fundingRatePercent.toFixed(4)}%, interval=${btc.fundingInterval}h`)
    : fail(`BTC/USDT:USDT NOT present`)

  // Critical: OKX nextFundingTimestamp must be in the future
  const future = [...data.values()].filter(d => d.nextFundingTimestamp > now)
  const past = [...data.values()].filter(d => d.nextFundingTimestamp <= now)
  const pct = (future.length / data.size * 100).toFixed(1)

  future.length / data.size > 0.9
    ? pass(`${pct}% of nextFundingTimestamp values are in the future (using nextFundingTimestamp, not fundingTimestamp)`)
    : fail(`Only ${pct}% of nextFundingTimestamp values are in the future — check if using wrong timestamp field. Past examples: ${past.slice(0, 2).map(d => `${d.symbol}=${new Date(d.nextFundingTimestamp).toISOString()}`).join(', ')}`)

  if (btc) {
    btc.nextFundingTimestamp > now
      ? pass(`BTC/USDT:USDT nextFundingTimestamp=${new Date(btc.nextFundingTimestamp).toISOString()} is in the future`)
      : fail(`BTC/USDT:USDT nextFundingTimestamp=${new Date(btc.nextFundingTimestamp).toISOString()} is in the PAST — wrong field used`)
  }
}

async function checkBybit() {
  console.log('\n=== Bybit ===')
  const ex = new BybitExchange(makeConfig('bybit'))
  const data = await ex.fetchFundingData()
  info(`Total symbols: ${data.size}`)

  const usdtLinear = [...data.values()].filter(d => d.symbol.endsWith(':USDT'))
  const usdcLinear = [...data.values()].filter(d => d.symbol.endsWith(':USDC'))
  const inverse = [...data.values()].filter(d => {
    const settle = d.symbol.split(':')[1]
    return settle && settle !== 'USDT' && settle !== 'USDC'
  })

  info(`USDT linear perps: ${usdtLinear.length}`)
  info(`USDC linear perps: ${usdcLinear.length}`)
  info(`Inverse perps: ${inverse.length}`)

  usdtLinear.length > 0 ? pass(`USDT linear coverage present`) : fail(`No USDT linear perps found`)
  inverse.length > 0 ? pass(`Inverse perp coverage present`) : fail(`No inverse perps found`)

  // Critical: USDC perp coverage (previously missing)
  usdcLinear.length > 0
    ? pass(`USDC linear perp coverage present (${usdcLinear.length} symbols) — previously missing`)
    : fail(`USDC linear perps NOT present — regression in USDC coverage`)

  if (usdcLinear.length > 0) {
    const sample = usdcLinear[0]
    info(`USDC sample: ${sample.symbol} rate=${sample.fundingRatePercent.toFixed(4)}%, next=${new Date(sample.nextFundingTimestamp).toISOString()}`)
  }

  const btc = data.get('BTC/USDT:USDT')
  btc
    ? pass(`BTC/USDT:USDT present — rate=${btc.fundingRatePercent.toFixed(4)}%, interval=${btc.fundingInterval}h`)
    : fail(`BTC/USDT:USDT NOT present`)

  // Check live intervals came through (not default)
  const nonDefault = [...data.values()].filter(d => d.fundingInterval !== 8)
  info(`Symbols with non-default interval (≠8h): ${nonDefault.length}`)

  // Future timestamp check
  const future = [...data.values()].filter(d => d.nextFundingTimestamp > now)
  const pct = (future.length / data.size * 100).toFixed(1)
  future.length / data.size > 0.9
    ? pass(`${pct}% of nextFundingTimestamp values are in the future`)
    : fail(`Only ${pct}% of nextFundingTimestamp values are in the future`)
}

async function checkBitget() {
  console.log('\n=== Bitget ===')
  const ex = new BitgetExchange(makeConfig('bitget'))
  const data = await ex.fetchFundingData()
  info(`Total symbols: ${data.size}`)

  const usdtLinear = [...data.values()].filter(d => d.symbol.endsWith(':USDT'))
  const usdcLinear = [...data.values()].filter(d => d.symbol.endsWith(':USDC'))
  const inverse = [...data.values()].filter(d => {
    const settle = d.symbol.split(':')[1]
    return settle && settle !== 'USDT' && settle !== 'USDC'
  })

  info(`USDT linear perps: ${usdtLinear.length}`)
  info(`USDC linear perps: ${usdcLinear.length}`)
  info(`Inverse perps: ${inverse.length}`)

  usdtLinear.length > 0 ? pass(`USDT-FUTURES coverage present`) : fail(`No USDT linear perps found`)
  inverse.length > 0 ? pass(`COIN-FUTURES (inverse) coverage present`) : fail(`No inverse perps found`)

  const btc = data.get('BTC/USDT:USDT')
  btc
    ? pass(`BTC/USDT:USDT present — rate=${btc.fundingRatePercent.toFixed(4)}%, interval=${btc.fundingInterval}h`)
    : fail(`BTC/USDT:USDT NOT present`)

  // Critical: nextFundingTimestamp must be real (from info.nextUpdate), not synthesized
  const future = [...data.values()].filter(d => d.nextFundingTimestamp > now)
  const past = [...data.values()].filter(d => d.nextFundingTimestamp <= now)
  const pct = (future.length / data.size * 100).toFixed(1)

  future.length / data.size > 0.9
    ? pass(`${pct}% of nextFundingTimestamp values are in the future (from info.nextUpdate)`)
    : fail(`Only ${pct}% of nextFundingTimestamp values are in the future. Past examples: ${past.slice(0, 2).map(d => `${d.symbol}=${new Date(d.nextFundingTimestamp).toISOString()}`).join(', ')}`)

  if (btc) {
    btc.nextFundingTimestamp > now
      ? pass(`BTC/USDT:USDT nextFundingTimestamp=${new Date(btc.nextFundingTimestamp).toISOString()} is in the future`)
      : fail(`BTC/USDT:USDT nextFundingTimestamp=${new Date(btc.nextFundingTimestamp).toISOString()} is in the PAST`)
  }
}

async function main() {
  console.log(`\nFunding Coverage Verification — ${new Date().toISOString()}`)
  console.log(`Now: ${now}`)

  await checkBinance().catch(e => console.log(`  ❌ Binance THREW: ${e.message}`))
  await checkOkx().catch(e => console.log(`  ❌ OKX THREW: ${e.message}`))
  await checkBybit().catch(e => console.log(`  ❌ Bybit THREW: ${e.message}`))
  await checkBitget().catch(e => console.log(`  ❌ Bitget THREW: ${e.message}`))

  console.log('\n=== Done ===\n')
}

main().catch(console.error)
