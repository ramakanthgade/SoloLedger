# SoloLedger — Private Crypto Tax

Import parsing, tax calculations, ledger storage and report generation run in your browser.
Create an account for managed connected services, or continue without an account for local
file imports and calculations. Provider-key mode is retired; legacy keys are disabled.

Local historical fiat conversion asks permission for each import/recovery batch before
using Frankfurter directly. Only currency codes and dates are sent, along with ordinary
connection metadata (IP address and browser headers); amounts, addresses and raw files
are not sent. Decline/dismiss makes no lookup requests, including no cache-based conversion.
USD and USDT remain different. Unsupported/unavailable rates stay unset for manual totals
in Review. Actual reference-rate dates and provider provenance are retained.

Your account is **not a backup or cross-device sync**. Signing in or out retains the selected
same-origin browser ledger. Existing hosted database files are not deleted or merged. In Settings → Your data, use
**Discover browser ledgers** to explicitly open an older local or account ledger, then
export its backup. Selection reloads the app; it does not combine ledgers or overwrite
other databases. You can return to the previous ledger through the same control.
JSON backups are **sensitive and unencrypted**. Encryption is a separate deferred security
feature. Restore replaces local data; export a current copy before restoring or changing
browser/device. Optional AI shares financial summaries and your question via the relay to
OpenRouter; no on-device language model or confidential enclave is claimed.

## What's implemented

- **Storage**: IndexedDB via Dexie — the only persistence layer. Full backup
  export/import as JSON, and a one-click "delete all data" in Settings.
- **Import**:
  - CSV upload with auto-detection for Coinbase and Binance
  - Manual column-mapping form for any other CSV shape (map headers + map
    each distinct "type" value in your file to a SoloLedger transaction type)
  - Manual single-transaction entry form
  - Managed read-only wallet lookup requires an account. Providers receive queried
    addresses and normal connection metadata. No customer provider keys are required.
- **Dashboard**: one coherent, cutoff-aware financial snapshot powers Total Net
  Worth, remaining Cost Basis, Unrealized P&L, chart, allocation, holdings,
  selected-period activity, and India tax/TDS. FY and Custom selections retain
  their nominal filing range while values clamp to the coherent local read
  time. Historical values replay the local ledger and opening balances; known
  unpriced quantities remain partial contributors rather than fabricated zeroes.
  The Dashboard publishes period and values atomically and contains no sync,
  reconciliation, or Data Health operations.
- **Connections**: owns sources, sync/history, opening balances, reconciliation,
  and Data Health. Dashboard activity cards deep-link to Transactions with the
  exact selected period, category, and contributor set.
- **Cost basis engine**: FIFO, LIFO, HIFO, and Specific Identification. Trade
  (asset-for-asset swap) transactions are split into a linked
  disposal + acquisition pair so both legs get proper cost basis treatment.
  The Transactions tab's "match lots" picker lets you choose which lots a Specific
  ID disposal draws from; anything you don't explicitly order falls back to
  oldest-lots-first for the remainder.
- **Valuation**: imported reporting-currency totals and confirmed zeros are retained.
  Foreign execution quotes stay available for explicit historical fiat conversion or
  manual reporting-currency totals in Review. Managed asset pricing requires an account.
- **Jurisdictions**: India (default), US, Canada, UAE — each a small pure-
  function rules module layered on the same disposal data, so adding a new
  country doesn't touch the calculation core.
- **Reports**: local PDF (jsPDF), CSV, and JSON export, each with a
  de-identification toggle that locally SHA-256-pseudonymizes wallet
  addresses/tx references (or you can extend it to summary-only) before
  anything is written to disk.
- **Transactions**: search/filter, bulk "mark as internal transfer," missing-price
  banner with one-click backfill, and the Specific ID lot picker.
- **Pricing**: strict legacy and canonical-v2 historical cache identities,
  exact-contract precedence, safe symbol fallback, historical closes no older
  than 48 hours, and current spot marks no older than 15 minutes.
- **Feature flagging**: `src/lib/features.ts` — a minimal tier system so
  advanced features can later be gated behind a license key without
  restructuring the app. Everything currently ships unlocked.

## Known approximations worth knowing about

- **CoinGecko symbol map**: only common tickers are mapped to CoinGecko's
  internal coin ids out of the box (`src/lib/pricing/coingecko.ts`). Extend
  `SYMBOL_TO_ID` for anything else, or enter values manually.
- **CoinGecko rate limits**: the free tier is aggressively rate-limited;
  the batch fetcher paces requests ~1.5s apart, so backfilling hundreds of
  missing prices will take a while and may need retries.
- **Specific ID candidate pools**: the lot picker shows what's open *given
  how every earlier disposal was matched under the method currently
  selected*. If you switch methods after saving lot choices, re-check them —
  the available pool can shift.
- **RPC wallet lookup**: imports everything as `transfer_in`/`transfer_out`
  by default (a raw explorer/RPC feed can't tell you if a transfer was a
  sale, a purchase, or a wallet-to-wallet move) — review and reclassify
  after importing.
- **Alchemy's free tier** (30M compute units/month) comfortably covers
  personal-scale lookups but isn't unlimited — very large wallets or many
  dozens of addresses in one sitting could approach it.
- **Solana lookups** fetch each transaction individually after listing
  signatures (`getSignaturesForAddress` + `getTransaction`), paced to stay
  under free-tier throughput — large histories will take a little while.
- **"Other EVM chain" fallback** is a legacy developer integration, not a customer key setup. Historically used keys from
  whichever explorer you point it at (Etherscan itself now paywalls some
  chains on its free tier — see the note on this in Settings).

## Run locally

```bash
npm install
npm run dev
```

Then open the printed local URL (typically `http://localhost:5173`). No
environment variables or accounts are required — the app works fully
offline after the first load (PWA service worker caches assets), aside from
optional historical fiat lookup. Account services require a network connection.

To build a production bundle:

```bash
npm run build
npm run preview
```

## Testing with real data

1. Connections → add/import a source (auto-detected Coinbase/Binance CSV,
   manual mapping, exchange connection, or wallet lookup).
2. Transactions → categorize flagged transactions, mark internal transfers,
   backfill missing prices, and (if using Specific ID) match lots for
   disposals.
3. Dashboard → select This/Last/prior tax year or a Custom range and review the
   coherent cutoff values, activity, holdings, and limitations disclosure.
4. Capital Gains / Reports → review disposals and export PDF/CSV/JSON.
5. Settings → export a full backup once you're happy with the data.

Your data stays in this browser's IndexedDB. Clearing browser storage for
this site deletes it — export a backup regularly if you want a portable copy.

## Future enhancements

- Deeper DeFi support: LP positions, lending/borrowing interest, liquidation
  events, wrapped-asset tracking
- NFT cost basis edge cases (royalties, floor-price estimation for missing data)
- Multi-year carryforward loss tracking where jurisdictions allow it
  (scaffolded in `lib/features.ts` as `multi_year_carryforward`)
- Desktop wrapper (Tauri) for a fully offline installable app with native
  file system access instead of browser storage
- Rule-based → ML-assisted transaction categorization
- Real license-key validation to back the feature-flag scaffold
