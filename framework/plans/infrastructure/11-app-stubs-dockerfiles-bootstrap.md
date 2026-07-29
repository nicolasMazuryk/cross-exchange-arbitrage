# Task 11: App stubs + Dockerfiles + bootstrap.sql

## Scope
Author **thin app stubs** so deploy + healthchecks are observable end-to-end without real
arbitrage/schema logic (that is the datapipeline workstream). Create minimal entrypoints
(`src/trader.ts`, `src/queryApi.ts`, `src/spreadComputer.ts` → `dist/*.js`): each boots, exposes `/up`
+ `/metrics` (prom text); the **trader additionally produces a dummy `ob.ticks` tick + pings
ClickHouse**; query-api answers `/up`/`/healthz`/`/metrics`; spread-computer consumes/exposes
`/metrics`. Author three multi-stage **amd64-only**, non-root Dockerfiles
(`docker/Dockerfile.trader|queryApi|spreadComputer`). Author `bootstrap.sql` that creates the
`arbinet` db + a `migrations` table **only** — no app tables/MVs/fees. This task is parallelizable
with Pillars 1–2 (no cloud dependency).

**Note:** the `ob.ticks` topic DDL is datapipeline-owned — the stub may need topic auto-create or a
manually-created topic for the produce to land.

## Spec References
- [04-deployment.md §images-to-build](../../specs/infrastructure/04-deployment.md#images-to-build), [§deploy-flow](../../specs/infrastructure/04-deployment.md#deploy-flow) (bootstrap.sql step)
- [04-deployment.md §build-architecture--amd64-only](../../specs/infrastructure/04-deployment.md#build-architecture--amd64-only), [§mandatory-up-healthcheck](../../specs/infrastructure/04-deployment.md#mandatory-up-healthcheck)
- [01-topology.md §the-obticks-warm-path](../../specs/infrastructure/01-topology.md#the-obticks-warm-path)

## Dependencies
- Depends on: None (parallelizable with Pillars 1–2)

## Acceptance Criteria
- [ ] `src/trader.ts`, `src/queryApi.ts`, `src/spreadComputer.ts` build to `dist/*.js`; each boots and
      serves `/up` (healthy) + `/metrics` (valid prom text).
- [ ] trader stub produces one dummy `ob.ticks` tick to Redpanda and pings ClickHouse (logs the result);
      query-api serves `/up`/`/healthz`/`/metrics`; spread-computer serves `/metrics`.
- [ ] Three multi-stage, **amd64-only**, **non-root** Dockerfiles under `docker/`.
- [ ] `bootstrap.sql` creates the `arbinet` database + a `migrations` tracking table only — no app
      tables, MVs, or `fees` seed.

## Verification Criteria (observe it working at runtime — no live cloud needed)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `docker buildx build --platform linux/amd64 -f docker/Dockerfile.trader .` (and queryApi,
      spreadComputer) each build successfully — print the build output; confirm amd64 + non-root user.
- [ ] `docker run` each image, then `curl localhost/up` returns healthy and `/metrics` returns prom
      text — print the responses.
- [ ] Run the trader stub against a local Redpanda + ClickHouse (or the dev compose) and observe the
      log line showing a produced `ob.ticks` tick + a successful CH ping — print it. Exercise the failure
      path: run with CH/Redpanda unreachable and confirm the stub logs the error without crashing the
      `/up` server.

## Out of Scope
- Real arbitrage/spread/schema logic, app tables/MVs/`fees` (datapipeline).
- `ob.ticks` topic DDL / partitioning (datapipeline).
- The Kamal `deploy.yml` (task 12) and the live deploy (task 13).
