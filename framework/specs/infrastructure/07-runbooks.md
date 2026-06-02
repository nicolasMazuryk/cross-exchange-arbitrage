# 07 — Runbooks

Operational procedures cutting across the four pillars ([02](./02-provisioning.md)–[05](./05-observability.md)). Every alert in [05](./05-observability.md#alert-rules) maps to a response here. The system is **three hosts, no HA, no backups** ([01](./01-topology.md#failure-isolation)) — the **core box is the data box**, so its loss is the consequential one; recovery is Terraform re-provision + replay. These runbooks are the difference between a 20-minute and a multi-hour outage.

## Deploy (spans two hosts)

1. Build amd64 images locally, push to GHCR ([04](./04-deployment.md#build-and-deploy-no-ci)):
   `docker buildx build --platform linux/amd64 -t ghcr.io/nicolasmazuryk/arbinet-trader:<tag> --push -f docker/Dockerfile.trader .` (repeat for `query-api`, `spread-computer`). **amd64 only — no arm64.**
2. `kamal deploy` — rolls accessories then apps: `trader` → hot box `10.0.1.10` (stop-before-start, single-instance, [04](./04-deployment.md#single-instance-trader)); `query-api`/`spread-computer` + `clickhouse`/`redpanda` accessories → core box `10.0.1.20`.
3. Run `bootstrap.sql` one-shot against ClickHouse on the core box — creates the `arbinet` db + `migrations` table only; app tables/MVs are (re)built by the **separate schema-migration tasks** (app-owned DDL), not by bootstrap.
4. **Smoke test:** `/up` healthchecks pass on all apps; `arbinet` db + `migrations` table exist. The orderbook-row-count check is **gated on after schema migrations have created the tables** — once migrated, confirm the hot box is producing `ob.ticks` (CH Kafka-engine consumer lag `redpanda_kafka_consumer_group_lag{group="ch_orderbooks"}` low) and `curl 127.0.0.1:8123/?query=SELECT%20count()%20FROM%20arbinet.orderbooks` on the core box > 0 within ~5 s.
5. Confirm obs: hot + core targets `up` in Grafana, GlitchTip reachable over WireGuard.
6. **Image prune** after deploy on **both** hot and core boxes: `kamal prune` (or `docker image prune`); watch root-disk `node_filesystem_avail_bytes{mountpoint="/"}` per host.

## Rollback

1. `kamal rollback` to the previous tag (or `kamal app stop` + redeploy prior tag). Roll back the affected app(s) — `trader` on hot, the warm services on core.
2. ClickHouse + Redpanda data persist on the core box's `/mnt/ch-volume` — rollback swaps the app image only, never data.
3. If rollback was due to a bad schema migration, the data DDL is app-owned ([`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md)) — coordinate the SQL revert separately.
4. Re-run the smoke test.

## Incident response per alert

| Alert | First check | Action |
|---|---|---|
| **`trader_down`** (crit) | Is the `trader` container up on the hot box? (`kamal app details`) | Restart (`kamal app boot`); if it won't boot, check GlitchTip for the boot error + Tempo trace; worst case **hot-box rebuild** below. Trading is **stopped** while down — top priority. No warm data lost (it lives on the core box). |
| **`ws_down`** (crit) | `ws_health{exchange}` per exchange; exchange status page | If one exchange: likely upstream — confirm reconnect/backoff in trader logs (Loki). If all: hot-box network/egress or app crash → treat as `trader_down`. |
| **`ob_ticks_drops`** (warn) | `ob_ticks_produce_dropped_total`, `ob_ticks_produce_seconds` p99 | Hot box dropping warm ticks on the ≤5 ms timeout. The drop **protects the trade loop** — trading is unaffected. Check private-net health hot→core (`10.0.1.20:9092` reachable), Redpanda producer-queue pressure on the core box; tune producer batching. Some snapshot gap is acceptable (app marks discontinuity). |
| **`ob_ticks_lag`** (warn) | `redpanda_kafka_consumer_group_lag{group="ch_orderbooks"}` (+ `spread_ticks`) | CH Kafka engine / SpreadComputer behind on `ob.ticks`. Check core-box CPU / CH parts / spread-computer container; Redpanda buffers up to retention — no loss yet. |
| **`ingest_lag`** (warn) | `redpanda_kafka_consumer_group_lag{group=~"ch_.*"}` | CH consumer behind. Check CH parts/CPU; raise `async_insert_threads`/`kafka_num_consumers` (clickhouse role var, [06](./06-capacity-and-cost.md#scaling-triggers)). Redpanda buffers up to retention — no data loss yet. |
| **`mv_stale`** (warn) | `mv_freshness_seconds{view}` | MV chain lagging — usually downstream of `ingest_lag`. Resolve lag first; verify rollup resolver ([`../datapipeline/05-rollups-and-mvs.md`](../datapipeline/05-rollups-and-mvs.md)). |
| **`ch_query_slow`** (warn) | `clickhouse_query_duration_p95`, `clickhouse_parts_active` | Too many active parts or heavy query on the core box. Check merges; if parts > 300/table, investigate insert pattern. |
| **`disk_low`** (warn) | `node_filesystem_avail_bytes{mountpoint="/mnt/ch-volume"}` (core box) | **Volume expand** (below) — do not let it hit 100 %. |
| **`hot_mem_high`** (warn) | `node_memory_MemAvailable_bytes{host="hot"}`, trader RSS | Hot box approaching 8 GB. If sustained, **upgrade CCX13 → CCX23** (Terraform `sku` change + re-provision, gap **G13**, [06](./06-capacity-and-cost.md#hot-box-process-boundaries)). |
| **`hot_cpu_steal`** (warn) | `rate(node_cpu_seconds_total{mode="steal",host="hot"})` | Dedicated cores should show ~0 steal. Sustained steal = isolation regression — open a Hetzner ticket (dedicated-vCPU SLA), not a sizing change. |
| **`clock_skew`** (info) | `chrony_tracking_last_offset_seconds`, `exchange_clock_skew_seconds` | Host clock or exchange skew. If host: `chronyc tracking`/`chronyc makestep`; verify chrony role config ([03](./03-configuration.md#chrony-role)). |
| **`obs_target_down`** (warn) | `up{job=...}` in Prometheus | An Alloy scrape failing. Check which host: Alloy systemd on the hot **or** core box; check private-net path to `10.0.1.30`. Obs blind ≠ trade impact. |

## Volume expand

`disk_low` fires at <40 GB free on `/mnt/ch-volume` (~80 % of the starting 200 GB). No-downtime expand:

1. Bump the Volume `size` in Terraform (200 → 400, later → 600) and `terraform apply` ([02](./02-provisioning.md#volume-lifecycle)). Hetzner grows the block device online.
2. Grow the filesystem on the core box: `resize2fs /dev/disk/by-id/...` (or `xfs_growfs /mnt/ch-volume`).
3. Confirm `node_filesystem_size_bytes{mountpoint="/mnt/ch-volume"}` reflects the new size in Grafana; `disk_low` clears.
4. If recurring, revisit retention vs. the cold-tier triggers ([06](./06-capacity-and-cost.md#scaling-triggers)) before expanding again. Reaching the full 3-day-hot retention assumes the Volume has grown toward the ~370 GB end-state.

The obs Volume (`/mnt/obs-data`, starting 40 GB) follows the same procedure (40 → 90 GB) if an obs retention window is widened.

## Host-rebuild recovery

There is **no failover and no backups** (gap **G10**, [08](./08-gaps-and-decisions.md#g10)). Recovery differs by host because the **data lives on the core box**:

### Core box (the data box) — consequential

A lost core box loses hot+warm ClickHouse (3-day) and in-flight Redpanda; **only the cold-tier Parquet in `arbinet-cold` survives.** Recovery:

1. **Re-provision:** `terraform apply` recreates the core box (cloud-init makes it reachable) and re-attaches/re-creates the 200 GB Volume. State is in `arbinet-tfstate` (native lockfile, [02](./02-provisioning.md#terraform-state-backend-with-native-lockfile)).
2. **Configure:** Ansible `site.yml` discovers the new host by `role=core` label and applies baseline → wireguard → chrony/clickhouse/redpanda (private listener)/spread-computer/alloy/kamal-proxy ([03](./03-configuration.md)). No inventory edits.
3. **Deploy:** `kamal deploy` (query-api/spread-computer + accessories) + run `bootstrap.sql` (db + `migrations` table), then the **schema-migration tasks** to (re)build the app tables/MVs.
4. **Replay/accept gap:** warm data since the last cold-tier export is **gone** — backfill is not attempted (the app accepts gaps and marks discontinuity on restart, [`../datapipeline/02-snapshotter.md`](../datapipeline/02-snapshotter.md)). Backtest reads fall back to `arbinet-cold` via the `s3()` table function ([`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)). While the core box is down, the hot box keeps trading; its `ob.ticks` produce drops-on-timeout (no block) and its **trade-state persist/restore to CH also fails** — the trader runs from its **in-memory trade state**, so a trader restart while the core box is down **cannot restore open trades from CH** ([`../datapipeline/11-redis-removal.md`](../datapipeline/11-redis-removal.md)).
5. **Resume:** confirm the CH Kafka engine + SpreadComputer consuming `ob.ticks` again, smoke test, obs targets up.

### Hot box (the trade box) — fast, no data loss

A lost hot box stops **live trading** but loses **no stored data** (warm/analytical state is on the core box). Recovery:

1. **Re-provision:** `terraform apply` recreates the CCX13 (or CCX23 if upgrading per G13). No Volume to re-attach.
2. **Configure:** Ansible applies `role=hot` (baseline → wireguard → chrony → lean alloy).
3. **Deploy:** `kamal deploy` rolls the `trader` back onto `10.0.1.10`; it reconnects to exchanges and resumes producing `ob.ticks` to the core box's Redpanda.
4. **Resume:** confirm one (and only one) trader instance, `ws_health` up, `ob_ticks_*` flowing, smoke test.

### Obs box — independent, data loss acceptable

The obs box rebuilds independently the same way (`role=obs`); its data loss is acceptable (telemetry only).

## WireGuard onboarding

A new operator needs private-network access to Grafana/GlitchTip and SSH ([01](./01-topology.md#wireguard-overlay), [03](./03-configuration.md#wireguard-role)):

1. Operator generates a WireGuard keypair; sends the **public** key.
2. Add the peer (public key + assigned `10.8.0.x`) to the `wireguard` role vars; the private endpoint keys stay in SOPS.
3. Add the operator's source IP to `operator_ips` in Terraform so **all three** firewalls (`fw-hot`, `fw-core`, `fw-obs`) admit UDP 51820 from it ([02](./02-provisioning.md#firewalls)); `terraform apply`.
4. Re-run the `wireguard` role on all three hosts (`ansible-playbook site.yml --tags wireguard`).
5. Operator connects → reaches `http://10.0.1.30:3000` (Grafana), `http://10.0.1.30:8000` (GlitchTip), and SSH to any host over the tunnel.
6. Offboarding: remove the peer + source IP, re-apply.

## Nightly drift detection

Idempotency is the contract ([03](./03-configuration.md#operational-practices)). A scheduled nightly run catches out-of-band manual changes:

1. `ansible-playbook site.yml --check --diff` against `env_prod` (read-only, no mutations).
2. Any reported change = drift (someone changed a host outside Ansible). Alert the team.
3. Investigate the diff; either codify the change into a role or revert it with a normal (non-`--check`) run.
4. A clean "0 changed" is the green light that prod matches the repo.

## Links

- Topology & failure isolation behind these procedures → [01-topology.md](./01-topology.md)
- Terraform resources touched (Volume resize, host rebuild, CCX23 upgrade) → [02-provisioning.md](./02-provisioning.md)
- Ansible roles re-applied during recovery → [03-configuration.md](./03-configuration.md)
- Deploy/rollback mechanics → [04-deployment.md](./04-deployment.md)
- Alerts that trigger these runbooks → [05-observability.md](./05-observability.md#alert-rules)
- Sizing & scaling triggers → [06-capacity-and-cost.md](./06-capacity-and-cost.md#scaling-triggers)
- No-backups acceptance (G10), app-split prereq (G12), hot RAM risk (G13) → [08-gaps-and-decisions.md](./08-gaps-and-decisions.md)
- App restart/gap behavior → [`../datapipeline/02-snapshotter.md`](../datapipeline/02-snapshotter.md), [`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)
</content>
