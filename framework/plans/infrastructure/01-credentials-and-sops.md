# Task 01: Credentials, accounts & SOPS prerequisites

## Scope
Gather and record (assume supplied at exec time) every credential and account fact the rest of the
build consumes, then stand up the secrets toolchain. This covers: the Hetzner Cloud API token, the
Hetzner Object-Storage access/secret keys, a GHCR PAT (`read:packages`/`write:packages`), the
query-api domain (replaces the `api.arbinet.example` placeholder), the operator source IP set, and
the operator ed25519 SSH key (private key at `~/.ssh/nicolas`, never in repo/state). Stand up
SOPS/age and the `vault.sops.yml` layout, and **manually bootstrap the `arbinet-tfstate` bucket** —
a chicken-and-egg: the Terraform S3 backend (task 02) cannot create the bucket that holds its own
state. This is the foundation every other task assumes.

## Spec References
- [02-provisioning.md §terraform-state-backend-with-native-lockfile](../../specs/infrastructure/02-provisioning.md#terraform-state-backend-with-native-lockfile)
- [02-provisioning.md §concrete-resource-table](../../specs/infrastructure/02-provisioning.md#concrete-resource-table) (ssh key, buckets)
- [03-configuration.md §secrets-management](../../specs/infrastructure/03-configuration.md#secrets-management)
- [04-deployment.md §build-and-deploy-no-ci](../../specs/infrastructure/04-deployment.md#build-and-deploy-no-ci), [04 §secrets](../../specs/infrastructure/04-deployment.md#secrets)
- Gaps G7 (registry/cred location), G10 (cold tier sole copy), G11 (operator IPs) — [08-gaps-and-decisions.md](../../specs/infrastructure/08-gaps-and-decisions.md)

## Dependencies
- Depends on: None

## Acceptance Criteria
- [ ] All credentials enumerated and recorded in the agreed secret store (not the repo): `hcloud_token`,
      `S3_ACCESS_KEY`/`S3_SECRET_KEY` (Hetzner OS), GHCR PAT, query-api domain, `operator_ips`,
      operator ed25519 public key. Private key confirmed present at `~/.ssh/nicolas` only.
- [ ] SOPS + age installed and configured; `.sops.yaml` creation-rules defined; a `vault.sops.yml`
      layout drafted matching the keys in [03 §secrets-management](../../specs/infrastructure/03-configuration.md#secrets-management)
      (CH user/pass, S3 keys, hcloud token, WG private keys, kamal-proxy ACME, GlitchTip secrets).
- [ ] The `arbinet-tfstate` bucket exists in Hetzner Object Storage (NBG1, `nbg1.your-objectstorage.com`),
      manually created (out-of-band, not by Terraform). `arbinet-cold` creation deferred to Terraform (task 05).
- [ ] No secret value committed to the repo or written to Terraform state.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `hcloud server list` (or `hcloud datacenter list`) authenticates with the token and returns a
      real response — print it; confirms the Hetzner token is valid.
- [ ] `aws --endpoint-url https://nbg1.your-objectstorage.com s3 ls` lists buckets and shows
      `arbinet-tfstate` present — print the listing.
- [ ] `sops -e` then `sops -d` round-trips a throwaway test secret (`echo`-piped), printing the
      decrypted value back identical to the input. Exercise the failure path: attempt `sops -d` with
      no/ wrong age key and observe the expected decryption error.

## Out of Scope
- Any Terraform/Ansible/Kamal code (later tasks).
- Provisioning `arbinet-cold` (Terraform, task 05) or any host resource.
- Populating real production secret values beyond what the build needs to proceed.
