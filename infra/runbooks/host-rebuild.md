# Host-rebuild recovery

**No failover, no backups** (gap G10). Recovery differs by host because the
**data lives on the core box**. Source:
[spec 07 §Host-rebuild](../../framework/specs/infrastructure/07-runbooks.md).
Tunnel up. Terraform creds recipe: [infra/CLAUDE.md](../CLAUDE.md).

The flow is always: **Terraform re-provision → Ansible by `role=` label → Kamal**.
No inventory edits — the `hetzner.hcloud` plugin rediscovers the host by label.

---

## Core box (the data box) — consequential

A lost core box loses hot+warm ClickHouse (3-day) and in-flight Redpanda; **only
the cold-tier Parquet in `arbinet-cold` survives.**

1. **Re-provision:** `terraform -chdir=infra/terraform apply` recreates the core
   box (cloud-init) and re-attaches/re-creates the 200 GB Volume. State is in
   `arbinet-tfstate` (native lockfile).
2. **Configure:** from `infra/ansible/`, `export SOPS_AGE_KEY_FILE=...` then
   `ansible-playbook playbooks/site.yml --limit role_core` — discovers the new
   host by `role=core`, applies baseline → wireguard → chrony → clickhouse →
   redpanda (private listener) → spread-computer prereqs → alloy → kamal-proxy.
3. **Deploy:** `infra/kamal/kamal.sh deploy` (query-api/spread-computer +
   accessories) + run `bootstrap.sql` ([deploy.md#3](./deploy.md)) + the
   datapipeline **schema-migration tasks** to rebuild app tables/MVs.
4. **Accept the gap:** warm data since the last cold export is **gone** — no
   backfill (the app marks discontinuity on restart). Backtests fall back to
   `arbinet-cold` via the `s3()` table function. While core is down the hot box
   keeps trading from **in-memory trade state**, but its trade-state persist to CH
   fails — a trader restart during a core outage **cannot restore open trades**.
5. **Resume:** confirm the CH Kafka engine + SpreadComputer consuming `ob.ticks`
   again, smoke test, obs targets up.

---

## Hot box (the trade box) — fast, no data loss

A lost hot box stops **live trading** but loses **no stored data** (warm/analytic
state is on core).

1. **Re-provision:** `terraform apply` recreates the CCX13 (or CCX23 if upgrading
   per G13). No Volume to re-attach.
2. **Configure:** `ansible-playbook playbooks/site.yml --limit role_hot` —
   baseline → wireguard → chrony → lean Alloy + node_exporter.
3. **Deploy:** `infra/kamal/kamal.sh deploy --roles=trader` rolls `trader` back
   onto `10.0.1.10`; it reconnects to exchanges and resumes producing `ob.ticks`.
4. **Resume:** confirm **one and only one** trader instance ([deploy.md#6](./deploy.md)),
   `ws_health` up, `ob_ticks_*` flowing, smoke test.

---

## Obs box — independent, data loss acceptable

Rebuild the same way (`--limit role_obs`); its data loss is acceptable (telemetry
only). After rebuild the **drift detection** stack comes back with the role —
re-deliver the age + drift SSH keys (the `drift_detection` role does this on the
`site.yml`/`obs.yml` run). **Residual secret exposure:** the obs box holds a copy
of the age key (`/opt/arbinet/secrets/age-key.txt`, 0600) and the drift SSH key
so the dockerized `--check` can decrypt the vault and reach the fleet — consistent
with the no-backups G10 posture; if the obs box is compromised, rotate the age
recipient + the drift keypair.
</content>
