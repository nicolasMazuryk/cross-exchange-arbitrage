# Building a Reliable Inventory Rebalancing Engine for CEX-CEX Arbitrage

This is an opinionated blueprint based on what actually survives contact with production: venues that lie by omission, acks that never arrive, deposits credited under a different ID than the withdrawal that produced them, and a trading engine that will happily spend a balance you thought you'd reserved. The organizing principle throughout: **your local database is a journal of intents and observations, never a source of truth about money.** The venue ledger and the chain are truth; your job is to converge on them safely and to never let the strategy layer see a fiction.

---

## 1. Sources of truth & state model

There are exactly three classes of data, and conflating them is the root cause of most desync bugs:

**Intents** — what you decided and asked for. A withdrawal intent, a transfer intent. Written locally *before* any side effect, immutable once created (status changes are appended events, the intent row's identity fields never change). Includes your client-generated idempotency key.

**Observations** — what venues and chains told you. Withdrawal records from `GET /withdrawHistory`, deposit records, transfer records, balance snapshots, on-chain confirmations. Append-only. You never edit an observation; if the venue's story changes, you append a new observation. This gives you a forensic trail when (not if) a venue's status sequence goes backwards.

**Derived state** — the movement FSM state, the ledger balances, the "available capital" view the strategy reads. Always recomputable from intents + observations. If you can't rebuild derived state by replaying the journal, your model is wrong.

Concretely on a single host with Node/TypeScript: **PostgreSQL**, full stop. Not Redis as primary state, not flat files, and SQLite only if you commit to a strictly single-process design. You want serializable or at least `READ COMMITTED` + explicit row locks (`SELECT ... FOR UPDATE`) for reservation, advisory locks for per-corridor mutual exclusion, `LISTEN/NOTIFY` as your in-host event bus, and transactional outbox semantics. `synchronous_commit = on`, fsync on — a treasury engine is the one place you never trade durability for latency.

Model balances as **double-entry ledger accounts** keyed `(venue, account_id, wallet_type, asset)`, plus *virtual* in-flight accounts per corridor, e.g. `in_flight:binance.sub3.spot→okx.main.funding:USDT`. Every movement is a balanced set of postings. Double-entry isn't ceremony — it's what makes "where is every dollar" a query instead of an investigation, and it makes double-counting structurally impossible: an asset is in exactly one account, and "in transit" is an account.

## 2. Movement lifecycle & FSM

Two distinct FSMs, because their failure surfaces differ enormously.

**On-chain withdrawal/deposit (one movement, two venues, one chain):**

```
DECIDED → RESERVED → SUBMITTING → SUBMIT_AMBIGUOUS?
        → ACCEPTED (venue withdrawal id obtained)
        → PROCESSING (venue internal review/queue)
        → BROADCAST (txid known)
        → CONFIRMING (n/N on chain)
        → DEPOSIT_DETECTED (destination venue sees it)
        → CREDITED (destination venue credits balance)
        → SWEPT (moved to the trading wallet that needs it)
        → SETTLED → RECONCILED
```

Failure/ambiguity branches off nearly every state: `REJECTED` (before broadcast — funds return to source, reverse the reservation), `CANCELLED`, `STUCK` (exceeded per-state SLA → alert + corridor freeze), `AMBIGUOUS` (submitted, no ack — see §3), `ORPHAN_CREDIT` (deposit appeared with no matching intent — recon catches this), `SHORT_CREDIT` (credited amount ≠ expected minus known fees). `STUCK` is a first-class state, not an alert label: withdrawals genuinely sit in venue manual review for hours, and your capital accounting must represent that honestly.

**Internal transfer FSM** is shorter (`RESERVED → SUBMITTED → CONFIRMED | AMBIGUOUS | FAILED → RECONCILED`) but the ambiguity window is nastier in practice because transfers are frequent, fast, and venues sometimes return success while crediting with a 1–5s delay — long enough for a strategy tick to see phantom or missing balance. Confirm internal transfers by **observed balance delta or transfer-history query**, not by HTTP 200.

Critical rule: a movement is `SETTLED` only when the destination credit is *observed*, not inferred. `RECONCILED` means a later recon pass matched intent ↔ source venue record ↔ chain tx ↔ destination venue record ↔ ledger postings, end to end.

## 3. Idempotency & exactly-once semantics

Exactly-once doesn't exist on the wire. What you build is: **at-most-once side effects via client IDs, at-least-once delivery via retries, deduplication via reconcile-before-retry.**

Generate the idempotency key locally (UUIDv7 — sortable is convenient) and persist it in the intent *before* the first network call. Pass it as the venue's client ID wherever supported: `withdrawOrderId` on Binance, `clientId` on OKX withdrawals/transfers, `transferId` on Bybit (which OKX/Bybit will actively dedupe). Verify each venue's actual behavior — some store the client ID but don't dedupe on it, which downgrades it from a safety mechanism to a lookup key. Both are useful; only one prevents double-spends by itself.

The iron rule for the ambiguous case (timeout, 5xx, connection reset after request was sent): **never blind-retry a money movement.** Transition to `SUBMIT_AMBIGUOUS` and resolve by querying — by client ID if the venue supports lookup-by-client-id, otherwise by scanning recent withdrawal/transfer history for a record matching (asset, amount, address, time window). Only after a definitive "not found" across a window comfortably exceeding the venue's ingestion lag (use 60s+, not 5s) may you retry — *with the same client ID* where dedupe is real, with a new intent where it isn't and you've proven absence.

Locally, use the **transactional outbox**: one DB transaction writes the intent, the reservation postings, and an outbox row; a dispatcher picks up the outbox row and makes the API call. The side effect is thus never attempted without a durable record that it was about to be attempted — which is exactly what crash recovery needs.

## 4. Event & status-stream reliability

Treat WebSocket user-data streams (Binance balance/withdrawal events, OKX account channel, Bybit wallet stream) as a **latency optimization, never the system of record**. The authoritative loop is REST polling: withdrawal history, deposit history, transfer history, balances — on a cadence per movement state (an `ACCEPTED` withdrawal polls every 10–15s; a `CONFIRMING` one every 30s; idle corridors every few minutes).

The pattern is snapshot-then-stream with self-healing: on WS connect, take a REST snapshot; apply WS events on top; on any gap, reconnect, or heartbeat miss, drop back to snapshot. Every WS event is just an *observation* appended to the journal and fed to the FSM — so a missed event costs you seconds of latency (next poll catches it), never correctness. Across 15 venues, WS quality varies wildly; some don't push withdrawal-status events at all. Design as if WS doesn't exist, then add it where it's good.

For deposit detection you can optionally run your own chain watcher (an indexer or RPC provider per major chain) to see the inbound tx before the venue credits it — useful for tightening the "expected arrival" window and earlier stuck-detection — but the venue's credit event is what moves the FSM to `CREDITED`. The chain telling you the tx confirmed is not the same as the venue giving you the money.

## 5. Reconciliation

Three layers, all continuous, because recon is your only defense against the bugs you didn't anticipate:

**Movement-level recon**: every record in every venue's withdrawal/deposit/transfer history must map to a local intent, and every non-terminal intent must map to a venue record (or be young enough not to). Orphan venue records (movement you don't remember making) are a *sev-1*: either your journal lost data, a human moved funds manually, or your API keys are compromised. Freeze and page.

**Balance recon**: per `(venue, account, wallet_type, asset)`, poll the venue balance and compare against ledger expectation (`settled + pending credits − reservations`). Tolerance bands per asset (dust, funding payments, fee rebates create noise on trading wallets — recon funding wallets to zero tolerance, trading wallets to a small band, and let the trading engine's own recon explain its wallets). Divergence beyond band → freeze the affected accounts for *new* movements while continuing to track in-flight ones.

**Full periodic recon**: a slower job (every 15–60 min) that recomputes derived state from the journal and diffs it against the live derived tables. Catches code bugs in incremental updates.

The cultural rule that matters: **divergence halts the corridor automatically and a human closes the ticket.** Auto-"fixing" the ledger to match the venue without understanding why is how small bugs become silent capital leaks.

## 6. In-flight capital accounting

Reserve at **decision time, before submission**, in the same transaction as the intent: debit `available@source`, credit `in_flight@corridor`, including the *expected* withdrawal fee. On settlement, debit in-flight, credit `available@destination` with the actual received amount, and post the fee true-up to a fee-expense account. The asset is therefore spendable in exactly zero places while moving — by construction, not by convention.

The strategy layer reads exactly one view: `tradeable(venue, wallet, asset) = observed venue balance − active reservations − safety buffer`, served with a monotonic sequence number so the strategy can detect staleness and refuse to size against an old snapshot. The buffer absorbs the things you can't model precisely (pending funding payments, fee accrual, the 1–5s internal-transfer crediting lag).

Reservation contention is real on a shared-capital system: two arb opportunities and a rebalance can race for the same balance in the same millisecond. Resolve it in the database — `SELECT ... FOR UPDATE` on the balance row, check-and-reserve atomically — not in application memory. Single host makes this cheap; use it.

One subtlety: the *trading engine's* own order placement must go through the same reservation layer for the wallets it shares with rebalancing, or you've only solved half the double-spend problem. Either the treasury service owns reservations for everyone, or you partition capital so trading and treasury never touch the same wallet concurrently. The first is more capital-efficient; the second is simpler and is a respectable v1.

## 7. Rebalancing decision logic

Don't rebalance reactively per opportunity — you'll thrash. The planner maintains **target inventory vectors** per `(venue, wallet_type, asset)` derived from strategy demand (recent fill distribution, open opportunity forecast, margin requirements for perp legs), and acts on deviations with **hysteresis**: trigger when deviation exceeds an upper band, rebalance back to target (not to the lower band), and enforce a minimum inter-movement cooldown per corridor.

Each candidate movement gets a cost model: `withdrawal fee + expected slippage of any required conversion + (transit time × opportunity cost of immobile capital) + a risk premium for the corridor's recent reliability`. Compare across all viable routes — including multi-hop ones (e.g., a stablecoin swap on the source venue then a cheaper chain). Enforce a minimum movement size so fees stay under a bounded percentage (e.g., never pay >5bps in fixed fees).

**Net before you move**: many internal transfers and even some on-chain corridors cancel each other out if you plan over a horizon of minutes instead of executing each deficit independently. The planner should produce a netted batch of movements per planning tick, not a stream of point decisions.

Cap concurrent in-flight notional globally and per corridor — in-flight capital is at-risk capital (venue freezes, chain halts), and the cap is your blast-radius control.

## 8. Chain & network specifics

Maintain a **capability matrix**, refreshed from venue currency/network endpoints every few minutes and on every movement failure: per `(venue, asset, network)` — deposit enabled, withdrawal enabled, min/max amounts, fee (these change with chain congestion), amount precision, confirmation count the venue requires for crediting, contract address, memo-required flag. A movement is only plannable on a network *both* sides currently support with matching contract addresses — the same-ticker-different-token trap (multiple bridged variants of a stablecoin, multiple chains with the same symbol) is a real loss vector; match on contract address, never on symbol.

Memo/tag chains (XRP, XLM, TON, ATOM, EOS) deserve paranoid treatment: missing or wrong memo means a funds-recovery support ticket measured in days-to-weeks. Validate memo presence in code at intent creation, again at submission, and prefer avoiding memo chains entirely when an alternative network is within ~2× cost.

Network selection: sort viable networks by `fee + transit_time × time_value`, where transit time = venue processing latency (track your own empirical P50/P95 per corridor — venue-published numbers are fiction) + block time × max(source payout batching, destination confirmation requirement). Keep per-corridor latency histograms; they feed both routing and stuck-detection SLAs.

Address whitelisting is an operational constraint to design around: several venues impose 24h holds on newly added addresses or require API withdrawals to go only to whitelisted addresses. Pre-whitelist the full corridor matrix during onboarding and monitor whitelist validity as part of recon — a silently expired whitelist entry turns into a rejected withdrawal at the worst time.

## 9. Sub-account & wallet-type transfer mechanics

Model each venue's transfer capabilities as a **directed graph** of `(account, wallet_type)` nodes with edges annotated by required API key, endpoint, rate limit, and observed crediting latency. Route with multi-hop pathfinding, because real moves are often `sub.spot → master.spot → master.funding → on-chain withdraw`. Venue realities to encode rather than fight:

- **Binance**: universal transfer with enumerated type pairs (SPOT↔UMFUTURE, SPOT↔CMFUTURE, etc.); master↔sub and sub↔sub transfers execute via the *master* key; sub-account withdrawal generally means moving to master first.
- **OKX**: the funding account is the hub — deposits land there, withdrawals leave from there; trading↔funding and master↔sub transfers each have their own paths and the unified trading account changes which balances are even transferable.
- **Bybit**: unified trading account internal transfers vs. universal (cross-sub) transfers are distinct endpoints with distinct semantics and dedupe behavior.

Treat the transfer-type enums and hub topologies as *data* (per-venue adapter config), not code branches, or 15 venues will rot your codebase. And again: an internal transfer is `CONFIRMED` when transfer history or balance delta shows it, not when the HTTP call returns — the seconds-scale crediting lag is exactly where the strategy double-spends if you're sloppy.

## 10. Crash recovery & persistence

The invariant that makes recovery tractable: **no side effect without a prior durable intent** (the outbox guarantees this). Recovery is then a single deterministic procedure on startup:

1. Load every movement in a non-terminal state.
2. For each, run the **ambiguity resolution** for its state: `SUBMITTING/SUBMIT_AMBIGUOUS` → query by client ID / scan history; `ACCEPTED..CONFIRMING` → poll venue + chain status; `DEPOSIT_DETECTED` → poll destination crediting; outbox rows never dispatched → resolve as ambiguous-submit (you don't know if the process died before or after the HTTP call).
3. Resume FSMs. Do not accept new planner decisions until the recovery scan completes and the balance view is rebuilt and recon-checked.

This means crash recovery and ambiguity handling are *the same code path* — which is the design goal, because it's the path you can test. And test it brutally: a harness that `kill -9`s the process at every FSM state (and mid-API-call, via a fault-injecting HTTP layer) and asserts post-recovery invariants (no duplicate submission, no lost reservation, ledger balanced) is the highest-ROI test suite in this entire system.

Single host means the DB host is the system. WAL archiving + continuous backup off-host (pgBackRest or even WAL-G to object storage). Your intents journal is the only thing that can't be reconstructed from venues — protect it accordingly.

## 11. FSM implementation

Hand-roll it; don't reach for XState here. What you need is a *persisted* state machine, and the persistence design is the whole game:

- A `movements` table with current state, and a `movement_events` table appending every transition: `(movement_id, seq, from_state, to_state, cause, evidence_ref, created_at)` — where `evidence_ref` points at the observation that justified the transition. Every state change is explainable after the fact.
- Transitions are validated against a static transition table (illegal transition = bug = throw and alert, never coerce).
- **Transition and its effects are split**: the transition commits in a DB transaction (with any ledger postings), effects (API calls, notifications) go through the outbox. Effects are retryable; transitions are facts.
- Timeouts are first-class: every state has a max dwell time, enforced by the scheduler, escalating to `STUCK` + alert rather than silently waiting forever.
- Make transitions idempotent on evidence: processing the same venue observation twice (which polling guarantees will happen) must be a no-op.

## 12. Circuit breakers & protections

Layered, each with an explicit trip condition and a *manual* reset (auto-reset breakers just oscillate):

- **Per-corridor**: N consecutive failures, any movement stuck beyond SLA, or movement-level recon mismatch → no new movements on that corridor; in-flight ones keep being tracked.
- **Per-venue**: balance recon divergence, repeated API auth/permission errors, venue-announced maintenance → freeze venue for treasury ops, notify strategy layer to stop assuming replenishment.
- **Global**: in-flight notional cap, daily on-chain withdrawal cap, max single-movement size with a manual-approval tier above it (a Slack-approve flow for anything over X is cheap insurance against planner bugs).
- **Anomaly tripwires**: withdrawal fee quoted vs. historical > 3×, destination credit short by more than fee tolerance, orphan movements, whitelist failures.
- A **kill switch** that halts all new movements while keeping watchers, recon, and FSM tracking alive — never a switch that blinds you to in-flight money.

Rate-limit budgeting deserves a mention as a protection: status polling for dozens of in-flight movements plus recon plus the trading engine share venue API budgets. A central per-venue token bucket with priority classes (ambiguity resolution > status polls > recon) prevents your own recon from starving the call that resolves a stuck withdrawal.

## 13. Failure modes & error handling

The catalogue worth designing for explicitly, each mapped to an FSM branch + severity + automated-vs-manual resolution:

- **Ambiguous submit** (timeout/5xx/reset) → §3 procedure. Most common, fully automated.
- **Accepted then rejected** by venue review → reverse reservation, alert, planner may re-route via another network.
- **Stuck in venue processing** (manual review, hot wallet empty, batching) → `STUCK`, corridor latency stats updated, escalate by age.
- **Venue suspends withdrawals/deposits mid-flight** → in-flight movement keeps tracking; corridor frozen for new ones via capability matrix refresh.
- **Short credit / fee surprise** → true-up posting within tolerance, alert beyond it.
- **Orphan credit** (deposit with no intent) → quarantine the funds in a holding ledger account, sev-1.
- **Memo lost / wrong network deposit** → manual workflow with a tracked recovery ticket entity in the DB — these take weeks and *must not* evaporate into someone's memory.
- **Chain reorg after venue credit** — rare, venue's problem at their confirmation depths, but your chain watcher noticing keeps you from being surprised by a venue clawback.
- **API key permission drift** (withdrawal permission revoked, IP whitelist change) → detected by recon probes, not at the moment you desperately need to move funds.

Classify every venue error response into `RETRYABLE / AMBIGUOUS / TERMINAL / NEEDS_HUMAN` in the per-venue adapter. The default for unknown errors is `AMBIGUOUS`, never `RETRYABLE`.

## 14. Architecture, process topology & decomposition

Single host, Node/TS — resist the urge to build microservices. The right shape is a **single treasury service** (one process, or two: engine + admin/UI) composed of in-process modules that communicate through Postgres (outbox tables + `LISTEN/NOTIFY`), giving you transactional handoffs between components for free:

- **Ledger** — double-entry postings, reservations, the `tradeable` read model.
- **Planner** — targets, deviations, netting, route selection. Pure function from (ledger view, capability matrix, demand signals) → movement intents; keep it deterministic and unit-testable.
- **Executor** — outbox dispatcher + per-venue adapters. CCXT is a fine baseline for the boring 80%, but write **native adapter overrides for everything that moves money** — sub-account transfers, universal transfers, withdrawal client IDs, currency/network metadata — because CCXT's coverage and semantics there are uneven across venues and you cannot afford abstraction leaks in this layer. Validate each venue's idempotency behavior empirically with testnet/small amounts during onboarding.
- **Watcher** — polling loops + WS consumers, emitting observations.
- **Reconciler** — the three recon layers.
- **Scheduler** — poll cadences, state timeouts, recovery scan, recon ticks. (BullMQ works; honestly, a `pg`-backed job table with `FOR UPDATE SKIP LOCKED` workers is fewer moving parts and one less datastore — I'd take that on a single host.)
- **Risk/breakers** — evaluates trip conditions on every event.

The strategy/trading engine consumes the `tradeable` view through a versioned snapshot (sequence-numbered, via NOTIFY or a thin in-process API) and submits reservation requests through the same ledger — it never reads venue balances directly for sizing.

No Kafka, no Redis-as-truth, no Temporal cluster. Postgres is your bus, your journal, your lock manager, and your job queue, and on one host that's a feature: one thing to make durable, one thing to back up, one transaction boundary.

## 15. Orchestration

The honest take on durable-workflow engines (Temporal et al.): they solve exactly this problem class — multi-step, long-running, retry-laden processes with timers — and if you were a 10-engineer team across regions I'd say use one. On a single host with this scope, the persisted-FSM + outbox + scheduler design above *is* your workflow engine, with less operational surface and full control over the ambiguity semantics (which generic retry policies get wrong by default — remember, blind retry is the cardinal sin here). If you later outgrow it, your FSM states map 1:1 onto workflow steps, so the migration path stays open.

What orchestration must own regardless of implementation: per-state timers and escalation; the startup recovery scan as a blocking phase before accepting new work; serialization guarantees (one in-flight mutation per movement — easy with `FOR UPDATE`; per-corridor concurrency limits via advisory locks); and ordering between planner ticks and recon (don't plan against a balance view that recon has flagged).

---

## The priorities, if you build this incrementally

1. Ledger + reservations + intents journal + outbox (the correctness core).
2. Internal-transfer FSM with ambiguity resolution and crash-recovery tests — highest frequency, fastest feedback.
3. Withdrawal/deposit FSM + capability matrix + one corridor end-to-end with small real money.
4. The three recon layers + breakers — *before* scaling corridor count, because recon is what lets you trust corridors you aren't watching.
5. Planner sophistication (netting, routing, hysteresis tuning) last — a dumb planner on correct plumbing loses basis points; a clever planner on leaky plumbing loses principal.

The system's quality is ultimately measured by one question asked at any moment, including mid-crash: *"where is every unit of capital, and what evidence do you have?"* Every design choice above exists to make that answer a query against the journal rather than a guess.