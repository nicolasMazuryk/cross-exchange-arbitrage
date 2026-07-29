# ArbiNet Runbooks

Operational procedures for the 3-host throwaway prod env (`hot` `10.0.1.10`,
`core` `10.0.1.20`, `obs` `10.0.1.30`). **No HA, no backups** — the **core box is
the data box**, so its loss is the consequential one. Source of truth:
[spec 07](../../framework/specs/infrastructure/07-runbooks.md). Reaching the
private net needs the operator WireGuard tunnel up (see
[wireguard-onboarding.md](./wireguard-onboarding.md) + root `CLAUDE.md`).

## When to use what

| Situation | Runbook |
|---|---|
| Ship new app images to hot + core | [deploy.md](./deploy.md) |
| Bad release — revert app image | [rollback.md](./rollback.md) |
| An alert fired | [incident-response.md](./incident-response.md) |
| `disk_low` / core Volume ≥ 80 % | [volume-expand.md](./volume-expand.md) |
| A host died / needs rebuild | [host-rebuild.md](./host-rebuild.md) |
| Add/remove an operator's private-net access | [wireguard-onboarding.md](./wireguard-onboarding.md) |
| Capacity pressure — when to scale what | [scaling-triggers.md](./scaling-triggers.md) |
| Nightly drift alert fired | [incident-response.md#drift_detected](./incident-response.md#drift_detected) |

## Alert → response index

Every alert in [spec 05 §alert-rules](../../framework/specs/infrastructure/05-observability.md#alert-rules)
plus the drift alerts maps to an entry in
[incident-response.md](./incident-response.md):

- **Infra (12):** `trader_down`, `ws_down`, `ob_ticks_drops`, `ob_ticks_lag`,
  `ingest_lag`, `mv_stale`, `ch_query_slow`, `disk_low`, `hot_mem_high`,
  `hot_cpu_steal`, `clock_skew`, `obs_target_down`.
- **Trader page-now (7):** `ws_stale_blind`, `account_state_stale`,
  `eventloop_lag_high`, `stuck_position`, `exposure_breach`, `drawdown_breach`,
  `kill_switch_on`.
- **Trader warn (6):** `slippage_high`, `fill_rate_low`, `funnel_anomaly`,
  `reject_spike`, `t2t_slow`, `cardinality_high`.
- **Drift (3):** `drift_detected`, `drift_check_stale`, `drift_check_failed`.

## Standing facts

- **Hosts / roles:** `hot`=trader (no ingress, no Volume); `core`=ClickHouse +
  Redpanda + query-api + spread-computer + kamal-proxy (only public edge, 200 GB
  Volume at `/mnt/ch-volume`); `obs`=Prometheus/Loki/Tempo/Pyroscope/
  Alertmanager/Grafana/GlitchTip (40 GB Volume `/mnt/obs-data`).
- **Deploy:** dockerized Kamal, `infra/kamal/kamal.sh`. **amd64-only** images to
  GHCR. Single-instance `trader` enforced by the pre-deploy hook.
- **Config:** Ansible from `infra/ansible/` (`site.yml`). `export
  SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt` first.
- **Provisioning:** Terraform from repo root (`terraform -chdir=infra/terraform`),
  S3 backend `arbinet-tfstate`. Creds recipe in [infra/CLAUDE.md](../CLAUDE.md).
- **Observability access:** Grafana `http://10.0.1.30:3000`, GlitchTip
  `http://10.0.1.30:8000`, Prometheus `http://10.0.1.30:9090` — WireGuard-only.
</content>
