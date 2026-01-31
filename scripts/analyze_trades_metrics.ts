// Script 1: Analyze trade metrics for BUY and SELL sides
// npx ts-node scripts/analyze_trades_metrics.ts

import * as fs from 'fs'
import * as path from 'path'

interface TrackedTrade {
  id: string
  deltaPercent: {
    buyExchange: number
    sellExchange: number
    net: number
  }
  fundingPercent: {
    buyExchange: number
    sellExchange: number
    net: number
  }
  [key: string]: any
}

interface TradeMetrics {
  tradeId: string
  buySide: {
    deltaPercent: number
    fundingPercent: number
    net: number
    percent: number | string
  }
  sellSide: {
    deltaPercent: number
    fundingPercent: number
    net: number
    percent: number | string
  }
}

function calculateMetrics(trade: TrackedTrade): TradeMetrics {
  // BUY side calculations
  const buyDeltaPercent = trade.deltaPercent.buyExchange
  const buyFundingPercent = trade.fundingPercent.buyExchange
  const buyNet = buyDeltaPercent + buyFundingPercent
  const buyPercent = buyFundingPercent !== 0 
    ? (buyNet / buyFundingPercent) * 100 
    : 'N/A (fundingPercent = 0)'

  // SELL side calculations
  const sellDeltaPercent = trade.deltaPercent.sellExchange
  const sellFundingPercent = trade.fundingPercent.sellExchange
  const sellNet = sellDeltaPercent + sellFundingPercent
  const sellPercent = sellFundingPercent !== 0 
    ? (sellNet / sellFundingPercent) * 100 
    : 'N/A (fundingPercent = 0)'

  return {
    tradeId: trade.id,
    buySide: {
      deltaPercent: buyDeltaPercent,
      fundingPercent: buyFundingPercent,
      net: buyNet,
      percent: buyPercent
    },
    sellSide: {
      deltaPercent: sellDeltaPercent,
      fundingPercent: sellFundingPercent,
      net: sellNet,
      percent: sellPercent
    }
  }
}

function formatTable(metrics: TradeMetrics[]): string {
  const header = [
    'Trade ID',
    'BUY delta%',
    'BUY funding%',
    'BUY net',
    'BUY percent',
    'SELL delta%',
    'SELL funding%',
    'SELL net',
    'SELL percent'
  ]

  const rows = metrics.map(m => [
    m.tradeId,
    m.buySide.deltaPercent.toFixed(4),
    m.buySide.fundingPercent.toFixed(4),
    m.buySide.net.toFixed(4),
    typeof m.buySide.percent === 'number' ? m.buySide.percent.toFixed(2) + '%' : m.buySide.percent,
    m.sellSide.deltaPercent.toFixed(4),
    m.sellSide.fundingPercent.toFixed(4),
    m.sellSide.net.toFixed(4),
    typeof m.sellSide.percent === 'number' ? m.sellSide.percent.toFixed(2) + '%' : m.sellSide.percent
  ])

  // Calculate column widths
  const colWidths = header.map((h, i) => {
    const maxWidth = Math.max(
      h.length,
      ...rows.map(r => String(r[i]).length)
    )
    return Math.min(maxWidth, 20) // Cap at 20 for readability
  })

  // Format header
  const headerRow = header.map((h, i) => h.padEnd(colWidths[i])).join(' | ')
  const separator = colWidths.map(w => '-'.repeat(w)).join('-|-')

  // Format rows
  const formattedRows = rows.map(row => 
    row.map((cell, i) => String(cell).padEnd(colWidths[i])).join(' | ')
  )

  return [
    headerRow,
    separator,
    ...formattedRows
  ].join('\n')
}

async function analyzeTrades(): Promise<void> {
  const dumpDir = path.join(process.cwd(), 'redis-dump')
  
  if (!fs.existsSync(dumpDir)) {
    console.error(`❌ Directory ${dumpDir} does not exist`)
    process.exit(1)
  }

  const files = fs.readdirSync(dumpDir)
    .filter(f => f.endsWith('.json'))
    .sort()

  if (files.length === 0) {
    console.error('❌ No JSON files found in redis-dump directory')
    process.exit(1)
  }

  console.log(`📊 Analyzing ${files.length} trade files...\n`)

  const allMetrics: TradeMetrics[] = []

  for (const file of files) {
    const filePath = path.join(dumpDir, file)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const trade: TrackedTrade = JSON.parse(content)
      
      if (trade.deltaPercent && trade.fundingPercent) {
        const metrics = calculateMetrics(trade)
        allMetrics.push(metrics)
      }
    } catch (error) {
      console.warn(`⚠️  Error processing ${file}:`, error)
    }
  }

  if (allMetrics.length === 0) {
    console.error('❌ No valid trades found')
    process.exit(1)
  }

  // Generate table
  const table = formatTable(allMetrics)
  
  // Save report
  const reportDir = path.join(process.cwd(), 'reports')
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true })
  }

  const reportPath = path.join(reportDir, 'trade_metrics_report.txt')
  const reportContent = [
    'Trade Metrics Analysis Report',
    '='.repeat(80),
    `Generated: ${new Date().toISOString()}`,
    `Total Trades Analyzed: ${allMetrics.length}`,
    '',
    table,
    '',
    'Summary Statistics:',
    '-'.repeat(80),
    `BUY Side - Average deltaPercent: ${(allMetrics.reduce((sum, m) => sum + m.buySide.deltaPercent, 0) / allMetrics.length).toFixed(4)}%`,
    `BUY Side - Average fundingPercent: ${(allMetrics.reduce((sum, m) => sum + m.buySide.fundingPercent, 0) / allMetrics.length).toFixed(4)}%`,
    `BUY Side - Average net: ${(allMetrics.reduce((sum, m) => sum + m.buySide.net, 0) / allMetrics.length).toFixed(4)}%`,
    `SELL Side - Average deltaPercent: ${(allMetrics.reduce((sum, m) => sum + m.sellSide.deltaPercent, 0) / allMetrics.length).toFixed(4)}%`,
    `SELL Side - Average fundingPercent: ${(allMetrics.reduce((sum, m) => sum + m.sellSide.fundingPercent, 0) / allMetrics.length).toFixed(4)}%`,
    `SELL Side - Average net: ${(allMetrics.reduce((sum, m) => sum + m.sellSide.net, 0) / allMetrics.length).toFixed(4)}%`
  ].join('\n')

  fs.writeFileSync(reportPath, reportContent, 'utf-8')

  console.log('✅ Analysis complete!')
  console.log(`📄 Report saved to: ${reportPath}\n`)
  console.log(table)
}

analyzeTrades().catch(console.error)

