# Process Topology, Orderbook Construction, Resource Optimization & Orchestration
### Dimensions A, C, F, G — the Node.js/TypeScript gap-fill

> Companion to the staleness-detection, orderbook-FSM, and WS-connection-FSM docs.
> Those cover **B** (subscription management), **D** (recovery), and most of **E**
> (hot-path discipline, latency measurement). This doc fills **A, C, F, G** and the
> runtime reality that reframes all four.
>
> Constraints honored throughout: ~30,000 subscriptions across 15 venues × ~2,000
> markets; **single region, single host**; **low-ms (not sub-ms)** local budget;
> **correctness strictly > latency**; **Node.js/TypeScript** runtime.

---

## 0. The Node.js reality that reframes everything below

The other four docs implicitly assume a systems-language execution model —
`isolcpus`, busy-poll, SIMD-JSON in C++, seqlocks over shared book memory, lock-free
SPSC rings between threads sharing one heap. Most of that intent survives in Node,
but the *mechanics* change, and pretending otherwise produces an architecture that
doesn't exist. Five facts drive A/C/F/G:

4. **SIMD-JSON in Node is a trap if used naively.** `simdjson` Node bindings exist,
   but the cost of materializing a C++-parsed document back into a JS object frequently
   **erases the win versus V8's own `JSON.parse`**. It only pays off with **lazy /
   on-demand extraction** — pull just the handful of fields a depth diff needs
   (`U`, `u`, `pu`, `b`, `a`, `E`/`T`/`ts`) via pointer access and *never materialize
   the full object*. That also happens to be the zero-allocation path GC wants. The
   bald advice "use simd-json" in the staleness doc is misleading for Node unless
   qualified this way.

---

## A. Process Topology & System Decomposition

### Recommended mapping

Reject both extremes:

- **One worker per venue** — a major's 2,000 symbols saturate a single core's
  parse+apply budget; everything on that venue shares one GC and one stall.
- **One worker per connection** — hundreds of workers; context-switch and
  per-isolate memory overhead; and you scatter the symbols that the staleness doc's
  *connection-level cross-symbol corroboration* depends on being co-resident.

**The unit that works: one *worker_thread* = one *venue shard* = one event loop owning
the set of WebSocket connections (and their books) for a slice of one venue, sized so
its steady-state parse+apply load stays under ~70% of one core.** The workers run
inside one (or a few) host processes; see the core layout below for how they map onto
isolated cores.

| Tier | Example venues | Shape |
|---|---|---|
| Majors (high msg-rate) | Binance, Bybit, OKX | **Several shard-workers each**; 2,000 symbols split across workers, spread across the isolated core-set |
| Mid | Bitget, etc. | One or a few shard-workers |
| Thin / long tail | the rest | One worker for the whole venue; hosted in the tail process on the housekeeping pool |

Rough fleet: **~30 feed-shard workers** across 15 venues, plus a **strategy/arb
worker**, an **order-placement worker**, a **snapshot/REST-limiter**, and a **metrics**
reader — hosted in one (or a few) processes under a **systemd** supervisor.
Comfortable on a 32-core box. The binding constraint is *not* core count — it's
keeping each hot loop under ~70% utilization so GC and reconnect storms have headroom.

### Fault domains

**The worker_thread is the decomposition and fault unit.** A poisoned book, an
unrecoverable parser bug, or a GC death-spiral is confined to that one shard worker's
few-hundred books; the host's main thread catches the worker's `'error'`/`'exit'` and
respawns it while every other worker keeps running.

Equally important, **GC is isolated per worker**: each worker is its own V8 isolate
with its own heap.

> **Decision: worker_threads, not separate processes.** Chosen for `SharedArrayBuffer`
> IPC ergonomics with **zero native code** — feed→arb publishing is an in-process SAB
> ring.

### IPC: feed shards → arb consumer

Discipline matters more than mechanism here, because the wrong queue policy converts a
slow consumer into a correlated stall.

**Mechanism — chosen: `SharedArrayBuffer` ring.** One SPSC ring per
feed-worker → arb worker, carved from a `SharedArrayBuffer` handed over at worker
spawn, lock-free via `Atomics` with a per-slot **seqlock** (write seq odd → write
payload → seq even; reader retries on odd/changed). Because the feed workers and the
arb worker live in the same process, the ring is just shared memory.

**Fallback for any genuinely cross-process boundary** (the tail-feed process, or an
order-placement process you've split off for a harder fault/risk boundary): **Unix
domain sockets** carrying binary packed frames (never JSON). Localhost UDS round-trips
run ~10–30µs — comfortably inside a low-ms budget — and you only put low-rate or
non-hot-path traffic across them, publishing coalesced top-of-book, not every level
update.

**Queue discipline — where correctness > latency bites:**

- **Feed → arb publish path: bounded ring, never block, coalesce-latest per book.**
  Blocking the reader stops it draining the socket → TCP backpressure → all ~2,000
  books on that connection go stale at once. So on a full ring, **overwrite the slot
  keyed by book id**. For an orderbook this is *lossless for the consumer*: top-of-book
  is a **latest-value signal, not an event log** — the newest state supersedes every
  pending prior update, and the arb engine only ever reads current best bid/ask + top-N.
- **In-shard book-apply path: must-not-drop, in-order, no coalescing.** Sequence
  continuity requires *every* diff in order; you cannot drop from the middle of a diff
  stream. If a shard can't keep up applying diffs, that *is* a `STALE`/`RESYNC`
  condition (per the orderbook FSM) and the signal to add a shard. **Only the
  post-apply publish coalesces; the pre-apply ingest never does.**

### Single-host core layout

- **Per-worker core pinning isn't available from JS** (no native code by choice, and
  Node exposes no per-thread affinity API). Pin each **host process** to a core-set with
  systemd `CPUAffinity` / `taskset` instead. To keep hot shards off the thin tail
  without per-thread pinning, run two host processes: a **hot** process (major-venue
  shard workers + the arb worker + order-placement) pinned to the **isolated cores**
  (`isolcpus` + `nohz_full` + `rcu_nocbs`), and a **tail** process (thin-venue workers,
  snapshotter, logging, metrics) pinned to the **housekeeping pool**. Within the hot
  process the scheduler spreads ~one hot worker per isolated core and they stay largely
  stationary — you trade strict 1:1 pinning for scheduler-managed placement; measure
  migration.
- **Steer NIC RX IRQs onto a housekeeping core** so packet interrupts don't jitter the
  hot cores.
- **NUMA:** prefer a **single-socket, high-clock** part — book-apply is latency-bound,
  not throughput-bound, so clock speed + large L2/L3 beats core count. If dual-socket
  is unavoidable, pin the **hot host process + NIC IRQs to the *same* node** and
  `numactl --membind` its memory to that node to avoid cross-node book reads.

---

## C. Orderbook Construction

### Read pattern reality

The arb engine almost always reads **top-of-book** (best bid/ask, sometimes top
5–25 levels) and rarely walks deep. Writes are insert/update/delete scattered but
**concentrated near the top**. Checksums (OKX/Bitget CRC32) need the **top 25 levels,
sorted**. So the structure must give O(1) best bid/ask, cheap sorted top-N, and fast
apply-by-price.

### Structure choice: sorted typed-array SoA (not a tree map)

| Option | Verdict |
|---|---|
| `Map<price,size>` + scan for best | **No** — insertion-ordered, finding best is a scan |
| **Sorted parallel typed arrays (SoA)** | **Yes** — best bid/ask is index 0 (O(1)); top-N is a slice; apply is binary-search + in-place update / small splice near the top; contiguous and cache-resident; no per-level objects = no GC pressure |
| Tree map / skip list | **No** in a managed runtime — pointer chasing + per-node objects = GC pressure and cache misses; only wins for huge, deep, uniformly-updated books, which crypto L2 is not |

**Per-book layout (structure-of-arrays, typed):**

```
bidPrice: Float64Array   bidSize: Float64Array   bidLen
askPrice: Float64Array   askSize: Float64Array   askLen
```

- Pre-size to a max depth (e.g. the venue's pushed depth + margin;).
- **Store prices as scaled integers** (`price × 10^tickDecimals`, kept within safe
  integer range) so comparison and CRC32 string-formatting are *exact* — this is what
  makes the crossed-book invariant and the checksum reliable (float equality is a
  desync-bug generator).
- **Apply:** binary-search the side by price; update size in place; `size == 0` ⇒
  delete (shift few elements near the top). **Best bid/ask:** `bidPrice[0]` /
  `askPrice[0]`. **Checksum:** read top-25 straight from the arrays — already sorted.

### Footprint at 30k books

Realistic pushed depth (tens to low-hundreds of levels) ⇒ ~2–8 KB of typed-array
payload per book ⇒ **~60–240 MB total** for all price-level data, plus the staleness
doc's SoA freshness arrays (~16 KB / 2,000-book connection, ~240 KB total). Low
hundreds of MB overall — trivial for RAM; the *hot* per-shard working set stays largely
in L2/L3. **At 30k books, GC pause time, not byte count, is the metric.**

### Crossing the boundary without tearing

Because every feed worker and the arb worker share one address space, each book's level
arrays (§C) are backed by a **`SharedArrayBuffer`** — single-writer (the owning feed
worker), readable by the arb worker **with no copy**. Two exposure paths, matched to the
two read shapes:

- **Top-of-book** (the common read): a per-book slot updated under an `Atomics`
  **seqlock** (write seq odd → write fields → seq even; reader retries on odd/changed).
  Cheap and tear-free.
- **Full-book reads** (now supported — the arb engine reads whatever depth it needs):
  use a per-book **double-buffer** — the writer builds into the inactive buffer and
  atomically flips an index; the reader follows the index to a stable snapshot. A
  seqlock over the whole multi-level region would let a deep reader livelock against a
  hot writer, so reserve the seqlock for the small projection and **double-buffer the
  full book.**

The owning worker is the **sole writer** of each book; the freshness SoA arrays
(staleness doc) live in the same shared segment, so the arb's freshness check and book
read touch one contiguous region. This preserves the staleness doc's "freshness checker
never touches the big L2 structures" decoupling while still letting the arb engine read
the full book when it wants to.

---

## F. Resource Optimization (CPU / RAM / NIC)

### CPU — "thread-per-core" in Node terms

Node offers *event-loop-per-isolate*, not Seastar-style thread-per-core. The closest
realization is **one feed-shard worker loop running on an isolated core** — i.e. the
topology in A (the hot host process is pinned to the isolated core-set and the scheduler
places workers across it, since per-worker pinning isn't available without native code).

- Pin the **hot host process** (shard workers + arb + orders) to the isolated cores;
  add **`nohz_full` and `rcu_nocbs`** on that set to kill timer-tick and RCU-callback
  jitter. In a managed runtime, **scheduler/timer jitter is your dominant tail-latency
  source — removing it beats any parse micro-opt.**
- **Capacity rule:** keep each hot loop **under ~70% core utilization** in steady
  state. The headroom absorbs reconnect storms (mass re-snapshot + replay) and GC. This
  rule *is* what sets your shard count in A.

### RAM — GC-pause avoidance is the entire game

- **Zero steady-state allocation on the hot path.** Pre-allocated typed-array books;
  object-pool any transient parse scratch; never create per-message objects. The lazy
  simdjson / scalar-extraction pattern (§0.4) keeps you reading spans, not allocating
  documents. Every avoided allocation is an avoided future GC.
- **Minimize young-gen churn** so scavenges stay rare/cheap and **major GC essentially
  never fires in steady state.** Size the young generation **per worker** via the
  `Worker` `resourceLimits.maxYoungGenerationSizeMb` option (bigger young gen ⇒ fewer
  scavenges) — worker_threads let you tune this per shard instead of one process-wide
  `--max-semi-space-size`; measure before tuning.
- **Treat GC as a correctness signal, not just a perf metric.** Instrument GC via
  `perf_hooks` / `--trace-gc`; **alarm on any major GC in a hot feed or arb worker** —
  it is a potential correlated multi-book stall.

### NIC / network

All venues are remote `wss` over the internet; you are **message-rate heavy, bandwidth
light** (L2 diffs are small). Optimize per-message cost and jitter, not Mbps.

- **`TCP_NODELAY` on every socket** (kill Nagle — it adds ms of jitter). Already in the
  WS-connection doc; keep it.
- **Enlarge `SO_RCVBUF`** to hold a few hundred ms of peak burst on majors, so a
  fast-market depth storm doesn't drop or backpressure into the exchange.

---

## G. Runtime & Orchestration

### Runtime / version

- **Node.js 24 (Active LTS)**

### Process supervision & lifecycle

- **systemd — not PM2, not a bespoke supervisor.** You already need per-unit
  `CPUAffinity`, `Nice`, `OOMScoreAdjust`, `LimitNOFILE`, `IOSchedulingClass` —
  systemd does all of this declaratively and is the OS's job-control truth. PM2 inserts
  a JS supervisor into the blast radius with weaker resource control.
- **Two-level supervision.** systemd supervises the **host process(es)** — the hot
  process and the tail process — with `Restart=on-failure`, `RestartSec` backoff, and
  `StartLimitIntervalSec`/`StartLimitBurst` so a crash-looping host can't hammer a venue
  (**supervision-level backoff mirroring the application-level resync-storm cap** in the
  orderbook FSM). The **host's main thread supervises its workers**: on `worker`
  `'exit'`/`'error'` it respawns the dead shard worker.
- **Crash recovery.** A **worker** crash → main-thread respawn → that worker reconnects
  and resyncs only **its** few-hundred books (each re-enters `INIT`, FSM transition 18)
  while the rest of the fleet is untouched. A **host-process** crash → systemd restart →
  all that process's workers respawn (the larger event). Either way the **snapshot/REST
  limiter** (token-bucket in front of `BUFFERING`'s fetch, per the FSM scale notes)
  prevents the resync from blasting hundreds of REST snapshots at once.
- **Graceful shutdown (SIGTERM)** hits the host process; the main thread broadcasts
  shutdown to each worker over its `MessagePort`, and each worker (1) flips its books
  `tradeable=false` / publishes `STALE` to the ring **first**, (2) sends normal-close
  unsubscribes, (3) flushes metrics; the main thread then `worker.terminate()`s them and
  exits within `TimeoutStopSec` (else SIGKILL).

### Configuration & deployment

- **Declarative desired-state, fleet-wide.** Lift the WS-connection doc's reconciliation
  model to the whole fleet: a small config service with a dynamic
  lists `(venue, symbol, market-type, tier)` tuples and the shard→connection→process
  mapping policy; each shard is handed its slice and continuously reconciles actual
  against desired.
- **Safe hot-reload of subscriptions — no restart.** Add/remove symbols by updating
  desired-state and signaling the **worker over its `MessagePort`** (`postMessage`) —
  not an OS signal, since signals are process-level — to re-reconcile.
  An **add** enters the orderbook FSM at `INIT` and is **never tradeable until `LIVE`**
  — safe by construction. A **remove** is unsubscribe + drop book. Rebalancing shards
  uses **make-before-break** (subscribe + fully resync the new location *before*
  dropping the old) so coverage never holes — the same discipline the WS doc applies to
  Binance's 24h cut.

### Observability — wired to the trust-state model

The WS-connection and staleness docs already enumerate the per-book/per-connection
metrics (last-update age, gap count, checksum failures, reconnect count, transit skew,
decode latency, cumulative staleness). Orchestration adds:

- **Export off the hot path.** On the hot loop, do only an O(1) counter increment or a
  histogram record into a pre-allocated structure (reuse the staleness doc's DDSketch /
  HDR-style histograms); a low-priority **metrics worker in the tail process reads the
  shared counter arrays directly (SAB) and exposes Prometheus**. Never serialize metrics
  on a hot loop.
- **Alerts keyed to FSM states, not arbitrary numbers:** a book sitting in
  `STALE`/`RESYNC`/`FAILED` past its tier budget; resync-storm cap tripped; a venue
  circuit breaker open; **any major GC in a hot worker**; a **dead shard worker**
  (heartbeat stall or a `worker` `'exit'`); transit-skew past the tier's p99-deviation
  budget. The dashboard shows, per venue, how many books are
  **LIVE / STALE / RESYNC / FAILED** — the trust model made visible.
- **State-transition log:** every FSM transition with a reason code, shipped off the hot
  cores — the 3am-forensics requirement.
- **Latency dashboards:** wire → parse → apply → publish → arb-read as histograms with
  p99/p99.9 tails. Measure spans with the **monotonic clock**
  (`process.hrtime.bigint()`), never wall-clock; use venue timestamps only for
  transit/freshness (per the staleness doc).

---

## How this slots into the existing docs

- **A** sets the *fault domains* the orderbook FSM's `transport_down → INIT` and the
  WS-connection FSM's per-venue circuit breaker operate within: a fault domain is a
  **worker** (hosted in a process), and "mark every book on that connection STALE"
  becomes the main thread seeing a dead shard worker (heartbeat stall or `'exit'`) and
  flagging its books.
- **C** is the concrete data structure under the FSM's "allocation-free in `LIVE`,
  pre-sized book, lock-free per-symbol" requirement, and under the staleness doc's
  SoA + seqlock/double-buffer exposure to the arb engine.
- **F** turns the staleness doc's signal *(j)* (local apply latency / queue depth as a
  first-class correctness signal) into a budget: ~70% core ceiling, zero-alloc hot path,
  GC-as-correctness-alarm.
- **G** makes the declarative-desired-state subscription model (WS doc) and the
  resync-storm / backoff caps (orderbook FSM) operational at the OS level via systemd
  (host processes) plus in-process worker supervision.