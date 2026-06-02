---
name: verify-runtime
description: Runs the Runtime Verification Protocol — prove a code change works by observing real values at runtime via the mcp-debugger MCP server, not by assuming. Use when verifying a change to src/, confirming a fix, checking an edge case, or before claiming something works. Pairs with temp logging and live breakpoint inspection.
---

# Verify Runtime

Enforce the CLAUDE.md rule: a task is NOT complete when code is written. Complete only when OBSERVED behaving correctly at runtime. Never write "this should work" — write "I ran X, observed Y, matches Z".

## When to use
- After any change under `src/`.
- To confirm a specific failure path, state transition, or edge case fires.
- To inspect in-memory state source can't reveal: orderbook snapshots, account-state Maps, closure vars in async chains, real error chain when catch re-throws.

## Protocol (6 steps)

1. **IDENTIFY observable behavior** — what happens at runtime? Inputs, outputs, side effects, state transitions for the changed code.

2. **ENUMERATE input space before testing.** Write the list first:
   - Happy path
   - Boundary (0, -1, empty, max, off-by-one neighbors)
   - Null / undefined / NaN / empty-string
   - Malformed / unexpected types
   - Concurrent / out-of-order (relevant for WS streams + async order paths)

3. **INSTRUMENT.** Choose:
   - Temp logs printing REAL values at every decision point + state mutation. Prefix `// TEMP-VERIFY` for clean removal.
   - mcp-debugger for live inspection without editing source (preferred for in-memory state).
   - VS Code logpoints for loops/async (no pause = no timing distortion); conditional breakpoints firing only on suspicious values.

4. **EXECUTE** against every case from step 2. Capture real output.

5. **COMPARE** observed vs expected. If they differ, decide: code wrong OR mental model wrong — investigate which before changing anything.

6. **CLEAN UP** all `// TEMP-VERIFY` instrumentation. State which cases ran + what was observed.

## mcp-debugger workflow

1. Start `npm run debug` in background (compiles to `dist/`, pauses at entry on port 9229).
2. Create session + attach:
   - `create_debug_session({ language: 'javascript' })`
   - `attach_to_process({ sessionId, host: '127.0.0.1', port: 9229 })`
3. While paused at entry, set breakpoints against `.ts` source (sourcemaps translate):
   - `set_breakpoint({ sessionId, file: '<repo>/src/core/.../foo.ts', line: 42 })`
4. `continue_execution`. Poll `list_debug_sessions` until `state` flips `running` → `paused`. Orchestrator init takes ~15–25s — non-init breakpoints don't fire instantly.
5. Inspect: `get_stack_trace`, `get_local_variables`, `get_variables`, `evaluate_expression`. Use `evaluate_expression` to JSON-stringify nested Maps/Sets that `get_variables` truncates. Mutate vars mid-run to drive a downstream path (e.g. force a reject to test hedge rollback).
6. `continue_execution` → `close_debug_session` → kill background process.

**Breakpoints stay unbound?** `dist/` stale vs `src/`. Re-run `npm run debug` after any `.ts` edit — sourcemap lines must match current source.

## Report

End with: cases run, real values observed per case, pass/fail vs expected. No "should work" — only observed facts.
