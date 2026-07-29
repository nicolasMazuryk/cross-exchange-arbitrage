/**
 * Thin trader stub.
 *
 * Boots, serves `/up` (8081) + `/metrics` (9464), then — in the background,
 * never blocking or crashing the health server — produces ONE dummy `ob.ticks`
 * tick to Redpanda and pings ClickHouse with `SELECT 1`. Proves the deploy +
 * healthcheck + warm-path wiring end-to-end without any real arbitrage logic
 * (that is datapipeline-owned). See framework/plans/infrastructure/11-*.md.
 */
import http from 'http'
import { Kafka } from 'kafkajs'
import { createClient } from '@clickhouse/client'
import { Counter, collectDefaultMetrics } from 'prom-client'
import { startHealthServer } from './stubs/health'
import { stubLogger } from './stubs/stubLogger'

const logger = stubLogger('trader-stub')
const VERSION = process.env.npm_package_version || '1.0.0'

const UP_PORT = Number(process.env.UP_PORT || 8081)
const METRICS_PORT = Number(process.env.METRICS_PORT || 9464)
// Canonical deploy-spec names first; dev-compose names as defensive fallback.
const BROKERS = (process.env.REDPANDA_BROKERS || process.env.KAFKA_BROKERS || '127.0.0.1:9092').split(',')
const CH_URL = process.env.CH_URL || process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123'
const OB_TICKS_TOPIC = 'ob.ticks'

collectDefaultMetrics()
const obticksProduced = new Counter({
  name: 'stub_obticks_produced_total',
  help: 'Dummy ob.ticks records produced by the trader stub',
})
const chPing = new Counter({
  name: 'stub_ch_ping_total',
  help: 'ClickHouse ping attempts by the trader stub',
  labelNames: ['result'] as const,
})

// Bounded retries — stub fails fast when Redpanda is unreachable instead of
// retrying for ~30s; the warm produce is best-effort and never gates /up.
const kafka = new Kafka({
  clientId: 'arbinet-trader-stub',
  brokers: BROKERS,
  retry: { retries: 2, initialRetryTime: 100 },
})
const producer = kafka.producer({ allowAutoTopicCreation: true })
const chClient = createClient({
  url: CH_URL,
  username: process.env.CH_USER || 'default',
  password: process.env.CH_PASSWORD || '',
})

async function produceDummyTick(): Promise<void> {
  try {
    await producer.connect()
    const tick = {
      symbol: 'BTC/USDT',
      exchange: 'stub',
      bid: 50000,
      ask: 50001,
      ts: new Date().toISOString(),
    }
    const result = await producer.send({
      topic: OB_TICKS_TOPIC,
      messages: [{ key: tick.symbol, value: JSON.stringify(tick) }],
    })
    obticksProduced.inc()
    const md = result[0]
    logger.info({
      msg: 'Produced dummy ob.ticks tick',
      function: 'trader.produceDummyTick',
      topic: md?.topicName ?? OB_TICKS_TOPIC,
      partition: md?.partition,
      offset: md?.baseOffset,
      brokers: BROKERS,
    })
  } catch (error) {
    logger.error({
      msg: 'Failed to produce ob.ticks tick',
      function: 'trader.produceDummyTick',
      brokers: BROKERS,
      error,
    })
  }
}

async function pingClickHouse(): Promise<void> {
  try {
    const rs = await chClient.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    const rows = await rs.json()
    chPing.inc({ result: 'ok' })
    logger.info({ msg: 'ClickHouse ping OK', function: 'trader.pingClickHouse', url: CH_URL, rows })
  } catch (error) {
    chPing.inc({ result: 'error' })
    logger.error({ msg: 'ClickHouse ping failed', function: 'trader.pingClickHouse', url: CH_URL, error })
  }
}

async function main(): Promise<void> {
  logger.info({
    msg: 'trader stub starting',
    function: 'trader.main',
    name: 'trader',
    version: VERSION,
    node: process.version,
  })

  const upServer = await startHealthServer({ port: UP_PORT, name: 'trader-up' })
  const metricsServer = await startHealthServer({ port: METRICS_PORT, name: 'trader-metrics' })

  // Background warm-path exercise — never blocks or crashes the /up server.
  void (async () => {
    await produceDummyTick()
    await pingClickHouse()
  })()

  installShutdown([upServer, metricsServer])
}

function installShutdown(servers: http.Server[]): void {
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ msg: 'Shutting down', function: 'trader.shutdown', signal })
    await Promise.allSettled([
      ...servers.map(s => new Promise<void>(r => s.close(() => r()))),
      producer.disconnect(),
      chClient.close(),
    ])
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(error => {
  logger.error({ msg: 'trader stub fatal', function: 'trader.main', error })
  process.exit(1)
})
