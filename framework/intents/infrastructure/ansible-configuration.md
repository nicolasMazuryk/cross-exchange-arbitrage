# Hetzner Cloud Infrastructure Ansible Configuration and Management

## 1. Tooling Stack & Division of Responsibility

The infrastructure is built on a three-tool toolchain in which each tool has a single, non-overlapping responsibility. The tools never call each other directly; they hand off through labels and a dynamic inventory.

| Tool | Responsibility | Boundary |
|------|----------------|----------|
| **Terraform** | Provisions cloud resources (servers, networks, firewalls) and stamps each server with labels. | Stops once resources exist. |
| **cloud-init** | Bare-minimum bootstrap so the box becomes reachable. | "Makes the box reachable." |
| **Ansible** | All configuration, hardening, and app deployment, organized as roles under a single set of playbooks. | "Makes the box useful." |

The integrating tool is the **`hetzner.hcloud` Ansible collection** (v6.7+), used for both cloud-resource modules and — critically — dynamic inventory.

- Official collection: `https://docs.ansible.com/projects/ansible/latest/collections/hetzner/hcloud/index.html`
- Dynamic inventory plugin: `https://docs.ansible.com/projects/ansible/latest/collections/hetzner/hcloud/hcloud_inventory.html`

---

## 2. Ansible Controller & Collection Requirements

### Controller prerequisites
- Python **3.10+** on the controller (required by current major versions of the collection).
- Collections pinned in `requirements.yml` and, ideally, installed inside an **Execution Environment** container for reproducibility.

### Pinned collections (`requirements.yml`)
```yaml
collections:
  - name: hetzner.hcloud
    version: ">=6.0.0,<7.0.0"
  - name: community.general
  - name: community.crypto
  - name: community.sops
  - name: ansible.posix
```

Install (collection only): `ansible-galaxy collection install hetzner.hcloud`

### Non-negotiables
- **FQCN everywhere** — `ansible.builtin.apt`, never the short `apt`. Short names are deprecated in spirit and a frequent source of subtle collection-shadowing bugs.
- **`ansible-lint` with the `production` profile**, run on every commit.
- **YAML-mode inventories, not INI** — composes cleanly with dynamic inventory.

---

## 3. Dynamic Inventory & Labeling Model

Dynamic inventory is treated as the central feature and is to be used **always**, from day one — not introduced later "once it's needed." Configured once, Ansible queries the Hetzner API for the current fleet on every run.

### Labels-driven grouping
This is the pattern that ties the toolchain together:

1. In Terraform, each `hcloud_server` is labelled, e.g. `labels = { role = "web", env = "prod", stack = "api" }`.
2. The inventory plugin turns those labels into groups (`role_web`, `env_prod`, …).
3. Playbooks target those groups directly.

The payoff: a new server created with the right labels automatically joins the right groups with **zero inventory editing**.

### Target inventory configuration (`inventory/hcloud.yml`)
```yaml
plugin: hetzner.hcloud.hcloud
api_token: "{{ lookup('community.sops.sops', 'secrets/hcloud_token.sops.yml') }}"
locations: [fsn1, nbg1, hel1]
status: [running]
network: prod-vpc            # use private IPs as ansible_host
hostvars_prefix: hcloud_
keyed_groups:
  - key: labels.role         # → group "role_web", "role_db" etc.
    prefix: role
  - key: labels.env          # → "env_prod", "env_staging"
    prefix: env
  - key: location
    prefix: hcloud_location
compose:
  ansible_host: private_net[0].ip   # talk over the private network
```

Notable preferences in this configuration: filter to `running` hosts, restrict to specific locations, prefix host vars, and **communicate over the private network** by composing `ansible_host` from the private IP.

---

## 4. Terraform → cloud-init → Ansible Handoff

**Pattern A — Labels + dynamic inventory (the chosen pattern).** Terraform creates the server with minimal cloud-init user data, sets labels, and exits. Ansible then discovers the server via the `hcloud` inventory plugin and configures it. The two tools never invoke each other.

### cloud-init scope
The cloud-init bootstrap must stay **minimal and idempotent**. Its jobs (among others) are:

- Create a non-root `ansible` user with sudo and the operator's public key.
- Disable root SSH password login.
- Install Python 3 (so Ansible can connect) and `qemu-guest-agent`.

Everything else — package installs, app config, hardening — belongs in Ansible, not cloud-init.

> The dividing line: **cloud-init makes the box reachable; Ansible makes it useful.**

---

## 5. Project Layout & Conventions

The layout that has stabilized as the preferred structure:

```
infra/
├── ansible.cfg
├── requirements.yml
├── requirements.txt
├── execution-environment.yml
├── inventories/
│   ├── production/
│   │   ├── hcloud.yml              # dynamic inventory
│   │   ├── group_vars/
│   │   │   ├── all/
│   │   │   │   ├── vars.yml
│   │   │   │   └── vault.sops.yml
│   │   │   ├── role_web.yml
│   │   │   └── env_prod.yml
│   │   └── host_vars/
│   └── staging/
├── playbooks/
│   ├── site.yml                    # top-level orchestrator
│   ├── bootstrap.yml               # one-shot, runs as root
│   ├── baseline.yml                # security + common
│   ├── web.yml
│   └── db.yml
├── roles/                          # one responsibility each
│   ├── common/
│   ├── hardening/
│   ├── docker/
│   └── app_web/
├── collections/                    # vendored third-party roles
└── molecule/                       # per-role tests live under each role
```

### Key conventions
- **Variable separation:** `group_vars/all/vars.yml` holds non-secret defaults; `vault.sops.yml` holds secrets, decrypted transparently at runtime.
- **One role = one responsibility.** A `docker` role installs Docker; an `app_web` role deploys the web app on top. Don't blend them.
- **Defaults vs. locked values:** `defaults/main.yml` for sane, overridable defaults; `vars/main.yml` for values that must not be overridden.
- **Tags on every play** (e.g. `tags: [hardening, ssh]`) so ops work can iterate quickly via `--tags ssh`.

---

## 6. Baseline Server Hardening

Every Hetzner box receives this baseline from Ansible immediately after cloud-init, regardless of the app it runs. This is the community-consensus stack.

| Area | Preference |
|------|------------|
| **SSH** | Key-only auth, `PermitRootLogin no`, password auth disabled, `AllowUsers` allowlist, modern ciphers/KEX, `ClientAliveInterval`. Delivered as a complete drop-in file in `/etc/ssh/sshd_config.d/`. |
| **Firewall** | Two layers, both used: Hetzner Cloud Firewall (configured via Terraform) as the **outer** layer; `ufw` (simplest on Debian/Ubuntu) or `nftables` (more powerful) as the **inner** layer. |
| **Auto patching** | `unattended-upgrades` (Debian/Ubuntu). |
| **Intrusion prevention** | `fail2ban` (still the default). |
| **Time sync** | `chrony`. |
| **Kernel hardening** | `sysctl` tweaks: `net.ipv4.tcp_syncookies`, disable source routing, ICMP redirect protections, etc. |
| **Audit/integrity** | `auditd` for logging. |

### Docker / iptables gotcha
Docker inserts iptables rules ahead of UFW, bypassing it. Mitigation: either use `ufw-docker`, or bind containers to `127.0.0.1` and front them with a reverse proxy.

### Preferred battle-tested collections
Use these rather than hand-rolling, adding only what is strictly needed and overriding defaults via `group_vars`:

- **`devsec.hardening`** — gold-standard, CIS-aligned, covering OS, SSH, MySQL, Nginx, etc.
- **`konstruktoid.hardening`** — actively maintained, systemd-era, strong defaults.
- **`geerlingguy.*`** — covers Docker, Nginx, PostgreSQL, security, etc.

---

## 7. Secrets Management

- **`ansible-vault`** — built in; the baseline mechanism.
- **Always set `no_log: true`** on any task that touches secrets so they don't leak into output.

---

## 8. Operational Practices

The practices that distinguish good operators, beyond what the docs cover:

- **Idempotency is the contract.** Every run must be safe to repeat. Non-idempotent tasks must be guarded with `creates:` / `removes:` / `changed_when:`. A `--check` run reporting "0 changed" on a no-op is the green light to ship.
- **One-command bootstrap.** A single `make bootstrap` / `task bootstrap` should be all a new engineer runs: it installs dependencies, pulls collections, decrypts vaults, and leaves the environment ready.
- **Drift detection.** Schedule a daily `--check --diff` run against production (e.g. in AWX) and alert on any drift. Drift indicates a manual, out-of-band change — exactly what this approach aims to eliminate.

---

## 9. End-to-End Provisioning Flow

The complete intended flow, end to end:

1. Terraform reads its variables and creates servers, attaching minimal cloud-init user data and a set of labels to each.
2. cloud-init performs only the bare bootstrap (ansible user, SSH lockdown, Python 3, guest agent); Terraform exits.
3. Ansible uses the `hetzner.hcloud.hcloud` inventory plugin to discover the fleet and group it by labels.
4. `site.yml` runs, applying layers in order: **common → hardening → role-specific**, with secrets pulled from vault/SOPS files at runtime.
5. Drift detection runs nightly.
6. Scaling out is a matter of bumping a count in Terraform and running `terraform apply`; the next Ansible run finds and configures the new server with no inventory edits.

---

## 10. Foundational Decision

The single decision flagged as paying off the most:

> **Commit to labels-driven dynamic inventory from day one.** Do not start with static inventory "until you need it."

---

## 11. Arbinet Middleware Roles

On top of the baseline (§6: `ufw`, `sysctl`, `fail2ban`, `unattended-upgrades`, `auditd`), Arbinet adds the roles below. Each follows the **one role = one responsibility** rule. These roles own **install / config / sizing only** — schema DDL, topic definitions, materialized views, and ingest patterns stay with the app (`../../specs/datapipeline/`). Sizing rationale: [capacity-and-cost.md](./capacity-and-cost.md).

### `chrony`

Wall-clock-aligned 1 Hz snapshotting depends on tight host clock sync. The role installs chrony and drops config, for example:

```conf
# /etc/chrony/chrony.conf
pool 0.europe.pool.ntp.org iburst minpoll 4 maxpoll 8
pool time.cloudflare.com   iburst minpoll 4 maxpoll 8
rtcsync
makestep 0.1 3
logdir /var/log/chrony
```

Contract: keep host clock within **50 ms** of UTC; surface `chrony_tracking_last_offset_seconds` to the metrics stack (alert at >200 ms p95 — see [observability-stack.md](./observability-stack.md)).

### `clickhouse`

Installs/pins ClickHouse (v26-LTS series — verify and pin the exact published tag before deploy) and lays down config under `/etc/clickhouse-server/`. Owns the **storage policy, resource limits, and users** — the table DDLs that *reference* this policy (`storage_policy='tiered'`, `TTL … TO VOLUME 'cold'`) belong to the app ([`../../specs/datapipeline/04-clickhouse-schemas.md`](../../specs/datapipeline/04-clickhouse-schemas.md)).

3-disk tiered storage policy (`config.d/storage.xml`):

```xml
<!-- /etc/clickhouse-server/config.d/storage.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <nvme><path>/var/lib/clickhouse/</path></nvme>
      <volume><path>/mnt/ch-volume/clickhouse/</path></volume>
      <s3>
        <type>s3</type>
        <endpoint>https://fsn1.your-objectstorage.com/arbinet-cold/</endpoint>
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

Resource limits (`config.d/limits.xml`) — caps CH at ~10 GB to coexist with the Node trader and Redpanda:

```xml
<!-- /etc/clickhouse-server/config.d/limits.xml -->
<clickhouse>
  <profiles><default>
    <max_memory_usage>10000000000</max_memory_usage>
    <max_bytes_before_external_group_by>5000000000</max_bytes_before_external_group_by>
    <max_threads>6</max_threads>
    <async_insert>1</async_insert>
    <wait_for_async_insert>0</wait_for_async_insert>
  </default></profiles>
</clickhouse>
```

`users.d/` carries the `arbinet` user + password (from SOPS/vault, never in the role tree) and `CLICKHOUSE_DB=arbinet`. Data dir is on the Volume (`/mnt/ch-volume/clickhouse`); S3-disk creds (`S3_ACCESS_KEY` / `S3_SECRET_KEY`) injected from secrets at container start. Role vars expose `max_threads`, `async_insert_threads`, and `max_memory_usage` for the scaling triggers in [capacity-and-cost.md](./capacity-and-cost.md#capacity-headroom--scaling-triggers).

Local-dev override: a single-disk policy (`tiered → default`, no S3) ships as `config.dev.d/storage.xml` for the dev compose ([deployment-ci-cd.md](./deployment-ci-cd.md)).

### `redpanda`

Installs/pins Redpanda (single-broker KRaft) and sets sizing flags so it stays inside its 3 GB heap budget:

- Start flags: `--smp 2 --memory 3G --reserve-memory 0M --overprovisioned --node-id 0 --mode production`.
- Listener: `INTERNAL://127.0.0.1:9092` only (loopback; bound off public).
- Data dir: `/mnt/ch-volume/redpanda` (on the Volume).
- Retention caps (size-based fail-safe behind the app's 24 h time retention): `ob.snapshots` 50 GB, `spreads.live` 20 GB; `delete.retention.ms = 86_400_000`.

Heap may be cut 3 GB → 1.5 GB under memory pressure (role var; scaling trigger in [capacity-and-cost.md](./capacity-and-cost.md)). **Topic creation, partition counts, and partition-key design are the app's** ([`../../specs/datapipeline/03-buffer-redpanda.md`](../../specs/datapipeline/03-buffer-redpanda.md)); this role only sizes and runs the broker. Redpanda is deployed as a Kamal accessory ([deployment-ci-cd.md](./deployment-ci-cd.md)).

### `observability_agents`

Self-hosted OpenTelemetry collection on the same host. Installs:

- **OpenTelemetry Collector** *or* **Grafana Alloy** (selection deferred — see [observability-stack.md](./observability-stack.md)) as the unified collector/shipper: scrapes `/metrics` from trader + query-api, tails container logs to Loki, receives OTLP traces.
- **node_exporter** — host CPU/mem/disk/net, including `node_filesystem_avail_bytes{mountpoint="/mnt/ch-volume"}` and per-device NVMe-vs-Volume I/O.
- **clickhouse-exporter** — CH parts/query/insert/S3 series.

Redpanda exposes a native Prometheus endpoint (no exporter needed). Backends (Prometheus, Loki, Tempo, Pyroscope, Parca, Alertmanager, Grafana) and their scrape/alert/dashboard config are specified in [observability-stack.md](./observability-stack.md); this role only installs and points the agents at those backends.

## Links

- Sizing rationale for these roles → [capacity-and-cost.md](./capacity-and-cost.md)
- What the agents feed → [observability-stack.md](./observability-stack.md)
- Containers/accessories that consume this config → [deployment-ci-cd.md](./deployment-ci-cd.md)
- App-owned schema/topics/MVs → [`../../specs/datapipeline/04-clickhouse-schemas.md`](../../specs/datapipeline/04-clickhouse-schemas.md), [`../../specs/datapipeline/03-buffer-redpanda.md`](../../specs/datapipeline/03-buffer-redpanda.md)