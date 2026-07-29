# Task 16: End-to-end live bring-up & teardown (capstone)

## Scope
From a clean slate, run the full **provision → configure → deploy → observe** sequence on a fresh
ephemeral env (Terraform apply → Ansible site.yml → Kamal deploy → obs targets up), assert the
failure-isolation table (e.g. stop the obs box → hot/core unaffected; stop ClickHouse → trader keeps
running and `ob.ticks` produce drops-on-timeout), then `terraform destroy` and confirm every resource
+ the env is gone. This is the capstone proving the whole chain comes up green from zero and tears down
cleanly; it depends on all prior tasks.

## Spec References
- [01-topology.md §provision--configure--deploy--observe-wiring](../../specs/infrastructure/01-topology.md#provision--configure--deploy--observe-wiring), [§failure-isolation](../../specs/infrastructure/01-topology.md#failure-isolation)
- [07-runbooks.md §host-rebuild-recovery](../../specs/infrastructure/07-runbooks.md#host-rebuild-recovery)

## Dependencies
- Depends on: All (Task 01–15)

## Acceptance Criteria
- [ ] The full chain runs from zero on a fresh ephemeral env: `terraform apply` → `ansible-playbook
      site.yml` → `kamal deploy` → both Alloy agents forwarding, obs targets up — all green.
- [ ] At least one failure-isolation assertion from [01 §failure-isolation](../../specs/infrastructure/01-topology.md#failure-isolation)
      is observed with real values (obs-box-down or CH-down isolation).
- [ ] `terraform destroy` removes all resources; the env is gone; the tfstate bucket is clean.

## Verification Criteria (observe it working at runtime — live)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Run the full sequence from a clean slate and observe it come up green: print `hcloud server list`
      (3 hosts), `kamal app details` (apps up), and obs Prometheus targets `up`.
- [ ] Exercise a failure path live: stop the obs box and observe hot + core keep running (trader still
      produces `ob.ticks`, query-api still serves) — print the observed state; **or** stop ClickHouse and
      observe the trader keeps trading from in-memory state while `ob.ticks` produce drops-on-timeout.
- [ ] `terraform destroy`, then `hcloud server list` returns **empty** and `terraform state list` is
      empty — print both; confirm teardown complete.

## Out of Scope
- Any new infra/app code — this composes and validates prior tasks only.
- Backfilling lost warm data on rebuild (app accepts gaps; datapipeline-owned).
