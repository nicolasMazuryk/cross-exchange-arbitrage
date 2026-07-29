# Task 13: Kamal deploy execution + edge/TLS + smoke test

## Scope
Execute the deploy live: build the three amd64 images → push to GHCR → `kamal deploy` rolls the
**accessories** (CH, Redpanda) then the **apps** onto the hot/core boxes; kamal-proxy on the core box
obtains the Let's Encrypt cert and terminates TLS (`Internet → 443 → query-api`); run `bootstrap.sql`;
prune images on both boxes. Smoke-test: `/up` green on all apps; `arbinet` db + `migrations` table
exist; the trader **produces `ob.ticks`** (redpanda topic offset grows / consumer-lag metric present);
the HTTPS edge serves query-api with a valid cert. The orderbooks-row-count check stays
**gated/out-of-scope** (needs datapipeline schemas).

## Spec References
- [04-deployment.md §deploy-flow](../../specs/infrastructure/04-deployment.md#deploy-flow), [§edge-and-tls-path](../../specs/infrastructure/04-deployment.md#edge-and-tls-path), [§single-instance-trader](../../specs/infrastructure/04-deployment.md#single-instance-trader)
- [07-runbooks.md §deploy-spans-two-hosts](../../specs/infrastructure/07-runbooks.md#deploy-spans-two-hosts)

## Dependencies
- Depends on: Task 12, Task 08, Task 10

## Acceptance Criteria
- [ ] All three images built `--platform linux/amd64` and pushed to GHCR; `kamal deploy` rolls
      accessories then apps onto hot/core without error.
- [ ] kamal-proxy on the core box obtains a valid LE cert and terminates TLS for query-api; trader has
      no ingress.
- [ ] `bootstrap.sql` ran: `arbinet` db + `migrations` table exist on the core CH.
- [ ] Exactly **one** trader instance on the hot box; images pruned on both boxes after deploy.

## Verification Criteria (observe it working at runtime — live)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] `kamal app details` shows one `trader` (hot) + queryapi/spreadcomputer (core) up — print it;
      confirm exactly one trader instance.
- [ ] `curl https://<domain>/up` returns 200 with a **valid LE cert** (`curl -v` shows the cert chain)
      — print it.
- [ ] On the core box, `redpanda` shows `ob.ticks` messages (topic offset > 0 / `rpk topic consume`)
      — print real offsets; confirm the trader is producing. Exercise the single-instance guarantee:
      attempt a second trader boot and observe stop-before-start prevents two concurrent instances.

## Out of Scope
- The orderbooks row-count check (gated on datapipeline schema migrations).
- App tables/MVs/`fees`, real arbitrage logic (datapipeline).
- The full metric contract / alert rules / dashboards (task 14).
