# Task 04: Host module + cloud-init

## Scope
Author the reusable `modules/host` Terraform module (`hcloud_server` + optional `hcloud_volume` +
volume attachment + network attachment with fixed private IP + labels + `user_data`), and the
minimal, idempotent cloud-init that makes a box reachable and nothing more: create the non-root
`ansible` user (sudo, `authorized_keys` = operator ed25519 key), SSH lockdown (`PermitRootLogin no`,
password auth off), install `python3` + `qemu-guest-agent`. `volume_gb=0` must mean **no Volume**
attached (the hot box has none). Everything beyond reachability belongs to Ansible.

## Spec References
- [02-provisioning.md §module-layout](../../specs/infrastructure/02-provisioning.md#module-layout)
- [02-provisioning.md §cloud-init-user_data-scope](../../specs/infrastructure/02-provisioning.md#cloud-init-user_data-scope)
- [01-topology.md §host-inventory](../../specs/infrastructure/01-topology.md#host-inventory)

## Dependencies
- Depends on: Task 03

## Acceptance Criteria
- [ ] `modules/host` accepts `name`, `sku`, `image`, `location`, `private_ip`, `volume_gb`,
      `network_id`, `firewall_ids`, `labels`, `ssh_keys`, `user_data` and creates a server attached to
      the network at the given private IP with the given labels and firewalls.
- [ ] `volume_gb > 0` creates + attaches an `hcloud_volume` (mounted under `/mnt/...`); `volume_gb=0`
      creates **no** Volume.
- [ ] cloud-init `user_data` is identical across hosts and limited to: ansible user + sudo +
      authorized_keys, SSH lockdown drop-in, `python3`, `qemu-guest-agent`. No package/middleware installs.
- [ ] The operator ed25519 `hcloud_ssh_key` is referenced and injected at server creation.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `terraform plan` for a single host (e.g. instantiate the module once) plans cleanly — print the
      plan summary (1 server, 0/1 volume per `volume_gb`).
- [ ] After `apply`, `ssh ansible@<public-ip>` succeeds **key-only** (no password) — print `whoami` +
      `id` from the host; observe the `ansible` user with sudo.
- [ ] On the host, `sudo sshd -T | grep -Ei 'permitrootlogin|passwordauthentication'` shows
      `permitrootlogin no` and `passwordauthentication no` — print the lines. Exercise the failure path:
      attempt root SSH login and observe it refused.

## Out of Scope
- Composing all three hosts / volumes / buckets (task 05).
- Any package install, hardening, or middleware beyond cloud-init reachability (Ansible, tasks 06–10).
