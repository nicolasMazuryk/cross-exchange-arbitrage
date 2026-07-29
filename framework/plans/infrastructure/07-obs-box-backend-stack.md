# Task 07: Obs-box backend stack roles

## Scope
Author the `role_obs` backend roles as an Ansible-managed docker-compose stack on the obs box
(`10.0.1.30`, CPX41 amd64): `prometheus` (remote-write receiver, 15 d), `loki` (7 d), `tempo` (72 h),
`pyroscope` (7 d), `alertmanager`, `grafana` (WireGuard-only UI), and `glitchtip` (+ Postgres + Redis,
30 d events). Each role lays down config + a compose service + a data dir under `/mnt/obs-data`. All
backends bind the **private IP** `10.0.1.30` — **no public ports**. This is the standing backend
target both Alloy agents forward to.

## Spec References
- [03-configuration.md §obs-box-backend-roles](../../specs/infrastructure/03-configuration.md#obs-box-backend-roles)
- [05-observability.md §obs-box-backend-stack](../../specs/infrastructure/05-observability.md#obs-box-backend-stack)
- [06-capacity-and-cost.md §obs-box-process-boundaries](../../specs/infrastructure/06-capacity-and-cost.md#obs-box-process-boundaries), [§obs-box-storage-and-retention](../../specs/infrastructure/06-capacity-and-cost.md#obs-box-storage-and-retention)

## Dependencies
- Depends on: Task 06

## Acceptance Criteria
- [ ] One role per backend; each lays down config + compose service + `/mnt/obs-data/<backend>` data dir.
- [ ] Ports/retention match the spec: prometheus `:9090`/15 d, loki `:3100`/7 d, tempo `:4317/4318`/72 h,
      pyroscope `:4040`/7 d, alertmanager `:9093`, grafana `:3000`, glitchtip `:8000`/30 d (+ PG + Redis).
- [ ] Every backend binds `10.0.1.30` only; container memory caps roughly match the obs-box sizing table.
- [ ] Grafana + GlitchTip have **no** public binding (WireGuard-only).

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Apply the obs roles, then from a WireGuard-connected host `curl 10.0.1.30:9090/-/ready`,
      `:3100/ready`, `:3000/api/health`, `:9093/-/ready`, `:8000` each answer — print the responses.
- [ ] From **outside** the private net, `curl <obs-public-ip>:3000` (and `:9090`) **times out / is
      refused** — print the failure; confirms no public exposure.
- [ ] `ls -la /mnt/obs-data` on the obs box shows the per-backend dirs created — print it. Exercise the
      restart edge: `docker compose restart` a backend and confirm it comes back healthy.

## Out of Scope
- Scrape configs, metric catalog, alert/recording rules, dashboards (task 14) — backends only here.
- Core/hot Alloy agents (tasks 09/10).
