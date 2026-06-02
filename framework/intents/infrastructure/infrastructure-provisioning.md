# Infrastructure Provisioning Preferences — Arbinet on Hetzner Cloud

## Provisioning

Infrastructure on Hetzner Cloud is provisioned declaratively using **Terraform** with the official `hetznercloud/hcloud` provider. Every cloud resource that Arbinet depends on is managed through Terraform — there is no manual, click-ops creation of infrastructure in the Hetzner Console.

The following Hetzner Cloud resource types are in scope for Terraform-managed provisioning:

| Resource type   | Purpose in Arbinet                                              |
| --------------- | --------------------------------------------------------------- |
| Servers         | Compute nodes running the trading system components             |
| Volumes         | Persistent block storage attached to servers                    |
| Networks        | Hetzner private networks for internal traffic                   |
| Firewalls       | Hetzner Cloud Firewalls applied to servers                      |
| Load Balancers  | Public ingress and TLS termination                              |
| SSH keys        | Managed centrally via the `hcloud_ssh_key` resource             |
| …               | Any additional Hetzner Cloud resources required by the system   |

## Terraform State Management

Terraform remote state is stored in **Hetzner Object Storage**, keeping state co-located with the rest of the infrastructure provider and avoiding dependencies on third-party state backends.

## Project Structure and Reusability

The Terraform codebase is organized around **reusable Terraform modules** that encapsulate recurring infrastructure patterns. Modules are the primary unit of abstraction; root configurations compose modules rather than redefining resources from scratch.

## Server Configuration and First-Boot Provisioning

Server bootstrapping uses **cloud-init** as the first-boot mechanism. A `user_data` script is passed to each server at creation time and is responsible for:

- Creating users
- SSH hardening
- Installing required packages
- Pulling and triggering any subsequent configuration steps

cloud-init is treated as the clean, declarative entry point into a server's lifecycle; further configuration management is chained from it to Ansible rather than performed out-of-band.

## Networking

- All internal service-to-service traffic flows over **Hetzner private networks** rather than the public internet.
- Public ingress is fronted by **Hetzner Load Balancers**, which also perform **TLS termination**.

## Security Hardening

Network-level and host-level controls are layered:

- **Hetzner Cloud Firewalls** (managed via Terraform) are the primary network policy enforcement point, used in preference to relying solely on host-level firewalls such as `iptables`/`nftables` on each server.
- **SSH access** is key-based only; password authentication is disabled.
- **SSH keys** are managed centrally as Terraform-tracked `hcloud_ssh_key` resources, not provisioned ad-hoc per server.

## Concrete Arbinet Resource Declarations

These are the specific Hetzner resources Terraform provisions for the Arbinet single-host deployment. They serve the ClickHouse / Redpanda / trader / query-api payload specified in [`../../specs/datapipeline/`](../../specs/datapipeline/README.md). Sizing rationale and budget live in [capacity-and-cost.md](./capacity-and-cost.md).

| Resource | Declaration | Purpose |
|---|---|---|
| `hcloud_server` | 1× **CPX62** (16 vCPU AMD / 32 GB RAM / 360 GB NVMe), datacenter **FSN** or **NBG**, Ubuntu 24.04 LTS minimal image | Runs trader + query-api (Kamal apps) and clickhouse + redpanda (Kamal accessories) |
| `hcloud_volume` | 1× **400 GB** (scale to 1 TB after measured fill), attached to the server, mounted **`/mnt/ch-volume`** | ClickHouse data + Redpanda data dir (`/mnt/ch-volume/clickhouse`, `/mnt/ch-volume/redpanda`) |
| Object Storage bucket | 1× bucket **`arbinet-cold`**, same region as the server | ClickHouse S3 cold disk + daily Parquet export (cold tier) |
| `hcloud_network` | 1× private network (e.g. `prod-vpc`) | Declared for future multi-host; today all traffic is loopback (see single-host note below) |
| `hcloud_firewall` | Inbound **22, 80, 443** only; everything else denied | Outer network policy (defense-in-depth with host `ufw`) |
| `hcloud_ssh_key` | Operator key(s), Terraform-tracked | Injected at server creation; key-only SSH |
| `hcloud_load_balancer` | 1× LB fronting the Query API, **TLS termination** via Hetzner-managed cert | Public ingress for the trader UI / query API |

### Volume lifecycle

The Volume ships at 400 GB. Expansion (400 → 600 GB → 1 TB) is a Terraform `size` change applied as fill is measured; the `disk_low` alert ([observability-stack.md](./observability-stack.md)) gates the trigger. See [capacity-and-cost.md](./capacity-and-cost.md#volume-sizing-math-3-day-hot) for the 3-day-hot footprint (~370 GB).

### Object Storage bucket usage

`arbinet-cold` is consumed two ways, both owned by the app/middleware config — not provisioned per-object by Terraform:

- ClickHouse **S3 disk** (native `.bin` parts after TTL move) — disk wired in the clickhouse `storage.xml` role ([ansible-configuration.md](./ansible-configuration.md)).
- Daily **Parquet export** under `orderbooks/date=YYYY-MM-DD/*.parquet` (and `spreads/…`) — export script owned by the app ([`../../specs/datapipeline/10-cold-path.md`](../../specs/datapipeline/10-cold-path.md)); Terraform provides only the bucket.

### Query-API ingress (reframed)

Earlier pipeline drafts terminated TLS in-app behind a self-managed Caddy/nginx on `:8443`. **Superseded:** TLS is terminated at a **Hetzner Load Balancer** (default choice, CCM-integrated, Let's Encrypt-managed cert). The query-api container binds to `127.0.0.1` and is reached only via the LB; the Hetzner firewall pins public exposure to 80/443. Self-managed Caddy is reserved for exotic routing only ([deployment-ci-cd.md](./deployment-ci-cd.md#networking-edge-and-tls)).

### Single-host network reality

Although a private network is declared for future scale-out, the current Arbinet deployment is **single-host**: trader, query-api, ClickHouse, and Redpanda all co-reside and communicate over **loopback (`127.0.0.1`)** with no internal TLS. The private network and firewall still enforce that no accessory (ClickHouse `:8123/:9000`, Redpanda `:9092`) is reachable from the public internet — accessory ports are bound to `127.0.0.1` and only 22/80/443 are open at the edge.

## Links

- Sizing & budget for these resources → [capacity-and-cost.md](./capacity-and-cost.md)
- Middleware that runs on the server → [ansible-configuration.md](./ansible-configuration.md), [deployment-ci-cd.md](./deployment-ci-cd.md)
- Dependent workload → [`../../specs/datapipeline/01-topology.md`](../../specs/datapipeline/01-topology.md)