# Scaling triggers → action

When capacity pressure shows up, this is the trigger → action map. Source:
[spec 06 §scaling-triggers](../../framework/specs/infrastructure/06-capacity-and-cost.md#scaling-triggers).
Most actions are a Terraform or Ansible role-var change. The drop-on-timeout warm
hop means hot-path latency degrades gracefully regardless.

| Trigger (alert / signal) | Action |
|---|---|
| **Hot trader RSS > ~6.5 GB sustained** (`hot_mem_high`) | **Upgrade hot CCX13 → CCX23** (4 vCPU / 16 GB, ~+€12/mo): Terraform `sku` change + re-provision the hot box ([host-rebuild.md#hot-box](./host-rebuild.md), gap G13). |
| **Hot CPU steal > 0 sustained** (`hot_cpu_steal`) | Dedicated-core isolation regression — **open a Hetzner ticket**, not a sizing change. |
| **Trader saturates both dedicated cores** | Split WS connectors per-exchange (P2 boundary; IPC change to `orderbookManager`). |
| **`ob.ticks` produce p99 nears 5 ms** (`ob_ticks_drops`) | Investigate private-net throughput; tune Redpanda producer batching. The drop-on-timeout protects the trade loop regardless. |
| **CH ingest backs up** (`ingest_lag`, `parts_to_throw_insert`) | Raise `async_insert_threads=4` + `kafka_num_consumers` (clickhouse role var); re-apply the clickhouse role. |
| **Redpanda heap pressure (core)** | Cut heap 5 GB → 3 GB (redpanda role var); throughput unaffected at our rates. |
| **Core Volume ≥ 80 %** (`disk_low`) | **Expand Volume 200 → 400 GB**, later → 600 ([volume-expand.md](./volume-expand.md)). |
| **Obs Volume ≥ 80 %** | Shorten a retention window or expand `obs-data` 40 → 90 GB (Terraform). |
| **Obs-box RAM pressure** | Cap/drop GlitchTip first; then shorten Tempo/Pyroscope retention. |
| **Cold cost > budget (y2)** | BBO-only post-day-30, lower spread retention, ZSTD-9. |
| **Series cardinality nears budget** (`cardinality_high`) | Prune high-cardinality labels (`sequence_gap_total{symbol}` → `{exchange}`) — [spec 05 §cardinality budget](../../framework/specs/infrastructure/05-observability.md#series-cardinality-budget). |

See per-alert first-checks in [incident-response.md](./incident-response.md).
</content>
