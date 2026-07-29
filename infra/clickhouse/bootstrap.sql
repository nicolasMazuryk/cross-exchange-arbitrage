-- ArbiNet bootstrap — db + migration tracking table ONLY.
-- App tables, materialized views, and the `fees` seed are datapipeline-owned
-- and arrive via the separate migration tasks. See plans/infrastructure/11-*.md.
CREATE DATABASE IF NOT EXISTS arbinet;

CREATE TABLE IF NOT EXISTS arbinet.migrations (
  version    UInt32,
  name       String,
  applied_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY version;
