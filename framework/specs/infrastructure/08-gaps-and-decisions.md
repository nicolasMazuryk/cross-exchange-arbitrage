# 08 — Gaps & Decisions Register

Every gap, conflict, or silent assumption found while turning the four observability/infra intents into one buildable architecture — with the resolution taken (and the interview decision behind it) and the input still needed to finalize. This satisfies "surface, don't paper over." Each gap is anchored so the other specs can link directly to it. **This revision** re-architects to three hosts with a dedicated-vCPU hot box; the gaps below reflect that (G1 resolved, G5 reversed, G2/G3 updated, G12/G13 added).

## Summary

| # | Gap | Resolution | Input still needed |
|---|---|---|---|
| [G1](#g1) | Budget vs ceiling | **Resolved** — ceiling raised to ~$200; three-host total ≈ $164, under | — (ceiling raised this session) |
| [G2](#g2) | Obs backends had no host budget | Own obs host (CPX41, amd64); hot + core each keep only an Alloy agent | — (recorded) |
| [G3](#g3) | Private network role | Now load-bearing **warm data path** (`ob.ticks`) + trader↔CH trade-state + telemetry + Ansible | — |
| [G4](#g4) | CCM/CSI = Kubernetes constructs | Volume wired by Terraform, no k8s (LB dropped) | — |
| [G5](#g5) | Double TLS / edge | **Reversed** — TLS in kamal-proxy on the core box; **Hetzner LB dropped** | confirm host-managed LE cert on core box acceptable |
| [G6](#g6) | Ansible vs Kamal ownership seam | Ansible lays config/dirs/sizing; Kamal runs images | — |
| [G7](#g7) | Registry unspecified | GHCR | **confirm GHCR vs Docker Hub + cred location** |
| [G8](#g8) | Parca vs Pyroscope; collector/shipper undecided | Pyroscope-only; single Alloy binary (on hot + core) | — |
| [G9](#g9) | TF state locking without DynamoDB | Native S3 lockfile, TF ≥ 1.10 | — |
| [G10](#g10) | No backups chosen | Documented residual risk; risk now on the **core box** | confirm cold-tier is acceptable sole copy |
| [G11](#g11) | Per-host hardening/ingress | WireGuard-only obs; no public ports on hot/obs | confirm operator source-IP allowlist |
| [G12](#g12) | SpreadComputer split / serviceless raw path (app prereq) | **NEW** — spread-computer split out of trader onto core box; snapshotter dissolved, raw `orderbooks` path serviceless (CH Kafka engine on `ob.ticks`); hard prereq for CCX13 sizing | datapipeline workstream owns/ships the change |
| [G13](#g13) | Hot-box 8 GB RAM risk | **NEW** — measure trader RSS; CCX23 fallback with defined trigger | measure sustained RSS at runtime |

---

## G1 — Budget vs ceiling {#g1}

**Gap.** The intents budgeted ≤ $150/mo. The earlier two-host design already ran ~$6 over; this redesign adds a dedicated-vCPU hot box and an amd64 obs box (CAX/CX ARM lines unavailable on the target account), which would push further over a $150 ceiling.

**Resolution.** The **ceiling was raised to ~$200/mo this session**, justified by the dedicated cores isolating the financial hot path. Quantified in [06](./06-capacity-and-cost.md#budget): CCX13 ~€13 + CPX51 ~€55 + CPX41 ~€25 + 200 GB Vol ~€9 + 40 GB Vol ~€2 + Object Storage ~€42 + misc ~€5 → **≈ €151 ≈ $164/mo**, **~$36 under** the new ceiling. The dropped LB and the smaller starting volumes (200/40 GB) offset most of the CPX41-vs-ARM cost bump. **G1 is resolved** — no longer an overage.

**Input needed:** — (ceiling raised; total under it).

## G2 — Obs backends had no host budget {#g2}

**Gap.** `observability-stack.md` mandated self-hosted Prometheus + Loki + Tempo + Pyroscope + Grafana + Alertmanager + Sentry + Grafana OnCall (multi-GB backends), but the trader host had no room.

**Resolution (interview).** A **dedicated obs host** holds the backends. Originally a small ARM CAX31; **this revision uses CPX41 (8 vCPU / 16 GB, amd64)** because the CAX (ARM) and CX (cost-optimized) lines are **unavailable on the target Hetzner account** — the design is now all-amd64. The hot box and the core box each keep only an Alloy agent (lean on hot, full collector on core); the hot path stays isolated on dedicated cores. Recorded across [01](./01-topology.md#why-dedicated-cores-hot-box), [06](./06-capacity-and-cost.md#obs-box-process-boundaries).

**Input needed:** — (resolved; trail recorded).

## G3 — Private network role {#g3}

**Gap.** The intents declared a private network "for future multi-host" while all traffic stayed on loopback — the network did nothing.

**Resolution.** With three hosts the private net is **load-bearing** and now carries a **warm data path**: the hot box produces raw **`ob.ticks`** to the core box's Redpanda (`10.0.1.20:9092`, async, ≤5 ms produce timeout, drop-on-timeout), and the hot box's trader also **persists/restores trade-state to the core box's ClickHouse** (`10.0.1.20:8123`, HTTP, [`../datapipeline/11-redis-removal.md`](../datapipeline/11-redis-removal.md)) — an accepted third hot-box egress — in addition to both Alloy agents' telemetry (remote_write/push/OTLP → `10.0.1.30`) and the Ansible control path. All ride `prod-vpc` (10.0.0.0/16, subnet 10.0.1.0/24; hot 10.0.1.10, core 10.0.1.20, obs 10.0.1.30). Co-resident data on the core box (CH native/Redpanda/spread-computer/query-api) **stays on loopback**; the two private-bound ports are Redpanda's Kafka listener (`9092`) and CH's HTTP port (`8123`). Address plan + tick seam: [01](./01-topology.md#private-network-address-plan), [01](./01-topology.md#the-obticks-warm-path).

## G4 — CCM/CSI are Kubernetes constructs {#g4}

**Gap.** `deployment-ci-cd.md` referenced the Cloud Controller Manager (CCM) and CSI driver for LB/volume wiring and label-based discovery — these are **Kubernetes** constructs. This is **Kamal-on-VMs, no k8s**.

**Resolution.** The Volume is wired by **Terraform** (`hcloud_volume`, not CSI). Labels feed **Ansible's dynamic inventory**, not a CCM. The LB that CCM would have managed is **dropped entirely** (G5) — TLS terminates in kamal-proxy on the core box. The CCM/CSI references are a misnomer for this deployment — flagged. See [02](./02-provisioning.md#labels), [04](./04-deployment.md#edge-and-tls-path).

## G5 — Double TLS / edge {#g5}

**Gap.** `infrastructure-provisioning.md` had the Hetzner LB do Let's Encrypt TLS; `deployment-ci-cd.md` had Kamal 2 provision Let's Encrypt TLS. Two cert authorities for one edge. The earlier two-host design resolved this by terminating at the **LB** (to keep cert management off the latency-sensitive host).

**Resolution (reversed this session).** With the dedicated hot box, **query-api lives on the core box, off the hot path** — so terminating TLS on the host is no longer a hot-path concern. The **Hetzner LB is dropped**; **TLS terminates once, in kamal-proxy on the core box** (Let's Encrypt, `proxy.ssl: true`). This saves the LB cost and simplifies the edge. The `trader` app on the hot box has no ingress; only `query-api` sits behind the edge, and its cert is on the core box — never on the dedicated trade cores. Single edge path: [01](./01-topology.md#public-edge-path-single), [04](./04-deployment.md#edge-and-tls-path).

**Input needed:** confirm a host-managed (kamal-proxy) Let's Encrypt cert on the core box is acceptable (vs. a specific cert authority/SAN requirement).

## G6 — Ansible vs Kamal ownership seam {#g6}

**Gap.** Ansible roles "own install/config/sizing" for ClickHouse/Redpanda, but those run as **Kamal accessories** (containers). Who owns what?

**Resolution.** **Ansible** lays down config files (`storage.xml`, `limits.xml`, `users.d`, Redpanda flags + private listener), volume dirs (`/mnt/ch-volume/...`), and host sizing on disk; **Kamal** runs the pinned images that **mount** that config. The boundary is explicit: config-on-host = Ansible, container-runtime = Kamal. This now also covers the split-out spread-computer (Ansible preps config/env, Kamal runs the app). See [03](./03-configuration.md#core-box-middleware-roles), [04](./04-deployment.md#kamal-apps-and-accessories).

## G7 — Registry unspecified {#g7}

**Gap.** "No CI" was chosen, but Kamal still **requires** an image registry to pull from. None was specified.

**Resolution.** **GHCR** (`ghcr.io`) — the git remote is GitHub, so GHCR is the natural registry. Build amd64 locally (three images: trader, query-api, spread-computer — **amd64 only**, no arm64), push to GHCR, `kamal deploy` pulls. A GHCR PAT (`read:packages`) lives in Kamal secrets. See [04](./04-deployment.md#build-and-deploy-no-ci).

**Input needed:** **confirm GHCR vs Docker Hub**, and the **credential location** (org PAT vs per-developer).

## G8 — Parca vs Pyroscope; collector/shipper undecided {#g8}

**Gap.** The intents listed **both** Pyroscope and Parca (eBPF) for profiling, and left "OTel Collector vs Alloy" and "Vector vs Fluent Bit" open.

**Resolution (interview).** **Pyroscope only** (Node SDK push); Parca/eBPF dropped. **Grafana Alloy** is the single collector binary — now running on **both** the hot box (lean: scrape trader + node, receive OTLP/Pyroscope, forward) and the core box (full: scrape the warm services + CH/Redpanda exporters, tail logs, forward) — dropping both the separate log shipper and the OTel-Collector alternative. See [03](./03-configuration.md#alloy-role-hot-lean), [05](./05-observability.md#why-two-alloy-agents-backends-on-the-obs-box).

## G9 — TF state locking without DynamoDB {#g9}

**Gap.** Remote state in Hetzner Object Storage (S3-compatible), but the classic S3 backend used **DynamoDB** for locking — Hetzner has no DynamoDB.

**Resolution.** Terraform's **native S3 lockfile** (`use_lockfile=true`, requires Terraform **≥ 1.10**) writes a `.tflock` object alongside state — no DynamoDB. Version pinned in `versions.tf`. State bucket `arbinet-tfstate`, endpoint `nbg1.your-objectstorage.com`. See [02](./02-provisioning.md#terraform-state-backend-with-native-lockfile).

## G10 — No backups {#g10}

**Gap.** No-HA/no-DR was chosen; the residual data-loss risk was unstated.

**Resolution (documented acceptance).** A **core-box**-loss event loses **hot+warm ClickHouse (3-day) and in-flight Redpanda**; **only the cold-tier Parquet in `arbinet-cold` survives**. The no-backup risk now lives on the **core box** (the data box) — a hot-box loss, by contrast, loses no stored data (the trader holds only in-memory books, and warm/analytical state is on the core box). No snapshots, no replicas, no failover. Recovery = Terraform re-provision + Ansible + Kamal + accept the gap (the app marks discontinuity on restart; no backfill). Explicitly accepted, not an oversight. See [01](./01-topology.md#failure-isolation), [06](./06-capacity-and-cost.md#cold-tier-per-year), [07](./07-runbooks.md#host-rebuild-recovery).

**Input needed:** confirm the cold tier as the **sole durable copy** is acceptable for the trade-data retention requirement (vs. adding CH backups / a Volume snapshot schedule on the core box).

## G11 — Per-host hardening / ingress {#g11}

**Gap.** The obs node and the new hot box needed firewall/ingress policy. Grafana/GlitchTip must not be public, but operators need to reach them; the hot box must not expose service ports.

**Resolution.** **WireGuard-only** operator access. Three firewalls ([02](./02-provisioning.md#firewalls)): **fw-hot** opens only SSH + WG (no public service ports — the trader has no ingress; it only dials out for `ob.ticks` + Alloy); **fw-core** opens SSH + WG + **80/443** (the kamal-proxy TLS edge) and admits the hot box's Redpanda producer on the private net; **fw-obs** opens only WG + SSH, **no public service ports** — all backends listen on `10.0.1.30`. WireGuard role runs on all three hosts. Operators dial WG to reach Grafana (`:3000`) / GlitchTip (`:8000`). See [01](./01-topology.md#wireguard-overlay), [02](./02-provisioning.md#firewalls), [03](./03-configuration.md#wireguard-role).

**Input needed:** confirm the **operator source-IP allowlist** for `operator_ips` (static office/VPN egress vs. dynamic — affects whether 51820 can be IP-pinned).

## G12 — SpreadComputer split / serviceless raw path (app prerequisite) {#g12}

**Gap (NEW).** The CCX13 hot-box sizing (8 GB, 2 dedicated cores) assumes the trader process runs **only** the trade hot path. But today the spread computation runs **inside** the trader process. Until it is extracted, the hot box must run everything and would need CCX23+.

**Resolution.** The **spread-computer is split OUT of the trader process** into a standalone service that runs on the **core box** and consumes the raw **`ob.ticks`** topic from Redpanda (the new warm-path seam) — the lone warm processor. The raw `orderbooks` system-of-record path is **serviceless**: ClickHouse's Kafka engine consumes `ob.ticks` directly into `orderbooks`, with no warm service in the path to crash it (gap detection moved upstream to the WS adapter / 1 Hz sampler, carried as a `sequence_gap` flag on `ob.ticks`, so the dissolved SnapshotterService is no longer needed). Infra defines only the seam: the private-net `ob.ticks` path ([01](./01-topology.md#the-obticks-warm-path)) and one new Kamal app on the core box ([04](./04-deployment.md#images-to-build)). The split itself is an **app/datapipeline change** — a **hard, blocking prerequisite** for the CCX13 sizing. Until it ships, run the hot box on CCX23.

**Input needed:** — the **datapipeline workstream owns and shipped** the SpreadComputer extraction + serviceless raw path; no infra-side input outstanding before sizing the hot box down to CCX13.

## G13 — Hot-box 8 GB RAM risk {#g13}

**Gap (NEW).** The CCX13 hot box has **8 GB RAM** with only ~1 GB headroom after the trader (~6.5 GB, RAM driven by in-memory L2 books) and the lean Alloy (~250 MB). This is **tight**.

**Resolution.** Flagged as a sizing risk with a **defined upgrade trigger**: measure trader RSS at runtime (`docker stats` / `/proc`, or the `verify-runtime` skill); the `hot_mem_high` alert fires at `node_memory_MemAvailable_bytes{host="hot"} < 1 GB` for 10 min ([05](./05-observability.md#alert-rules)). If RSS exceeds **~6.5 GB sustained**, fall back to **CCX23** (4 vCPU / 16 GB, ~+€12/mo) — a Terraform `sku` change + re-provision (no data on the hot box, so the rebuild is fast). See [06](./06-capacity-and-cost.md#hot-box-process-boundaries), [07](./07-runbooks.md#host-rebuild-recovery).

**Input needed:** measure sustained trader RSS once the split (G12) ships to confirm CCX13 holds or trigger the CCX23 fallback.

## Links

- Topology realizing these decisions → [01-topology.md](./01-topology.md)
- Provisioning (G4, G5, G9, G10, G11) → [02-provisioning.md](./02-provisioning.md)
- Configuration (G5, G6, G8, G11, G12) → [03-configuration.md](./03-configuration.md)
- Deployment (G4, G5, G7, G12) → [04-deployment.md](./04-deployment.md)
- Observability (G2, G8, G12, G13) → [05-observability.md](./05-observability.md)
- Capacity & cost (G1, G10, G12, G13) → [06-capacity-and-cost.md](./06-capacity-and-cost.md)
- Recovery for the no-HA/no-backup path → [07-runbooks.md](./07-runbooks.md#host-rebuild-recovery)
</content>
