# CLAUDE.md — ArbiNet Infrastructure

Scope: Hetzner Cloud infra (`provision → configure → deploy → observe`, 16 tasks in `framework/plans/infrastructure/`, specs `framework/specs/infrastructure/`). Separate from trading app (root `CLAUDE.md`).

**Topology (3 boxes, private net `prod-vpc` `10.0.0.0/16`, NBG1):**
- `hot` (CCX13 dedicated, `10.0.1.10`) = trader app only, no ingress/Volume/Redpanda.
- `core` (cpx62, 16c/32GB, `10.0.1.20`, 200 GB Volume) = ClickHouse + Redpanda + query-api + spread-computer + kamal-proxy (only public edge, TLS→query-api).
- `obs` (cpx42, 8c/16GB, `10.0.1.30`, 40 GB Volume) = observability backends (Prometheus/Loki/Tempo/Pyroscope/Alertmanager/Grafana/GlitchTip), no public ports.

Each box = host module + role firewall (`fw_hot`/`fw_core`/`fw_obs`). `core`/`obs` x2-gen (prior-gen `cpx51`/`cpx41` EOL — see Gotchas). Detail: `01-topology.md`.

## Tooling

- **Terraform** (S3 backend → `arbinet-tfstate`), **Ansible** (config, `community.sops`), **Kamal** (deploy). **SOPS + age** secrets. **`hcloud`** CLI; **`aws`** CLI = S3 client for Hetzner Object Storage.
- **Terraform `>= 1.15`** (`versions.tf`); brew may be older → `brew upgrade hashicorp/tap/terraform`. Native S3 lockfile (`use_lockfile=true`, no DynamoDB); `plan` printing "Releasing state lock" = lock OK.
- Creds in repo-root `.env` (gitignored): `HCLOUD_TOKEN`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`. TF: map `HCLOUD_TOKEN` → `TF_VAR_hcloud_token`. (`S3_*` naming rationale → Gotchas.)

## Terraform commands

From repo root (creds + `-chdir`; see Gotchas re cwd):

```bash
set -a; source .env; set +a            # raw HCLOUD_TOKEN, S3_ACCESS_KEY/S3_SECRET_KEY
export TF_VAR_hcloud_token="$HCLOUD_TOKEN"                                        # provider token
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"  # S3 tfstate backend
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform plan
terraform -chdir=infra/terraform apply
```

## Ansible commands

From `infra/ansible/` (the `ansible.cfg` dir) — `community.sops.sops` lookups **cwd-relative** (token path anchored `inventories/production/...`). Always `export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt`. First WG-install run = public inventory `bootstrap.hcloud.yml`; later runs = private `hcloud.yml` (WireGuard-only). Collections: `ansible-galaxy collection install -r requirements.yml`.

Per-box playbooks under `playbooks/`, orchestrated by `site.yml` in order: `baseline` → `wireguard` → `obs.yml` (obs backends) → `core.yml` (data middleware) → `hot.yml` (lean Alloy/node_exporter). Run one layer with its tag (e.g. `--tags hot`) or whole fleet via `site.yml`.

## Secrets (SOPS + age)

- Tooling `sops`, `age` (`brew install sops age`).
- age key `~/.config/sops/age/keys.txt` (0600, never committed). Single recipient in repo-root `.sops.yaml`. Public recipient: `age1yvj9rn0k6tjhn3rt6dpq2yklnwqtv3usmd307mdq24afkzdz8ywstrsung`.
- Encrypted stores under `infra/ansible/inventories/production/`:
  - `group_vars/all/vault.sops.yml` — consolidated vault (CH user/pass, S3 keys, hcloud token mirror, GHCR PAT, WireGuard keys, kamal-proxy ACME, GlitchTip + grafana secrets). Real values only for current build; rest placeholder.
  - `secrets/hcloud_token.sops.yml` — standalone; decrypted by `hetzner.hcloud` inventory plugin **before** group_vars load → must be own file.
- Decrypt: `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops -d <file>`.
- Secret **values** live only in SOPS — never in repo/TF state: `hcloud_token`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `ghcr_pat`.

## Credential register (non-secret facts)

| Fact | Value |
| --- | --- |
| Operator SSH key (ed25519) | private `~/.ssh/nicolas` (local only); pubkey `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIljEw49E8vw0nrc6zzdsooLDFAsE5HSs/AxMspZiY5 nicolasmazuryk@gmail.com` |
| query-api domain | `api.arbinet.xyz` (replaces `api.arbinet.example`). Zone `arbinet.xyz` TF-managed (`hcloud_zone`, `dns.tf`), apex A + www CNAME; NS delegated from GoDaddy |
| Operator source IPs | `OPERATOR_IP` (firewall allow-set; operator IP is dynamic — update `operator_ips` default in `infra/terraform/variables.tf` + `terraform apply` when it changes) |
| GHCR username | `nicolasMazuryk` |
| GHCR image path | `ghcr.io/nicolasmazuryk/...` |
| GHCR PAT scopes | `read:packages`, `write:packages` (vault `ghcr_pat`) |

## Terraform state bucket (bootstrapped out-of-band)

`arbinet-tfstate` — Hetzner Object Storage, NBG1. Manual create (S3 backend can't create own state bucket). `arbinet-cold` IS TF-managed (task 05, `aws_s3_bucket.cold` via aliased `aws` provider).

```bash
export AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY> AWS_SECRET_ACCESS_KEY=<S3_SECRET_KEY>
aws --endpoint-url https://nbg1.your-objectstorage.com --region nbg1 \
    s3api create-bucket --bucket arbinet-tfstate --create-bucket-configuration LocationConstraint=nbg1
```

## Gotchas

- **Terraform: run from repo root** — bash cwd persists between calls → later relative `source .env`/`cd` fails silently → blank `AWS_*` → `403 InvalidAccessKeyId`. Always `set -a; source .env; set +a` then `terraform -chdir=infra/terraform <cmd>`.
- **`source .env` does NOT map creds — export them.** `.env` has raw `HCLOUD_TOKEN` + `S3_ACCESS_KEY`/`S3_SECRET_KEY`; TF needs `TF_VAR_hcloud_token` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (recipe above) or `403 InvalidAccessKeyId`. **Keep `S3_*` names** (CH cold-disk, Parquet export, Ansible vault all read `S3_ACCESS_KEY`; they double as tfstate `AWS_*`) — don't rename.
- **Child TF modules need own `required_providers`** → leaf using `hcloud_*` without it resolves to `hashicorp/hcloud` (nonexistent) → `validate` "Missing required provider". Root `versions.tf` does NOT propagate; add per module.
- **Hetzner Object Storage region = location code** (`nbg1`/`fsn1`/`hel1`), NOT AWS regions → `eu-central-1` errors `LocationConstraintConflict`. Endpoint `https://nbg1.your-objectstorage.com`; create `--region nbg1 --create-bucket-configuration LocationConstraint=nbg1`. Buckets ARE TF-manageable via aliased `aws` provider + `aws_s3_bucket`.
- **Hetzner prior-gen SKUs EOL, not flagged** — `cpx41`/`cpx51` fail at *apply* ("Server Type ... unavailable in nbg1 and can no longer be ordered") yet `hcloud server-type describe` shows `deprecation: None`. Use x2-gen: core `cpx51→cpx62`, obs `cpx41→cpx42`; hot `ccx13` still orderable. Match cores+mem to a `*2`-suffixed name.
- **Hetzner DNS lives in root-level TF (`dns.tf`), not a module** — `hcloud_zone`/`hcloud_zone_rrset` GA since provider v1.56. **GoDaddy NS validator rejects `.de` nameservers** even when they resolve → delegate `arbinet.xyz` with the 2 `.com` Hetzner NS only (`hydrogen`/`oxygen.ns.hetzner.com`); ≥2 sufficient.
- **App images amd64-only** (all 3 prod boxes amd64 — arm64→amd64 = exec-format error). On Apple Silicon: `docker buildx build --platform linux/amd64 --load`; `FromPlatformFlagConstDisallowed` lint warning is intentional.
- **`bootstrap.sql` multi-statement → needs `clickhouse-client --multiquery`**, not CH HTTP `/` endpoint (rejects `Multi-statements are not allowed`).
- **Canonical pipeline env names = `REDPANDA_BROKERS` / `CH_URL`** (deploy spec), legacy `KAFKA_BROKERS`/`CLICKHOUSE_URL` as fallback. Thin/prod entrypoints must NOT import `src/utils/logger.ts` — it `readFileSync`s YAML config at import and **throws** without one; use config-free logger (`src/stubs/stubLogger.ts`).

## Kamal gotchas

- **Host ruby 2.6 too old → dockerized kamal. Tag is `v2.11.0`, NOT `2.11`** (latter 404s). Parse-check: `docker run --rm -e VERSION=x -v "$PWD:/workdir" -w /workdir ghcr.io/basecamp/kamal:v2.11.0 config`.
- **Don't prefix `image:` with registry server.** Kamal prepends `registry.server` → `ghcr.io/ghcr.io/ns/x`. Use bare `image: nicolasmazuryk/arbinet-trader`.
- **Custom role names require top-level `primary_role:`** — no default `web` → "primary_role web isn't defined".
- **`kamal.sh` mounts ONLY the operator key, not all `~/.ssh`** (wrapper has host docker socket → whole keyring = leak). Runs as host uid (`--user`), copies just `~/.ssh/nicolas` (600) + seeded `known_hosts` into per-run `$HOME`, age key read-only at `SOPS_AGE_KEY_FILE`. net-ssh (pure-ruby) enforces key-owner==uid. Image tag = `Dockerfile.kamal` content hash → edit forces rebuild.
- **Dockerized kamal needs the `x25519` gem** — hardened prod sshd offers only `curve25519-sha256`/`dh-group16`; net-ssh ships neither → "could not settle on kex algorithm". `Dockerfile.kamal` installs `x25519` (+ `ed25519`/`bcrypt_pbkdf`).
- **`builder.dockerfile` + `builder.context` required** — Dockerfile isn't at repo root; without them kamal errors "Missing Dockerfile". Use `context: .` + `dockerfile: docker/Dockerfile.trader`.
- **In-wrapper buildx needs dynamic `--group-add`.** In-container `docker buildx` hits `permission denied /var/run/docker.sock` as non-root host uid. Fix: `kamal.sh` resolves socket gid (`stat -c %g`), passes `--group-add <gid>`. Supplementary groups change `getgroups()`, not `getuid()`, so SSH key-owner check holds. gid `0` on Docker Desktop, real docker gid on Linux; non-numeric → fallback `0`.
- **GHCR push needs `write:packages`** — `docker login` SUCCEEDS on any valid token but push fails `denied: ... token does not match expected scopes` if vault `ghcr_pat` lacks write. Fix: classic PAT w/ `write:packages`; `sops set <vault> '["ghcr_pat"]' '"ghp_..."'`.
- **`kamal deploy` does NOT boot accessories** — boot CH/Redpanda first via `kamal accessory boot all` (apps crashloop on missing CH/Redpanda). Reconfigure+restart: `kamal accessory reboot <name>`.
- **Every role gets kamal-proxy unless `proxy: false`** — no-ingress `trader` sets `proxy: false` (Kamal 2 routes all roles by default; routeless leftover proxy may linger on hot box — remove it).
- **Spec-pinned accessory tags don't exist on registry:** use `clickhouse/clickhouse-server:26.3` (no `-lts`) and `redpandadata/redpanda:v26.1.9` (no rolling `v26.1`). Verify `docker manifest inspect <ref>` before deploy.
- **Redpanda config lives in `/etc/redpanda` (mount as a DIR) + `rpc_server` required.** Dir mount: rpk rewrites `redpanda.yaml` via atomic temp+rename, fails on file bind-mount ("device or resource busy"); `rpc_server` mandatory or boot aborts. Production/fsync: `--mode dev-container` BANNED (silently adds `--unsafe-bypass-fsync`); dropping `--mode` doesn't help — fresh config defaults to dev mode → rpk injects bypass from `developer_mode:true` (check real cmdline in `docker logs`). Fix: redpanda role seeds `/etc/redpanda/redpanda.yaml` `developer_mode: false` (`force:false`). Sizing/listeners on `cmd`; cluster props via immutable `/etc/redpanda/.bootstrap.yaml`. Migrating a dev-container box: `rm` stale `redpanda.yaml`. Boot fails Volume self-check → `--check=false`.
- **ClickHouse storage is 2-tier, not 3** — core has one durable Volume (`/var/lib/clickhouse`, holds built-in `default` disk); a second on-Volume "warm" disk just churns parts between identical storage. Policy `tiered` = `main(default)` → `cold(s3)`; S3 = only physically separate tier.
- **`kamal.sh` lives at `infra/kamal/kamal.sh`** (not repo root) and tags the image by **git HEAD short-SHA** while building from the **worktree** → commit before deploy or the image ships uncommitted code under a misleading tag. `deploy --roles=trader` targets only the hot box (pre-deploy single-instance hook fires); env-only changes still rebuild+retag but layer-cache makes it cheap. Benign noise during deploy: `fatal: not a git repository` (kamal probing git in the mounted worktree) + SSH `post-quantum` warnings — every step still exits 0.
- **Single-instance `trader` is NOT auto-enforced by kamal** — plain `kamal deploy`/`app boot` is rolling (boot-new→wait-healthy→stop-old), runs 2 traders for ~6.5s. Enforced via `.kamal/hooks/pre-deploy` + `kamal.sh` guard that `docker rm -f` the trader before boot (brief downtime accepted, never overlap — spec 04). The hook shells out to openssh `ssh`, which **FATALS under a host uid with no passwd entry** (`No user exists for uid <n>`, exit 255). Fix in `kamal.sh`: append host uid to image's `/etc/passwd` (bind-mount read-only) so `getpwuid()` resolves.

## Ansible gotchas

- **Don't set `collections_path` in `ansible.cfg`** — overrides default search path, hides brew-bundled `community.general`/`ansible.posix` → `ansible-lint` "couldn't resolve module".
- **`ansible-lint --profile production` must pass** (run from `infra/ansible/`); `exclude_paths` `*.sops.yml` + `secrets/`. Traps: task `name:` with colon-space breaks unquoted YAML scalar → quote it; `var-naming[no-role-prefix]` → stack-wide shared vars go in `group_vars`, not role `defaults/`; `import_playbook` needs `name:`; use `ansible_facts['x']` not `ansible_x`.
- **hetzner.hcloud `hostvars_prefix` applies BEFORE construct** → `keyed_groups`/`compose` use prefixed names: `hcloud_labels.role`, private IP `hcloud_private_ipv4` (not `private_net[0].ip`), public `hcloud_ipv4`. Plugin only loads files ending `hcloud.yml/yaml` (bootstrap = `bootstrap.hcloud.yml`).
- **apt/sshd tasks need `until`/`retries`** on fresh boxes — cloud-init `unattended-upgrades` holds dpkg lock, openssh postinst regenerates host keys (→ `sshd -t` non-zero mid-run).
- **WG dial-in (`wg-quick up`) needs local interactive sudo** — not headless; hand operator the commands, verify server-side over SSH (`sudo wg show`). Operator WG tunnel reaches prod private net (`10.0.1.0/24`), needed for `hcloud.yml`-inventory applies. Up/down recipe in root `CLAUDE.md`.
- **Docker registry "latest semver" can lie** — `grafana/tempo:3.0.0` exists but config schema rejects `compactor`, crashloops. Real Tempo = 2.x (`2.10.5`). Highest semver ≠ right product; boot + check health.
- **Container-managed bind-mount dirs drift → non-idempotent.** `postgres:*-alpine` chowns data dir to `uid 70 / 0700`, `redis:*-alpine` to `uid 999 / 0750`, every start. An `ansible.builtin.file` setting owner/mode resets them each run (`changed=1` forever). Pre-set dir to container's exact owner/group/mode; verify via restart then `stat`.
- **Verify a templated SOPS secret without leaking it.** `no_log: true` on the template task; confirm on-box with a *count* not a cat: `sudo grep -c CHANGE_ME <file>` → 0 = placeholder gone. Add-key headless: `sops set <vault> '["key"]' '"value"'`.
- **Single-file bind-mount + atomic template rewrite = stale config in the container.** Ansible `template` writes temp+rename → new inode; a single-FILE docker bind-mount stays pinned to the original inode, so `/-/reload` reads the OLD file forever (Prometheus/Alertmanager both hit this). Mount the config DIRECTORY (`config/<svc>:/etc/<svc>/config:ro`) so renames are visible. A container only picks up a single-file change on RECREATE — which compose does only when the *fragment* changes, not when the mounted file's bytes change.
- **Handlers flush after the `roles` block but BEFORE `post_tasks`.** So a "reload after compose up" handler fires before the post_tasks compose-up runs (and a failed handler aborts the play before post_tasks). Put the reload (Prometheus/Alertmanager `POST /-/reload`, `changed_when: false`, retries) as a `post_task` AFTER the compose-up, not a handler. Prometheus needs `--web.enable-lifecycle` for `/-/reload` (else 403).
- **`--tags <role>` skips the reload/compose_up post_tasks** (obs.yml: those are tagged `[obs, reload]`/`[obs, compose_up]`, NOT the role name). So `ansible-playbook playbooks/obs.yml --tags prometheus` templates new rules to disk but Prometheus keeps the OLD rules in memory. Add `,reload` to the tag set or `curl -XPOST 10.0.1.30:9090/-/reload` by hand; verify the live rule via `/api/v1/rules` (check the `query` field, not just that the file changed).
- **Operator IP is dynamic — firewall `operator_ips` pins one.** When the operator's egress IP changes, SSH + WireGuard (UDP 51820) silently drop at the hcloud firewall: the local WG route exists (`route -n get 10.0.1.30` shows utun) but no packets pass and all 3 boxes time out on :22. Fix: update `operator_ips` default in `infra/terraform/variables.tf` + `terraform apply` (in-place firewall update). Source IPs are stored bare (no `/32`).
- **`ansible-playbook --check` is NOT clean-`0` by default — classify before trusting drift.** `template` tasks ARE check-accurate (a `changed` = real content drift, repo↔host). But `get_url` reports a permanent false `changed` under `--check` (it would re-fetch to compare) → pin `checksum: "sha256:..."` (also a supply-chain pin; recompute on rotation). `service: state=started`/`enabled` can also false-`changed` in check mode (real apply shows `ok`). So a non-zero drift count is a MIX of real drift (templates) + check-mode noise (get_url/service) — investigate the `--diff`, don't assume drift.
- **Nightly drift detection = `roles/drift_detection` on obs** (task 15): pushes the `ansible/` tree to `/opt/arbinet/ansible`, runs a pinned dockerized ansible `site.yml --check --diff` against `env_prod`, writes `arbinet_drift.prom` (node_exporter textfile) → `drift.rules.yml` (`drift_detected`/`drift_check_stale`/`drift_check_failed`) → Slack. Manual run: `ssh obs 'sudo /opt/arbinet/drift-check.sh'`; full `--diff` in `/var/log/arbinet-drift.log`. Drift SSH key authorized fleet-wide by `baseline`; age key delivered to obs (residual exposure, see `infra/runbooks/host-rebuild.md`).
- **`synchronize` push: use `{{ playbook_dir | dirname }}/` not `{{ playbook_dir }}/../`** (rsync chokes on the literal `..` `change_dir`), and do NOT `delegate_to` for a control→remote push.
- **`changed_when: "'CHANGED' in <reg>.stdout"` matches `UNCHANGED`** (substring) → task reports changed every run. Print a non-overlapping token (`NOCHANGE`), or compare `stdout_lines | last`.
- **`docker compose run` with a 0600-root `env_file` needs root** — non-root `docker compose run` fails `open ...env: permission denied`. Runs fine under ansible `become: true`; reproduce by hand with `sudo`.
- **`sudo rm -rf <dir>/*` on a 0700-root dir wipes nothing** — the glob expands in the non-root shell (can't list the dir) → passes the literal `*`. Use `sudo sh -c 'rm -rf <dir>/* <dir>/.[!.]*'` so root expands it.
- **GlitchTip (6.x) provisioning facts.** `web` does NOT auto-migrate (every request `UndefinedTable` against an empty DB); add a one-shot `migrate` service (`./manage.py migrate --noinput`, `restart:"no"`) and gate web/worker on it via `service_completed_successfully`. No env-based superuser — provision via `manage.py shell -c` in a one-off `docker compose run --rm` (email is `USERNAME_FIELD`). Org model path = `apps.organizations_ext.models` (`Organization`/`OrganizationUser`/`OrganizationOwner`); `org.add_user(user, OrganizationUserRole.OWNER)` auto-creates the `OrganizationOwner` for the first user (roles enum MEMBER=0…OWNER=3). Provision post_task in `playbooks/obs.yml`, tag `glitchtip_provision`; admin password vaulted (`glitchtip_admin_password`).
- **Verify GlitchTip login over the real auth path.** `_allauth/browser/v1/auth/login` needs a CSRF flow: GET `/_allauth/browser/v1/auth/session` for the `csrftoken` cookie, then POST with `X-CSRFToken:` + `Referer:` headers (bare POST → 403 CSRF, NOT a creds failure). The CSRF-exempt `app` client (`_allauth/app/...`) is 404 (not enabled). Success = 200 + `meta.is_authenticated: true`.
- **A narrow `--tags X` skips a role's `main.yml`, so facts set there are UNDEFINED for tasks that consume them.** Running `--tags glitchtip_provision` alone skipped the `set_fact` that loads the admin password → the provision snippet got an empty `-e GT_ADMIN_PASSWORD=` and `set_password('')` WIPED the login. Make a tag-selectable task self-contained (load its own secrets via SOPS in its own tasks file) and `assert` the secret is non-empty before any destructive write. Run a stack-up-dependent provisioning step as a post_task via `import_role: {name, tasks_from}` (role `files/`/`defaults` stay in scope; `main.yml` does NOT run).

## Telemetry / Alloy

- **CH has TWO users with different reach.** `default` (users.d/default-user.xml) = loopback-only (`::1`/`127.0.0.1`), NO password → loopback clients (query-api/spread-computer via `127.0.0.1:8123`) work passwordless. `arbinet` (users.d/arbinet.xml, `networks ::/0`, password = vault `ch_arbinet_password`, user = vault `ch_arbinet_user`="arbinet") is the ONLY networked user. The trader hits CH over the private net (`10.0.1.20:8123`) → MUST set `CH_USER=arbinet` + `CH_PASSWORD`; `CH_USER=default` fails `REQUIRED_PASSWORD` (code 194) even with a password.
- **ClickHouse metrics = native endpoint, NOT an exporter.** `clickhouse_exporter` ships zero releases; others abandoned. Use CH first-party `<prometheus><port>9363</port><metrics/><events/><asynchronous_metrics/></prometheus>` config.d fragment; Alloy scrapes `127.0.0.1:9363`, job=clickhouse.
- **Grafana Alloy = official apt repo (deb822), single systemd unit `alloy`.** GPG `https://apt.grafana.com/gpg.key` → `/etc/apt/keyrings/grafana.asc`. Config `/etc/alloy/config.alloy` via `CONFIG_FILE` in `/etc/default/alloy`. Add `alloy` user to `docker` group for log-tail socket.
- **node_exporter on Ubuntu = `prometheus-node-exporter` apt pkg**, same-named unit; bind loopback via `ARGS="--web.listen-address=127.0.0.1:9100"` in `/etc/default/prometheus-node-exporter`.
- **Core metrics reach Prometheus ONLY via Alloy remote-write** (`scrape_configs: []` except the obs box's own self-scrape: `job=prometheus` + `job=node` w/ `host=obs`, task 14). End-to-end: `curl -sG 10.0.1.30:9090/api/v1/query --data-urlencode 'query=up{job=~"trader|query-api|spread-computer|node|clickhouse|redpanda"}'`. Disambiguate per box with `host="hot"`/`host="core"`/`host="obs"`. Wait ~35s after target up/down. Hot/core targets are remote-written, so they DON'T appear in Prometheus `/api/v1/targets` — verify the 5s vs 15s scrape cadence via sample spacing instead: `count_over_time(node_load1{host="hot"}[60s])` ≈ 12 (5s), core/obs ≈ 4 (15s).
- **Alloy `scrape_timeout` MUST be ≤ `scrape_interval`** — default timeout is 10s, so the hot box's 5s interval makes Alloy refuse to build the scrape config (`scrape_timeout (10s) greater than scrape_interval (5s)`, systemd unit dies exit 1, silent metric blackout). Set `alloy_scrape_timeout` per box (hot **4s** = strict headroom under the 5s interval, core 10s under 15s) in group_vars; `config.alloy.j2` emits it. An apply-time `assert` in the alloy role (`timeout <= interval`) now turns that runtime crash into a pre-flight failure. Real loopback scrape durations are tiny (node ~150ms, redpanda 11k samples in 45ms), so timeouts are about clean failure semantics, not slow scrapes. obs Prometheus static jobs set `scrape_timeout: 10s` explicitly (was the implicit 10s default).
- **Obs box self-metrics = containerized node-exporter** (`obs_node_exporter` role, compose fragment on the `obs` network, no host port). The obs box runs no host Alloy/apt node_exporter, so without this its host metrics + `prometheus_tsdb_head_series` (read by `cardinality_high`) are uncollected. Prometheus self-scrapes it by service name `node-exporter:9100`.
- **TSDB cardinality pruned at the Alloy scrape edge (was ~20.4k, now ~7.2k apps-down).** The spec's ~5.5k budget never held — native endpoints emit far more. Three scrape-edge cuts (all in Alloy/node_exporter config, no app/backend change): (1) **redpanda** scrapes `/public_metrics` not `/metrics` — verbose `/metrics` carries only `vectorized_*` (~11.5k series); the curated `/public_metrics` is ~2k AND is the *only* endpoint emitting the `redpanda_*` names the `ob_ticks_lag`/`ingest_lag` alerts query, so this doubles as a bug fix. Set via per-target `metrics_path` in `alloy_scrape_targets` (group_vars). (2) **node_exporter** `--no-collector.systemd` (`node_exporter_disabled_collectors`) drops `node_systemd_unit_state` (~2.1k across 3 hosts; Debian enables systemd by default, upstream doesn't). (3) **ClickHouse** drop-list: per-target `drop_metrics` regex emits a `prometheus.relabel` before remote_write (Alloy has no inline `metric_relabel_configs`), dropping `ClickHouseProfileEvents_.*` (~1.2k). Drop-list NOT keep-list — survives the unsettled `ClickHouse*`/`clickhouse_*` name contract without starving new panels. `cardinality_high` re-baselined 6000 → **12500** = ceil(apps-up ~9.4k × 1.30). NOTE: `prometheus_tsdb_head_series` gauge lags ~2h after a prune (stale series GC on head truncation); measure the real floor with `count({__name__!=""})` (5-min staleness), not the gauge.

- **Before trusting an alert, confirm its metric actually exists.** Native exporters use unexpected name families: CH emits `ClickHouseProfileEvents_*`/`ClickHouseMetrics_*`/`ClickHouseAsynchronousMetrics_*`/`ClickHouseHistogramMetrics_*` (NOT `clickhouse_*`), redpanda `vectorized_*` on `/metrics` vs `redpanda_*` on `/public_metrics`. Rules referencing `clickhouse_query_duration_seconds`/`clickhouse_parts_active` match **nothing** today (datapipeline name contract unsettled). Gate any "alert verified" on `count({__name__=~"<name>"})>0`.

## Verification

Infra tasks: **CLI/observation only, no mcp-debugger**. "I ran X, observed Y." e.g. `hcloud server list` (token), `aws --endpoint-url ... s3 ls` (bucket), sops encrypt→decrypt round-trip + wrong-key failure.
- SSH host: `ssh -i ~/.ssh/nicolas ansible@<public_ipv4>` (cloud-init ready ~15s post-create). `hcloud server list` columns use `type` (not `server_type`).
- **Prove single-instance trader live:** detached sampler on hot — `nohup sh -c 'for i in $(seq 1 400); do printf "%s %s\n" "$(date +%s.%N)" "$(docker ps -q --filter label=role=trader --filter status=running | wc -l)"; sleep 0.2; done' >/tmp/s.log 2>/dev/null &` — run deploy/boot, then assert `max(count)==1` and sequence `1→0→1`, never `2`.
- **Health-check a `proxy:false` role (trader) via the container IP, not a published port.** No proxy → no port mapping, slim image has no `wget`/`curl`/`ss`. Resolve `IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' arbinet-trader-<v>)` then `curl http://$IP:8081/up` from the host (over WG). Trader serves `/up` 8081, `/metrics` 9464.
- **Validate Prometheus rules / Alertmanager config offline** (before any apply): render the `.j2` with ansible's bundled python (`$(head -1 $(which ansible-playbook)|sed 's/^#!//')` — system `python3` lacks `jinja2`/`yaml`), then `docker run --rm --entrypoint promtool prom/prometheus:v3.12.0 check rules /cfg/*.yml` and `--entrypoint amtool prom/alertmanager:v0.32.1 check-config /cfg/alertmanager.yml`. The images' default entrypoint is the **server** binary → must override `--entrypoint`. Read live AM runtime config via `:9093/api/v2/status` (`.config.original`); firing→receiver via `:9093/api/v2/alerts`. Grafana API needs the vault admin pass (anon disabled): `curl http://admin:$PW@10.0.1.30:3000/api/...`.
