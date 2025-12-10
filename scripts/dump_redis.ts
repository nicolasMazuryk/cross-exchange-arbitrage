// ssh -i ~/.ssh/nicolas -L 6379:localhost:6379 -f -N ec2-user@EC2_HOST
// pkill -f "ssh.*6379.*EC2_HOST"

// npx ts-node scripts/dump_redis.ts

import Redis from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'

interface JsonData {
  entryTimestamp?: number
  [key: string]: any
}

async function dumpRedis(): Promise<void> {
  const redis = new Redis('redis://localhost:6379')
  const keys = await redis.keys('*')

  if (keys.length === 0) {
    console.log('No keys found')
    await redis.quit()
    return
  }

  const dumpDir = path.join(process.cwd(), 'redis-dump')
  if (!fs.existsSync(dumpDir)) {
    fs.mkdirSync(dumpDir, { recursive: true })
  }

  const jsonDataArray: Array<{ key: string; data: JsonData }> = []

  for (const key of keys) {
    const value = await redis.get(key)
    if (value) {
      try {
        const jsonData: JsonData = JSON.parse(value)
        jsonDataArray.push({ key, data: jsonData })
      } catch {
        // Skip non-JSON data
      }
    }
  }

  jsonDataArray.sort((a, b) => (a.data.entryTimestamp ?? 0) - (b.data.entryTimestamp ?? 0))

  for (let i = 0; i < jsonDataArray.length; i++) {
    const { key, data } = jsonDataArray[i]
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filename = `${String(i + 1).padStart(4, '0')}_${safeKey}.json`
    fs.writeFileSync(path.join(dumpDir, filename), JSON.stringify(data, null, 2), 'utf-8')
  }

  console.log(`✅ Saved ${jsonDataArray.length} files to ${dumpDir}`)
  await redis.quit()
}

dumpRedis().catch(console.error)
