# Task 02: Terraform skeleton

## Scope
Lay down the Terraform root config and module scaffolding for `infra/terraform/` (greenfield — none
exists today). Author `versions.tf` (`required_version >= 1.15`, hcloud provider `~> 1.64`),
`backend.tf` (S3 backend against Hetzner Object Storage, `use_lockfile=true` native lockfile, the
`skip_*` compatibility flags, NBG1 endpoint), `variables.tf` (hcloud_token, operator_ips, ssh key ids,
region, sizes), `outputs.tf` (host private IPs, bucket names — consumed by Ansible/Kamal), the root
`main.tf` module-composition shape, and empty `modules/{network,firewall,host}/` scaffolding. No
resources are realized yet beyond what `init` needs.

## Spec References
- [02-provisioning.md §module-layout](../../specs/infrastructure/02-provisioning.md#module-layout)
- [02-provisioning.md §terraform-state-backend-with-native-lockfile](../../specs/infrastructure/02-provisioning.md#terraform-state-backend-with-native-lockfile)
- Gap G9 (native S3 lockfile, no DynamoDB) — [08-gaps-and-decisions.md §g9](../../specs/infrastructure/08-gaps-and-decisions.md#g9)

## Dependencies
- Depends on: Task 01 (tfstate bucket + S3 credentials in env)

## Acceptance Criteria
- [ ] `infra/terraform/` contains `versions.tf`, `backend.tf`, `variables.tf`, `outputs.tf`,
      `main.tf`, and `modules/{network,firewall,host}/` directories.
- [ ] `versions.tf` pins `required_version >= 1.15` and `hcloud ~> 1.64`.
- [ ] `backend.tf` matches the spec: `bucket="arbinet-tfstate"`, NBG1 `endpoints.s3`, `use_lockfile=true`,
      and the four `skip_*` flags; **no DynamoDB**.
- [ ] `variables.tf` declares `hcloud_token`, `operator_ips`, `ssh_key_ids`, region/location, and size
      vars; `outputs.tf` declares placeholders for private IPs + bucket names.
- [ ] `main.tf` composes `network`/`firewall`/`host` modules in shape (no full resource bodies required
      yet — module wiring only).

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `terraform init` succeeds against the **live** `arbinet-tfstate` bucket — print the output; observe
      the S3 backend initialized and a `.tflock` object written during a lock-acquiring op (e.g.
      `terraform plan` then check `aws s3 ls` for `terraform.tfstate.tflock`).
- [ ] `terraform validate` passes — print the "Success! The configuration is valid." line.
- [ ] Exercise the failure path: temporarily unset `AWS_ACCESS_KEY_ID` and run `terraform init`,
      observe the backend auth failure; restore and re-init clean.

## Out of Scope
- Any concrete resource bodies (network CIDRs, firewall rules, host SKUs) — tasks 03–05.
- `terraform apply` / creating cloud resources.
- Provider credential provisioning (task 01).
