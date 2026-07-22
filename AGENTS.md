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

### Adding an auto-sync exchange (checklist)
Auto-sync pulls trades/deposits/withdrawals via a read-only exchange API key through the hosted relay's exchange tunnel (see `sololedger_claude_V3/src/lib/exchangeSync/README.md` for the full module architecture). Adding an exchange touches BOTH repos — one owner end to end:

**Relay (server repo):**
1. `server/src/routes/exchangeTunnel.ts` — add the exchange to the `EXCHANGES` host+allowlist map (spot REST hosts + path prefixes ONLY; no futures/margin hosts). The tunnel is a byte-pipe: no storage, no body logs.
2. `server/scripts/live-verify-exchange-tunnel.mjs` — add the tier-2 public probe (unauthenticated 200 + shape, e.g. a time endpoint) and the tier-3 dummy-key signature probe asserting the exchange's DISTINCTIVE auth error (Binance `-2015`, Kraken `EAPI:Invalid key`, Coinbase 401, OKX `50111`, KuCoin `400003`). Run both tiers against production after deploy and record results.

**Client core (`sololedger_claude_V3/src/lib/exchangeSync/`):**
3. `types.ts` — extend the `ExchangeId` union + `SYNC_EXCHANGES`; `EXCHANGE_API_SOURCES` in `lib/storage/db.ts` (the `'<id>_api'` stable-ref source).
4. `ccxtLoader.ts` — ctor options in `createExchangeClient` (spot-only scope: `defaultType`/`fetchMarkets`; disable `fetchCurrencies`-style signed extras — see the binance block), passphrase → ccxt `password` when required (OKX, KuCoin), `requiredCredentials` check, and the `syncErrorMessage` copy when a new error bucket is needed (error strings live here — keep them plain-language).
5. `engine.ts` — pagination plan: page-size caps, window caps (e.g. Binance 7-day trades rule → 6.5 d windows, 90-day transfer rule → 89 d), retention quirks (OKX fills ~3 months), launch-date floor in `EXCHANGE_LAUNCH_MS`, per-exchange fetch functions.
6. `normalize.ts` — §B-5b ref mapping that MUST collide with that exchange's CSV parser refs (native id first where the CSV has one — e.g. Kraken `refid`, OKX `ordId`; formula ref otherwise). Divergences are documented, never silently "fixed".
7. `__fixtures__/<exchange>/` — API fixtures per call shape + CSV twins for the dedup contract. Mark `"_recorded": false` + `_note` when hand-authored.
8. Tests — normalize tests per exchange, `dedup.contract.test.ts` collision + full-pipeline coverage, engine cursor/window coverage, tunnel/ccxtLoader assertions.

**Client UI (Import → Auto-sync):**
9. `autoSyncExchanges.ts` catalog — display entry, `keyInstructions` (where on the exchange to mint a READ-ONLY key), `needsPassphrase`.
10. One-line architecture note: exchange traffic rides the relay route `GET/POST /api/proxy/exchange/<id>/<path>` (JWT + active-subscription gated, per-exchange host allowlist) — the browser never talks to the exchange directly.

Binance caveat to check first when live-verifying: Binance geo-blocks the current relay egress (HTTP 451 `restricted location` → client `region_blocked` copy directs users to CSV import) — verify the relay region before promising Binance live.
