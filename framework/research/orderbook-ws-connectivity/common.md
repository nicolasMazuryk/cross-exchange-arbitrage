## D. Numerical Correctness
*(New — non-negotiable given the correctness requirement.)*

- **No IEEE-754 floats for money. Ever.** JS `Number` is float64. Use **scaled integers / BigInt** on the hot path (fast) or a decimal library on the cold path (safe, slow). Pick the boundary deliberately. A `0.1 + 0.2`-class bug in a fee calc is a real outage.
- **Branded types** for `Price`, `Qty`, `Notional`, `VenueId` so the compiler blocks adding a price to a quantity.
- **Rounding discipline** — round *toward* exchange constraints (size down to lot, price to tick in the conservative direction). Define rounding direction per field; wrong-direction rounding gets orders rejected or filled at unintended sizes.


## J. State, Persistence & Recovery

- **Source-of-truth design** — exchange is truth, local is cache; on restart, reconstruct from exchange + durable journal.
- **Durable order journal / WAL** — append-only log of every intent and event, so a crash mid-trade is recoverable and auditable.
- **Crash recovery** — deterministic state reconstruction, idempotent replay, no double-sends after restart.


## L. Concurrency & Async Model

- **Event-loop discipline** — never block the loop; the hot path is allocation- and parse-sensitive.
- **Backpressure** — when a venue floods you, use bounded queues with a drop/coalesce policy, not unbounded memory growth.
- **Single-writer per book/position** — avoid locks and races.


## M. Architecture & Topology

- **Process decomposition** — per-venue gateway processes vs in-process adapters; separate OMS / risk / strategy vs co-located. On a **single host / single region**, lean toward a **small number of processes** (gateways isolated from the strategy/OMS core) over **Unix domain sockets or shared memory**, not microservice sprawl. The failure isolation of separate gateway processes is worth it; network-style decomposition on one box is just latency tax.
- **Hot path vs cold path separation** — order entry / market data vs reference data / accounting / reporting.


## N. Performance & Resources

- **Latency-budget decomposition** — wire → parse → normalize → signal → risk → sign → send, with a number on each.
- **Allocation reduction & GC tuning** — object pooling; avoid `JSON.parse` on the hot path (binary/streaming parsers); zero-copy buffers.


## O. Failure Modes & Resilience

- A real **failure taxonomy** — network; exchange-side (rejects, halts, maintenance); internal (bug, OOM); data (desync, bad book).
- **Degraded-mode operation** — one venue down → keep trading the rest, don't halt everything; graceful drain/shutdown; poison-message handling.
