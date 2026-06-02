# 03 — Configuration (Pillar 2: Ansible)

Ansible owns all configuration, hardening, middleware install/sizing, and the observability backend stack — organized as roles under one set of playbooks. It discovers the Terraform-provisioned fleet ([02](./02-provisioning.md)) via labels and a dynamic inventory, then lays down config files, volume dirs, and sizing on disk. Container **runtime** belongs to Kamal ([04](./04-deployment.md)); Ansible lays the bed Kamal's containers lie in. This file carries the concrete CH/Redpanda/chrony config inline.

## Toolchain & boundaries

| Tool | Responsibility | Boundary |
|---|---|---|
| Terraform | Provisions resources; stamps `role`/`env` labels. | Stops once resources exist. |
| cloud-init | Bare bootstrap (ansible user, SSH lockdown, Python 3, guest agent). | "Makes the box reachable." |
| **Ansible** | All config, hardening, middleware **install/config/sizing**, obs backend stack. | "Makes the box useful." |
| Kamal | Runs app + accessory **containers** on top of Ansible-laid config. | "Runs the workload." |

Integrating tool: the **`hetzner.hcloud`** Ansible collection (v6.9) for dynamic inventory. Non-negotiables: FQCN everywhere (`ansible.builtin.apt`, never `apt`); `ansible-lint` `production` profile on every commit; YAML-mode inventories.

Pinned collections (`requirements.yml`):

```yaml
collections:
  - name: hetzner.hcloud
    version: ">=6.9.0,<7.0.0"
  - name: community.general
  - name: community.crypto
  - name: community.sops
  - name: ansible.posix
```

## Dynamic inventory

Used **from day one**, never static. Configured once, Ansible queries the Hetzner API for the live fleet on every run and groups it by the Terraform labels: `role=hot` → `role_hot`, `role=core` → `role_core`, `role=obs` → `role_obs`, `env=prod` → `env_prod`. A new host with the right labels joins the right groups with zero inventory editing.

```yaml
# infra/ansible/inventories/production/hcloud.yml
plugin: hetzner.hcloud.hcloud
api_token: "{{ lookup('community.sops.sops', 'secrets/hcloud_token.sops.yml') }}"
locations: [nbg1]
status: [running]
network: prod-vpc                  # use private IPs as ansible_host
hostvars_prefix: hcloud_
keyed_groups:
  - key: labels.role               # → role_hot, role_core, role_obs
    prefix: role
  - key: labels.env                # → env_prod
    prefix: env
compose:
  ansible_host: private_net[0].ip   # talk over the private network (10.0.1.0/24)
```

`locations` is **`[nbg1]`** (all three hosts in NBG1). `ansible_host` is composed from the private IP — the controller reaches all hosts over the load-bearing private net (it dials in via WireGuard first; [01](./01-topology.md#wireguard-overlay)). The controller connects as `ansible_user=ansible` with `private_key_file = ~/.ssh/nicolas` (the operator key injected at provisioning, [02](./02-provisioning.md#concrete-resource-table)) — set in `ansible.cfg`.

## Project layout

```
infra/ansible/
├── ansible.cfg
├── requirements.yml / requirements.txt / execution-environment.yml
├── inventories/production/
│   ├── hcloud.yml                   # dynamic inventory (above)
│   └── group_vars/
│       ├── all/{vars.yml, vault.sops.yml}
│       ├── role_hot.yml             # lean Alloy targets, trader prep
│       ├── role_core.yml            # CH/RP sizing vars, spread-computer, Alloy targets, kamal-proxy
│       └── role_obs.yml             # backend retention/ports
├── playbooks/
│   ├── site.yml                     # orchestrator: baseline → wireguard → role layers
│   ├── hot.yml                      # chrony, lean alloy (trader is Kamal-deployed)
│   ├── core.yml                     # chrony, clickhouse, redpanda, spread-computer, alloy, kamal-proxy
│   └── obs.yml                      # obs backend compose stack
└── roles/
    ├── baseline/ wireguard/         # all hosts
    ├── chrony/ alloy/               # role_hot (lean alloy) + role_core
    ├── clickhouse/ redpanda/ kamal_proxy/      # role_core
    └── prometheus/ loki/ tempo/ pyroscope/ grafana/ alertmanager/ glitchtip/   # role_obs
```

Conventions: `group_vars/all/vars.yml` = non-secret defaults; `vault.sops.yml` = secrets (transparent decrypt at runtime); one role = one responsibility; `defaults/main.yml` overridable, `vars/main.yml` locked; tags on every play. `no_log: true` on any task touching secrets.

`site.yml` applies layers in order: **baseline → wireguard → role-specific** (`role_hot` gets chrony + lean alloy; `role_core` gets chrony/clickhouse/redpanda/spread-computer/alloy/kamal-proxy; `role_obs` gets the backend stack).

## Baseline hardening role

Applied to **all three** hosts immediately after cloud-init (community-consensus stack; prefer `devsec.hardening` / `konstruktoid.hardening` / `geerlingguy.*` over hand-rolling, overriding via `group_vars`):

| Area | Setting |
|---|---|
| SSH | Key-only, `AllowUsers ansible`, modern ciphers/KEX, `ClientAliveInterval`; explicit drop-in under `/etc/ssh/sshd_config.d/` (below). |
| Firewall (inner) | `ufw` as defense-in-depth behind the Hetzner Cloud Firewall ([02](./02-provisioning.md#firewalls)). **Docker/iptables gotcha:** Docker inserts rules ahead of UFW — mitigated because core-box data ports bind `127.0.0.1` (except Redpanda's private listener and ClickHouse's HTTP listener, both pinned to `10.0.1.0/24`) and the only public app path is the core box's kamal-proxy edge. |
| Auto patching | `unattended-upgrades`. |
| Intrusion prevention | `fail2ban`. |
| Time sync | `chrony` (hot + core: see role below; obs: defaults). |
| Kernel | `sysctl`: `tcp_syncookies`, disable source routing, ICMP redirect protections. |
| Audit | `auditd`. |

The SSH row lands as an explicit sshd drop-in (`/etc/ssh/sshd_config.d/`), alongside the `AllowUsers ansible`, modern ciphers/KEX, and `ClientAliveInterval` directives above:

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 5
PubkeyAuthentication yes
AllowTcpForwarding yes
```

## WireGuard role

Applied to **all three** hosts (gap **G11**, [08](./08-gaps-and-decisions.md#g11)). Stands up a WireGuard endpoint on UDP `51820`; operator peers get `10.8.0.0/24` addresses with `AllowedIPs` covering `10.0.1.0/24` + the host, so a connected operator reaches Grafana (`10.0.1.30:3000`) and GlitchTip (`10.0.1.30:8000`) and can SSH to any host. Peer public keys are inventory vars; private keys come from SOPS. The firewall opens `51820` only from operator source IPs ([02](./02-provisioning.md#firewalls)). Onboarding: [07-runbooks.md](./07-runbooks.md#wireguard-onboarding).

## Hot-box configuration (`role_hot`)

On top of baseline + wireguard, the hot box gets only two roles — it is kept **lean** so the 2 dedicated cores serve the trader:

### chrony role (hot)

1 Hz wall-clock-aligned tick emission needs tight host clock sync (same config as core, below).

### alloy role (hot, lean)

A **lean** Grafana Alloy agent (single systemd binary) plus `node_exporter`. It:

- **Scrapes** loopback `/metrics`: trader (`:9464`), node_exporter (`:9100`).
- **Receives** OTLP traces (`127.0.0.1:4317/4318`) and Pyroscope profiles (`127.0.0.1:4040`) from the trader SDK.
- **Tails** the trader container's stdout JSON logs → Loki.
- **Forwards** all signals to the obs box over the private net (`10.0.1.30`). Targets are `role_hot` group vars.

No clickhouse-exporter, no Redpanda scrape here — those live on the core box. The trader itself is Kamal-deployed ([04](./04-deployment.md)); Ansible only preps chrony + Alloy on the hot box.

## Core-box middleware roles

On top of baseline + wireguard, `role_core` adds the roles below. Each owns **install/config/sizing only** — schema DDL, topic definitions, MVs stay with the app ([`../datapipeline/`](../datapipeline/README.md)). The Ansible↔Kamal seam (gap **G6**, [08](./08-gaps-and-decisions.md#g6)): **Ansible lays down config files + volume dirs + sizing on the host; Kamal runs the pinned images that mount that config.**

### chrony role

Core-box workloads (ClickHouse timestamps, Redpanda, time-correlated telemetry) need tight host clock sync.

```conf
# /etc/chrony/chrony.conf
pool 0.europe.pool.ntp.org iburst minpoll 4 maxpoll 8
pool time.cloudflare.com   iburst minpoll 4 maxpoll 8
rtcsync
makestep 0.1 3
logdir /var/log/chrony
```

Contract: host clock within **50 ms** of UTC; surface `chrony_tracking_last_offset_seconds` (alert >200 ms p95, [05](./05-observability.md#alert-rules)).

### clickhouse role

Lays down config under `/etc/clickhouse-server/` and creates the data dir on the Volume (`/mnt/ch-volume/clickhouse`). Owns storage policy, resource limits, users. Table DDLs referencing this policy (`storage_policy='tiered'`, `TTL … TO VOLUME 'cold'`) belong to the app ([`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md)). Kamal runs `clickhouse/clickhouse-server` (`26.3-lts`, pinned) mounting this config.

3-disk tiered storage policy (`config.d/storage.xml`) — **S3 endpoint NBG1**:

```xml
<!-- /etc/clickhouse-server/config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <nvme><path>/var/lib/clickhouse/</path></nvme>
      <volume><path>/mnt/ch-volume/clickhouse/</path></volume>
      <s3>
        <type>s3</type>
        <endpoint>https://nbg1.your-objectstorage.com/arbinet-cold/</endpoint>
        <access_key_id from_env="S3_ACCESS_KEY"/>
        <secret_access_key from_env="S3_SECRET_KEY"/>
        <metadata_path>/var/lib/clickhouse/disks/s3/</metadata_path>
      </s3>
    </disks>
    <policies>
      <tiered>
        <volumes>
          <hot>  <disk>nvme</disk>   <max_data_part_size_bytes>10737418240</max_data_part_size_bytes></hot>
          <warm> <disk>volume</disk> </warm>
          <cold> <disk>s3</disk>     <prefer_not_to_merge>true</prefer_not_to_merge> </cold>
        </volumes>
        <move_factor>0.2</move_factor>
      </tiered>
    </policies>
  </storage_configuration>
</clickhouse>
```

Resource limits (`config.d/limits.xml`) — CH gets more room on the core box (no Node trader to coexist with here):

```xml
<!-- /etc/clickhouse-server/config.d/limits.xml -->
<clickhouse>
  <profiles><default>
    <max_memory_usage>12000000000</max_memory_usage>
    <max_bytes_before_external_group_by>6000000000</max_bytes_before_external_group_by>
    <max_threads>6</max_threads>
    <async_insert>1</async_insert>
    <wait_for_async_insert>0</wait_for_async_insert>
  </default></profiles>
</clickhouse>
```

**Network binding.** The hot-box trader reaches ClickHouse's **HTTP interface `8123`** over the private net for trade-state persist/restore (`@clickhouse/client`; [`../datapipeline/11-redis-removal.md`](../datapipeline/11-redis-removal.md)), so CH must listen on the private IP, not loopback-only. ClickHouse's `listen_host` is **global across protocols** (no clean per-port interface binding), so this mirrors exactly how Redpanda's private listener is handled: bind `listen_host` to both `10.0.1.20` and `127.0.0.1`, and let **fw-core** (already `private-net all-allow` from `10.0.1.0/24`, [02](./02-provisioning.md#firewalls)) be the access control. Native `9000` is reachable on the private NIC too as a side-effect of the global `listen_host`, but it is firewall-gated and consumed only by loopback core-box clients — the firewall is the control plane, same posture as Redpanda's `9092`.

```xml
<!-- /etc/clickhouse-server/config.d/network.xml -->
<clickhouse>
  <listen_host>127.0.0.1</listen_host>
  <listen_host>10.0.1.20</listen_host>
</clickhouse>
```

`users.d/` carries the `arbinet` user + password (from SOPS, never in the role tree) and `CLICKHOUSE_DB=arbinet`. S3-disk creds (`S3_ACCESS_KEY`/`S3_SECRET_KEY`) injected from secrets at container start. Role vars expose `max_threads`, `async_insert_threads`, `max_memory_usage` for the scaling triggers ([06](./06-capacity-and-cost.md#scaling-triggers)). Local-dev override: single-disk policy (`tiered → default`, no S3) as `config.dev.d/storage.xml` ([04](./04-deployment.md#local-development)).

### redpanda role

Installs/pins Redpanda (single-broker KRaft) and sets sizing flags. Kamal runs `redpandadata/redpanda:v26.1` (pinned) as an accessory mounting `/mnt/ch-volume/redpanda`. **Redpanda's listener is now private-bound** so the hot box's trader can produce `ob.ticks` over the private net:

- Start flags: `--smp 2 --memory 5G --reserve-memory 0M --overprovisioned --node-id 0 --mode production` (more headroom than the old 3 GB — Redpanda is no longer squeezed by a co-located trader).
- Listener: **`INTERNAL://10.0.1.20:9092`** — bound to the **private IP**, not loopback, so the hot box producer reaches it (firewall pins source to `10.0.1.0/24`, [02](./02-provisioning.md#firewalls)). Admin/Prometheus `/metrics` stays on `127.0.0.1:9644`.
- Data dir: `/mnt/ch-volume/redpanda`.
- Topics & retention: the **`ob.ticks`** raw topic (the hot→core warm path) plus the existing `spreads.live` (20 GB) cap; `ob.ticks` retention is short (raw ticks consumed near-real-time by the CH Kafka engine and SpreadComputer), size-cap ~20 GB / `delete.retention.ms = 86_400_000` as a fail-safe behind the app's time retention.

Topic creation, partition counts, partition-key design are the app's ([`../datapipeline/03-buffer-redpanda.md`](../datapipeline/03-buffer-redpanda.md)); this role only sizes, sets the private listener, and runs the broker.

### spread-computer role

The **spread-computer**, split out of the trader process (gap **G12**), runs as a standalone service on the core box — the **lone warm processor**. It **consumes `ob.ticks`** from the local Redpanda (`10.0.1.20:9092`, in practice loopback-adjacent on the same host), computes spreads, and writes `spreads.live` → ClickHouse `spreads`. Ansible preps its config/env + `/metrics` bind (`127.0.0.1`, scraped by the local Alloy); Kamal runs it as an app ([04](./04-deployment.md)). Its app logic (spread cadence, formulas) stays in the datapipeline specs. The raw `orderbooks` path is **serviceless** — ClickHouse's Kafka engine consumes `ob.ticks` directly ([`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md)) — so there is no warm service to configure for it.

### alloy role (core, collector)

A full Grafana Alloy collector on the core box:

- **Scrapes** loopback `/metrics`: query-api (`:8080/metrics`), spread-computer, node_exporter (`:9100`), clickhouse-exporter (`:9116`), Redpanda native (`:9644`).
- **Tails** core-box container stdout JSON logs → Loki.
- **Receives** OTLP traces and Pyroscope profiles from the core-box services.
- **Forwards** all signals to the obs box over the private net (`10.0.1.30`). Targets are `role_core` group vars.

This role also installs `node_exporter` and `clickhouse-exporter` on the core box.

### kamal_proxy role

Preps the host for **kamal-proxy** to terminate TLS on the core box (gap **G5** reversed — the Hetzner LB is dropped). Lays down the ACME/Let's Encrypt config dir + the `/up` health-gate routing config kamal-proxy uses; the proxy container itself is run by Kamal ([04](./04-deployment.md#edge-and-tls-path)). The cert lives on the core box, off the hot box's dedicated cores.

## Obs-box backend roles

`role_obs` runs the backend stack as an Ansible-managed **docker compose** stack on the obs box (CPX41, **amd64** — all upstream images publish amd64). One role per backend, each laying down config + a compose service + the data dir on `/mnt/obs-data`:

| Role | Listens (private IP `10.0.1.30`) | Data dir | Retention |
|---|---|---|---|
| `prometheus` | `:9090` (remote-write receiver enabled) | `/mnt/obs-data/prometheus` | 15 d |
| `loki` | `:3100` | `/mnt/obs-data/loki` | 7 d |
| `tempo` | `:4317/:4318` (OTLP) | `/mnt/obs-data/tempo` | 72 h |
| `pyroscope` | `:4040` | `/mnt/obs-data/pyroscope` | 7 d |
| `alertmanager` | `:9093` | `/mnt/obs-data/alertmanager` | — |
| `grafana` | `:3000` (WireGuard-only UI) | `/mnt/obs-data/grafana` | — |
| `glitchtip` | `:8000` (WireGuard-only UI) + Postgres + Redis | `/mnt/obs-data/glitchtip` | 30 d events |

All bound to `10.0.1.30`, reachable by both Alloy agents (private net) and operators (WireGuard) only; never public (fw-obs, [02](./02-provisioning.md#firewalls)). Full scrape/alert/dashboard/retention config: [05-observability.md](./05-observability.md). Sizing: [06](./06-capacity-and-cost.md#obs-box-process-boundaries).

## Secrets management

**SOPS-encrypted** in the repo/inventory, decrypted transparently at runtime (`community.sops`):

- Ansible vault (`vault.sops.yml`) — host/middleware config: CH `arbinet` user/password, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `hcloud_token`, WireGuard private keys, kamal-proxy ACME account, GlitchTip `SECRET_KEY`/Postgres password.
- Kamal env — app container secrets (`QUERY_API_KEY`, `CH_*`, `REDPANDA_BROKERS` = `10.0.1.20:9092`, exchange API keys) ([04](./04-deployment.md#secrets)). `CH_URL` is **host-specific**: `http://10.0.1.20:8123` for the **hot-box trader** (trade-state over the private net), `http://127.0.0.1:8123` for core-box services (loopback).

`no_log: true` on every task touching a secret. No `.env` files, no `scp`.

## Operational practices

- **Idempotency is the contract.** Every run safe to repeat; guard non-idempotent tasks with `creates:`/`removes:`/`changed_when:`. A `--check` reporting "0 changed" on a no-op is the green light.
- **One-command bootstrap.** `make bootstrap` installs deps, pulls collections, decrypts vaults.
- **Drift detection.** Nightly `--check --diff` against production; alert on drift ([07](./07-runbooks.md#nightly-drift-detection)). Drift = an out-of-band manual change.

## Links

- The topology these roles configure → [01-topology.md](./01-topology.md)
- Resources being configured → [02-provisioning.md](./02-provisioning.md)
- Containers that consume this config (Ansible↔Kamal seam, G6) → [04-deployment.md](./04-deployment.md)
- What Alloy feeds + backend config → [05-observability.md](./05-observability.md)
- Sizing for these roles → [06-capacity-and-cost.md](./06-capacity-and-cost.md)
- Drift & WireGuard runbooks → [07-runbooks.md](./07-runbooks.md)
- Gaps resolved here (G5, G6, G8, G11, G12) → [08-gaps-and-decisions.md](./08-gaps-and-decisions.md)
- App-owned schema/topics/MVs → [`../datapipeline/04-clickhouse-schemas.md`](../datapipeline/04-clickhouse-schemas.md), [`../datapipeline/03-buffer-redpanda.md`](../datapipeline/03-buffer-redpanda.md)
</content>
