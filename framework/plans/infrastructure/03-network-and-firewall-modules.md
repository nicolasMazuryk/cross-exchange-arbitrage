# Task 03: Network + firewall modules

## Scope
Author the `modules/network` and `modules/firewall` Terraform modules. `network`: `hcloud_network`
**`prod-vpc`** (`10.0.0.0/16`) + one `hcloud_network_subnet` `10.0.1.0/24` in zone `eu-central`.
`firewall`: a single parametrized `hcloud_firewall` module rendering the three distinct rule sets by
`role` (hot/core/obs) — SSH 22 + WireGuard UDP 51820 from `operator_ips` everywhere; 80/443 public
**only** on core; **no public service ports** on hot or obs; private-net (`10.0.1.0/24`) all-allow on
all three. This is the first task to apply live onto the throwaway env.

## Spec References
- [02-provisioning.md §firewalls](../../specs/infrastructure/02-provisioning.md#firewalls)
- [02-provisioning.md §concrete-resource-table](../../specs/infrastructure/02-provisioning.md#concrete-resource-table)
- [01-topology.md §private-network-address-plan](../../specs/infrastructure/01-topology.md#private-network-address-plan)
- Gap G11 (operator-IP allowlist, WireGuard-only obs) — [08-gaps-and-decisions.md §g11](../../specs/infrastructure/08-gaps-and-decisions.md#g11)

## Dependencies
- Depends on: Task 02

## Acceptance Criteria
- [ ] `modules/network` creates `prod-vpc` (`10.0.0.0/16`) + subnet `10.0.1.0/24`, zone `eu-central`,
      and outputs the network id.
- [ ] `modules/firewall` is parametrized by `role` + `operator_ips` and renders the exact rule sets:
      fw-hot (22 + 51820 from operator_ips, private all-allow, no 80/443), fw-core (adds 80/443 public),
      fw-obs (22 + 51820 from operator_ips only, private all-allow, no public service ports).
- [ ] Root `main.tf` instantiates `network`, `fw_hot`, `fw_core`, `fw_obs`.
- [ ] No public allow rule for Grafana/GlitchTip/Prometheus/Redpanda/ClickHouse ports anywhere.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `terraform apply` (onto the ephemeral env) creates the network + 3 firewalls; print
      `terraform state list` showing them.
- [ ] `hcloud firewall describe fw-hot` and `fw-obs` show **no** 80/443 rule; `hcloud firewall describe
      fw-core` shows 80/443 from `*` and 22/51820 from the operator IPs — print the rule tables and
      confirm against the spec.
- [ ] Exercise the boundary: confirm fw-hot/fw-obs admit private-net `10.0.1.0/24` all-allow but deny
      public service ports (inspect the rendered rules); confirm `hcloud network describe prod-vpc`
      reports subnet `10.0.1.0/24` in `eu-central`.

## Out of Scope
- Hosts, volumes, buckets, ssh key (tasks 04/05).
- WireGuard daemon config on the hosts (Ansible, task 06) — this is firewall edge policy only.
