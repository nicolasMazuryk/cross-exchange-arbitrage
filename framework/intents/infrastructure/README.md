# Arbinet Infrastructure — Intent Index

## Purpose

The **provision → configure → deploy → observe** task surface for Arbinet on Hetzner Cloud. This is the **first** of two sequential tasks; the orderbook data pipeline (`../../specs/datapipeline/`) is the **second** and depends on this infrastructure being live.

Chosen toolchain (locked):

**Terraform** (provision cloud resources) → **cloud-init** (bare-minimum first boot) → **Ansible** (configure, harden, install middleware) → **Kamal 2** (deploy app + accessory containers), with a **self-hosted OpenTelemetry** observability stack (Prometheus / Loki / Tempo / Pyroscope / Parca / Alertmanager, visualized in Grafana).

> This stack supersedes the simpler Docker-Compose + `scp .env` + Grafana-Cloud model that earlier pipeline drafts assumed. Where the pipeline specs reference runtime/provisioning/observability, they point here.

## Files

| File | Owns |
|---|---|
| [infrastructure-provisioning.md](./infrastructure-provisioning.md) | Terraform-managed Hetzner resources: CPX62 server, Volume, Object Storage bucket, private network, firewall, SSH keys, Load Balancer (Query-API ingress + TLS), remote state |
| [ansible-configuration.md](./ansible-configuration.md) | Toolchain division, dynamic inventory, baseline hardening, and middleware **install/config/sizing** roles: `chrony`, `clickhouse` (storage.xml + limits.xml + users.d), `redpanda` (smp/memory/retention/data-dir), observability agents |
| [deployment-ci-cd.md](./deployment-ci-cd.md) | Container builds (`trader`, `query-api`), Kamal accessories (redpanda, clickhouse), SOPS/Kamal secrets, deploy flow incl. `bootstrap.sql` step + smoke test + rollback, local-dev compose |
| [observability-stack.md](./observability-stack.md) | Self-hosted OTel stack, metric catalog (scrape side), SLIs/SLOs, alert rules, dashboards, series-cardinality budget |
| [capacity-and-cost.md](./capacity-and-cost.md) | Per-service resource caps, Volume sizing math, cold-tier per-year, budget, scaling triggers |
| this README | Index, infra decisions table, implementation phasing, glossary pointer |

## Infra decisions table

Infrastructure decisions extracted from the pipeline interview, reframed to the chosen toolchain. (App-level decisions — snapshot depth, spread cadence, formulas, DDL/retention intent, partition keys, pair-stats — stay in `../../specs/datapipeline/README.md`.)

| Topic | Decision |
|---|---|
| Host SKU | 1× Hetzner CPX62 (16 vCPU / 32 GB / 360 GB NVMe), FSN or NBG; Terraform-managed |
| Block storage | 1× Hetzner Volume 400 GB (scale to 1 TB after measured fill), mounted `/mnt/ch-volume`, holds CH + Redpanda data |
| Cold storage | 1× Hetzner Object Storage bucket `arbinet-cold`, same region; CH S3 disk + daily Parquet export |
| Provision tooling | Terraform (`hetznercloud/hcloud`), remote state in Hetzner Object Storage |
| Config tooling | cloud-init (minimal bootstrap) → Ansible (roles), labels-driven dynamic inventory from day one |
| Deploy tooling | Kamal 2; middleware (redpanda, clickhouse) as Kamal accessories |
| Single-instance constraint | Exactly one trader instance ever; Kamal zero-downtime (overlap) **disabled** — brief deploy downtime acceptable, overlapping instances are not |
| Ingress / TLS | Hetzner Load Balancer terminates TLS for Query API (reframed from in-app `:8443` Caddy); firewall 22/80/443 only |
| Internal traffic | Single host; inter-service on loopback. Private network declared for future multi-host; accessory ports bound to `127.0.0.1` |
| Secrets | SOPS-encrypted, delivered via Ansible vault + Kamal env (reframed from `.env` + `scp`) |
| Observability | Self-hosted OpenTelemetry stack on the same host (Prometheus / Loki / Tempo / Pyroscope / Parca / Alertmanager + Grafana) |
| Retention (middleware config) | Redpanda 24 h / size caps per topic; CH TTL move to cold at 3 d (raw) / 90 d (`funding_rates`); cold indefinite |
| Budget | ≤ $150/mo infra total (~€125 ≈ $135/mo projected — see [capacity-and-cost.md](./capacity-and-cost.md)) |

## Implementation phasing

Infra is the prerequisite for all pipeline phases. Sequence:

1. **Provision** — Terraform applies: server, Volume (attached + mounted), Object Storage bucket, private network, firewall, SSH keys, Load Balancer. cloud-init brings the box to reachable. ([infrastructure-provisioning.md](./infrastructure-provisioning.md))
2. **Configure** — Ansible `site.yml`: baseline (common → hardening: ufw/sysctl/fail2ban/unattended-upgrades/auditd) → middleware roles: `chrony`, `clickhouse`, `redpanda`, observability agents. ([ansible-configuration.md](./ansible-configuration.md))
3. **Deploy** — Build `trader` + `query-api` images (multi-arch per target line); Kamal deploys app + accessories; run `bootstrap.sql` (create DB/tables/MVs/seed fees); smoke test; configure rollback. ([deployment-ci-cd.md](./deployment-ci-cd.md))
4. **Observe** — Stand up self-hosted OTel stack; wire scrape targets, alert rules, dashboards, SLOs. ([observability-stack.md](./observability-stack.md))

Capacity caps and budget gating apply throughout ([capacity-and-cost.md](./capacity-and-cost.md)).

Once infra is live, build the pipeline per `../../specs/datapipeline/README.md` (P1 warm path → P2 spreads/trades/query API → P3 cold path).

## Glossary

Infra terms (Terraform, cloud-init, Ansible roles, Kamal accessories, dynamic inventory, SOPS) are defined inline in their respective files. Pipeline/domain terms (hot/warm/cold path, Top-N, BBO, rollup tier, AggregatingMergeTree, sequence gap, stale leg, MV chain) live in the [pipeline glossary](../../specs/datapipeline/README.md#glossary).

## Links

- Dependent task (build second) → [`../../specs/datapipeline/README.md`](../../specs/datapipeline/README.md)
- The 6 infra files are listed in [Files](#files) above.
