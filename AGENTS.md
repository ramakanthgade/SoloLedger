# AGENTS.md

## Cursor Cloud specific instructions

### Project layout
- The actual app lives in the `sololedger_claude_V3/` subdirectory, not the repo root. Run all `npm` commands from there (`cd sololedger_claude_V3`).
- SoloLedger is a fully client-side Vite + React + TypeScript app (no backend). Persistence is browser IndexedDB (Dexie). Standard commands are in `sololedger_claude_V3/package.json` and `sololedger_claude_V3/README.md`.

### Running the app locally (Chrome / Edge)
```bash
cd sololedger_claude_V3
npm install
npm run dev
```
Then open **http://localhost:5173** in your browser.

For Cursor Cloud port forwarding, Vite is configured with `server.allowedHosts` for `*.cursorvm.com` and `*.agent.cvm.dev`.

Wallet lookup on `npm run dev` routes Alchemy calls through a same-origin Vite proxy (`/alchemy-rpc/*`) because direct browser → Alchemy requests are blocked by CORS for some RPC methods.

### Non-obvious caveats
- `npm run build` (`tsc -b && vite build`) currently fails on pre-existing `TS6133` "declared but never read" errors (`ColumnMappingForm.tsx`, `costBasis/fifo.ts`, `costBasis/specId.ts`). The dev server does not type-check and runs fine.
- `npm run lint` fails because `eslint` is not in `devDependencies` and there is no eslint config committed.
- Wallet lookup requires enabling **Settings → Wallet address lookup** and an Alchemy API key for EVM/Solana chains. Bitcoin uses Blockstream (no key).
- Browser IndexedDB data (settings, transactions) is per-browser and per-origin — it does not sync between Cloud preview and your local Chrome.

### Binance Transaction History — classification rules
- **Spot trades** (`Transaction Buy` + `Spend` + `Fee`, `Transaction Sold` + `Revenue` + `Fee`) are stitched into single buy/sell rows with USDT cost basis.
- **P2P trading** (`P2P Trading` operation, or `Withdraw` with P2P in the remark):
  - **Incoming crypto** (positive `Change`) → `buy` — opens a cost-basis lot (your funding/buy side).
  - **Outgoing crypto** (negative `Change`) → `sell` — taxable disposal in capital gains / Reports.
  - Not treated as `transfer_in` / `transfer_out` because the counterparty is another person, not your own wallet.
  - User can override any row in Review → mark as **internal transfer** if it was actually between their own accounts.
- **Deposits / withdrawals** (on-chain, non-P2P) stay as `transfer_in` / `transfer_out` — mark internal transfer in Review when moving between your own wallets.
