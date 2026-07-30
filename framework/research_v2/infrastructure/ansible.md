# ANSIBLE

The hetzner.hcloud Ansible collection (now at v6.7+) for cloud resources and dynamic inventory, Terraform for provisioning, cloud-init as the bridge between them, Ansible roles structured around a single set of playbooks.


1. Core foundation: the right Ansible itself

Pin versions in a requirements.yml and (ideally) install them inside an Execution Environment container:

# requirements.yml
collections:
  - name: hetzner.hcloud
    version: ">=6.0.0,<7.0.0"
  - name: community.general
  - name: community.crypto
  - name: community.sops
  - name: ansible.posix

Non-negotiables:

FQCN everywhere (ansible.builtin.apt, not apt). Short names are deprecated in spirit and a frequent source of subtle collection-shadowing bugs.
ansible-lint with the production profile, run on every commit.
YAML mode for inventories, not INI — it composes cleanly with dynamic inventory.



Official Hetzner Ansible Collection:

 https://docs.ansible.com/projects/ansible/latest/collections/hetzner/hcloud/index.html


Current major versions require Python 3.10+ on the controller.

Install:

```ansible-galaxy collection install hetzner.hcloud```


Dynamic Inventory Plugin:

https://docs.ansible.com/projects/ansible/latest/collections/hetzner/hcloud/hcloud_inventory.html



You'll touch it in a distinct way:

As a dynamic inventory plugin — always. This is the killer feature. Configure once and Ansible asks the Hetzner API for the current fleet every run:

# inventory/hcloud.yml
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

The pattern that ties everything together is labels driving groups. In Terraform you set labels = { role = "web", env = "prod", stack = "api" } on each hcloud_server; the inventory plugin turns those into role_web, env_prod, etc., which your playbooks target directly. New server with the right labels = it joins the right groups automatically with zero inventory editing.


3. The Terraform ↔ Ansible handoff

Pattern A — Labels + dynamic inventory (recommended). Terraform creates the server with cloud-init for the absolute minimum bootstrap, sets labels, and exits. Ansible discovers the server via the hcloud inventory plugin and configures it. The two tools never call each other directly.

For the cloud-init bootstrap (Pattern A), keep it minimal and idempotent — its jobs (beside other) are:
- Create a non-root ansible user with sudo and your public key.
- Disable root SSH password login.
- Install Python 3 (so Ansible can connect) and qemu-guest-agent.

Everything else — package installs, app config, hardening — belongs in Ansible, not cloud-init. The line is: cloud-init makes the box reachable; Ansible makes it useful.


4. Project layout
The layout that has stabilized as best practice:

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
├── roles/                          # your roles (one responsibility each)
│   ├── common/
│   ├── hardening/
│   ├── docker/
│   └── app_web/
├── collections/                    # vendored third-party roles
└── molecule/                       # per-role tests live under each role


Key conventions:

group_vars/all/vars.yml for non-secret defaults; vault.sops.yml for secrets, decrypted transparently at runtime.
One role = one responsibility. A docker role installs Docker. An app_web role deploys your web app on top. Don't blend them.
defaults/main.yml sets sane defaults that work everywhere; vars/main.yml is for things you don't want users to override.
Tags on every play (tags: [hardening, ssh]), so you can do --tags ssh to iterate quickly during ops.



5. Baseline server hardening
This is what every Hetzner box should get from Ansible immediately after cloud-init, regardless of what app runs on it. The community consensus stack:

- SSH hardening: key-only auth, PermitRootLogin no, disable password auth, AllowUsers allowlist, modern ciphers/KEX, ClientAliveInterval. Drop a complete file in /etc/ssh/sshd_config.d/.
- Firewall: ufw (Debian/Ubuntu, simplest) or nftables (more powerful). The Hetzner Cloud Firewall, configured via Terraform, is your outer layer; UFW is your inner layer. Use both. Mind the Docker/iptables gotcha — Docker inserts rules ahead of UFW; either use ufw-docker or bind containers to 127.0.0.1 and front them with a reverse proxy.
- Automatic security patches: unattended-upgrades on Debian/Ubuntu.
- Intrusion prevention: fail2ban is still the default
- Time sync: chrony.
- Kernel hardening: sysctl tweaks (net.ipv4.tcp_syncookies, disable source routing, ICMP redirect protections, etc.).
- Audit/integrity: auditd for logging.

Use battle-tested ones:

- devsec.hardening — the gold-standard CIS-aligned collection covering OS, SSH, MySQL, Nginx, etc.
- konstruktoid.hardening — actively maintained systemd-era hardening with strong defaults.
- geerlingguy.* — Jeff Geerling's collection covers Docker, Nginx, PostgreSQL, security, etc. and is what most people learn from.

Add only what's strictly needed and override their defaults via group_vars.


6. Secrets management

ansible-vault — built in. 

Always use no_log: true on tasks that touch secrets so they don't leak into output.


10. Operational practices that separate good from great

A few things experienced Ansible operators do that aren't obvious from docs:

- Idempotency is the contract. Every run must be safe to repeat. If a task isn't idempotent, mark it so or wrap it in creates:/removes:/changed_when:. The signal --check shows "0 changed" on a no-op run is your green light to ship.
- One-command bootstrap. make bootstrap/task bootstrap should be all a new engineer runs: it installs, pulls collections, decrypts vaults, and is ready to go.
- Drift detection. Schedule a daily --check --diff run in AWX against production and alert on any drift. Drift means someone SSH'd in and made a manual change, which is what you're trying to eliminate.

11. The full picture, end to end

A complete modern flow looks like this: Terraform reads its variables, creates servers with cloud-init user data that does only the bare bootstrap, and tags each one with labels. Terraform exits. Ansible — uses the hetzner.hcloud.hcloud inventory plugin to discover the fleet, groups it by labels, and runs site.yml. That playbook applies common → hardening → role-specific layers, with secrets pulled from vault files at runtime. Drift detection runs nightly. When you add a new web server, you bump a count in Terraform, terraform apply, and the next Ansible run finds and configures it without you touching the inventory.

The one single decision that pay off the most: commit to labels-driven dynamic inventory from day one (don't start with static inventory "until you need it").