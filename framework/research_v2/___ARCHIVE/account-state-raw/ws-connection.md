# Reliable, Reconciled Local Account State for CEX–CEX Crypto Arbitrage

**Scope:** continuously correct local model of balances, open orders, trades/fills, positions, funding, and fees across ~15 venues × multiple subaccounts, on a single Node.js/TypeScript host that must survive process restarts. Correctness > latency whenever they conflict.

**Governing axiom:** *the exchange is the only source of truth that matters when real money is at stake.* Local state is a cache that must be **provably convergent** to venue truth, and must **fail closed** (report zero deployable capital) the instant it cannot prove freshness. Silently-wrong state is strictly worse than no state.

---

## 0. Mental model and non-negotiable design rules

Everything below hangs off five rules. If a design choice violates one of these, it is wrong regardless of how fast it is.

1. **Single writer per account.** All mutations to one `(exchange, subaccount)` state object are serialized through exactly one async actor / command queue. Node is single-threaded, but `await` interleaving still produces lost-update and read-modify-write races. A snapshot-apply that yields mid-way and races a live fill will corrupt state. Serialize or perish.
2. **Monotonic sequencing + idempotency.** Every inbound event carries a dedup key and (where the venue provides it) a sequence/update id. Applying the same event twice must be a no-op. Applying events out of order must never regress a monotonic field (e.g. `cumExecQty`).
3. **Fail closed via a freshness gate.** The capital allocator reads a derived `deployable` figure that is **0** unless the account is `LIVE` *and* last reconcile is within the freshness window *and* all invariants hold. Strategy code physically cannot size a trade against stale state.
4. **Reserve before you send.** Capital is committed in a *local reservation ledger* the moment an order intent is written — before the venue call — so two simultaneous arb opportunities cannot double-spend the same capital. The venue later confirms the lock; the local reservation is reconciled against it.
5. **Persist intent before action.** A deterministic `clientOrderId` and the order intent are written to a durable WAL **before** the place/cancel request leaves the host. This is the only thing that lets you recover an order whose ack was lost to a crash.

### Layered architecture

```
            ┌──────────────────────────────────────────────────────┐
            │  Strategy / arbitrage sizer  (read-only consumer)       │
            └───────────────▲──────────────────────────────────────┘
                            │ reads `deployable` (freshness-gated, =0 if not LIVE)
            ┌───────────────┴──────────────────────────────────────┐
            │  Capital allocator + local reservation ledger          │
            └───────────────▲──────────────────────────────────────┘
                            │
            ┌───────────────┴──────────────────────────────────────┐
            │  Account state store (single-writer actor per account) │
            │  balances · orders(FSM) · trades · positions · funding  │
            └───▲───────────────▲────────────────────▲──────────────┘
                │ apply()       │ snapshot()         │ replay()
   ┌────────────┴───┐   ┌───────┴────────┐   ┌────────┴─────────┐
   │ Event normalizer│   │  Reconciler    │   │  WAL / durable   │
   │ (WS → canonical)│   │ (REST snapshot)│   │  store (SQLite)  │
   └────────▲────────┘   └───────▲────────┘   └──────────────────┘
            │                    │
   ┌────────┴────────┐   ┌───────┴────────┐
   │ Private WS conn  │   │   REST client  │
   │ lifecycle FSM    │   │ (rate-limited) │
   └─────────────────┘   └────────────────┘
```

Three orthogonal FSMs govern liveness (composed in §6 and §9):

- **Connection FSM** — the private/user-data WebSocket lifecycle (full spec in §9).
- **Reconciliation FSM** — snapshot/drift/repair cycle (§5, §6).
- **Per-account health FSM** — the trading gate the allocator reads (§6).

> **Trading-enabled invariant:** `enabled = Connection==LIVE ∧ Health==HEALTHY ∧ Reconcile==FRESH ∧ allInvariantsHold`. The three FSMs are AND-composed; any one leaving its good state collapses `deployable` to 0.

---

## 1. Connection establishment

You maintain **one private WS connection per `(venue, subaccount)`**, multiplexed by a connection manager.

### 1.1 Authentication models (they differ per venue — abstract them)

| Auth style | Venues (representative) | Keepalive concern |
|---|---|---|
| **listenKey** issued via REST, attached to the WS URL | Binance (spot & futures) | listenKey expires (~60 min); must `PUT`-keepalive (~every 30 min) and re-issue on `401`/expiry |
| **Signed login frame** sent on the open socket (HMAC over expires/timestamp) | Bybit, OKX, Bitget | login expires; some require periodic re-auth; signature is over server-aligned time |
| **Per-request signing** with rolling timestamp window | most REST snapshots | clock skew → signature rejection |

Wrap all of this behind a `VenueAdapter` interface so the connection FSM is venue-agnostic:

```ts
interface VenueAdapter {
  resolveCredentials(): Promise<AuthMaterial>;     // keys, listenKey, server-time offset
  buildWsUrl(auth: AuthMaterial): string;
  authFrame?(auth: AuthMaterial): WsFrame | null;  // null for listenKey venues
  privateChannels(account: AccountId): Subscription[];
  keepalive?(auth: AuthMaterial): Promise<void>;    // listenKey PUT, login refresh
  // REST snapshots:
  fetchBalances(a): Promise<Balance[]>;
  fetchPositions(a): Promise<Position[]>;
  fetchOpenOrders(a): Promise<Order[]>;
  fetchRecentTrades(a, since): Promise<Trade[]>;
  fetchOrderByClientId(a, coid): Promise<Order | null>;  // crash-recovery primitive
  // sequencing hints (null where venue doesn't provide):
  eventSeq?(raw): number | null;
  eventTs(raw): number;        // venue-side timestamp (ms)
}
```

### 1.2 The snapshot↔stream race (the single most important sequencing detail)

A naive "take a REST snapshot, then subscribe" loses every event that fires in the gap. The order-book sync pattern applies verbatim to account state:

1. Open WS, authenticate, **subscribe** to all private channels.
2. The moment events *can* arrive (entry to `SUBSCRIBING`), **buffer every inbound event in memory** — do **not** apply yet. Tag each with arrival order + dedup key + `eventSeq`/`eventTs`.
3. After subscriptions are confirmed, issue REST snapshots and record a **fence** per domain: ideally a venue sequence/transaction id; if the venue only gives timestamps, use the snapshot's server time **minus a safety margin** as the fence and rely on idempotency to absorb the overlap.
4. Apply the snapshot as the base state.
5. **Drain the buffer:** apply each buffered event only if it is *after* its domain fence; events at/before the fence are no-ops (already reflected). With per-event ids, compare ids; with timestamps, tolerate overlap and let idempotency dedup.
6. Transition to `LIVE`.

**Subtlety that bites everyone:** venue REST snapshots are **not atomic across endpoints** — balances, positions, and open-orders are separate calls captured at different instants, and the venue's own REST view is eventually consistent with its stream (an order you saw `NEW` on WS may not yet appear in `GET /openOrders`). Consequences baked into the design:

- The fence is **per-domain**, not global.
- Application must be **idempotent** so overlapping data converges.
- A buffered `NEW` for an order absent from the REST snapshot is **adopted**, not discarded (match by `clientOrderId`); a snapshot order absent from the stream is adopted too.
- A **follow-up full reconcile** shortly after going LIVE catches residual divergence.

### 1.3 Clock discipline

Maintain a per-venue **server-time offset** (sampled via the venue's time endpoint, smoothed, re-sampled periodically). Sign every REST request and login frame against `now + offset`. Signature rejections due to skew are a *recoverable* auth failure (re-sample offset, retry) — distinct from invalid-key failures (unrecoverable, → `HALTED`).

---

## 2. Connection health

The dangerous failure is not a clean disconnect — it is a **silent half-open** socket: TCP says alive, no data flows, you keep trusting a frozen view. Health monitoring exists to detect *the absence of expected liveness*, not just errors.

### 2.1 Three independent liveness signals

1. **Protocol ping/pong.** Honor the venue's scheme (some send ping and expect your pong; some expect *you* to ping). Track RTT. A missed pong within `pongTimeout` → connection presumed dead → `RECONNECTING`.
2. **Application data watchdog.** A monotonic timer reset on *every* inbound frame (data or pong). If `now - lastFrameTs > stalenessThreshold`, the stream is silent → `DEGRADED`, then escalate. Private streams are quiet by nature (no trades = no events), so the watchdog must be paired with a **deliberate liveness probe**: a cheap periodic REST call (e.g. server time or a light balance read) whose success proves the *venue path* is alive even when the *stream* is legitimately idle.

### 2.2 Freshness as a first-class field

Every account carries `lastReconcileAt` and `lastEventAppliedAt`. The allocator's freshness gate compares these to wall-clock. Health is therefore not boolean — it is *"how recently can I prove this view matches the venue."* Latency spikes (RTT breach), reconcile staleness, and partial subscription all degrade health *before* anything has visibly broken.

### 2.3 Concrete thresholds (tune per venue, start here)

| Signal | Soft (→ DEGRADED) | Hard (→ RECONNECTING/RESYNCING) |
|---|---|---|
| Pong RTT | > 1s sustained | missed pong past `pongTimeout` (e.g. 10s) |
| Inbound frame silence | > 30s with no liveness-probe success | probe fails twice |
| Reconcile staleness | > 2× reconcile cadence | > 5× cadence |
| Sequence gap | 1 missed (auto-resync) | repeated/unrecoverable gaps |

---

## 3. Reconnection

### 3.1 Core rule: **never resume mid-stream.** Re-snapshot on every reconnect.

User-data streams on these venues are **not resumable with a cursor** — there is no "give me everything since seq N." So a reconnect = potential unbounded gap = you *must* re-establish via the §1.2 snapshot↔stream sync. Treat any reconnect as "trust nothing the stream told me during the outage; the snapshot is truth."

### 3.2 Backoff, jitter, circuit breaker

- **Exponential backoff with full jitter**, capped (e.g. base 250ms → cap 30s). Full jitter (`random(0, min(cap, base·2^attempt))`) avoids thundering-herd across 15 venues reconnecting together.
- **Circuit breaker per venue.** After N consecutive failures within a window, open the circuit: stop hammering, hold the account in `HALTED`/`RECONNECTING-backoff`, alert. Half-open probes test recovery.
- **Re-resolve credentials on every reconnect attempt** (listenKey may have expired, login material rotated, server-time offset drifted). `RECONNECTING → RESOLVING_CREDS → CONNECTING`.

### 3.3 Trading is gated for the entire reconnect + resync window

From the instant health degrades through the moment the post-reconnect reconcile passes, the account is **not LIVE**, so `deployable = 0`. No exception. The cost is a few hundred ms of missed opportunity; the alternative is sizing against a frozen view and double-committing capital.

### 3.4 Distinguish reconnect classes

| Class | Trigger | Path |
|---|---|---|
| **Transport reconnect** | TCP/pong death, server close | `RECONNECTING → RESOLVING_CREDS → CONNECTING → … → SNAPSHOTTING → LIVE` |
| **Re-auth (socket retained)** | listenKey refresh OK, login still valid | `REAUTHING → RESYNCING → LIVE` (resync because a refresh can create a micro-gap) |
| **Re-auth (socket rebuild)** | login expired, listenKey revoked | `REAUTHING → RECONNECTING → …` |

---

## 4. Event-stream reliability

Private streams drop messages, deliver out of order, and silently miss events. Your defenses are **detection** (so you *know* you diverged) and **recovery** (snapshot, because replay is almost never available).

### 4.1 Gaps / dropped events

- **If the venue exposes a per-stream monotonic sequence:** maintain `expectedSeq`. On `event.seq > expectedSeq` → gap detected → `RESYNCING`. On `event.seq < expectedSeq` → stale/duplicate → drop.
- **If it does not** (common for private streams): you **cannot** detect a single dropped fill from the stream alone. This is why §5 periodic reconciliation and the §0.4 reservation ledger exist — they are the safety net for undetectable drops. Cross-checks catch them: a balance delta that doesn't correspond to any seen fill, or `cumExecQty` jumping by more than the sum of received fills, signals a missed event → targeted resync.

### 4.2 Out-of-order delivery

Order events legitimately arrive out of order (`NEW` after `PARTIALLY_FILLED`, a stale `NEW` after `FILLED`). The **order FSM** (§4.4) is the guard: transitions only move forward; monotonic fields never regress; a late event that would regress state is **absorbed for its data, ignored for its transition** (e.g. a stale `NEW` after `FILLED` does not reopen the order, but its `updateTime` is reconciled).

### 4.3 Deduplication

Two dedup namespaces, both persisted with TTL:

- **Fills:** key `(venue, exchangeOrderId, execId|tradeId)`. A fill is applied at most once — critical, because a double-applied fill double-counts realized PnL and balance.
- **Order-state events:** key `(venue, exchangeOrderId, status, cumExecQty, updateTime)`.

A bounded LRU/TTL `seenSet` in memory, backed by the durable event log for restart survival.

### 4.4 Order lifecycle FSM (per order)

```
            place intent written
                  │
            ┌─────▼─────┐  send fails / reject
            │PENDING_NEW│───────────────► REJECTED ●
            └─────┬─────┘
          sent to venue│
            ┌─────▼─────┐  reject ack
            │   SENT    │──────────────► REJECTED ●
            └─────┬─────┘
            NEW ack│
            ┌─────▼─────┐                cancel ack
            │  OPEN/NEW │───► PENDING_CANCEL ───► CANCELED ●
            └──┬─────┬──┘
       partial │     │ full fill
         fill  │     └──────────────────► FILLED ●
            ┌──▼──────────┐  full fill
            │PARTIALLY_    │───────────► FILLED ●
            │   FILLED     │  expire
            └──────────────┴───────────► EXPIRED ●
```

- **States:** `PENDING_NEW` (intent persisted, not sent), `SENT` (request issued, no ack), `OPEN/NEW`, `PARTIALLY_FILLED`, `PENDING_CANCEL`, and terminals `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`.
- **Monotonic guard:** `cumExecQty` is non-decreasing; `leavesQty` non-increasing; terminal states are absorbing.
- **Out-of-order guard:** apply a fill only if `execId` unseen *and* the resulting `cumExecQty` is consistent; ignore transitions that would move backward; never resurrect a terminal order.
- **Lost-ack guard:** an order stuck in `SENT` past `ackTimeout` triggers a **targeted query** by `clientOrderId` (§4.5) rather than a guess.

### 4.5 Recovery: targeted snapshot ≫ full snapshot ≫ replay

| Recovery | When | Cost |
|---|---|---|
| **Targeted re-fetch** (single order by `clientOrderId`, single position, single asset balance) | a specific entity is suspect (stuck `SENT`, gap touching one order, balance delta mismatch) | cheap; preferred |
| **Domain snapshot** (all open orders, or all positions, or all balances) | gap with unknown blast radius in one domain | moderate |
| **Full account snapshot** (all domains + recent trades) | reconnect, repeated gaps, invariant breach | expensive; the §1.2 sync |
| **Replay from stream** | venue offers a resumable cursor (rare for private) | usually unavailable — do not design around it |

**Replay is not a real option** on these venues for private data. Recovery = snapshot. Build for that.

---

## 5. Reconciliation

Reconciliation is the heartbeat that keeps the cache honest. Three views are continuously compared:

> **local derived state** (from applied stream events) **vs WS-implied** **vs REST snapshot truth**.

### 5.1 Modes and cadence

| Trigger | Type | Cadence |
|---|---|---|
| Steady-state drift sweep | full account snapshot | periodic, e.g. every 30–60s per account (jittered across venues to respect rate limits) |
| Post-reconnect / post-resync | full snapshot | mandatory, gates return to LIVE |
| Gap / suspicious delta | targeted or domain snapshot | event-driven, immediate |
| Pre-trade lazy check | freshness assertion (not a fetch) | on every sizing decision — assert `lastReconcileAt` within window, else `deployable=0` |
| Funding/settlement boundary | positions + balances snapshot | aligned to venue funding times (§7) |

### 5.2 Drift detection with correct tolerances

Define divergence semantics per domain — **exact** where it must be, **epsilon** where physics forces it:

- **Orders:** *exact set comparison.* An order present locally but not at venue, or vice versa, is drift. Match by `clientOrderId` first, then `exchangeOrderId`. No tolerance.
- **Fills/trades**.
- **Positions:** size **exact** to lot precision; `avgEntry`/`uPnL` within epsilon. A sign flip or unexpected nonzero size is **never** tolerated → invariant breach.
- **Balances:** `total` exact to asset precision; `available`/`locked` split may legitimately differ momentarily because fee/funding accrual and lock release are asynchronous on the venue — small epsilon, but the epsilon must be **tiny and time-bounded** (persistent gap = real drift).
- **Realized PnL / fees / funding:** reconcile cumulatively against the trade ledger, not instantaneously.

### 5.3 Reconciling safely while orders are in flight — the hard part

In-flight orders create **false drift**: an order you just placed (locally `SENT`/`OPEN`) may not yet be in the venue's open-orders snapshot, and an order you just canceled may still appear. Naive reconciliation would "repair" these and corrupt state. Solution: a **snapshot fence/epoch**.

1. Before issuing snapshot REST calls, capture `fence = max(localEventSeq, venueServerTime)` — a logical cutline.
2. Run the diff, but **classify each divergence against the fence and against in-flight intents**:

| Divergence | Classification | Action |
|---|---|---|
| Order local-only, created **after** fence, still `SENT`/`PENDING_NEW` | in-flight, not yet visible at venue | **ignore** (race, not drift) |
| Order local-only, created **before** fence, locally `OPEN` | genuine drift (we missed a terminal event) | re-fetch by `clientOrderId`; adopt venue truth |
| Order venue-only, matches a local `PENDING_CANCEL` | cancel not yet processed | ignore until next sweep |
| Order venue-only, **no local record** | **invariant breach** — an order we don't know we have | adopt + **escalate/HALT** (possible unhedged leg) |
| Position venue-only, no local origin | **invariant breach** | **HALT** (§8 invariants) |

3. Only divergences that are *not* explained by in-flight intents or the fence are real drift.

### 5.4 Automated repair — with hard safety gates

The reconciler emits a **diff**, not a mutation. A repair policy decides per-diff:

- **Auto-adopt venue truth** when the repair is *capital-neutral or capital-reducing* and explains a *missed event we'd expect*: e.g. an order we thought OPEN is actually FILLED → adopt the fill, apply the resulting balance/position change (this is just a late event). Adopt a slightly different `available/locked` split.
- **Escalate / HALT** when the repair would imply **new, unexplained exposure or risk**: an unknown open position; an order/balance we have no local origin for; a position size larger than any order we placed could produce; realized PnL diverging beyond tolerance. *Adopting these silently is exactly the catastrophe in the brief — a position we didn't open, or capital that isn't really free.* The system must stop and surface it, not "repair" it into local truth.

> Principle: **auto-repair may resolve "we missed an event"; it may never invent risk we cannot account for.** When in doubt, fail closed.

---

## 6. The three composed FSMs

Beyond the connection FSM (full spec in §9), two more FSMs run as orthogonal regions per account. The allocator reads their AND-composition.

### 6.1 Reconciliation FSM

```
IDLE ──(cadence tick | gap | reconnect-done)──► SNAPSHOTTING
SNAPSHOTTING ──(snapshot ok)──► DIFFING
SNAPSHOTTING ──(REST error/rate-limit)──► BACKOFF ──► SNAPSHOTTING
DIFFING ──(no drift)──► IDLE                       [sets FRESH, lastReconcileAt=now]
DIFFING ──(benign drift: missed event)──► REPAIRING ──► IDLE
DIFFING ──(unsafe drift: unknown exposure)──► ESCALATED ──► (account HALT)
```

- `FRESH` is the flag the freshness gate reads; it is cleared whenever `lastReconcileAt` ages out, forcing the account out of HEALTHY.

### 6.2 Per-account health FSM (the trading gate)

```
            all green
   ┌──────────────────────────► HEALTHY ──────────┐
   │                              │  soft fault     │ hard fault / invariant breach
   │           fault cleared      ▼                 ▼
RECOVERING ◄───────────────── DEGRADED ──────────► HALTED
   ▲   recovery complete          │ escalates        │ operator clears + reconcile passes
   │                              │                   │
   └──────────────────────────────┘◄──────────────────┘
```

| Health state | Meaning | `deployable` |
|---|---|---|
| `HEALTHY` | LIVE + FRESH + invariants hold | venue_available − reservations − buffer |
| `DEGRADED` | soft fault (late heartbeat, stale reconcile, partial sub, latency) | **0** (gate closed, but in-band recovery underway) |
| `RECOVERING` | re-snapshot/repair running after a fault | **0** |
| `HALTED` | hard fault / invariant breach | **0** + alert + supervised resume required |

**Composition:** `deployable > 0` requires `Connection==LIVE ∧ Health==HEALTHY ∧ Reconcile.FRESH`. The health FSM is the *single read* the strategy depends on; it summarizes the other two plus invariants.

---

## 7. Failure modes & error handling (catalog with detection + recovery)

| # | Failure mode | Detection | Recovery |
|---|---|---|---|
| F1 | **Lost order ack** (placed, no response; crash or network) | order stuck in `SENT` past `ackTimeout`; on restart, unresolved intent in WAL | query venue by persisted `clientOrderId`; resolve to actual state; never re-send blindly (idempotent place via `clientOrderId` if you must retry) |
| F2 | **Duplicate fill event** | `execId` already in dedup set | no-op; do not re-apply balance/PnL |
| F3 | **Out-of-order events** | order FSM backward transition / monotonic regression | absorb data, reject transition (§4.2) |
| F4 | **Missed/dropped fill (no seq on stream)** | balance/`cumExecQty` delta with no matching fill; periodic reconcile finds order FILLED locally OPEN | targeted re-fetch order + recent trades; adopt |
| F5 | **listenKey expiry / login expiry** | auth-rejected frame; keepalive `PUT` returns error | `REAUTHING` → refresh creds → resync (§3.4) |
| F6 | **Clock skew → signature rejection** | REST `-1021`/timestamp errors, auth reject | re-sample server-time offset; retry; if persists, NTP alarm |
| F7 | **Rate limit / IP ban (429/418, weight exhaustion)** | HTTP status, retry-after header, weight headers | token-bucket limiter pre-emptively; on hit, backoff + jitter, drop reconcile cadence (not order-critical paths); circuit-break if banned |
| F8 | **Venue maintenance / partial outage** | systemic 5xx, WS close with maintenance code, status page | `HALTED` for that venue; halve in-flight risk; resume via half-open probe + full reconcile |
| F9 | **Half-open socket (silent freeze)** | data watchdog + failed liveness probe (§2.1) | force-close socket → `RECONNECTING` |
| F10 | **Partial subscription** (some private channels confirmed, some not) | missing sub-ack for a channel | `DEGRADED`; retry failed channels; if unrecoverable, recycle socket |
| F11 | **Phantom available balance** (local shows free capital that's actually locked) | reconcile `available/locked` split drift beyond epsilon/time bound | adopt venue split; audit reservation ledger for orphaned/duplicate reservations |
| F12 | **Unknown position / order discovered** | reconcile finds venue entity with no local origin | **invariant breach** → `HALTED` + alert (never auto-adopt risk) |
| F13 | **Double-commit across two arb legs** | reservation ledger sum exceeds venue available; pre-trade gate sees negative deployable | gate blocks the second leg; reservation ledger is the *prevention*, reconcile is the *detection* |
| F14 | **Funding settlement applied twice / missed** | funding ledger vs balance delta at settlement boundary | reconcile positions+balances at funding time; idempotent funding events keyed by settlement id |
| F15 | **Snapshot inconsistency** (non-atomic REST endpoints disagree) | cross-domain diff fails but each domain self-consistent | re-snapshot with fresh fence; converge via idempotent re-apply; if persists → `HALTED` |
| F16 | **Reject/insufficient-margin on place** | place returns reject | release the local reservation immediately; mark order `REJECTED`; do **not** leak the reservation |

**Error-handling discipline:** classify every error as **recoverable-transient** (retry w/ backoff), **recoverable-stateful** (resync/reauth), or **terminal-risk** (HALT). Default unclassified errors to the most conservative bucket (HALT) — an unrecognized error near money is treated as dangerous until proven benign.

---

## 8. Invariants (detection + recovery for each)

Invariants are continuously asserted by the single-writer actor after every applied event and by the reconciler after every diff. A violation is the strongest signal you have that local state is wrong.

| Inv | Statement | Detection | Recovery |
|---|---|---|---|
| **INV1** | No state mutation occurs outside the per-account single-writer queue | static (architecture) + dev-assert: reject mutations not tagged with the actor's token | crash-on-violation in dev; in prod, route through queue; this is a *prevented*, not repaired, condition |
| **INV2** | Order lifecycle is monotonic; terminal states absorbing; `cumExecQty` non-decreasing | order FSM guard rejects illegal transition | log + flag the offending event; targeted re-fetch of that order to confirm truth |
| **INV3** | Per asset: `available + locked == total` within epsilon, and `total` matches venue within precision | reconcile (§5.2) | adopt venue truth (benign) or HALT (persistent/large gap) |
| **INV4** | Every `locked` amount maps to a known open order **or** an in-flight intent | join reservation ledger + open orders against venue locked | release orphaned reservations; if venue locks exceed accountable orders → HALT (unknown order) |
| **INV5** | Every open position has a known local origin (we never *discover* exposure) | reconcile finds position with no originating order chain | **HALT** + alert (F12) — never auto-adopt |
| **INV6** | `clientOrderId` is unique and persisted **before** the venue call | WAL write precedes send; uniqueness index in store | on collision, abort send (never reuse a coid); on missing pre-write, abort send |
| **INV7** | While `not LIVE/HEALTHY/FRESH`, `deployable == 0` | allocator computes gate on every read | structural — gate cannot be bypassed |
| **INV8** | Reservation ledger sum ≤ venue available + accountable in-flight | allocator pre-trade check | block the trade that would breach; reconcile to clean orphans |
| **INV9** | Snapshot fence is monotonic per domain | reconciler asserts fence ≥ previous fence | discard a snapshot with a regressed fence; re-snapshot |
| **INV10** | Realized PnL + fees ledger reconciles cumulatively to venue | periodic cumulative reconcile | targeted trade re-fetch over the divergent window; HALT if irreconcilable |

> The decisive design stance: **INV5 and INV12-class breaches HALT rather than repair.** Discovering money/exposure you didn't account for is the one thing local state must *never* silently absorb.

---

## 9. Private/user-data WebSocket connection FSM — full specification

This is the connection lifecycle in full: every state, every legal transition with trigger + guard + action, entry/exit actions, and the recovery path for each failure. It is venue-agnostic via the `VenueAdapter` (§1.1).

### 9.1 States

| State | Purpose | Trading gate | Notes |
|---|---|---|---|
| `INIT` | constructed, nothing started | closed | loads persisted state on entry |
| `RESOLVING_CREDS` | acquire/refresh API key, signing material, listenKey, server-time offset | closed | also the re-entry point from reconnect & supervised resume |
| `CONNECTING` | TCP+TLS+WS handshake | closed | handshake timeout armed |
| `AUTHENTICATING` | send login/sign frame, or attach listenKey; await auth ack | closed | **event buffering not yet, no subscriptions** |
| `SUBSCRIBING` | subscribe to private channels; await sub-acks | closed | **buffering of inbound events BEGINS on entry** |
| `SNAPSHOTTING` | buffer live events, pull REST snapshots, apply, drain buffer past fence | closed | the §1.2 sync; runs the reconcile FSM's first pass |
| `LIVE` | steady state; apply incremental events; heartbeats healthy; reconcile fresh | **OPEN** (iff Health/Reconcile also green) | the only tradeable state |
| `DEGRADED` | connected but soft fault; in-band recovery; trading gated | closed | late heartbeat / minor gap / stale reconcile / partial sub / latency |
| `RESYNCING` | re-snapshot to repair detected gap/drift, socket retained | closed | targeted or full; returns to LIVE on success |
| `REAUTHING` | auth/listenKey expired; refresh creds (socket may be retained or rebuilt) | closed | §3.4 classes |
| `RECONNECTING` | transport lost; backoff timer running; will rebuild | closed | circuit breaker lives here |
| `HALTED` | unrecoverable or safety-tripped; hard trading block | closed (hard) | requires supervised resume |
| `CLOSING` | graceful shutdown in progress | closed | flush WAL, cancel timers, unsubscribe |
| `CLOSED` | terminal; resources released | closed | |

### 9.2 Entry / exit actions per state

| State | On entry | On exit |
|---|---|---|
| `INIT` | construct adapter; load durable state; replay WAL into in-memory model | — |
| `RESOLVING_CREDS` | fetch/refresh keys + listenKey; sample server-time offset; arm creds-timeout | clear creds-timeout |
| `CONNECTING` | open WS; arm handshake-timeout | clear handshake-timeout |
| `AUTHENTICATING` | send auth frame (or note listenKey-in-URL); arm auth-timeout | clear auth-timeout |
| `SUBSCRIBING` | send subscribe frames; **start event buffer**; arm sub-timeout | clear sub-timeout (keep buffer) |
| `SNAPSHOTTING` | capture per-domain fence; issue REST snapshots; arm snapshot-timeout | apply snapshot + drain buffer + assert invariants; clear snapshot-timeout; stop buffering |
| `LIVE` | start heartbeat + data-watchdog + liveness-probe timers; start reconcile cadence timer; set Health=HEALTHY, Reconcile=FRESH; open gate | stop heartbeat/watchdog/probe/cadence timers; close gate |
| `DEGRADED` | mark Health=DEGRADED (gate closes); start fault-recovery timer; begin in-band probe/resync attempt | clear fault-recovery timer |
| `RESYNCING` | mark Health=RECOVERING; start resync; arm resync-timeout | apply repair; clear resync-timeout |
| `REAUTHING` | call adapter keepalive/refresh; arm reauth-timeout | clear reauth-timeout |
| `RECONNECTING` | close socket cleanly; compute backoff w/ jitter; tick circuit breaker; arm backoff-timer | clear backoff-timer |
| `HALTED` | hard-close socket; set Health=HALTED; emit alert; persist halt reason | require operator/supervisor token to leave |
| `CLOSING` | unsubscribe; flush WAL/checkpoint store; cancel all timers | — |
| `CLOSED` | release socket + handles | — |

### 9.3 Transition table (trigger / guard / action)

| # | From → To | Trigger | Guard | Action |
|---|---|---|---|---|
| T1 | `INIT → RESOLVING_CREDS` | `start()` | persisted state loaded & WAL replayed | begin credential resolution |
| T2 | `RESOLVING_CREDS → CONNECTING` | creds resolved | keys valid, offset sampled | proceed to connect |
| T3 | `RESOLVING_CREDS → HALTED` | creds error | error is *invalid key/permission* (not skew) | alert: bad credentials |
| T4 | `RESOLVING_CREDS → RECONNECTING` | transient creds error / timeout | recoverable (network, skew) | backoff & retry |
| T5 | `CONNECTING → AUTHENTICATING` | WS open | handshake ok | send auth frame / attach listenKey |
| T6 | `CONNECTING → RECONNECTING` | handshake fail/timeout | — | backoff |
| T7 | `AUTHENTICATING → SUBSCRIBING` | auth ack ok | login accepted | send subscriptions; start buffer |
| T8 | `AUTHENTICATING → REAUTHING` | auth reject (expired listenKey/login, skew) | recoverable | refresh creds |
| T9 | `AUTHENTICATING → HALTED` | auth reject (invalid key/permission) | unrecoverable | alert |
| T10 | `AUTHENTICATING → RECONNECTING` | transport drop / auth-timeout | — | backoff |
| T11 | `SUBSCRIBING → SNAPSHOTTING` | all sub-acks received | every required channel confirmed | capture fence; pull snapshots |
| T12 | `SUBSCRIBING → DEGRADED` | partial sub-ack | some required channel missing past sub-timeout | retry failed channels in-band |
| T13 | `SUBSCRIBING → RECONNECTING` | transport drop / sub-timeout (total) | no channels acked | backoff |
| T14 | `SNAPSHOTTING → LIVE` | snapshot applied & buffer drained | invariants hold; fence monotonic | open gate; start LIVE timers |
| T15 | `SNAPSHOTTING → RESYNCING` | snapshot inconsistent / REST retryable error | retryable | re-snapshot w/ fresh fence |
| T16 | `SNAPSHOTTING → RECONNECTING` | transport drop / snapshot-timeout | — | backoff |
| T17 | `SNAPSHOTTING → HALTED` | invariant breach implying unknown exposure (INV5/INV4) | auto-repair unsafe | alert; supervised resume |
| T18 | `LIVE → DEGRADED` | late pong / data-silence / reconcile-stale / latency breach | soft thresholds (§2.3) | close gate; begin in-band recovery |
| T19 | `LIVE → RESYNCING` | seq gap / confirmed drift | recoverable via snapshot | targeted/full re-snapshot |
| T20 | `LIVE → REAUTHING` | listenKey/login near expiry; keepalive failed | recoverable | refresh creds |
| T21 | `LIVE → RECONNECTING` | pong timeout / transport drop / half-open detected | — | force-close; backoff |
| T22 | `LIVE → HALTED` | hard invariant breach (INV5/INV3-persistent/INV10) | unrecoverable safely | alert |
| T23 | `LIVE → CLOSING` | `shutdown()` | — | graceful teardown |
| T24 | `DEGRADED → LIVE` | fault cleared | heartbeat resumed ∧ reconcile fresh ∧ gap benign ∧ subs complete | reopen gate |
| T25 | `DEGRADED → RESYNCING` | recovery needs snapshot | drift/gap confirmed | re-snapshot |
| T26 | `DEGRADED → RECONNECTING` | escalation / decide to recycle socket | fault-recovery timer expired or transport lost | backoff |
| T27 | `DEGRADED → HALTED` | persistent fault past budget / invariant breach | unrecoverable | alert |
| T28 | `RESYNCING → LIVE` | resync applied | drift repaired ∧ invariants hold | reopen gate |
| T29 | `RESYNCING → RECONNECTING` | transport drop during resync | — | backoff |
| T30 | `RESYNCING → HALTED` | unrepairable drift / repeated resync failures / invariant breach | unrecoverable safely | alert |
| T31 | `REAUTHING → RESYNCING` | creds refreshed, socket retained | login valid again | resync (close micro-gap) |
| T32 | `REAUTHING → RECONNECTING` | refresh requires new socket | listenKey revoked / login unrecoverable on this socket | rebuild |
| T33 | `REAUTHING → HALTED` | refresh fails (key revoked) | unrecoverable | alert |
| T34 | `RECONNECTING → RESOLVING_CREDS` | backoff elapsed | circuit not open | re-resolve creds, then reconnect |
| T35 | `RECONNECTING → HALTED` | max retries / circuit open past budget | breaker tripped | alert; supervised resume |
| T36 | `RECONNECTING → CLOSING` | `shutdown()` during backoff | — | cancel backoff; teardown |
| T37 | `HALTED → RESOLVING_CREDS` | supervised resume | operator token ∧ root cause cleared | full re-establish + mandatory reconcile |
| T38 | `HALTED → CLOSING` | `shutdown()` | — | teardown |
| T39 | `CLOSING → CLOSED` | teardown complete | WAL flushed, timers cleared | release handles |
| T40 | `* → CLOSING` | `shutdown()` (any state) | — | graceful teardown (highest-priority transition) |
| T41 | `* → HALTED` | unclassified error near money | error not provably benign | conservative default: halt + alert |

### 9.4 Recovery path summary (per failure, by originating state)

- **Handshake/transport failure** (`CONNECTING/AUTH/SUBSCRIBING/SNAPSHOTTING/LIVE/RESYNCING`) → `RECONNECTING` → backoff+jitter → `RESOLVING_CREDS` → … → full re-sync. Circuit breaker guards runaway loops (→ `HALTED`).
- **Auth/listenKey expiry** → `REAUTHING` → refresh → `RESYNCING` (socket kept) or `RECONNECTING` (socket rebuilt). Invalid key → `HALTED`.
- **Half-open socket** → data-watchdog + failed liveness probe → `LIVE→RECONNECTING` (force-close first).
- **Seq gap / drift** → `RESYNCING` (targeted, else full). Unrepairable → `HALTED`.
- **Partial subscription** → `DEGRADED` → retry channels → `LIVE`, else recycle → `RECONNECTING`.
- **Invariant breach implying unknown exposure** → `HALTED` from any state; never auto-repaired.
- **Rate limit / maintenance** → `DEGRADED`/`HALTED` for that venue; reconcile cadence throttled; resume via half-open probe + mandatory full reconcile.
- **Shutdown** → `CLOSING → CLOSED` from anywhere (T40 wins).
- **Supervised resume** is the *only* exit from `HALTED` other than shutdown (T37), and it forces a full re-establish + reconcile before the gate can reopen.

---

## 10. Crash recovery & persistence

Single host, must survive unclean restarts. The persistence layer exists to answer one question after a crash: *"What is the true state, and did anything I was in the middle of doing actually happen?"*

### 10.1 Durable store: `better-sqlite3` (recommended), WAL mode

For a single-host Node/TS system, **`better-sqlite3`** is the pragmatic best-in-class: synchronous API (no async race in the persistence path — fits the single-writer actor perfectly), full ACID, queryable, battle-tested. Run it in **WAL journal mode** with `synchronous=NORMAL` (or `FULL` for the intent log specifically) so writes are durable across power loss while staying fast.

- Alternative: **LMDB** (`lmdb-js`) for higher write throughput and zero-copy reads if the event log volume is extreme. Trade-off: less queryable, more bespoke.
- Avoid: a remote DB (adds a network failure domain to your source-of-record), or relying on in-memory only.

### 10.2 Two append-only logs (this is the heart of crash safety)

1. **Intent log** — written **before** any state-changing venue call.
   `{ coid, venue, account, op: PLACE|CANCEL, params, status: PENDING, ts }`
   After the response: append a resolution row `{ coid, status: ACKED|REJECTED|UNKNOWN, exchangeOrderId?, ts }`.
   *This is what rescues you from a crash between "sent the place request" and "received the ack."*
2. **Event log** — every normalized inbound event, append-only, with a local monotonic seq, dedup key, raw payload, and applied-flag.
   *This is what lets you rebuild derived state deterministically by replay.*

Materialized state (current balances/positions/orders/fills) is a **checkpoint** derived from the event log — kept for fast cold start, but always re-derivable, never the sole truth.

### 10.3 `clientOrderId` discipline

`coid` is **deterministic, unique, and persisted to the intent log before send**. It is the join key that lets you, after a crash, ask the venue *"did order `coid` land?"* via `fetchOrderByClientId`. Without it, an order whose ack you lost is **unidentifiable** → unhedged-leg risk → forced halt. This single discipline is the difference between graceful recovery and a manual money-hunt. (INV6.)

### 10.4 Cold-start / unclean-restart sequence

```
1. Open store (SQLite WAL). Integrity-check; recover WAL if needed.
2. Replay event_log → rebuild in-memory account models (idempotent apply).
   (Or load last checkpoint, then replay events after it.)
3. Resolve the intent_log:
     for each intent with status PENDING or UNKNOWN:
        query venue by coid (fetchOrderByClientId + recent trades)
        → reconcile to actual outcome (landed/filled/rejected/never-placed)
        → release or confirm the matching reservation
4. Per account: run a MANDATORY full reconcile against the venue (§5.1).
        local-derived vs REST truth; resolve all drift through the §5.4 policy.
5. Assert all invariants (§8). Any unresolved breach → account stays HALTED.
6. Only accounts that pass 1–5 transition Connection→LIVE and reopen the gate.
   Trading resumes per-account, not globally.
```

Until step 6 completes for an account, `deployable = 0` for it. A restart is, by construction, a reconnect for every venue — same §1.2 sync, same gating.

### 10.5 What survives, what is rebuilt

| Data | Persistence | On restart |
|---|---|---|
| Intent log | durable, fsync (FULL) | scanned & resolved against venue (§10.4 step 3) |
| Event log | durable (NORMAL) | replayed to rebuild derived state |
| Reservation ledger | derived from intents + events | rebuilt; orphans released after reconcile |
| Materialized balances/positions/orders/fills | checkpoint | loaded then validated by reconcile (truth = venue) |
| Dedup sets | backed by event log | rebuilt from log within TTL window |
| Server-time offset, listenKey | transient | re-resolved on `RESOLVING_CREDS` |

---

## 11. Recommended Node/TS toolset

| Concern | Choice | Why |
|---|---|---|
| WS client | `ws` | minimal, fast, full control of ping/pong & close codes; avoid heavy SDK abstractions that hide reconnect/health |
| Durable store + WAL | `better-sqlite3` (WAL mode) | synchronous ACID, fits single-writer actor; queryable audit trail |
| (alt) high-throughput KV | `lmdb-js` | zero-copy reads, very fast writes |
| FSM | `xstate` (or a hand-rolled typed reducer) | statecharts model orthogonal regions, guards, entry/exit actions directly; |
| Rate limiting | token-bucket per venue (e.g. `bottleneck` or hand-rolled) | pre-emptively respect weight limits; protect order path over reconcile path |
| Decimals | `decimal.js` / `big.js` | **never** use JS `number` for balances/qty/PnL — float error compounds and breaks INV3/INV8 |
| Validation | `zod` | parse-don't-validate every inbound venue payload into the canonical type at the boundary |
| Supervision | a process supervisor (systemd/pm2) + structured logs + alerting | restart triggers the §10.4 cold-start path; HALTED accounts page a human |

---

## 12. Summary of the opinionated stance

- **The venue is truth; local state is a freshness-gated cache that fails closed.** No LIVE + FRESH + invariants ⇒ no deployable capital ⇒ no trade.
- **Single-writer actor + idempotency + monotonic guards** make event application safe under drops, dupes, and reordering.
- **Reserve-before-send + reservation ledger** prevent cross-leg double-spend *before* it happens; periodic reconcile *detects* what slipped through.
- **Reconnect ⇒ always re-snapshot** via the buffer-then-snapshot-then-drain sync, fenced against in-flight orders to avoid false drift.
- **Auto-repair resolves missed events; it never invents unaccounted risk** — unknown positions/orders/balances/fills HALT, they do not get silently adopted.
- **Persist intent (with `clientOrderId`) before action; replay the event log + resolve the intent log + mandatory reconcile on restart.** That is the whole of graceful crash recovery.
- **Correctness > latency, always, where they conflict** — encoded structurally in the freshness gate, not left to discipline.