# WireGuard onboarding

Give a new operator private-network access (Grafana/GlitchTip/Prometheus + SSH
over the `10.0.1.0/24` tunnel). Gateway-per-host model — each host is an
independent WG gateway (NAT MASQUERADE), one operator config = full subnet.
Source: [spec 07 §WireGuard onboarding](../../framework/specs/infrastructure/07-runbooks.md),
`group_vars/all/vars.yml` (`wireguard`).

> **WG dial-in needs local interactive sudo** — not headless. Hand the operator
> the `wg-quick` commands; verify server-side over SSH.

## 1. Operator generates a keypair

```bash
wg genkey | tee operator.key | wg pubkey > operator.pub   # send the PUBLIC key only
```

## 2. Add the peer to the wireguard role vars

In `infra/ansible/inventories/production/group_vars/all/vars.yml` → `wireguard`:
add the operator's public key + assigned overlay IP (`10.8.0.x`). Private endpoint
keys stay in `vault.sops.yml` (`wireguard_private_keys`).

## 3. Admit the operator's source IP at all three firewalls

The Hetzner firewalls (`fw-hot`/`fw-core`/`fw-obs`) only admit UDP 51820 from
listed `operator_ips`. **Operator IPs are dynamic** — when an operator's egress
IP changes, SSH + WG silently drop at the firewall (infra/CLAUDE.md).

```bash
# add the source IP to operator_ips in infra/terraform/variables.tf (bare, no /32)
set -a; source .env; set +a
export TF_VAR_hcloud_token="$HCLOUD_TOKEN"
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
terraform -chdir=infra/terraform apply       # in-place firewall update, all 3
```

## 4. Re-apply the wireguard role on all three hosts

```bash
cd infra/ansible
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
ansible-playbook playbooks/site.yml --tags wireguard
```

## 5. Operator connects

```bash
sudo wg-quick up ~/code/cross-exchange-arbitrage/wireguard/operator-wg0.conf
```

Then reachable: `http://10.0.1.30:3000` (Grafana), `:8000` (GlitchTip),
`:9090` (Prometheus), SSH to any host over the tunnel. Verify server-side:
`ssh ... 'sudo wg show'`. Tear down after: `sudo wg-quick down ...`.

### UI login credentials

Secrets live in SOPS only — never paste the plaintext into this file or any
commit. Retrieve on demand:

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
cd infra/ansible/inventories/production/group_vars/all
sops -d --extract '["grafana_admin_password"]' vault.sops.yml   # Grafana admin pass
```

| UI | URL | User | Password source |
| --- | --- | --- | --- |
| Grafana | `http://10.0.1.30:3000` | `admin` | vault `grafana_admin_password` (anon disabled) |
| GlitchTip | `http://10.0.1.30:8000` | self-registered | first user signs up via UI; `EMAIL_URL=consolemail://` → verification link in the glitchtip-web container logs |
| Prometheus | `http://10.0.1.30:9090` | — | no auth (private net only) |

## 6. Offboarding

Remove the peer from `wireguard` vars + the source IP from `operator_ips`,
`terraform apply`, re-run the `wireguard` role.
</content>
