# 06 — Persistence & Recovery

**Scope:** what is persisted and why, the storage engine, the two append-only logs and the write-ordering contract, snapshots and replay determinism, the cold-start sequence, and persistence-failure policy. Cross-references: event model/reducers → `01 §7`, coid discipline → `03 §1`, Resolver → `03 §5`, mandatory boot reconcile → `05`, halt semantics → `07`.

Persistence here answers exactly two questions after a crash: **"What did I think was true?"** and **"What was I in the middle of doing?"** It is a *head start* for recovery — never an authority. The venue is the authority; persisted state exists so the post-restart reconcile is a diff against a near-current view instead of a from-scratch rebuild, and so in-flight intents are recoverable at all.

---

## 1. Storage engine

- **`better-sqlite3`, WAL journal mode**, per venue worker (one DB per venue keeps the single-writer story clean and failure domains separate; → `01 §2`). Synchronous API is a *feature*: writes happen inline in the actor's critical section with no async interleaving (→ `01 §5`); single-writer matches the actor model; ACID without a server; SQL makes the audit trail queryable.
- `synchronous=NORMAL` is the right default in WAL mode for most tables; use **`synchronous=FULL` (true fsync) for the intent log** — the one place where losing the last write means an unidentifiable order at a venue (§3).
- **Alternative:** `lmdb-js` where write throughput dominates (zero-copy reads, very fast) at the cost of queryability. **Avoid a remote DB on the trading path** — a network hop in the write path adds a failure mode to every order.
- **Checksummed records** in the append-only logs (length-prefix + CRC per record) so a torn final write at crash is *detected and truncated*, not replayed as garbage.
- **Single-writer enforcement on disk:** an advisory file lock on the data directory; a second process instance must refuse to start. Split-brain — two processes trading one account — is catastrophic and must be structurally impossible (→ `07 §3`).
- Snapshot + WAL is the durability pattern; the WAL is the truth, snapshots are an optimization (§4).

## 2. What is persisted

| Data | Why | Survives restart as |
|---|---|---|
| **Intent log** (order/cancel/amend intents + resolutions) | crash-recovery of in-flight actions; the coid registry | authoritative list of "what we may have done" |
| **Event log** (canonical `AccountEvent`s, → `01 §7.2`) | replayable truth feed; audit; dedup memory | source for projection rebuild |
| Snapshots (projection state @ lsn + hash) | bound replay time | head start |
| `clientOrderId` counter / allocated ranges | id uniqueness across restarts | boot check (→ `03 §1`, I9) |
| Dedup sets (`seenTradeIds`, event dedup keys) with TTL | exactly-once across restart | rebuilt-verifiable from event log within TTL window |
| Sequence cursors per `(venue, channel)` + reconcile fences | gap detection continuity | resume points (advisory — streams aren't resumable anyway, → `02 §6.1`) |
| Discrepancy ledger, halt reasons, breaker states | ops/audit; HALTED must survive restart | a halted scope **boots halted** |
| Clean-shutdown flag | distinguishes crash from graceful exit | selects recovery strictness (§5) |

Not persisted (always recomputed): uPnL, marks, effective_available, health/connection states, anything derivable from events + venue.

## 3. The two logs and the write-ordering contract

**Intent log** — *written BEFORE the venue call.* Each row: `{coid, intentType: place|cancel|amend, params, scope, ts, status: PENDING}`; later updated with a resolution row `{coid, outcome, evidence, ts}` (append a resolution record rather than updating in place — the log stays append-only). The contract:

```
mint coid → append OrderIntent (synchronous, FULL fsync) → only then send
```

If the process dies between append and send (or between send and ack), boot finds a `PENDING` intent and the Resolver asks the venue by coid (→ `03 §5`). If it dies *before* the append, nothing was sent (the send is gated on durable append) — no orphan possible. This single ordering rule is what makes "order at venue that we don't know about" structurally impossible for our own orders.

**Event log** — every canonical event appended with: monotonic `lsn`, dedup key, venue seq/ts where present, **raw venue payload** (forensics + re-normalization after adapter bug fixes), and an `applied` marker. Rules:

- **Persist the event before mutating projections** (especially fills — money moves). Apply-then-persist loses the event on crash and leaves projections claiming state the log can't justify.
- Append + fold happen inside the actor's synchronous critical section; network effects happen after, outside it (→ `01 §5`, `04 §3.1`).
- fsync policy: group-commit/batched fsync is acceptable for the event log (NORMAL), **never** for intent-log appends gating sends.

## 4. Snapshots & replay determinism

- Snapshot = full projection state + `lsn` + a projection **hash**, written periodically (time/size-based) and on graceful shutdown. Restore = load snapshot, replay events `lsn+1 …` through the same reducers.
- Compaction: events older than the latest durable snapshot (beyond audit retention) can be archived out of the hot store.
- **Determinism is enforced, not hoped for:** no wall-clock/randomness in `apply()` (→ `03 §6`); CI replays golden logs and full from-genesis rebuilds, asserting byte-identical projection hashes (I12, → `08 §3`). A replay mismatch is a projection bug discovered in CI rather than during an incident.

## 5. Cold-start sequence (crash or clean restart — same path)

Trading is **disabled throughout**; each account's gate reopens individually at step 8.

```
1. Acquire data-dir lock; read clean-shutdown flag (absent ⇒ strict mode).
2. Load latest snapshot; verify hash; replay event log lsn+1.. → projections.
3. Verify coid counter strictly > max(coid in logs); else refuse-to-trade + rebuild (I9).
4. Resolve intent log: every PENDING/UNKNOWN intent → Resolver by coid
   (fetchOrderByClientId + recent-trades window per 03 §5) → append resolutions.
5. Connect per 02 §9 (RESOLVING_CREDS → … → SNAPSHOTTING): buffer stream,
   pull full REST snapshots (balances, open orders, positions, recent trades).
6. MANDATORY full reconcile per account (05): adopt/bind venue-side orders by coid
   (cold-start adoption of our own is benign); unknown positions ⇒ HALT scope;
   apply explainable diffs as natural events, residue as *Corrected.
7. Rebuild the reservation overlay from surviving non-terminal orders
   (each open order re-acquires its reservation; orphans → reaper rules, 04 §2).
8. Assert all invariants (05 §8). Per-account: Connection LIVE ∧ reconcile FRESH
   ∧ invariants ⇒ gate opens. Scopes persisted as HALTED stay HALTED.
```

The persisted view's only job was making step 6 a *small diff*. If logs are corrupt/lost, the same sequence still works from an empty state — slower, and any in-flight intents are unrecoverable except via venue queries over a time window (which is why the intent log gets FULL fsync).

## 6. Persistence-failure policy

A failed write (disk full, I/O error, fsync error) means the recovery guarantee is gone: **halt all order submission immediately** (cancel-only remains, since cancels reduce risk and need no durable intent to be safe — though they are still journaled best-effort). Never trade without a working journal. Disk-space and fsync-latency are monitored with alarms well before the cliff (→ `08 §1`).
