# 02 — Provisioning (Pillar 1: Terraform)

Every Hetzner Cloud resource ARBINET depends on is declared in **Terraform** with the official `hetznercloud/hcloud` provider. No click-ops in the Hetzner Console. Terraform's job ends once resources exist and are stamped with labels; cloud-init makes them reachable; Ansible ([03](./03-configuration.md)) makes them useful. This file carries the complete, concrete resource set for the three-host topology ([01](./01-topology.md)) inline.

## Module layout

The codebase is organized around reusable modules; the root config composes them rather than redefining resources. **The LB module is removed** — TLS now terminates in kamal-proxy on the core box (gap **G5** reversed), so there is no `hcloud_load_balancer` to provision.

```
infra/terraform/
├── main.tf                 # root: composes modules below, wires outputs → inputs
├── versions.tf             # required_version >= 1.15, provider pin
├── backend.tf              # S3 backend (Hetzner Object Storage) + native lockfile
├── variables.tf            # hcloud_token, operator_ips, ssh keys, region, sizes
├── outputs.tf              # host private IPs, bucket names, zone NS/FQDN → consumed by Ansible/Kamal
├── dns.tf                  # hcloud_zone arbinet.xyz (primary) + A/CNAME rrsets (api/apex/www)
└── modules/
    ├── network/            # hcloud_network + subnet
    ├── firewall/           # hcloud_firewall (parametrized: hot vs core vs obs rule set)
    └── host/               # hcloud_server + optional hcloud_volume + attachment + network attach + labels + user_data
```

Root composition (shape, not full HCL — code is out of scope):

```hcl
module "network" { source = "./modules/network" cidr = "10.0.0.0/16" subnet = "10.0.1.0/24" zone = "eu-central" }
module "fw_hot"  { source = "./modules/firewall" role = "hot"  operator_ips = var.operator_ips }
module "fw_core" { source = "./modules/firewall" role = "core" operator_ips = var.operator_ips }
module "fw_obs"  { source = "./modules/firewall" role = "obs"  operator_ips = var.operator_ips }
module "hot"  { source = "./modules/host" name="hot"  sku="ccx13" image="ubuntu-24.04" location="nbg1"
                private_ip="10.0.1.10" volume_gb=0   network_id=module.network.id
                firewall_ids=[module.fw_hot.id]  labels={role="hot",env="prod"}  ssh_keys=var.ssh_key_ids }
module "core" { source = "./modules/host" name="core" sku="cpx51" image="ubuntu-24.04" location="nbg1"
                private_ip="10.0.1.20" volume_gb=200 network_id=module.network.id
                firewall_ids=[module.fw_core.id] labels={role="core",env="prod"} ssh_keys=var.ssh_key_ids }
module "obs"  { source = "./modules/host" name="obs"  sku="cpx41" image="ubuntu-24.04" location="nbg1"
                private_ip="10.0.1.30" volume_gb=40  network_id=module.network.id
                firewall_ids=[module.fw_obs.id]  labels={role="obs",env="prod"}  ssh_keys=var.ssh_key_ids }
```

All three hosts use the **`host`** module (no separate obs/lb wrapper). `volume_gb=0` on the hot box means **no Volume attached** — the trader holds its books in memory and persists nothing locally.

## Concrete resource table

The full set Terraform provisions for the three-host deployment. Sizing rationale and budget: [06-capacity-and-cost.md](./06-capacity-and-cost.md). All hosts **amd64**, datacenter **NBG1** (CAX/CX lines unavailable on the target account; CCX dedicated + CPX regular only).

| Resource | Declaration | Purpose |
|---|---|---|
| `hcloud_server` **hot** | **CCX13** (2 **dedicated** vCPU / 8 GB / 80 GB NVMe), Ubuntu 24.04 LTS, NBG1, labels `role=hot,env=prod`, private IP `10.0.1.10`, **no Volume** | trader Node app only; lean Alloy |
| `hcloud_server` **core** | **CPX51** (16 shared vCPU / 32 GB / 360 GB NVMe), Ubuntu 24.04 LTS, NBG1, labels `role=core,env=prod`, private IP `10.0.1.20` | ClickHouse + Redpanda + query-api + spread-computer + kamal-proxy + Alloy |
| `hcloud_server` **obs** | **CPX41** (8 shared vCPU / 16 GB / 240 GB NVMe, **amd64**), Ubuntu 24.04 LTS, NBG1, labels `role=obs,env=prod`, private IP `10.0.1.30` | Observability backend stack |
| `hcloud_volume` **ch-volume** | **200 GB**, attached to core, mounted `/mnt/ch-volume` | CH data + Redpanda data dir (`/mnt/ch-volume/clickhouse`, `/mnt/ch-volume/redpanda`) |
| `hcloud_volume` **obs-data** | **40 GB**, attached to obs, mounted `/mnt/obs-data` | Prometheus TSDB + Loki + Tempo + Pyroscope + GlitchTip Postgres |
| `hcloud_network` **prod-vpc** | `10.0.0.0/16`, one `hcloud_network_subnet` `10.0.1.0/24`, zone `eu-central` | Load-bearing private net: warm `ob.ticks` path (hot→core Redpanda) + Alloy→obs telemetry + Ansible control ([01](./01-topology.md#private-network-address-plan)) |
| `hcloud_firewall` **fw-hot** | Inbound: **22** (SSH, operator IPs), **WireGuard UDP 51820** (operator IPs); private-net all-allow; **no public service ports**; everything else denied | Edge policy for hot box — only three outbound flows (`ob.ticks`→core Redpanda, trade-state→core ClickHouse, Alloy→obs) |
| `hcloud_firewall` **fw-core** | Inbound: **22** (SSH, operator IPs), **80 + 443** (public, to kamal-proxy), **WireGuard UDP 51820** (operator IPs); private-net all-allow; everything else denied | Edge policy for core box (kamal-proxy TLS edge + Redpanda private listener + ClickHouse HTTP from the hot box, both from `10.0.1.0/24`) |
| `hcloud_firewall` **fw-obs** | Inbound: **WireGuard UDP 51820** (operator IPs), **SSH 22** (operator IPs, over WG in practice); private-net all-allow; **no public service ports** | Edge policy for obs (gap **G11**) |
| Object Storage bucket **arbinet-cold** | NBG1 (`nbg1.your-objectstorage.com`) | CH S3 cold disk + daily Parquet export ([`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)) |
| Object Storage bucket **arbinet-tfstate** | NBG1 | Terraform remote state + native lockfile (below) |
| `hcloud_zone` **arbinet.xyz** | `mode=primary`, zone `ttl=3600`; NS delegated from GoDaddy registrar (one-time manual step) | Hetzner authoritative DNS for the query-api edge domain; fully Terraform-managed (no Console) |
| `hcloud_zone_rrset` **api / @ / www** | `api` A → `module.core.public_ipv4` (`ttl=300`), apex `@` A → core (`ttl=300`), `www` CNAME → `arbinet.xyz.` (`ttl=3600`) | `api.arbinet.xyz` = kamal-proxy TLS host; apex/www DNS presence. Low A TTL keeps re-pointing fast on core rebuild |
| `hcloud_ssh_key` | Operator ed25519 key `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIljEw49E8vw0nrc6zzdsooLDFAsE5HSs/AxMspZiY5 nicolasmazuryk@gmail.com`, Terraform-tracked | Injected at all servers' creation; key-only SSH. Matching private key lives at `~/.ssh/nicolas` on the operator machine (never in repo/state); Ansible + Kamal authenticate over SSH with it |

**No `hcloud_load_balancer`.** The single public edge is kamal-proxy on the core box ([04](./04-deployment.md#edge-and-tls-path)).

**DNS is Terraform-managed (no Console).** `hcloud_zone arbinet.xyz` + its rrsets live in `dns.tf`; the only manual step is delegating the zone's nameservers (Terraform output `zone_nameservers`) to Hetzner at the GoDaddy registrar, once.

### Volume lifecycle

Volumes **ship small and grow later.** `ch-volume` ships at **200 GB** (not 400) on the core box; `obs-data` ships at **40 GB** (not 90) on the obs box. The hot box has **no Volume**. Expansion is a Terraform `size` change, gated by the `disk_low` alert ([05](./05-observability.md#alert-rules)) — `ch-volume` grows 200 → 400 → 600+; `obs-data` grows 40 → 90+ as a retention window widens. Online resize, no downtime ([07](./07-runbooks.md#volume-expand)).

### Object Storage bucket usage

- **`arbinet-cold`** — consumed by the app/middleware on the core box, not provisioned per-object by Terraform: CH **S3 disk** (the `tiered` policy's cold volume, wired in the clickhouse role's `storage.xml` with endpoint `nbg1.your-objectstorage.com`, [03](./03-configuration.md#clickhouse-role)) and a daily **Parquet export** under `orderbooks/date=YYYY-MM-DD/*.parquet` (export script owned by the app, [`../datapipeline/10-cold-path.md`](../datapipeline/10-cold-path.md)). Terraform provides only the bucket. It is the **only durable data copy** (no backups, gap **G10**).
- **`arbinet-tfstate`** — Terraform's own remote state + lockfile (below).

## Firewalls

Three distinct rule sets, all Terraform-managed (the outer layer; host `ufw` is the inner layer, [03](./03-configuration.md#baseline-hardening-role)).

**fw-hot** (attached to `10.0.1.10`) — no public service ports; the hot box only dials out:

| Direction | Port/proto | Source | Why |
|---|---|---|---|
| in | TCP 22 | operator IPs | SSH (key-only) |
| in | UDP 51820 | operator IPs | WireGuard |
| in | all | `10.0.1.0/24` | private-net (Alloy reverse paths, admin) |
| in | * | * | **deny** (no 80/443 — trader has no ingress) |

**fw-core** (attached to `10.0.1.20`) — the public edge + Redpanda private listener:

| Direction | Port/proto | Source | Why |
|---|---|---|---|
| in | TCP 22 | operator IPs | SSH (key-only) |
| in | TCP 80, 443 | * (public) | kamal-proxy TLS edge → query-api |
| in | UDP 51820 | operator IPs | WireGuard |
| in | all | `10.0.1.0/24` | private-net: **hot box `ob.ticks` producer → Redpanda `10.0.1.20:9092`**; **hot box trade-state client → ClickHouse `10.0.1.20:8123`**; admin/scrape paths |
| in | * | * | **deny** |

**fw-obs** (attached to `10.0.1.30`) — gap **G11**: no public service ports:

| Direction | Port/proto | Source | Why |
|---|---|---|---|
| in | UDP 51820 | operator IPs | WireGuard (the only public-facing port) |
| in | TCP 22 | operator IPs | SSH (in practice reached over WG) |
| in | all | `10.0.1.0/24` | Alloy remote_write/push/OTLP from hot + core; obs backends listen on `10.0.1.30` |
| in | * | * | **deny** |

Grafana (`:3000`), GlitchTip (`:8000`), Prometheus (`:9090`), Loki (`:3100`), Tempo (`:4317`), Pyroscope (`:4040`), Alertmanager (`:9093`), ClickHouse, spread-computer metrics are **never** in a public allow rule — reachable only over the private net (Alloy / `ob.ticks`) or WireGuard (operators). Redpanda's `9092` is reachable on the private net only (firewall pins source to `10.0.1.0/24`). ClickHouse's HTTP `8123` is likewise reachable on the private net only — the hot box's trader uses it for trade-state persist/restore — with the same firewall pin to `10.0.1.0/24`.

## Labels

Every resource is labelled — labels are the discovery mechanism for Ansible's dynamic inventory ([03](./03-configuration.md#dynamic-inventory)). The load-bearing pair:

- `role = hot | core | obs` → inventory groups `role_hot`, `role_core`, `role_obs`
- `env = prod` → group `env_prod`

A host created with the right labels auto-joins the right Ansible groups with zero inventory editing. (Note: these labels feed **Ansible**, not a Kubernetes CCM/CSI — this is Kamal-on-VMs, no k8s; gap **G4**, [08](./08-gaps-and-decisions.md#g4).)

## Terraform state backend with native lockfile

Remote state in Hetzner Object Storage via the S3-compatible backend, co-located with the rest of the infra (NBG1). **No DynamoDB** — Hetzner has no DynamoDB equivalent; instead use Terraform's **native S3 lockfile** (requires Terraform **≥ 1.10**), gap **G9** ([08](./08-gaps-and-decisions.md#g9)):

```hcl
# versions.tf
terraform {
  required_version = ">= 1.15"
  required_providers { hcloud = { source = "hetznercloud/hcloud", version = "~> 1.64" } }
}

# backend.tf
terraform {
  backend "s3" {
    bucket                      = "arbinet-tfstate"
    key                         = "arbinet/prod/terraform.tfstate"
    region                      = "eu-central-1"             # placeholder; Hetzner OS ignores AWS region semantics
    endpoints                   = { s3 = "https://nbg1.your-objectstorage.com" }
    use_lockfile                = true                       # native .tflock object — replaces DynamoDB
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true                       # Hetzner OS compatibility
  }
}
```

`use_lockfile=true` writes a `terraform.tfstate.tflock` object alongside state for concurrency safety. The `region` placeholder stays (AWS-semantics, ignored by Hetzner OS) but the **endpoint is NBG1** (`nbg1.your-objectstorage.com`). Credentials (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` mapped to the Hetzner Object Storage keys) come from the environment, never from the repo.

## cloud-init `user_data` scope

Terraform attaches a **minimal, idempotent** cloud-init `user_data` to each server. Identical on all three hosts; it makes the box reachable and nothing more (the dividing line: cloud-init makes the box reachable, Ansible makes it useful):

- Create a non-root `ansible` user with sudo; its `authorized_keys` is *this* operator ed25519 public key (`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIljEw49E8vw0nrc6zzdsooLDFAsE5HSs/AxMspZiY5 nicolasmazuryk@gmail.com`, the `hcloud_ssh_key` row above). The matching private key lives at `~/.ssh/nicolas` on the operator machine — never in the repo or state; Ansible and Kamal both authenticate over SSH with it.
- `PermitRootLogin no`, disable SSH password auth.
- Install Python 3 (so Ansible can connect) and `qemu-guest-agent`.

Package installs, hardening, middleware, the observability stack — all belong to Ansible ([03](./03-configuration.md)), not cloud-init. Terraform then exits; the two tools never invoke each other (Pattern A — labels + dynamic inventory).

## End-to-end provisioning flow

1. `terraform apply` creates all three servers (with cloud-init `user_data` + labels), both volumes (core + obs, attached + ready to mount; none on hot), the network + subnet, all three firewalls, both buckets, and the SSH keys; writes state to `arbinet-tfstate` under the native lock. **No LB created.**
2. cloud-init runs the bare bootstrap on each box → reachable.
3. Outputs (private IPs `.10`/`.20`/`.30`, bucket names) are consumed by Ansible inventory vars and the Kamal config.
4. Scaling a Volume or rebuilding a host is a Terraform change (see [07-runbooks.md](./07-runbooks.md#volume-expand)).

## Links

- The topology these resources realize → [01-topology.md](./01-topology.md)
- What configures the provisioned hosts → [03-configuration.md](./03-configuration.md)
- What deploys onto them → [04-deployment.md](./04-deployment.md)
- Sizing rationale & budget for every line above → [06-capacity-and-cost.md](./06-capacity-and-cost.md)
- Volume-expand & host-rebuild runbooks → [07-runbooks.md](./07-runbooks.md)
- Gaps resolved here (G4, G5, G9, G10, G11) → [08-gaps-and-decisions.md](./08-gaps-and-decisions.md)
- App workload these resources serve → [`../datapipeline/01-topology.md`](../datapipeline/01-topology.md)
</content>
