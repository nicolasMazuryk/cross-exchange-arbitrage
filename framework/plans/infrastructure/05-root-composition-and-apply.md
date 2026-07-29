# Task 05: Root composition + full provisioning apply

## Scope
Compose the full three-host topology in the Terraform root and apply it live, leaving the env up for
Pillar 2. Wire: the network + 3 firewalls (tasks 03), the hot/core/obs hosts via `modules/host` (task
04) with correct SKUs (CCX13/CPX51/CPX41), private IPs `.10`/`.20`/`.30`, and `role`/`env` labels;
the 2 volumes (core `ch-volume` 200 GB, obs `obs-data` 40 GB, **none on hot**); the 2 Object Storage
buckets (`arbinet-cold` created here; `arbinet-tfstate` already exists from task 01); and the
`hcloud_ssh_key`. Populate `outputs.tf` (private IPs, bucket names). **No `hcloud_load_balancer`.**

## Spec References
- [02-provisioning.md §concrete-resource-table](../../specs/infrastructure/02-provisioning.md#concrete-resource-table)
- [02-provisioning.md §end-to-end-provisioning-flow](../../specs/infrastructure/02-provisioning.md#end-to-end-provisioning-flow)
- [06-capacity-and-cost.md §budget](../../specs/infrastructure/06-capacity-and-cost.md#budget) (SKUs / volume sizes)
- Gap G10 (cold tier sole durable copy) — [08-gaps-and-decisions.md §g10](../../specs/infrastructure/08-gaps-and-decisions.md#g10)

## Dependencies
- Depends on: Task 04

## Acceptance Criteria
- [ ] Root `main.tf` composes: network + subnet, fw-hot/core/obs, hosts hot(CCX13)/core(CPX51)/obs(CPX41),
      volumes ch-volume(200, core)/obs-data(40, obs), bucket `arbinet-cold`, `hcloud_ssh_key`.
- [ ] Private IPs fixed at hot `10.0.1.10` / core `10.0.1.20` / obs `10.0.1.30`; labels `role=hot|core|obs`
      + `env=prod` on every host.
- [ ] Hot box has **no Volume**; volumes attach to core + obs only. **No `hcloud_load_balancer`** anywhere.
- [ ] `outputs.tf` exports the three private IPs and both bucket names.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `terraform apply` succeeds; `hcloud server list` shows 3 hosts with the right SKUs + labels — print it.
- [ ] `hcloud volume list` shows ch-volume(200)→core, obs-data(40)→obs, and **no** volume on hot;
      `terraform state list | grep load_balancer` returns nothing — print both.
- [ ] `terraform output` prints populated private IPs + bucket names; `aws --endpoint-url ... s3 ls`
      shows both `arbinet-cold` and `arbinet-tfstate`. Exercise an edge case: re-run `terraform plan`
      and observe **no changes** (idempotent apply). **Leave the env up for Pillar 2.**

## Out of Scope
- Any host configuration / middleware / WireGuard (Ansible, tasks 06–10).
- Per-object writes into `arbinet-cold` (app/CH-owned, datapipeline).
- Teardown (capstone, task 16).
