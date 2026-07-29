# Task 09: Core-box app-support + telemetry roles

## Scope
Author the remaining `role_core` roles: `spread-computer` (env/config prep + `/metrics` on
`127.0.0.1`), `kamal_proxy` (ACME/Let's Encrypt config dir + `/up` health-gate routing config the
proxy container consumes), and the full `alloy` collector (scrape query-api/spread-computer/node/
clickhouse/redpanda exporters on loopback, tail container logs, receive OTLP/Pyroscope, forward to the
obs box) — which also installs `node_exporter` (`:9100`) and `clickhouse-exporter` (`:9116`). Ansible
preps config; Kamal runs spread-computer and kamal-proxy as workloads later.

## Spec References
- [03-configuration.md §spread-computer-role](../../specs/infrastructure/03-configuration.md#spread-computer-role), [§alloy-role-core-collector](../../specs/infrastructure/03-configuration.md#alloy-role-core-collector), [§kamal_proxy-role](../../specs/infrastructure/03-configuration.md#kamal_proxy-role)
- [05-observability.md §signal-flow-over-the-private-network](../../specs/infrastructure/05-observability.md#signal-flow-over-the-private-network)

## Dependencies
- Depends on: Task 06, Task 07

## Acceptance Criteria
- [ ] `spread-computer` role lays env/config + binds `/metrics` to `127.0.0.1` (scraped by local Alloy);
      no app logic (datapipeline-owned).
- [ ] `kamal_proxy` role lays the ACME/LE config dir + `/up` health-gate routing config; cert on the
      core box (off the hot cores).
- [ ] `alloy` (core) role scrapes query-api `:8080`, spread-computer, node_exporter `:9100`,
      clickhouse-exporter `:9116`, redpanda `:9644` on loopback; tails logs; receives OTLP/Pyroscope;
      forwards metrics/logs/traces/profiles to `10.0.1.30`.
- [ ] `node_exporter` + `clickhouse-exporter` installed and answering on loopback.

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Apply the roles; on the core box `systemctl status alloy` shows it up and `curl 127.0.0.1:9100/metrics`
      + `127.0.0.1:9116/metrics` answer — print samples.
- [ ] In the obs Prometheus, query `up{job=~"node|clickhouse"}` for the core host and observe target
      `up == 1` (Alloy is **forwarding to 10.0.1.30**) — print the query result.
- [ ] Exercise a failure path: stop `node_exporter`, observe the core target flip to `up == 0` in
      Prometheus, then restart and confirm recovery — print both states.

## Out of Scope
- The chrony/clickhouse/redpanda config roles (task 08).
- Running spread-computer / kamal-proxy containers (tasks 12–13).
- Alert/recording rules, dashboards, scrape intervals/metric contract (task 14).
