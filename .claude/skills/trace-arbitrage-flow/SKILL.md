---
name: trace-arbitrage-flow
description: Walks the ArbiNet data flow end-to-end for a given symbol and strategy (spread: spot-spot, spot-perp, perp-perp; or funding) — from WebSocket orderbook ingest through arbitrage detection to hedged trade execution, to trade monitoring, to trade exit — printing real state at each stage via the mcp-debugger MCP server. Use to understand the orchestrator init pipeline, debug why an opportunity did or didn't fire, or onboard onto the trade path.
---

# Trace Arbitrage Flow

Build a concrete, observed picture of how data moves through ArbiNet for one symbol/strategy. Source shows shape; the debugger shows values. Print real values — do not narrate from the code alone.

## Inputs to confirm before tracing
- **Symbol** (e.g. `ETH/USDT`)
- **Strategy** — `spread (spot-spot, spot-perp, perp-perp)` or `funding` (`STRATEGY` env / which prod config)
- **Exchanges** in scope (binance / bybit / okx / bitget)
If the user didn't say, ask before starting.

## The pipeline (where to look)

Orchestrator (`src/core/orchestration/orchestrator.ts`, extends EventEmitter) runs a 10-stage init:
1. REST clients → 2. Funding service → 3. Core services (orderbook, arbitrage engine) → 4. State service (Redis) → 5. Account sync → 6. Trading services → 7. WebSocket clients → 8. Funding fee collector → 9. Shutdown handlers → 10. State restoration

Trace the live path through these files:
1. **Ingest** — `src/adapters/websocket/**` public WS → orderbook deltas/snapshots.
2. **Book** — `src/core/orderbook/orderbookManager.ts`: merged book, best bid/ask per exchange. Check for crossed book, empty side, stale seq.
3. **Detect** — `src/core/arbitrage/arbitrageEngine.ts`: spread or funding-rate differential, profitability threshold, opportunity emit.
4. **Account state** — `src/core/state/accountStateManager.ts` / `accountSyncService.ts` / `stateService.ts`: balances, open positions, Redis-backed.
5. **Execute** — `src/core/trading/tradeExecutor.ts` (+ `tradeMonitor.ts`, `utils.ts`): two-leg hedged order placement + fill monitoring.
6. **Monitor** — `src/core/trading/tradeMonitor.ts`: order status, fill details, P&L tracking.
7. **Exit** — `src/core/trading/tradeMonitor.ts`: position closure, profit/loss settlement.

## Trace procedure (mcp-debugger)

1. `npm run debug` in background → attach (`create_debug_session` → `attach_to_process` 127.0.0.1:9229).
2. Set breakpoints at each stage boundary for the target symbol. Use conditional breakpoints to fire only on the chosen symbol, e.g. condition `symbol === 'BTC/USDT'`.
   - orderbook update handler in `orderbookManager.ts`
   - opportunity-evaluation method in `arbitrageEngine.ts`
   - executor entry in `tradeExecutor.ts`
3. `continue_execution`; poll `list_debug_sessions` for `paused` (init ~15–25s).
4. At each stop print REAL values:
   - `get_local_variables`, `get_stack_trace`
   - `evaluate_expression` to JSON-stringify nested Maps/Sets (best bid/ask per exchange, computed spread, threshold, account state) that `get_variables` truncates.
5. Record per stage: input value in → transform → value out → branch taken (fired / skipped, and why).
6. `continue_execution` → `close_debug_session` → kill background process.

**Breakpoints unbound?** Re-run `npm run debug` — stale `dist/` vs `src/` breaks sourcemap line mapping.

## Output

A stage-by-stage trace table for the symbol: stage | file:line | observed value | branch/decision. Call out exactly where an opportunity was rejected (threshold, crossed book, insufficient balance, hedge sizing) when debugging a no-fire case. Observed values only.
