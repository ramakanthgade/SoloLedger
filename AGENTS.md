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
- `npm run build` runs `tsc -b && vite build` and currently succeeds.
- `npm run lint` uses the committed ESLint configuration and currently exits 0 with no errors; it may emit accepted warn-level warnings.
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

### Hyperliquid perpetual trades — CSV column map & classification
Hyperliquid Trade History CSV uses abbreviated headers. Map UI → CSV as:
| UI label | CSV column |
|----------|------------|
| Time | `time` (`DD/MM/YYYY - HH:mm:ss`) |
| Market | `coin` |
| Direction | `dir` (`Open Long` / `Open Short` / `Close Long` / `Close Short`) |
| Price | `px` |
| Size | `sz` |
| Trade Value | `ntl` (USDC notional) |
| Fee | `fee` (USDC) |
| Closed PNL | `closedPnl` (USDC) |

Deposits/withdrawals CSV: `time`, `action`, `source`, `destination`, `accountValueChange`, `fee`.

**Import rules (cash-settled perps — never create spot lots for the `coin`):**
- Every fill fee → `fee` USDC (`category: perp`, `instrumentClass: derivative`)
- Open/Add fills: ignore `closedPnl` (it equals `−fee` in HL exports)
- Close/Liquidate with `closedPnl > 0` → `income` USDC (`category: perp`)
- Close/Liquidate with `closedPnl < 0` → `fee` USDC (`category: perp_loss`) so portfolio decreases without a fake taxable USDC disposal
- Deposit → `transfer_in` USDC; Withdraw → `transfer_out` USDC (`category: perp_collateral`)

**Tax presentation (Settings → Derivatives tax treatment):**
- Defaults: IN/CA → `business_income`; US/AE → `capital_gains` (user can override)
- Applied at **report time** (Capital Gains / Reports) — does not rewrite stored txs
- Business income: profits in Derivatives income; fees + losses in Derivatives expenses; net = income − expenses
- Capital gains: each Close uses exit notional as proceeds and (exit notional − closedPnl) as cost
  (= implied open notional). Gain = closedPnl. Trading fees excluded from CG rows (same as spot).
- Review: All | Spot | Derivatives filter + pagination (200/page)

### Adding a chain (EVM mainnet checklist)
Four edit points, all client-side (`sololedger_claude_V3/src`):
1. `lib/rpc/providers.ts` — add the id to the `ChainId` union AND a `CHAINS` entry (`provider: 'alchemy_evm'`, `alchemyNetwork: <slug>`, `needsKey: true`), inserted before `custom_evm`. Add a `COINGECKO_PLATFORM` entry when CoinGecko has an asset platform for the chain id (check `https://api.coingecko.com/api/v3/asset_platforms`, match `chain_identifier`); leave a `// no CoinGecko asset platform` comment when it doesn't. Add an `ETHERSCAN_V2_CHAIN_IDS` entry when the chainid answers on Etherscan V2's free tier (chains that are RPC-only on Alchemy NEED this — V2 is their import path, via the any-Alchemy-failure → V2 fallback, same as mantle).
2. `lib/rpc/moralis.ts` — add the id to `DIRECT_PROBE_CHAINS` so auto-detect step 3 probes it. A chain Moralis never served needs NO other Moralis change: no `MORALIS_CHAIN` entry means `getMoralisChain` returns null and imports skip Moralis automatically. Do NOT add it to `MORALIS_DROPPED_CHAINS` (that set means "Moralis 400s on a slug it once served").
3. Native-asset pricing — add the native symbol → CoinGecko coin id to `SYMBOL_TO_ID` in `lib/pricing/coingecko.ts` when one exists.
4. Tests — `lib/rpc/newChains.test.ts` pins the registry entries; update probe-mock coverage in `moralisActiveChains.test.ts` (its `PROBE_NETWORKS` is derived from `DIRECT_PROBE_CHAINS`, so new chains must stay probeable).

Verifying a candidate chain against the production relay (the relay passes ANY Alchemy network slug through — no server change needed; scripts: `/var/tmp/probe-new-chains.mjs`, `/var/tmp/probe-missing-chains.mjs`):
```bash
# login first: POST /api/auth/login {email,password} → token
# (a) true numeric chain id:
curl -X POST "$RELAY/api/proxy/alchemy/<slug>" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# (b) Enhanced API support (the import path) — 200 with a result.transfers array:
curl -X POST "$RELAY/api/proxy/alchemy/<slug>" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{"fromAddress":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","category":["external"],"maxCount":"0x1"}]}'
```
Re-verify the native asset symbol against chainid.network before finalizing (rebrands happen — e.g. Fraxtal's gas token is FRAX post North Star, Stable's is USDT0).
