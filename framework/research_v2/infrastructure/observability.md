
## Instrumentation

* OpenTelemetry

## Metrics

* Prometheus
* Alertmanager
* Grafana

- ??? VictoriaMetrics ??? (Metrics, Traces, Logs)

## Logs

* Loki
* Vector (https://vector.dev/) or Fluent Bit
* Grafana


## Traces

* OpenTelemetry SDKs
* OpenTelemetry Collector
* Tempo

- W3C TraceContext

## Profiles (Continuous Profiling)

What They Solve
* CPU hotspots
* Memory leaks
* Lock contention
* Performance regressions


* Grafana Pyroscope
* Parca (eBPF is the key enabling technology)


## Events & Errors

Alerting
* Prometheus Alertmanager

Error Tracking
* Sentry

Incident routing
* Grafana OnCall


## Dashboards

* Grafana

## Collection Pipeline

* OpenTelemetry Collector

or the newer Grafana Alloy as the unified collector

## Node Metrics

* node_exporter

## eBPF Observability

* Parca

===================

- [ ] Prompt: Build Modern Production Architecture based on the observability stack above



##### Biggest Mistakes Teams Make

1. Overusing Logs

Logs are expensive noise.

Modern priority: Metrics → Traces → Profiles → Logs

3. Skipping Trace Correlation

If logs aren’t correlated with traces:

* debugging becomes archaeology

Always inject:

* trace_id
* span_id

Into logs.



###### The Two Meta-Principles That Tie It Together
Cross-signal correlation is everything. The stack's ROI is in navigation: metric anomaly → find the offending trace exemplar → jump to the correlated logs for that trace_id → open the flame graph for that span. This is only possible if trace_id and span_id flow through every signal. OpenTelemetry exemplars (trace IDs embedded in Prometheus histograms) and Grafana's data link system make this click-through navigation real.

SLOs, not just alerts. Modern teams define SLIs (error rate, latency P99) and SLO burn-rate alerts (Prometheus recording rules + Alertmanager, or Datadog SLOs, or Nobl9). A burn-rate alert fires when you're consuming your error budget too fast — this is almost always more actionable than a raw threshold alert, and dramatically reduces alert fatigue. 