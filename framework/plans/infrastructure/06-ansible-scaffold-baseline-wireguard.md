# Task 06: Ansible scaffold + dynamic inventory + baseline + wireguard

## Scope
Stand up the Ansible foundation for `infra/ansible/`: `ansible.cfg` (connect as `ansible` user with
`~/.ssh/nicolas`), `requirements.yml` (hetzner.hcloud ≥6.9, community.general/crypto/sops,
ansible.posix), the `hcloud.yml` dynamic inventory keyed on labels (`role_hot`/`role_core`/`role_obs`,
`env_prod`, `ansible_host` = private IP), the `group_vars` layout, the `site.yml` orchestrator
(baseline → wireguard → role layers), the `baseline` hardening role (sshd drop-in, ufw,
unattended-upgrades, fail2ban, sysctl, auditd), and the `wireguard` role on all three hosts.
**Bootstrap nuance:** the first run reaches hosts over public SSH (operator IP) to install WG;
thereafter the controller reaches them over the private net via WG.

## Spec References
- [03-configuration.md §toolchain--boundaries](../../specs/infrastructure/03-configuration.md#toolchain--boundaries), [§dynamic-inventory](../../specs/infrastructure/03-configuration.md#dynamic-inventory)
- [03-configuration.md §baseline-hardening-role](../../specs/infrastructure/03-configuration.md#baseline-hardening-role), [§wireguard-role](../../specs/infrastructure/03-configuration.md#wireguard-role)
- [01-topology.md §wireguard-overlay](../../specs/infrastructure/01-topology.md#wireguard-overlay)

## Dependencies
- Depends on: Task 05, Task 01

## Acceptance Criteria
- [ ] `ansible.cfg`, `requirements.yml`, `inventories/production/hcloud.yml`, `group_vars/` layout,
      `playbooks/site.yml`, and `roles/baseline`, `roles/wireguard` exist; FQCN used throughout;
      `ansible-lint` (production profile) passes.
- [ ] Dynamic inventory groups the live fleet by label into `role_hot`/`role_core`/`role_obs`/`env_prod`
      with `ansible_host` composed from the private IP; no static host list.
- [ ] `baseline` applies the sshd drop-in (PermitRootLogin no, password auth off, ciphers/KEX,
      AllowUsers ansible), ufw, unattended-upgrades, fail2ban, sysctl, auditd on all 3 hosts.
- [ ] `wireguard` stands up a UDP 51820 endpoint on all 3 hosts; peer pubkeys from inventory vars,
      private keys from SOPS; `AllowedIPs` covers `10.0.1.0/24` + host.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `ansible-inventory --graph` lists exactly 3 hosts grouped under `role_hot`/`role_core`/`role_obs`
      — print the graph.
- [ ] `ansible-playbook site.yml --tags baseline,wireguard` applies green; then **re-run with `--check`
      and observe `0 changed`** (idempotency contract) — print the recap.
- [ ] Dial the WireGuard tunnel and confirm a peer connects: `wg show` reports a handshake and `ping
      10.0.1.20` over the overlay reaches the core box — print the output. Exercise the bootstrap edge:
      confirm the first run reaches hosts over public SSH, subsequent runs over the private net.

## Out of Scope
- Role layers beyond baseline + wireguard (obs/core/hot middleware — tasks 07–10).
- Any container runtime (Kamal, tasks 12–13).
