# AGENTS.md

## Cursor Cloud specific instructions

### Project layout
- The actual app lives in the `sololedger_claude_V3/` subdirectory (not the repo root). Run all npm commands from there.
- `sololedger_claude_V3` is **SoloLedger**, a fully client-side React 18 + Vite + TypeScript SPA for crypto capital-gains/tax reporting. There is **no backend**; all data persists in the browser (IndexedDB via Dexie). The only network calls are two opt-in features (price lookup, wallet/RPC lookup), both off by default.

### Running (single service: Vite dev server)
- Dev server: `npm run dev` in `sololedger_claude_V3/` (serves on `http://localhost:5173`). This is the development workflow — it uses Vite only and does **not** run the TypeScript type-checker, so it starts even though `tsc` reports errors (see below).

### Known pre-existing issues (not environment problems)
- `npm run lint` fails: the `lint` script calls `eslint`, but ESLint is not in `devDependencies` and there is no ESLint config. This is a repo config gap, not a setup issue.
- `npm run build` fails: `build` runs `tsc -b && vite build`, and there are pre-existing TypeScript errors (unused vars, `unknown`-typed values). `vite build` itself is fine; only the `tsc` typecheck fails. Development via `npm run dev` is unaffected.
