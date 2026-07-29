# Task 10: Hot-box roles (lean)

## Scope
Author the two lean `role_hot` roles (kept minimal so the 2 dedicated cores serve the trader):
`chrony` (same tight clock-sync config as core — 1 Hz wall-clock-aligned tick emission needs it) and a
**lean** `alloy` role plus `node_exporter`: scrape the trader `:9464` + node_exporter `:9100` on
loopback, receive OTLP (`:4317/4318`) and Pyroscope (`:4040`) from the trader SDK, tail the trader
container's stdout logs, and forward all signals to the obs box (`10.0.1.30`). No clickhouse-exporter,
no Redpanda scrape here. The trader itself is Kamal-deployed; Ansible only preps chrony + Alloy.
Completes the configuration pillar.

## Spec References
- [03-configuration.md §hot-box-configuration-role_hot](../../specs/infrastructure/03-configuration.md#hot-box-configuration-role_hot), [§alloy-role-hot-lean](../../specs/infrastructure/03-configuration.md#alloy-role-hot-lean)
- [01-topology.md §loopback-vs-private-bindings](../../specs/infrastructure/01-topology.md#loopback-vs-private-bindings)
- [05-observability.md §host-node_exporter-9100--on-all-three-hosts](../../specs/infrastructure/05-observability.md#host-node_exporter-9100--on-all-three-hosts) (hot CPU steal ≈ 0)

## Dependencies
- Depends on: Task 06, Task 07

## Acceptance Criteria
- [ ] `chrony` role applied to hot (same config as core).
- [ ] Lean `alloy` role: scrapes trader `:9464` + node_exporter `:9100` (loopback), receives
      OTLP/Pyroscope, tails trader logs, forwards to `10.0.1.30`. **No** clickhouse-exporter / Redpanda scrape.
- [ ] `node_exporter` installed on hot, answering `127.0.0.1:9100`.
- [ ] Hot box stays lean — only chrony + alloy + node_exporter added on top of baseline + wireguard.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Apply the hot roles; `systemctl status alloy` up on the hot box; in obs Prometheus the hot
      `node` target shows `up == 1` (Alloy forwarding) — print the query result.
- [ ] Query `rate(node_cpu_seconds_total{mode="steal",host="hot"}[5m])` in Prometheus and observe it
      ≈ 0 (dedicated cores, no steal) — print the value.
- [ ] Exercise the no-trader-yet edge: confirm the trader `:9464` scrape target is `down` (trader not
      deployed until task 13) while node/host targets are `up` — print both. **Configuration pillar done.**

## Out of Scope
- The trader container (Kamal, task 13).
- Core/obs roles (tasks 07–09).
- Metric contract / alerts / dashboards (task 14).
