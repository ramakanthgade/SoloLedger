# SoloLedger — Private Crypto Tax

A fully client-side crypto capital gains and tax reporting tool. Everything —
parsing, calculation, storage, and report generation — runs in your browser.
There is no backend, and no data is transmitted anywhere unless you explicitly
export a file or turn on one of the two optional network features (live price
lookup, RPC wallet lookup), both off by default and clearly indicated by the
badge in the top-right of the app at all times.

## What's implemented

- **Storage**: IndexedDB via Dexie — the only persistence layer. Full backup
  export/import as JSON, and a one-click "delete all data" in Settings.
- **Import**:
  - CSV upload with auto-detection for Coinbase and Binance
  - Manual column-mapping form for any other CSV shape (map headers + map
    each distinct "type" value in your file to a SoloLedger transaction type)
  - Manual single-transaction entry form
  - Optional read-only wallet lookup covering Bitcoin, Ethereum, Polygon,
    Arbitrum, Base, BNB Smart Chain, Optimism, Avalanche, and Solana — off
    by default. Bitcoin uses Blockstream/mempool.space (free, no key).
    Every other chain runs on one free Alchemy API key (entered once in
    Settings, reused everywhere), plus a manual Etherscan-compatible
    fallback for anything else. Paste in multiple addresses at once (one
    per line) and it queries all of them in a single job. Every explorer,
    free or paid, sees the address you query — there's no way around that
    for any hosted lookup service; the only true alternative is running
    your own full node. See the in-app warning and Settings for specifics.
- **Cost basis engine**: FIFO and Specific Identification, chosen per report
  run. Trade (asset-for-asset swap) transactions are split into a linked
  disposal + acquisition pair so both legs get proper cost basis treatment.
  The Review tab's "match lots" picker lets you choose which lots a Specific
  ID disposal draws from; anything you don't explicitly order falls back to
  oldest-lots-first for the remainder.
- **Pricing**: optional historical price backfill via CoinGecko's public API
  (Settings → "Live price lookup"). Only an asset symbol and a date are sent —
  never wallet addresses, amounts, or anything else. A "Fetch missing prices"
  button appears in Review whenever transactions are missing a fiat value.
- **Jurisdictions**: India (default), US, Canada, UAE — each a small pure-
  function rules module layered on the same disposal data, so adding a new
  country doesn't touch the calculation core.
- **Reports**: local PDF (jsPDF), CSV, and JSON export, each with a
  de-identification toggle that locally SHA-256-pseudonymizes wallet
  addresses/tx references (or you can extend it to summary-only) before
  anything is written to disk.
- **Review**: search/filter, bulk "mark as internal transfer," missing-price
  banner with one-click backfill, and the Specific ID lot picker.
- **Portfolio**: holdings and cost basis computed live from local transaction
  history.
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
- **"Other EVM chain" fallback** needs an Etherscan-family API key from
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
the two opt-in network features described above.

To build a production bundle:

```bash
npm run build
npm run preview
```

## Testing with real data

1. Import tab → CSV upload (auto-detected for Coinbase/Binance, or map
   columns manually for anything else), Manual entry, or Wallet lookup.
2. Review tab → categorize flagged transactions, mark internal transfers,
   backfill missing prices, and (if using Specific ID) match lots for
   disposals.
3. Portfolio tab → sanity-check holdings match what you expect.
4. Reports tab → pick jurisdiction, year, and method, then export PDF/CSV/JSON.
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
