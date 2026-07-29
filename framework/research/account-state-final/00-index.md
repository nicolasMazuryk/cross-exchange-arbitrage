# 00 — Index

Consolidated best-practices set for reliable, reconciled local account-state management in a CEX–CEX crypto arbitrage system (Node.js/TypeScript, single host, ~15 venues × multiple subaccounts; correctness > latency; **the exchange is the source of truth**). Merged from six source documents with deduplication by meaning; conflicting guidance is resolved in place, with the minority position preserved as an inline "> **Alternative view:**" note.

## The documents

| Doc | One-line scope |
|---|---|
| `01-architecture-and-data-model.md` | Governing axioms and anti-patterns; worker-per-venue topology with SAB seqlock sharing; orchestration/supervision; single-writer actor discipline; the venue adapter layer; canonical events, keys and aggregates; money/numeric discipline; market-type normalization; Node/TS stack; defaults cheat-sheet. |
| `02-connections-and-order-transport.md` | WS-primary/REST-fallback order transport; per-venue WS order-entry landscape; private-stream auth, the snapshot↔stream sync, health, reconnection, gap handling; the full connection FSM (T1–T41); signing and recvWindow; hot-path and socket tuning summaries; REST fallback done properly; rate limits. |
| `03-order-lifecycle-fills-positions.md` | `clientOrderId` discipline; the canonical 12-state order FSM with full transition tables; cancel/fill and amend races; the UNKNOWN Resolver; idempotency/exactly-once; the fill lifecycle; positions, avg-entry, PnL, liquidation distance and liquidation/ADL response. |
| `04-balances-capital-funding-fees.md` | Two-tier balance model; the reservation ledger FSM and reaper; the atomic no-await capital gate and multi-leg all-or-nothing reservation; fees and fee-asset asymmetry; unified-margin accounts; the funding lifecycle FSM. |
| `05-reconciliation-and-invariants.md` | The three reconcile mechanisms; the three-way reconcile; cadence, tolerances and fencing of in-flight operations; the repair policy and drift ladder (including unknown-entity handling); the Reconciliation/Health FSMs and the deployable gate; the consolidated 18-invariant table. |
| `06-persistence-and-recovery.md` | SQLite/WAL engine choice; the intent log and event log; the write-ordering contract (durable intent before send); snapshots and replay determinism; the cold-start sequence; persist-failure fail-closed policy. |
| `07-reliability-breakers-killswitch.md` | Core reliability principles; the unified error taxonomy; **the master failure-mode catalog** (all domain docs cross-reference here); circuit breakers; pre-trade gates and continuous protections; halt scopes and grades; the three kill-switch layers; graceful shutdown; time discipline. |
| `08-observability-testing-venue-notes.md` | Correctness-oriented metrics, SLOs and alerting; operational practices; the testing strategy (simulators, fuzzing, replay, chaos, canaries, shadow mode); the build sequence; the venue-specific notes appendix (re-verify at integration). |

## Recommended reading order

1. **`01`** — the axioms, topology, and data model everything else assumes.
2. **`03` → `04`** — the two money domains (orders/fills/positions, then capital/funding).
3. **`05`** — how truth is enforced (read before `02` so the connection FSM's gates make sense).
4. **`02`** — transport and connection lifecycle in full.
5. **`06` → `07`** — recovery and failure handling (the master catalog will now read as a checklist of things you've already seen the machinery for).
6. **`08`** — how to verify, observe, and sequence the build.

For implementation, follow the build sequence in `08 §4` instead.

## Coverage verification

- All unique practices, FSM specifications (states, transition tables, entry/exit actions), code snippets, diagrams, failure modes, invariants, and venue-specific details from the six sources are mapped into the set above; near-identical duplicate diagrams/tables were merged by meaning. Failure-mode catalogs from all sources are consolidated once in `07 §3`; invariant lists are consolidated once in `05 §8`.
- The instruction to substitute Node.js equivalents for any Rust/C++-specific content was a **no-op**: no Rust/C++-specific content was found in the sources (all sources were already Node.js/TypeScript-oriented; the only native-code mentions — a small `setsockopt` addon, `sodium-native`, simdjson bindings — are Node-ecosystem practices and were retained as such).
- Venue-specific claims (endpoints, limits, channel names, dead-man support, signing rules) are retained verbatim where load-bearing and uniformly flagged **re-verify at integration time**.

## Open questions

Items the sources flag as unresolved, genuinely setup-dependent, or where reasonable positions differ (primary stances are committed in the docs; alternatives noted inline):

1. **Margin-mode mix across the 15 venues** — the sources note this is the single input that most changes the capital design: the split between isolated-margin, cross-margin, and unified/portfolio-margin accounts (and per-venue account modes) determines how much of `04 §1`'s per-asset reservation arithmetic applies versus `04 §5`'s venue-authoritative-headroom approach. Decide per venue before implementing the allocator.
2. **recvWindow band** — committed: 2–5 s default; alternative 1–3 s once clock discipline is proven in production (`02 §10.3`).
3. **HTTP/1.1 keepalive vs HTTP/2 for the REST fallback** — committed: h1.1 pools by default; h2 where measured faster (`02 §13`).
4. **uPnL mark source** — committed: recompute locally from own top-of-book, venue-pushed uPnL as sanity check; alternative venue-mark-driven stance noted (`03 §8.3`). Both agree uPnL never gates capital alone.
5. **Reconcile cadence** — sources span "light checks every few seconds" to "full every 30–60 s"; committed as a tiered table (`05 §3`) with the tightening rule for no-sequence venues. Final numbers are a rate-limit-budget decision per venue.
6. **SQLite `synchronous` scope** — committed: `NORMAL` (WAL) generally, `FULL` for the intent log (`06 §1`). Revisit if measured fsync latency on the chosen hardware makes FULL affordable everywhere.
7. **Adopted unknown orders: cancel or manage?** — the locked stance adopts + halts the scope (`05 §6`); whether adopted orders are then auto-canceled is left config-gated, since the right answer differs for manual-trading coexistence vs fully-automated accounts.
8. **Single-event-loop vs worker-per-venue** — worker-per-venue is committed as primary (`01 §2`); the single-loop actor deployment remains a documented alternative for smaller venue counts or early phases.
