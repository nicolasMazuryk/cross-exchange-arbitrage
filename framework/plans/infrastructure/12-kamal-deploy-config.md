# Task 12: Kamal deploy config

## Scope
Author the Kamal `deploy.yml` (no apply yet): the `trader` app → hot box `10.0.1.10` (no
proxy/ingress), `queryapi` → core box `10.0.1.20` (`proxy.ssl: true`, `host` = the real query-api
domain, `app_port 8080`, healthcheck `/up`), `spreadcomputer` → core box; GHCR registry
(`ghcr.io/nicolasmazuryk/...` lowercase image paths, login username case-preserved `nicolasMazuryk`),
`builder.arch: amd64`; **CH + Redpanda accessories** on the core box (private-bound `9092`/`8123`);
single-instance / stop-before-start; and Kamal secrets including host-specific `CH_URL`
(hot → `10.0.1.20:8123`, core → `127.0.0.1:8123`) and `REDPANDA_BROKERS=10.0.1.20:9092`. Pure
authoring — verified via `kamal config` parse, no live deploy.

## Spec References
- [04-deployment.md §kamal-apps-and-accessories](../../specs/infrastructure/04-deployment.md#kamal-apps-and-accessories), [§single-instance-trader](../../specs/infrastructure/04-deployment.md#single-instance-trader), [§secrets](../../specs/infrastructure/04-deployment.md#secrets)
- [03-configuration.md §secrets-management](../../specs/infrastructure/03-configuration.md#secrets-management)
- Gap G7 (GHCR + cred location) — [08-gaps-and-decisions.md §g7](../../specs/infrastructure/08-gaps-and-decisions.md#g7)

## Dependencies
- Depends on: Task 11, Task 01

## Acceptance Criteria
- [ ] `deploy.yml` defines `trader`→`10.0.1.10` (no proxy), `queryapi`→`10.0.1.20` (proxy ssl:true,
      host=domain, app_port 8080, `/up`), `spreadcomputer`→`10.0.1.20`.
- [ ] GHCR registry: server `ghcr.io`, username `nicolasMazuryk` (case-preserved), image paths
      lowercase; `builder.arch: amd64`; **no arm64 anywhere**.
- [ ] CH + Redpanda accessories on the core box, bound `10.0.1.20:8123` / `10.0.1.20:9092`, mounting the
      Ansible-laid config + `/mnt/ch-volume` data dirs.
- [ ] Single-instance / stop-before-start configured for trader (and spread-computer); secrets sourced
      from SOPS, with host-specific `CH_URL` + `REDPANDA_BROKERS=10.0.1.20:9092`.

## Verification Criteria (observe it working at runtime — no live deploy needed)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `kamal config` parses and prints the resolved 2-host plan (trader on hot, queryapi/spreadcomputer
      + accessories on core) — print it and confirm host/port assignments.
- [ ] Confirm secrets resolve from SOPS (e.g. `kamal secrets print` or a dry-run) and that `CH_URL` is
      host-specific — print the resolved env, redacting values.
- [ ] Grep the resolved config for `arm64`/`linux/arm64` and observe **no matches** — print the result.
      Exercise the failure path: introduce a missing `/up` healthcheck on queryapi, observe `kamal config`
      or a deploy dry-run flag the risk, then restore.

## Out of Scope
- Running `kamal deploy` / building+pushing images (task 13).
- App stubs + Dockerfiles (task 11).
