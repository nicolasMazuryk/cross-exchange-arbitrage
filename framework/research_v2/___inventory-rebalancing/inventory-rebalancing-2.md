# Building a Reliable Inventory Rebalancing Engine for CEX-CEX Arbitrage

Architecture and stack for the stated constraints: 15 venues, multi-subaccount, frequent internal transfers, several on-chain rebalances per day per corridor, single host, Node.js/TypeScript, correctness over latency.

---

## 1. First Principles That Drive Everything Else

**Truth hierarchy.** There are exactly three classes of truth, in descending order of authority: (1) the blockchain, (2) the venue's ledger as observed via its API (balance snapshots, deposit/withdrawal history, transfer history), and (3) your local state. Your local database never stores "facts" about where money is — it stores *intents* (movements you tried to cause) and *observations* (snapshots and history records you fetched, with their fetch timestamps). Everything the trading engine consumes is a *derived projection* of intents + observations, and that projection must carry explicit staleness metadata.

**Three-valued outcomes.** Every network call that moves money has three outcomes, not two: succeeded, failed, and **unknown**. Timeouts, 5xx, dropped connections, and "request submitted" acks without an ID are all *unknown*. The single most common catastrophic bug in treasury systems is collapsing unknown into failed and retrying — that's how you double-withdraw. Your client layer must return a typed `Outcome = Confirmed | Rejected | Ambiguous`, and `Ambiguous` must be unrepresentable as "retry-safe" without first running a resolution query.

**Write the intent before the wire.** Persist the movement record (with its idempotency key) and fsync *before* sending the request. If you crash between the DB write and the HTTP call, recovery sees a `SUBMITTING` record and resolves it by querying the venue with the client ID. If you crash between the HTTP call and recording the response, same path. There is no ordering of (persist, send) that is crash-safe in the other direction.

**Money is reserved before it moves.** Capital that a movement *might* consume is unavailable to the trading engine the instant the decision is made, not when the venue confirms. Double-spend prevention is a local reservation problem, not a venue problem.

---

## 2. Core Architecture

Five components, all on one host, all sharing one Postgres instance:

1. **Movement Orchestrator** — a saga runner that owns the state machine for every movement (withdrawal, deposit-expectation, internal transfer). Single writer per movement.
2. **Capital Ledger** — an append-only double-entry journal plus a projection of balances per `(venue, account, walletType, asset)` including in-flight and reserved buckets.
3. **Observation Ingest** — pollers that continuously fetch venue balances, deposit history, withdrawal history, transfer history, and chain confirmations, writing immutable observation records.
4. **Reconciler** — diffs ledger projections against observations, matches expected deposits to actual credits, flags drift, and is the only component authorized to declare a movement terminally settled.
5. **Planner/Router** — decides *what* to move (corridor selection, network selection, fee/latency optimization). Deliberately decoupled: the planner emits movement *proposals*; the orchestrator owns execution.

The trading engine never reads venue balances directly. It reads one view:

```
available(venue, account, walletType, asset) =
    lastReconciledBalance − activeReservations − inFlightHaircut
```

with a staleness timestamp it must gate on.

---

## 3. The Movement State Machine

Model every movement as an explicit, persisted state machine. Don't be clever; enumerate everything. For an on-chain withdrawal:

```
PLANNED → RESERVED → SUBMITTING → SUBMITTED (venue withdrawal ID known)
        → PROCESSING (venue-side review/queue)
        → BROADCAST (txid known)
        → CONFIRMING (n/m confirmations, independently verified)
        → ARRIVED (destination venue shows the deposit, possibly uncredited)
        → CREDITED (spendable on destination)
        → SWEPT (moved to the trading wallet, if the venue credits to funding)
        → RECONCILED (ledger entry matches both venues' history records)
```

Failure and ambiguity branches, each first-class:

- `REJECTED` — venue refused: bad address, below min, suspended network.
- `CANCELED` — you or the venue canceled pre-broadcast.
- `AMBIGUOUS_SUBMIT` — sent, no usable ack; resolution required before anything else.
- `STUCK` — exceeded the corridor's p99 latency at any stage; alerts, doesn't auto-retry.
- `RETURNED` — venue reversed it.
- `MANUAL_REVIEW` — terminal-ish; a human owns it; capital stays reserved.

Internal transfers use a collapsed version:

```
PLANNED → RESERVED → SUBMITTING → SUBMITTED → VERIFIED → RECONCILED
```

where `VERIFIED` means you've confirmed it via transfer history or balance delta, *not* merely received a 200. Several venues will 200 a transfer request and then not execute it (maintenance windows, sub-account permission issues), and several return ambiguous errors on duplicate client IDs. Treat a transfer ack as a hint.

Two rules that matter more than the diagram:

- **Transitions only via the orchestrator, only with evidence.** `CONFIRMING → ARRIVED` requires an observation record (a deposit-history row or chain inclusion proof), referenced by ID in the transition. Every transition row stores: prior state, new state, evidence reference, timestamp, and actor. This gives you a complete audit trail and makes replay/debugging tractable.
- **Crash recovery is just "resume non-terminal sagas."** On startup, load every movement not in a terminal state, and for each, run its *resolution* step first: query the venue by client ID / venue ID, query chain by txid if known, then continue. A movement mid-flight on chain across a restart is the normal case, not an edge case.

---

## 4. Double-Spend Prevention: Reservations + Double-Entry

Use a real double-entry ledger internally. Accounts are `(venue, account/subaccount, walletType, asset)` plus synthetic accounts: `in_flight:<corridorId>`, `fees`, `unmatched_deposits`. A withdrawal posts `debit source / credit in_flight` at `RESERVED`, then `debit in_flight / credit destination` at `CREDITED`, with a separate fee posting. The invariant — every journal entry sums to zero, and projected balances equal the sum of postings — is checked continuously, and a violation halts movement initiation.

Reservations are rows with a TTL-less hold tied to a movement ID, taken inside the same DB transaction that creates the movement. The available-balance projection subtracts them. Because capital is shared across simultaneous arb opportunities and rebalances, the reservation must be the *single* gate: both the trading engine (sizing a leg) and the planner (sizing a rebalance) acquire reservations through the same API, with conflicts resolved by per-key serialization (below). Never let two subsystems compute "available" independently.

**Concurrency model.** Single host makes this easy — exploit it. Serialize all mutations per `(venue, account, walletType, asset)` key through an in-process keyed queue (a simple promise-chain map is fine), and additionally guard with `SELECT ... FOR UPDATE` on the balance row inside the transaction so correctness doesn't depend on the in-process lock surviving bugs. Optimistic version columns on movement rows catch any double-writer regression loudly.

**Haircuts on uncertainty.** While a movement is between `RESERVED` and `CREDITED`, the capital exists *nowhere* as far as sizing is concerned: subtracted from source, not yet added at destination. Resist the temptation to "pre-credit" the destination for latency reasons — the trading engine can see `incoming(venue, asset, eta)` as advisory data for opportunity selection, but never as spendable balance.

---

## 5. Idempotency, Per Venue

Every venue with a real API supports client-supplied IDs on movement endpoints; use them universally and derive them deterministically from the movement UUID so retries and crash-resolution always reference the same key:

- **Binance**: `withdrawOrderId` on withdrawals; sub-account/universal transfers return a `tranId` — persist it immediately, and resolve ambiguity via the transfer-history endpoints filtered by time window.
- **OKX**: `clientId` on both `/asset/withdrawal` and `/asset/transfer`; both queryable by clientId. The best-behaved venue in this respect.
- **Bybit**: UUID `transferId` you generate for internal/universal transfers (resolvable via transfer query); withdrawals can be queried by ID.
- Others vary; for any venue lacking a client ID on some endpoint, your resolution fallback is *time-windowed history matching*: fetch history for `[t_submit − ε, now]`, match on (asset, amount, address/memo or destination account), and treat multiple candidates as `MANUAL_REVIEW`. Build this matcher once, generically — you will need it constantly, because even with client IDs, some venues' lookup endpoints lag.

Hard rule: **no resubmission until the prior intent reaches a terminal state.** `AMBIGUOUS_SUBMIT` blocks the corridor for that movement until resolution succeeds, even if that takes minutes of polling. Correctness > latency.

---

## 6. On-Chain Specifics

**Network/chain selection.** Maintain a corridor table keyed by `(srcVenue, dstVenue, asset, network)` containing: withdrawal fee, withdrawal min/max, deposit confirmation requirement at the destination, whether the network is currently enabled for withdraw at source *and* deposit at destination (these flip independently and often), memo requirement, observed latency distribution (p50/p95/p99 from your own history), and a precision field. Refresh the static parts from venue currency/chain endpoints every few minutes (ccxt's `fetchCurrencies` / `fetchDepositWithdrawFees` are genuinely useful here even if you go native elsewhere); learn the latency distribution from your own completed movements. The router sorts by effective cost = fee + (latency penalty priced against opportunity decay), and refuses corridors where either side currently reports the network suspended — withdrawing into a suspended deposit network is a classic way to strand funds for days.

**Memos/tags.** XRP, XLM, ATOM, TON, EOS-style chains: a missing or wrong memo means a recovery ticket measured in weeks. Make `memo` a non-optional field in the address-book schema for memo-requiring networks (enforced by the type system and a DB check constraint), and validate against the destination venue's deposit-address response on every movement, not just at address-book creation — venues do rotate deposit addresses/memos.

**Address whitelisting.** Withdraw only to a pre-registered address book, whitelisted on each venue with the venue's own whitelist feature enabled and API-withdrawal restricted to whitelisted addresses. Address-book changes go through a separate, human-gated admin flow (two-person rule), never through the orchestrator's code path. This converts "attacker with API key" from "drains everything" to "can only shuffle money between your own accounts."

**Independent chain verification.** Don't trust the source venue's "completed" status as proof of arrival, and don't trust the destination's silence as proof of non-arrival. Once you have a txid, verify inclusion and confirmation depth yourself: viem against EVM chains, a Solana RPC client for SOL/SPL, mempool.space/Esplora APIs for BTC, TronWeb/TronGrid for TRC-20 (which will likely be your highest-volume stablecoin corridor). One managed RPC provider (Alchemy/QuickNode/Chainstack tier) plus one fallback covers this at your volume; running your own nodes is not worth it for several-movements-per-day-per-corridor.

**Deposit side.** Detection has three stages you must track separately: *seen on chain*, *visible in venue deposit history* (often with a status like pending/credited), and *spendable*. Venues credit at their own confirmation threshold, which differs from yours and changes without notice. Some venues credit deposits to a funding wallet that requires an explicit internal transfer before the capital is tradable — model that sweep as its own movement in the same saga, not as an afterthought, or your "credited" capital is fictional for trading purposes.

**Unexpected deposits.** Anything appearing in deposit history that doesn't match an expected movement goes to the `unmatched_deposits` ledger account and pages a human. Never auto-credit it into trading capital.

---

## 7. Internal Transfers and Wallet Types

The wallet-type graph differs per venue and changes as venues migrate to unified accounts: Bybit UTA collapses spot/linear into one unified wallet (with funding still separate); OKX has a unified trading account plus funding; Binance still distinguishes spot/USDⓈ-M/COIN-M/funding (with portfolio margin as a separate regime). Model each venue's wallet topology explicitly as a per-venue adjacency map of legal transfer edges with their endpoint, min amounts, and whether master-key authorization is required (master↔sub transfers almost always run on the master key; sub-to-sub is usually master-mediated). The planner routes over this graph; do not hardcode "spot→linear" as if it's universal.

Master↔subaccount transfers deserve the same idempotency rigor as withdrawals. Throughput note: at many-per-hour you'll meet per-endpoint rate limits on transfer-history queries during reconciliation — budget your poll frequencies per venue and prefer time-windowed batch history fetches over per-movement lookups.

Verification: after a transfer ack, confirm via transfer history (preferred) or a before/after balance read on both wallets under the per-key lock. Only then release the reservation and post the ledger move. Seconds-level confirmation is achievable this way; it's one or two extra reads.

---

## 8. Reconciliation — the Component That Keeps You Honest

Run three loops:

1. **Fast loop (every few seconds per venue, within rate limits):** balance snapshots for all accounts/wallet types; advance any sagas waiting on balance evidence.
2. **Movement loop:** for every non-terminal movement, poll the specific lookups it's waiting on (withdrawal status, txid confirmations, deposit history at destination).
3. **Deep loop (every few minutes, plus on startup):** full diff of ledger projections vs. observed balances per `(venue, account, walletType, asset)`, with expected in-flight amounts as explained variance. Compute `drift = observed − (projected + explainedInFlight)`.

Drift policy, tiered:

- Below a per-asset epsilon (dust, fee rounding) → auto-post a reconciliation adjustment with full provenance.
- Above epsilon → freeze *initiation* of new movements touching that bucket, alert, keep existing sagas running.
- Above a hard threshold, or any ledger-invariant violation → global movement halt and trading-engine notification so it stops sizing against your numbers.

A stale view that admits it's stale is recoverable; the deep loop existing — and being trusted to halt the system — is what makes your local state safe to act on at all.

Startup sequence: resolve all non-terminal sagas → run a full deep-loop reconcile → only then accept new movement proposals. This makes "process restarted with a withdrawal mid-flight" boring.

---

## 9. The Concrete Stack

**Runtime & language.** Node current LTS, TypeScript `strict`, with `exactOptionalPropertyTypes` and discriminated unions for every state and outcome type so illegal transitions don't typecheck. Movement amounts as `bigint` minor units with per-asset scale taken from venue precision metadata — never floats; avoid decimal.js in the hot ledger path in favor of integer arithmetic; convert at the API boundary only.

**Persistence.** Postgres 16+, even on a single host, over SQLite — not for scale, but for `FOR UPDATE`/`SKIP LOCKED`, mature operational tooling, and online inspection while the engine runs. `synchronous_commit = on`, WAL archiving to off-host storage (your ledger is the business; a host loss must not lose it). Schema access through Kysely or Drizzle — typed SQL, no heavyweight ORM; you want to see every query in a system like this. Append-only tables for journal entries, movement transitions, and observations; projections as ordinary tables rebuilt on demand from the log (cheap insurance and a great debugging tool).

**Workflow engine: build, don't buy — at this scale.** Temporal is the genuinely good off-the-shelf answer for durable sagas, and for a larger team or multi-service deployment it would be the recommendation. For a single-host, single-process system, its server footprint and the impedance between its execution model and your per-key serialization needs outweigh the benefit. A hand-rolled saga runner — movements as Postgres rows, a poll/resume scheduler using `SKIP LOCKED`, deterministic resolution steps — is ~2–3k lines you fully understand, and full understanding is itself a reliability feature in treasury code. For background jobs (pollers, reconcile runs), use **pg-boss** or **graphile-worker**: Postgres-backed, transactional with your state. Do **not** put movement state in BullMQ/Redis; Redis durability semantics are not what you want underneath money.

**Exchange connectivity.** Use ccxt for what it's great at — currency/network/fee metadata, quick coverage of tail venues — but write **native, typed REST clients for the movement-critical endpoints** of your top corridors (withdraw, transfer, the corresponding history/lookup endpoints). ccxt's unification papers over exactly the distinctions you need: per-venue error taxonomies (is `-4026` retryable?), client-ID semantics, ambiguous-ack shapes. Every native client returns the three-valued `Outcome`, validates responses with **zod** at the boundary (venues change response shapes without notice; fail loudly), and classifies errors into `Retryable | Fatal | Ambiguous` per venue from documentation plus your own incident history.

**Chain layer.** viem (EVM), official Solana SDK, TronWeb, Esplora/mempool.space for BTC; one managed RPC provider + one fallback, health-checked.

**Security.** Separate API keys for trading vs. movement; withdrawal-enabled keys IP-whitelisted to the host, restricted to whitelisted addresses, stored encrypted at rest (age/KMS-wrapped, loaded into memory at boot — no plaintext env files). chrony for clock sync (signature/`recvWindow` failures from drift will otherwise plague you). Per-asset and per-hour withdrawal velocity limits enforced *in your code*, below the venue-side limits, as the last line against a logic bug.

**Observability.** pino structured logs with the movement ID on every line; OpenTelemetry traces spanning a movement's whole lifecycle; Prometheus + Grafana with alerts on: any saga in one state past its corridor p99, any `AMBIGUOUS_*` older than N minutes, drift events, unmatched deposits, reconcile-loop lag, and rate-limit budget consumption. Page on all of these — at several on-chain movements a day, every alert is investigable.

---

## 10. Operating Practices

Canary every new corridor and every corridor that's been idle >N days with a minimum-size movement before committing real size. Score corridor health continuously from your own latency/failure history and have the planner de-prioritize sick corridors automatically. Keep a manual-review queue with real tooling — the state machine's job is to *narrow* what humans handle to genuinely ambiguous cases, then make those cases fast to resolve (show both venues' history, chain status, and one-click "confirm matched / mark lost"). Write the runbook for the top five incidents before they happen: ambiguous withdrawal, stuck on-chain transfer, venue suspends a network mid-flight, unmatched deposit, drift halt.

**Testing** is where treasury systems are won:

- A deterministic fake-venue harness that injects every ambiguity (timeout after execution, 200-without-execution, duplicate-history rows, delayed crediting, network suspension mid-saga).
- Chaos tests that `kill -9` the process at every await point in the submit path and assert recovery converges with no double-spend.
- Property tests on ledger invariants (entries sum to zero; available never negative; reservation conservation) under randomized concurrent operations.

Run the full chaos suite in CI on every change to the orchestrator.

---

## Build Order

1. Ledger + reservations.
2. Internal-transfer saga on your two highest-volume venues (fastest feedback, no chain risk).
3. Observation ingest + reconciler.
4. On-chain withdrawals on one stablecoin corridor (TRC-20 or an L2) with canary sizing.
5. Breadth across venues.

The reconciler comes before the first on-chain movement, not after — flying on-chain without the deep loop is how teams discover drift weeks late.