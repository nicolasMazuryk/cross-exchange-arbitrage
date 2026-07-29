# Incident response per alert

Every alert in [spec 05 §alert-rules](../../framework/specs/infrastructure/05-observability.md#alert-rules)
+ the drift alerts maps to a first-check and an action here. Alerts carry a
`severity` label (Alertmanager routes by it: `crit`→PagerDuty+Slack,
`warn`/`info`→Slack) and an `action` annotation rendered from the rule templates
(`roles/prometheus/templates/rules/*.j2`). Standing reminder: **before trusting
an alert, confirm its metric exists** — `count({__name__=~"<name>"})>0` (some
datapipeline metric names are unsettled, infra/CLAUDE.md).

Query Prometheus: `curl -sG 10.0.1.30:9090/api/v1/query --data-urlencode 'query=...'`.
Logs: Grafana → Loki. Traces: Tempo. Errors: GlitchTip `10.0.1.30:8000`.

---

## Infra alerts

### trader_down  (crit · page)
- **First check:** is the trader container up on hot? `kamal app details` /
  `ssh hot 'docker ps --filter label=role=trader'`.
- **Action:** restart (`infra/kamal/kamal.sh app boot --roles=trader`). Won't
  boot → GlitchTip for the boot error + Tempo trace; worst case
  [host-rebuild.md#hot-box](./host-rebuild.md). **Trading is stopped while down —
  top priority.** No warm data lost (it lives on core).

### ws_down  (crit · page)
- **First check:** `ws_health{exchange}` per venue; the exchange status page.
- **Action:** one venue → likely upstream; confirm reconnect/backoff in trader
  logs (Loki). All venues → hot-box egress or app crash → treat as `trader_down`.

### ob_ticks_drops  (warn)
- **First check:** `ob_ticks_produce_dropped_total`, `ob_ticks_produce_seconds`
  p99 vs the 5 ms budget.
- **Action:** hot dropping warm ticks on the ≤5 ms timeout — **the drop protects
  the trade loop, trading is unaffected.** Check hot→core net (`10.0.1.20:9092`
  reachable), Redpanda producer-queue pressure on core; tune producer batching.
  Some snapshot gap is acceptable (app marks discontinuity).

### ob_ticks_lag  (warn)
- **First check:** `redpanda_kafka_consumer_group_lag{group="ch_orderbooks"}`.
- **Action:** CH Kafka engine behind on `ob.ticks`. Check core CPU, CH active
  parts, CH insert throughput. Redpanda buffers up to retention — no loss yet.

### ingest_lag  (warn)
- **First check:** `redpanda_kafka_consumer_group_lag{group=~"ch_.*"}`.
- **Action:** a CH consumer behind. Raise `async_insert_threads` /
  `kafka_num_consumers` (clickhouse role var — [scaling-triggers.md](./scaling-triggers.md)).
  Buffers up to retention — no loss yet.

### mv_stale  (warn)
- **First check:** `mv_freshness_seconds{view="spreads_15s"}`.
- **Action:** MV chain lagging — usually downstream of `ingest_lag`; resolve lag
  first, then verify the rollup resolver (datapipeline rollups/MVs).

### ch_query_slow  (warn)
- **First check:** `clickhouse_query_duration` p95, `clickhouse_parts_active`.
- **Action:** too many active parts or a heavy query on core. Check merges; if
  parts > 300/table investigate the insert pattern.

### disk_low  (warn)
- **First check:** `node_filesystem_avail_bytes{mountpoint="/mnt/ch-volume"}`.
- **Action:** **do not let it hit 100 %** → [volume-expand.md](./volume-expand.md).

### hot_mem_high  (warn)
- **First check:** `node_memory_MemAvailable_bytes{host="hot"}`, trader RSS.
- **Action:** hot box nearing 8 GB. If sustained, **CCX13 → CCX23** (Terraform
  `sku` + re-provision, gap G13 — [scaling-triggers.md](./scaling-triggers.md)).

### hot_cpu_steal  (warn)
- **First check:** `rate(node_cpu_seconds_total{mode="steal",host="hot"}[5m])`.
- **Action:** dedicated cores should show ~0 steal. Sustained = isolation
  regression → open a Hetzner ticket (dedicated-vCPU SLA), not a sizing change.

### clock_skew  (info)
- **First check:** `chrony_tracking_last_offset_seconds`,
  `exchange_clock_skew_seconds`.
- **Action:** host → `chronyc tracking` / `chronyc makestep`, verify the chrony
  role; exchange-side skew → informational.

### obs_target_down  (warn)
- **First check:** `up{job=...}` in Prometheus — which host?
- **Action:** an Alloy scrape failing — check Alloy systemd on hot **or** core,
  or the obs node-exporter; check the private-net path to `10.0.1.30`. **Obs
  blind ≠ trade impact.**

---

## Trader page-now alerts (capital at risk / blind / stuck)

These wake on-call. Each names a human action.

### ws_stale_blind  (crit · page)
Feed is fiction while `ws_health==1`. **Halt the strategy on that venue** until
`ws_staleness_seconds` recovers < 2 s.

### account_state_stale  (crit · page)
`account_state_age_seconds > 60`. **Stop trading; resync account state from the
venue** — risk checks are running blind on stale balances/positions.

### eventloop_lag_high  (crit · page)
`nodejs_eventloop_lag_seconds` p99 > 0.1 s — the loop is blocked, ticks drop
silently. Investigate sync work / GC (Pyroscope flame graph); if a deploy
regressed it, [rollback.md](./rollback.md).

### stuck_position  (crit · page)
`trade_rollback_total{reason="leg_unwind_failed"}` increased — a **one-legged
position**. Manually flatten the open leg on the venue, then confirm
`net_exposure_usd` returns to plan. P0.

### exposure_breach  (crit · page)
`exposure_limit_utilization_ratio > 1` — over the limit. **Trip the kill-switch**
(`kill_switch_active`), then unwind down to limit.

### drawdown_breach  (crit · page)
`portfolio_drawdown_usd < -<X>` (threshold = business input,
`trader_drawdown_breach_usd`; rule stays off until set). Stop-loss trip — halt
and review.

### kill_switch_on  (crit · page)
`kill_switch_active == 1` for 1 min. **Confirm the halt is intended.** If
unintended, find the `circuit_breaker_trips_total{reason}` that tripped it before
clearing.

---

## Trader warn alerts (degradation, not bleeding)

### slippage_high  (warn)
`trade_slippage_bps` p95 > 20 for 10 min. Slippage erodes edge — check venue
depth / order sizing; compare `trade_edge_expected_bps` vs `_realized_bps`.

### fill_rate_low  (warn)
`filled/submitted < 0.80` over 10 min — adverse selection or stale quotes. Check
`order_reject_total{reason}` and venue latency.

### funnel_anomaly  (warn)
Opportunities detected but `acted == 0` for 5 min — a **silent miss**. Walk
`arb_funnel_total{reason}` to find where they die (risk block, balance, too slow).

### reject_spike  (warn)
`rate(order_reject_total[5m])` up vs baseline — venue-side rejects. Inspect
`order_reject_total{exchange,reason}`; could be rate-limit, min-notional, auth.

### t2t_slow  (warn)
`tick_to_trade_seconds` p99 > 5 ms for 5 min — losing the latency race. Decompose
by `{stage}`; correlate with `eventloop_lag_high` / GC.

### cardinality_high  (warn)
`prometheus_tsdb_head_series > 12500` (re-baselined, infra/CLAUDE.md). A
cardinality regression — trim labels per
[spec 05 §cardinality budget](../../framework/specs/infrastructure/05-observability.md#series-cardinality-budget)
([scaling-triggers.md](./scaling-triggers.md)). Note the gauge lags ~2h after a
prune — measure the real floor with `count({__name__!=""})`.

---

## Drift alerts

### drift_detected  (warn)
- **Metric:** `arbinet_ansible_drift_changed > 0` — the nightly
  `ansible-playbook site.yml --check --diff` found N changed tasks: a host was
  modified **out-of-band** (someone changed it outside Ansible).
- **First check:** read the full `--diff` in `/var/log/arbinet-drift.log` on the
  obs box (`ssh ... obs 'sudo tail -200 /var/log/arbinet-drift.log'`); identify
  which host/role/task drifted.
- **Action:** either **codify** the change into the role (if intended) or
  **revert** it with a normal (non-`--check`) run:
  `ansible-playbook playbooks/site.yml --limit <host>`. A clean re-run
  (`changed=0`) clears the alert (auto-resolving). Idempotency is the contract.

### drift_check_stale  (warn)
- **Metric:** `time() - arbinet_ansible_drift_last_run_timestamp_seconds >
  129600` (36h) — a clean run must keep proving itself; the timer has gone
  silent.
- **First check:** `ssh ... obs 'systemctl status arbinet-drift.timer
  arbinet-drift.service; systemctl list-timers arbinet-drift.timer'`; confirm the
  textfile collector dir exists and node-exporter reads it.
- **Action:** restart the timer (`systemctl restart arbinet-drift.timer`), run
  the wrapper once by hand (`/opt/arbinet/drift-check.sh`), confirm the metric
  refreshes. If the obs box was down, expect it to clear on next run (Persistent
  timer fires the missed run).

### drift_check_failed  (warn)
- **Metric:** `arbinet_ansible_drift_run_success == 0` — the last `--check` did
  not complete cleanly (a host unreachable, or a play error) — distinct from real
  drift (no trustworthy `changed` count).
- **First check:** `/var/log/arbinet-drift.log` on obs for the failing host /
  task; confirm private-net reachability (`ssh ... 10.0.1.x`) and the drift SSH
  key is authorized (baseline).
- **Action:** fix the reachability/play error, re-run `/opt/arbinet/drift-check.sh`,
  confirm `success=1`.
</content>
