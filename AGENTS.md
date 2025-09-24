# Repository Guidelines
This guide summarizes how to contribute to ArbiNet’s cross-exchange arbitrage engine.

## Project Structure & Module Organization
`src/main.ts` boots the orchestrator and pulls domain logic from `src/core` (arbitrage, funding, markets, orchestration, trading, orderbook). Exchange connectors live under `src/adapters/rest` and `src/adapters/websocket`; shared utilities are in `src/utils`, with type declarations in `src/types`. Tests sit beside their targets inside `src/core` as `*.test.ts`. Environment-specific settings belong in `config/*.yaml`, compiled bundles in `dist/`, and captured logs in `logs/`.

## Build, Test, and Development Commands
- `npm install` – install or update dependencies.
- `npm run dev` – hot-reload development runner via `ts-node-dev`.
- `npm start` – launch the runtime through `ts-node` with production flags.
- `npm run build` – emit TypeScript output into `dist/`.
- `npm run lint` – check ESLint rules; fixable issues respond to `npm run format`.
- `npm test` – run the Jest suite; add `--watch` for focus mode.

## Coding Style & Naming Conventions
Target Node.js 22.12 and TypeScript strict mode. Use two-space indentation, single quotes, and trailing commas where allowed. Let Prettier and ESLint own formatting—avoid manual restyling. Name exported classes and types with `PascalCase`, functions and variables with `camelCase`, and reserve `SCREAMING_SNAKE_CASE` for module-level constants. Prefer small, composition-friendly modules over large files.

## Testing Guidelines
Author Jest specs alongside code as `<module>.test.ts`, mirroring domain terminology in `describe` blocks. Cover success paths plus edge conditions like empty orderbooks or stale funding data. Use `config/test.yaml` for deterministic inputs and stub exchange clients rather than hitting live endpoints. Run `npm test` locally before committing; add `--coverage` when touching pricing or execution logic.

## Commit & Pull Request Guidelines
Keep commits focused and imperative (e.g., `integrate funding data into arbitrage opportunity finding`). Reference related tickets in the body when applicable. Pull requests should include: concise summary, risk callouts (markets, adapters, orchestration), validation evidence (`npm test`, manual steps), and follow-up notes. Attach logs or screenshots when behavior changes.

## Security & Configuration Tips
Load API keys and secrets from an untracked `.env`; never commit credentials. Document any new configuration keys inside `config/development.yaml` comments or the tech spec. When altering rate limits or order execution parameters, flag the change so operators can update production settings safely.
