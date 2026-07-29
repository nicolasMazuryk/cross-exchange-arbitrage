# Task 14: Observability wiring & validation

## Scope
Layer the metric **contract** on top of the standing backends (task 07) and agents (tasks 09/10):
Alloy scrape configs + intervals (hot path 5 s / warm 15 s), the full metric catalog + histogram-bucket
sets, Prometheus **recording rules + SLO burn-rate alerts** (1 h fast-burn / 6 h slow-burn), the alert
rule set (incl. `ob_ticks_*`, `hot_cpu_steal`, the page-now trader alerts), Alertmanager routing
(email/Slack/PagerDuty), trace/exemplar correlation + `trace_id` propagation across the `ob.ticks`
hop, the 5 + 5 dashboards, and the ~5.5 k-series cardinality budget + `cardinality_high` self-alert.
Metric *names* are the app instrumentation contract (datapipeline-owned) — referenced, not authored;
thresholds/scrape/alerts/dashboards are infra and authored here.

## Spec References
- [05-observability.md](../../specs/infrastructure/05-observability.md) (whole file: metric catalog, histogram buckets, SLIs/SLOs, alert rules, dashboards, cardinality budget)
- [06-capacity-and-cost.md §scaling-triggers](../../specs/infrastructure/06-capacity-and-cost.md#scaling-triggers) (alert → action)
- Deferred inputs (drawdown/exposure `<X>`, enum domains) — [05 §open-questions-deferred](../../specs/infrastructure/05-observability.md#open-questions-deferred), recorded in [00-overview](./00-overview.md)

## Dependencies
- Depends on: Task 13, Task 07, Task 09, Task 10

## Acceptance Criteria
- [ ] Alloy scrape intervals: hot-path exporters 5 s, warm services/middleware/host exporters 15 s.
- [ ] Prometheus has the recording rules + SLO burn-rate alerts (1 h/6 h) and the full alert set from
      [05 §alert-rules](../../specs/infrastructure/05-observability.md#alert-rules) incl. `ob_ticks_*`,
      `hot_cpu_steal`, `obs_target_down`, and the page-now trader alerts; histograms use the defined bucket sets.
- [ ] Alertmanager routes by severity to email/Slack/PagerDuty; `trace_id`/`span_id` propagate across the
      `ob.ticks` hop and exemplars + Grafana data links are configured.
- [ ] The 10 dashboards (5 original + 5 new trader) exist; `cardinality_high` self-alert fires at
      `prometheus_tsdb_head_series > 6000`; deferred dollar thresholds left unset and documented.

## Verification Criteria (observe it working at runtime — live)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] In obs Prometheus, hot + core targets are `up` and a representative metric (e.g.
      `ob_ticks_produce_seconds`, `nodejs_eventloop_lag_seconds`) is queryable — print the query results.
- [ ] Fire a synthetic condition (e.g. force an `obs_target_down` by stopping a scrape, or push a test
      series tripping `cardinality_high`) and observe the expected Alertmanager route fire — print the
      alert + routing.
- [ ] Click a metric → trace exemplar → log in Grafana and confirm the cross-signal navigation resolves;
      query `prometheus_tsdb_head_series` and observe it `< 6000` — print the value.

## Out of Scope
- Authoring the app metric *names* (datapipeline instrumentation contract).
- Setting the deferred drawdown/exposure dollar thresholds (business input).
- Runbooks / drift detection / dev stack (task 15).
