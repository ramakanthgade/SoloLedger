# AGENTS.md

## Cursor Cloud specific instructions

### Project layout
- The actual app lives in the `sololedger_claude_V3/` subdirectory, not the repo root. Run all `npm` commands from there (`cd sololedger_claude_V3`).
- SoloLedger is a fully client-side Vite + React + TypeScript app (no backend). Persistence is browser IndexedDB (Dexie). Standard commands are in `sololedger_claude_V3/package.json` and `sololedger_claude_V3/README.md`.

### Running the app
- Dev server: `npm run dev` (Vite, serves on `http://localhost:5173`). Use `npm run dev -- --host` if you need it reachable on the VM network interface.
- No environment variables or accounts are required; the two optional network features (price lookup, wallet RPC lookup) are off by default.

### Non-obvious caveats
- `npm run build` (`tsc -b && vite build`) currently fails on pre-existing `TS6133` "declared but never read" errors (`ColumnMappingForm.tsx`, `costBasis/fifo.ts`, `costBasis/specId.ts`). This is a code issue unrelated to environment setup; the dev server does not type-check and runs fine.
- `npm run lint` fails because `eslint` is not in `devDependencies` and there is no eslint config committed. The `lint` script is effectively non-functional in this repo.
- The manual-entry form's Asset field is required; the visible "BTC" text is only a placeholder, so the "Add transaction" button stays disabled until Asset is actually typed in.
