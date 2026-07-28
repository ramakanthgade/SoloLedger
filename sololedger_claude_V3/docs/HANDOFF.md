# SoloLedger — Session Handoff (2026-07-27)

## Where we are

**PR #61 (`fix/binance-trade-completeness`)** — pushed, 2 commits, ready for review/merge:
1. `977946c5` — full spot-symbol scan on initial Binance sync (fixes 7% API trade coverage).
2. `79faf3d7` — stitch OLD-era (2017-2021) simple `Sell`+`Buy`+`Fee` trades in the
   Transaction History CSV parser (fixes 53% of fills silently dropped) + UTC timestamp fix.

**Verified on the user's real 28,928-row Binance Transaction History export:**
- Spot-trade recovery 47% → ~100%. Deposits 331≥251, withdrawals 359≥279.
- All 157 parser tests pass (28 files). tsc clean. vite build exit 0.
- Ground-truth CSVs live at `C:\Users\ramak\.hermes\desktop-attachments\` (Trade/Deposit/
  Withdraw/Transaction History, 2017→2026). Real-data tests: `src/lib/parsers/binanceRealData.verify.test.ts`,
  `src/lib/parsers/binanceCoverage.verify.test.ts`.

## Key diagnosis (do NOT re-litigate)

- Binance API **discontinued pre-Sept-2022 trade history (Nov 2024)** — myTrades/allOrders
  can't return it. Deposits/withdrawals ARE full-history via API. So: **CSV backfill for old
  trades + API for recent/incremental** is the only complete architecture (matches Koinly/
  CoinTracker/CoinLedger — they ALL require CSV for history).
- Industry standard: import **Transaction History CSV** (the full ledger), NOT Trade+Dep+WD.
  Koinly explicitly excludes the Spot Trade History file to avoid dupes.
- Two ledger eras: OLD (2017-2021) = simple `Buy`/`Sell`/`Fee`; NEW (2020+) = `Transaction
  Buy/Spend/Fee` triplet. Both now stitched.

## Remaining work (in order)

### A1 — Non-spot stitchers (Binance Transaction History) → literal 100% of 28,928 rows
The ~830 non-spot rows currently dropped. Each is a small additive handler in
`src/lib/parsers/binanceStitch.ts` + a real-data assertion. Operations to handle (counts):
- Futures: `Realized Profit and Loss` (248), `Funding Fee` (25) → income/fee USDT, category perp.
- Income: `Commission Rebate` (208), `Referee Commission` (165), `Distribution` (31),
  `Staking Rewards` (10), `Airdrop Assets` (10), `Launchpool Airdrop - User Claim Distribution` (24),
  `Commission History` (19), `Asset Recovery` (4), `Token Swap - Distribution` (4),
  `Campaign Related Reward` (1) → type income. NOTE: INCOME_OPS set has name mismatches —
  these exact strings must be added.
- Dust convert: `Small Assets Exchange BNB` (86) → trade (dust→BNB).
- Internal acct transfers: `Transfer Between Spot and Funding/CM/UM/Options` (190) → already
  partially handled; confirm isInternalTransfer.
- Fiat: `Fiat Withdraw` (16) → decide handling (probably skip or fiat ledger).
Goal: every recognized operation maps to a tx; coverage test asserts zero recognized-op drops.

### A2 — Generic stitching engine (reuse across all 109 CCXT exchanges)
Refactor so the STITCHING LOGIC (leg-pairing, Buy/Sell/Fee→trade, deposit/withdrawal/income
classification) is exchange-AGNOSTIC, driven by a per-exchange OPERATION-MAP (declarative
table: operation-string → semantic role). New exchange = new operation-map, NOT new stitcher.
Prove by the Binance real-data tests still passing after refactor. DO NOT attempt a universal
"any CSV" reader in one shot — semantics differ per exchange; the generic part is the
stitching, the per-exchange part is the op-map.

### Reconciliation engine (dashboard correctness)
Design doc: `docs/reconciliation-engine-design.md`. Balance-authority display (exchange
fetchBalance / on-chain RPC as the holding qty) + "N balances don't match" report (ledger vs
authority cross-check). This is what makes the dashboard match Binance/Koinly ($ amounts)
instead of ledger-reconstruction phantoms.

## Env / gotchas
- node_modules is flaky under git stash on this MSYS box — if vitest/tsc vanish, `npm install`.
- Run tests: `cd sololedger_claude_V3 && npx vitest run src/lib/parsers` (or full suite).
- Build: `npx vite build`. tsc: `npx tsc -b`.
- gh CLI: `C:\Program Files\GitHub CLI\gh.exe`, authed ramakanthgade.
- DO NOT commit `node_modules` (it has a pre-existing tracking issue — leave it unstaged).
- User's real backup for reference: `C:\Users\ramak\Downloads\sololedger-backup-2026-07-27 (1).json`.
