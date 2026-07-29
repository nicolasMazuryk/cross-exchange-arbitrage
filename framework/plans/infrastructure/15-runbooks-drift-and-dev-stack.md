# Task 15: Runbooks, drift detection & local-dev stack

## Scope
Author the operational runbooks (deploy/rollback, per-alert incident response, volume-expand,
host-rebuild for hot vs core, WireGuard onboarding, scaling-trigger → action map), set up the
**nightly `--check --diff` drift detection** job + drift alert, and reconcile the existing
`docker-compose.dev.yml` to the spec's dev stack (trader/query-api/spread-computer + CH + Redpanda,
single-disk policy, bind mounts, `bootstrap.sql`). Runbooks point at the live throwaway env so the
volume-expand and drift procedures are exercised for real.

## Spec References
- [07-runbooks.md](../../specs/infrastructure/07-runbooks.md) (whole file)
- [06-capacity-and-cost.md §scaling-triggers](../../specs/infrastructure/06-capacity-and-cost.md#scaling-triggers)
- [04-deployment.md §local-development](../../specs/infrastructure/04-deployment.md#local-development)

## Dependencies
- Depends on: Task 13, Task 05

## Acceptance Criteria
- [ ] Runbooks authored for: deploy (2 hosts), rollback, incident-response per alert (every alert in
      [05 §alert-rules](../../specs/infrastructure/05-observability.md#alert-rules) maps to a response),
      volume-expand, host-rebuild (hot vs core), WireGuard onboarding, scaling-trigger → action.
- [ ] Nightly `ansible-playbook site.yml --check --diff` against `env_prod` scheduled + a drift alert
      on any reported change.
- [ ] `docker-compose.dev.yml` reconciled to the spec: trader/query-api/spread-computer + CH(`26.3-lts`)
      + Redpanda(`v26.1`, `--smp 1 --memory 1G`), single-disk `config.dev.d/storage.xml`, bind mounts
      under `./.dev-data`, `bootstrap.sql` runs identically.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Run the nightly drift job against the live env and observe **0 changed** (green) — print the recap;
      then make a deliberate out-of-band change on a host and observe the drift `--check --diff` flags it.
- [ ] Execute the volume-expand runbook end-to-end (Terraform `size` 200 → 400 + `resize2fs`) and observe
      `node_filesystem_size_bytes{mountpoint="/mnt/ch-volume"}` reflect the new size in Grafana — print
      before/after values.
- [ ] `docker compose -f docker-compose.dev.yml up -d` boots the dev stack locally; `curl` the query-api
      `/up` and confirm CH + Redpanda containers healthy — print the status.

## Out of Scope
- The metric contract / alert authoring itself (task 14) — runbooks reference those alerts.
- Capstone end-to-end bring-up + teardown (task 16).
