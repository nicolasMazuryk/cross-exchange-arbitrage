# 10 — Cold Path

Tier raw data older than 3 days to Hetzner Object Storage as Parquet. CH manages move via TTL `TO VOLUME 'cold'`. Backtests read directly via `s3()` table function; rehydrate for repeated runs.

`funding_rates` is also tiered via `TTL ts + INTERVAL 90 DAY TO VOLUME 'cold'`. It is small (< 1 GB/y at projected volume) and stays on the native S3 disk only — no daily Parquet export.

## Goals

- Indefinite retention of `orderbooks` + `spreads` at minimal cost.
- Parquet format for portability (read from pandas / DuckDB / external tools).
- Day-partitioned object layout for full-day scan efficiency.
- No automated rehydrate; backtester rehydrates the window it needs.

## Storage policy

The `tiered` policy (`hot=nvme → warm=volume → cold=s3`, `move_factor 0.2`) and its config are infra-owned → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#clickhouse). Tables `orderbooks` and `spreads` declare `TTL ts + INTERVAL 3 DAY TO VOLUME 'cold'` (DDL in [04](./04-clickhouse-schemas.md)); CH's background move job migrates parts to the S3 disk.

## S3 disk format vs Parquet format

CH's S3 disk stores native `.bin` parts on S3 — readable only by CH, not pandas. For portable Parquet, we **also** run a daily export:

```sql
-- Run by cron 00:05 UTC daily for D-1.
-- <cold-bucket-endpoint> + S3 creds are injected from config/secrets;
-- the bucket itself is provisioned by infra (see Links).
INSERT INTO FUNCTION
  s3(
    '<cold-bucket-endpoint>/orderbooks/date={d:String}/part-{_part_index}.parquet',
    'S3_ACCESS_KEY', 'S3_SECRET_KEY',
    'Parquet'
  )
SELECT * FROM orderbooks
WHERE toDate(ts) = {d:Date}
SETTINGS s3_max_part_size = 1024 * 1024 * 256;
```

Two physical copies of cold orderbooks:

| Copy | Lives in | Read by | Cost |
|---|---|---|---|
| Native S3 disk parts | `s3://<cold-bucket>/disks/s3/...` (CH-managed prefix) | CH only, via normal `SELECT … FROM orderbooks` after TTL move | Already counted in CH ingest size |
| Parquet day files | `s3://<cold-bucket>/orderbooks/date=YYYY-MM-DD/*.parquet` | External tools + CH `s3()` function | Daily export |

For budget tightness in P3, we can drop the native S3 copy (`MODIFY TTL … DELETE` after Parquet export confirmed), keeping only Parquet:

```sql
-- P3 candidate: replace TO VOLUME 'cold' with DELETE
ALTER TABLE orderbooks
  MODIFY TTL ts + INTERVAL 3 DAY DELETE
  WHERE _part_min_time < parquet_export_watermark();
```

Decision deferred until we measure Parquet export reliability over 30 days.

## Object layout

```
s3://<cold-bucket>/
├── orderbooks/
│   └── date=2026-05-25/
│       ├── part-0.parquet
│       └── part-1.parquet
├── spreads/
│   └── date=2026-05-25/
│       └── part-0.parquet
├── trades/                 # one-shot exports, e.g. monthly
│   └── month=2026-05/part-0.parquet
└── disks/
    └── s3/                 # CH-native S3 disk parts, opaque
```

Full-day scans match the `date=YYYY-MM-DD/*.parquet` pattern. Hive-style partition discovery works in DuckDB/Spark.

## Daily export job

```ts
// scripts/cold_export.ts (run by cron on the core box — the ClickHouse host)
import { createClient } from '@clickhouse/client'

const ch = createClient({ url: 'http://127.0.0.1:8123' })
const dStr = process.argv[2] ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
const COLD = process.env.COLD_BUCKET_URL // e.g. https://<region>.your-objectstorage.com/<bucket>

const TABLES = ['orderbooks', 'spreads'] as const
for (const table of TABLES) {
  await ch.command({
    query: `
      INSERT INTO FUNCTION s3(
        '${COLD}/${table}/date=${dStr}/part-{_part_index}.parquet',
        {access:String}, {secret:String}, 'Parquet'
      )
      SELECT * FROM ${table}
      WHERE toDate(ts) = toDate({d:String})
      SETTINGS s3_max_part_size = 268435456
    `,
    query_params: { access: process.env.S3_ACCESS_KEY, secret: process.env.S3_SECRET_KEY, d: dStr },
  })
}
```

This script (`scripts/cold_export.ts`) is **app-owned**. The daily cron **trigger** (`5 0 * * *`) and the `COLD_BUCKET_URL` / `S3_*` config are provided by infra at deploy ([`../../intents/infrastructure/deployment-ci-cd.md`](../../intents/infrastructure/deployment-ci-cd.md)); the bucket is provisioned by Terraform.

Idempotent: re-runs overwrite same prefix.

## Backtest read patterns

### One-day scan

```sql
SELECT exchange, symbol, avg(spread_bps) AS avg_spread
FROM s3(
  '<cold-bucket-endpoint>/orderbooks/date=2026-04-15/*.parquet',
  'S3_ACCESS_KEY','S3_SECRET_KEY',
  'Parquet'
)
WHERE symbol = 'BTC/USDT'
GROUP BY exchange, symbol;
```

### Date range

```sql
SELECT *
FROM s3(
  '<cold-bucket-endpoint>/spreads/date=2026-04-*/*.parquet',
  'S3_ACCESS_KEY','S3_SECRET_KEY',
  'Parquet'
)
WHERE symbol = 'BTC/USDT'
  AND buy_exchange = 'binance'
  AND sell_exchange = 'okx'
  AND spread_bps > 5;
```

### Rehydrate for repeated backtest

```sql
CREATE TABLE backtest_orderbooks_2026_04 ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts) ORDER BY (symbol, exchange, ts) AS
SELECT * FROM s3(
  '<cold-bucket-endpoint>/orderbooks/date=2026-04-*/*.parquet',
  'S3_ACCESS_KEY','S3_SECRET_KEY',
  'Parquet'
);
```

Lives on warm volume for the duration of the backtest run. `DROP TABLE` when done.

## Cost model

Cold-tier per-year footprint, the per-TB cost model, and budget-overrun mitigations (BBO-only post-day-30, lower spread retention, ZSTD-9) live in the infra capacity spec → [`../../intents/infrastructure/capacity-and-cost.md`](../../intents/infrastructure/capacity-and-cost.md#cold-tier-per-year).

## Risks

- **Parquet write throughput**: 95 GB/day in one `INSERT INTO FUNCTION s3()` is heavy; chunk by hour if observed > 30 min wall-clock.
- **S3 read latency**: range scans on Hetzner Object Storage are ~50-200 ms first byte; CH `s3()` prefetches. Acceptable for "seconds-to-tens" UI latency.
- **Manifest absence**: no Iceberg/Delta; cold reads are best-effort by prefix. Manual reconciliation script in P3 if gaps appear.

## Links

- TTL DDL → [04-clickhouse-schemas.md](./04-clickhouse-schemas.md)
- Storage policy config → [`../../intents/infrastructure/ansible-configuration.md`](../../intents/infrastructure/ansible-configuration.md#clickhouse)
- Cold-tier footprint, cost model & budget → [`../../intents/infrastructure/capacity-and-cost.md`](../../intents/infrastructure/capacity-and-cost.md#cold-tier-per-year)
- Bucket provisioning → [`../../intents/infrastructure/infrastructure-provisioning.md`](../../intents/infrastructure/infrastructure-provisioning.md#object-storage-bucket-usage)
