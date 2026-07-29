# Prompt — Add a local-dev observability stack with meaningful production parity

## Objective
Set up a local development observability stack — **Prometheus** (metrics), **Loki** (logs), **Tempo** (traces), **Pyroscope** (continuous profiling), and **Grafana** — that runs alongside our existing local dev environment. Two goals:

1. **Meaningful parity** with our Hetzner production observability, so that while developing we can see roughly how things will look and behave in prod.
2. **Make the tools usable by you (the Claude Code agent)** at runtime — so you can inspect metrics, find traces, and pull profiles for code you just ran locally, giving you more context while building and debugging features and bugs.

Keep it meaningful, **not over-engineered**. This is a dev environment: no alerting, no error tracking, no HA, no long retention.

## Ground rules
- Treat `./infra/**` (production infra) as **read-only reference**. Do not modify production configs.
- **Extend the existing local dev setup** (the dev Dockerfile / docker-compose that already brings up the app). Do not create a separate parallel system.
- Mirror production *patterns* — image versions, datasource provisioning, metric/label and trace/span naming conventions, dashboards — but scale everything down for local use.
- Work incrementally; keep diffs reviewable. Explore and plan before editing.
- If anything **beyond Docker Compose** is required (app instrumentation, SDK dependencies, env vars, host ports, privileged containers / eBPF for profiling, kernel settings, make targets, etc.), surface it explicitly and tell me.

## Phase 0 — Discover first, then pause
Before changing anything:
- Read `./infra/**` and inventory the **production** observability stack: which components exist, exact images/versions, scrape configs, retention, datasource provisioning, dashboards, log shipping (Promtail / Grafana Alloy / Docker log driver) and Loki label conventions, any collector/agent (OTel Collector, Grafana Alloy, etc.), and how the app is instrumented (SDKs, OTLP endpoints, env vars, metric/label/span naming, log format).
- Read the existing **dev** Dockerfile and docker-compose to understand current services, networks, ports, volumes, env, and how the app starts.
- Produce a short written summary: (a) what prod runs, (b) the proposed dev stack and where/why it diverges from prod, (c) anything needed beyond Docker Compose.
- **Pause for my confirmation** before implementing if the plan involves nontrivial app-code changes or architectural decisions.

## In scope
- **Prometheus** scraping the local app and the observability components; short retention (e.g. a few hours to 1–2 days); single instance.
- **Loki** receiving logs from the local app and (optionally) the dev containers, shipped the same way prod does it (Promtail / Alloy / Docker log driver); short retention; single instance. Match prod's Loki label conventions so queries look the same.
- **Tempo** receiving traces via OTLP from the app; minimal local storage backend.
- **Pyroscope** receiving continuous profiles from the app. (I dictated "Gyroscope" — I mean Grafana Pyroscope.)
- **Grafana** with provisioned datasources (Prometheus, Loki, Tempo, Pyroscope) and provisioned dashboards — reuse/port prod dashboards where feasible — plus correlation across signals (exemplars, trace-to-logs, trace-to-metrics, trace-to-profiles, logs-to-trace) if prod uses it.
- A **collector/agent** matching prod's approach (OTel Collector or Alloy) if prod uses one; otherwise direct SDK→backend.
- Whatever **app instrumentation** is needed so the local app actually emits metrics, logs, traces, and profiles to this stack (confirm what exists or add it). Ensure logs carry the trace/span IDs so trace↔log correlation works.

## Out of scope (keep it lean)
- No Alertmanager / alerting rules. No GlitchTip or error tracking. No `remote_write`, no HA/replication, no production-grade persistence, no long retention. Keep resource usage modest so the whole thing runs comfortably on a laptop.

## Make it usable by the coding agent (important)
Set things up so you — and future agent sessions — can actually use these tools to debug:
- Expose the query APIs on **documented, stable localhost ports**: Prometheus HTTP API, Loki query API, Tempo query API, Pyroscope query API, Grafana API.
- Write an **`OBSERVABILITY.md`** documenting endpoints/ports and copy-pasteable example queries: PromQL against the Prometheus API, LogQL against the Loki API (and via `logcli` if available), TraceQL / trace-by-ID lookups against Tempo, profile/flame-graph queries against Pyroscope, and how to find the trace ID for a request just made and pivot from it to the matching logs.
- Provide a **small helper** (script or make targets) for common agent workflows: generate load / hit an endpoint, then fetch the resulting metrics, logs, traces, and profile for that operation.
- **Access method — prefer CLI and curl, not MCP.** Do not set up MCP servers. The agent should query everything via shell commands the way a developer would: native CLIs where they exist (`logcli` for Loki, `promtool` for Prometheus, `curl` against each component's HTTP API for Tempo/Pyroscope/Grafana, `docker compose logs` as a fallback). Document the exact commands in `OBSERVABILITY.md` so any agent session can copy-paste them — base URLs, auth (if any), and a working example per tool.

## End-to-end verification (must pass)
Bring the full stack up with the existing single command (e.g. `docker compose up` or the existing make target) and verify, ideally via a script:
- All services healthy (healthchecks / `depends_on` wired correctly).
- A test request through the app produces: a metric visible via the Prometheus API, a log line visible in Loki (queryable by `logcli`/curl and carrying the request's trace ID), a trace visible in Tempo, and a profile visible in Pyroscope.
- Grafana datasources report healthy and dashboards render with live data; correlation links work if configured.
- Document the verification steps and include the checklist in `OBSERVABILITY.md`.

## Deliverables
- Updated dev `docker-compose` (and Dockerfile if needed) bringing up app + observability together with one command.
- Config files: prometheus, loki (+ log shipping: promtail/alloy/docker log driver as prod does), tempo, pyroscope, grafana provisioning (datasources + dashboards), collector/agent config if used.
- Any app instrumentation changes plus required env vars, documented.
- `OBSERVABILITY.md`: architecture, ports/endpoints, the CLI/curl commands the agent uses to query each tool (PromQL, LogQL, TraceQL, profiles), parity notes vs prod, and the verification checklist.
- **`CLAUDE.md` update:** add a brief section noting that the local observability stack (Prometheus, Loki, Tempo, Pyroscope, Grafana) is available during development, that the agent should use the CLI/curl commands rather than MCP to query it, and a link to `OBSERVABILITY.md` for full details, endpoints, and example queries — so the agent discovers and explores it on its own. Keep this short; `OBSERVABILITY.md` holds the detail.
- A verification script.
- A clear list of anything required beyond Docker Compose.

## Working style
Explore → summarize prod + propose parity plan → confirm if needed → implement incrementally → verify end-to-end → document. Call out tradeoffs and where dev intentionally diverges from prod.