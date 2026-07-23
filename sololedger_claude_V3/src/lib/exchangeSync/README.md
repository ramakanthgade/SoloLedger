# Exchange Auto-Sync (client core)

Pull trades/deposits/withdrawals directly from a user's exchange API key
(read-only) into the normal SoloLedger transaction store — initial full
history + incremental syncs — with zero new dedup machinery: synced rows
carry `sourceRef`s that collide with the CSV parsers' refs, so the existing
`deduplicateTransactions()` removes API↔CSV twins automatically.

Supported exchanges (v1): **binance, coinbase, kraken, okx, kucoin** — the
`ExchangeId` union in `types.ts` (one name, no aliases). Binance is the
fully-validated path (CSV-twin zero-duplicate guarantee); the other four
ship behind the same code paths.

**Hosted-only.** All exchange traffic egresses through the SoloLedger relay
(the browser can't reach the exchanges directly — CORS + user IP privacy),
so auto-sync requires Hosted (SaaS) mode with the server flag
`exchangeSyncEnabled`. In local/BYOK mode every entry point fails closed as
`not_hosted` (see `AUTO_SYNC_HOSTED_ONLY` in `index.ts`).

## Module map

| file | role |
|---|---|
| `types.ts` | contract types + constants. Pure (no ccxt/db/saas imports) — safe to pull into any bundle context. |
| `connections.ts` | Dexie CRUD for `exchangeConnections` (db v8): add/list (redacted views), tx count via `importBatchId`, `deleteConnectionAndTransactions`. |
| `tunnel.ts` | transport contract (C1 client side): overrides `exchange.fetch` so every ccxt request is signed locally by ccxt, then sent verbatim through the relay via `apiFetch('/api/proxy/exchange/<id>/…')`. The ONLY accepted relay error signal is the `x-sololedger-error` header (an exchange JSON error body must never be misread as a relay failure). |
| `ccxtLoader.ts` | lazy `import('ccxt')` (own `vendor-ccxt` chunk, excluded from the PWA precache), `createExchangeClient` (credentials, `enableRateLimit`, 30 s timeout, per-exchange ctor options), error classification (`classifySyncError`) + plain-language copy (`syncErrorMessage`). |
| `binanceSymbols.ts` | Binance symbol discovery: balance ∪ transfer currencies ∪ `knownAssets` crossed with live spot markets. |
| `normalize.ts` | ccxt unified structures → `Transaction` rows with CSV-colliding `sourceRef`s (the §B-5b ref contract). |
| `engine.ts` | the sync state machine + pagination/cursor/window logic + shared save pipeline. |
| `syncJob.ts` | module-level job store (survives tab navigation) + `useExchangeSyncJob()` hook + the four public entry points. |
| `index.ts` | barrel — the only import site the UI (Section C) should use. |
| `__fixtures__/` | recorded-shape API responses per exchange + Binance CSV twins + `binanceReplay.ts` (shared replay scaffolding for tests). |

## Request flow

```
UI → syncJob (single-slot job store)
   → engine.syncConnection(connectionId, {mode})
      ├─ validating: createClient → loadMarkets + fetchBalance
      ├─ fetching:   deposits → withdrawals → (binance: symbol discovery) → trades
      │              every HTTP call: ccxt sign() → tunnel → apiFetch → relay → exchange
      ├─ normalize:  ccxt rows → Transaction rows (refs per §B-5b)
      ├─ mode 'stage':  row back to 'idle', NOTHING persisted (preview only)
      └─ mode 'commit': persistSyncedRows
                        filterAlreadyImported → stamp importBatchId=connectionId
                        → convertOrNormalizeForImport → bulkPut
                        → deduplicateTransactions
                        → ONLY THEN row update (cursors/knownAssets/knownSymbols/lastSyncAt/status)
                        → price fetch (gated on effective priceApiEnabled; failure ⇒ warning)
```

`syncJob` entry points: `runInitialSync` (stage a preview),
`commitInitialSync` (persist the staged preview), `discardInitialSync`,
`syncNow` (stage+commit in one shot for incremental syncs). Single-slot
rule: only one sync at a time (the slot is claimed **synchronously** before
any await, so a same-tick second call no-ops with a warning), and starting
a sync discards any staged preview (with a warning).

## Cursors, windows, budgets (§B-3)

- Per-kind ms cursors on the connection row; a sync starts at
  `cursor - overlap` (`TRADE_OVERLAP_MS` 5 min, `TRANSFER_OVERLAP_MS` 7 d).
  The overlap makes the sync self-healing for late-arriving rows and for
  Binance pending→confirmed transfers (their `insertTime` never moves, the
  status flips — the overlap re-fetches them and dedup keeps one copy).
- **Cursors are written ONLY post-save.** Stage mode, discards, aborts and
  failures leave the Dexie row untouched, so a failed sync resumes from the
  last saved position.
- Cursors track the max timestamp of ALL fetched rows — including rows the
  normalizer excludes (pending/failed transfers) — otherwise a confirmed
  transfer sitting just past the cursor would be re-fetched forever.
- Forward window scan: `window = [since, min(since+cap, now)]`. Window caps:
  Binance transfers 89 d (their 90-day rule), trades 6.5 d for
  binance/coinbase/okx/kucoin (Binance spot myTrades 7-day rule; KuCoin
  "up to one week after since"). Kraken trades paginate by `ofs` (50 fills
  per call) inside one window.
- Budgets: `MAX_PAGES_PER_PHASE = 200` caps **data pages** (pages with
  rows); empty-window probes have their own `MAX_EMPTY_HOPS_PER_PHASE =
  4000` so an initial sync can skip across silent years without going
  partial. A tripped budget = PARTIAL success (rows kept, cursor = max ts
  seen, warning) — never an error.
- The initial (cursorless) scan is floored at each exchange's launch date
  (`EXCHANGE_LAUNCH_MS`) — nothing can predate the exchange itself, and
  6.5-day windows from the unix epoch would need thousands of requests.
- Retries: `MAX_RETRIES = 3`, backoff `[2 s, 5 s, 15 s]`, and ONLY for
  `rate_limit`/`network`. Everything else (including `region_blocked`)
  aborts immediately.

## Error model

`classifySyncError` (ccxtLoader) maps anything thrown mid-sync to a
`SyncErrorKind`; `syncErrorMessage` gives the plain-language copy. Relay
failures are detected ONLY via the `x-sololedger-error` header — never by
reading an exchange error body.

- `region_blocked` — Binance currently answers ALL relay traffic with HTTP
  451 `Service unavailable from a restricted location` (Binance geo-blocks
  the relay's hosting region). ccxt surfaces this as `ExchangeNotAvailable`
  (a NetworkError), which would read as a "temporary network issue" — so
  classification checks the `/restricted location/i` marker BEFORE the
  generic network mapping. It is NON-retryable (aborts like `invalid_key`)
  and the copy directs users to CSV import for Binance until the relay
  egress moves.

## Dedup contract (§B-5, fixed decision 2)

API rows are stable-ref sources (`binance_api`, `coinbase_api`, …) and
their refs MUST collide with the corresponding CSV parsers' refs — the
dedup key is `ex:${sourceRef}`, source-independent. The pinned mappings:

| exchange | trades | transfers |
|---|---|---|
| binance | `exchangeSourceRef('binance', floorSec(ts), side, BASE, amount)` (== binanceSpot.ts Trade-History-CSV refs) | same formula, `transfer_in`/`transfer_out` (== binanceTransfers.ts) |
| coinbase | `trade.id` (CSV `ID` column) | `transfer.id` |
| kraken | aggregate fills by `trade.order` → `sourceRef = orderTxid` (== CSV `refid`) | `transfer.info?.refid ?? transfer.id` |
| okx | `trade.order ?? trade.id ?? formula` (**order first** — okx.ts prefers `ordId`) | `transfer.id ?? formula` |
| kucoin | `trade.id ?? formula` | `transfer.id ?? formula` |

`dedup.contract.test.ts` proves the collisions pairwise (real CSV parsers
vs real ccxt parsing) and end-to-end: CSV import → replay sync → **zero
net-new rows**, CSV twins survive (they win the survivor score).

## Validation tiers

1. **Fixture tests (CI)** — everything under `src/lib/exchangeSync/*.test.ts`.
2. **Public-endpoint tunnel probes (live)** — relay repo
   `server/scripts/live-verify-exchange-tunnel.mjs` tier 2.
3. **Signature-integrity probes (live, dummy keys)** — same script tier 3;
   assert each exchange's DISTINCTIVE auth error.
4. **Full live flow (Binance, hosted site, read-only key)** — manual:
   1. Hosted sign-in → Import → Auto-sync → add Binance key → "✓ Connected".
   2. Initial sync → preview counts match exchange history → confirm → row `ok`.
   3. `Sync now` immediately → "No new transactions since last sync" (0 imported).
   4. Import the account's **Trade History** + **Deposit & Withdrawal History**
      CSVs → banner reports **0 newly saved rows**. Any residual rows = FAIL —
      inspect ref collisions (second-floor timestamps, `stableAmountKey`
      precision) first. P2P rows from a statement CSV are EXPECTED net-new
      (the API doesn't expose P2P).
   5. Review: API rows show source `binance_api`; capital-gains numbers
      identical to a CSV-only baseline (judged post-dedup on the merged set).
   6. Negative paths: wrong secret → invalid_key copy; revoke key → auth
      error next sync; network cut mid-sync → retryable error, cursor NOT
      advanced, resume works.
   7. Local mode: auto-sync UI shows the hosted-only explainer; no relay
      call fires.

   The read-only key comes from env `BINANCE_API_KEY`/`BINANCE_API_SECRET` —
   never printed, committed, or shown in reports.

### Fixture provenance

ALL fixtures under `__fixtures__/` are **hand-authored**
(`"_recorded": false` with a `_note`) — schema-faithful but written by
hand, because Binance geo-blocks this build environment (HTTP 451, see
`region_blocked` above) so nothing could be recorded live. When tier-4
runs against a real account, refresh the Binance fixtures with sanitized
real responses (mask account ids/addresses) and flip `_recorded`.

## Known limitations / caveats

1. **Binance P2P not exposed via spot REST** — CSV import remains the P2P
   path; no duplicates either way (refs can't collide).
2. **Binance symbol-discovery blind spot** — an asset bought AND fully sold
   with zero balance/deposit/withdrawal traces leaves nothing to discover;
   the initial-sync hint recommends a one-time CSV import for such history
   (dedup makes it free). Fetching ALL spot markets was rejected (thousands
   of signed calls).
3. **OKX fills retention ~3 months** — older fills need CSV; surfaced as a
   sync warning on the initial sync.
4. **KuCoin fills window** — KuCoin returns fills "up to one week after
   `since`" and never tells you a page was full; the engine paginates 6.5-day
   windows so a full page can never strand older rows.
5. **API↔CSV zero-duplicate guarantee is Binance-only** this round; the
   other four guarantee API↔API dedup and match CSV on native ids where
   present (Kraken `refid`). Their quirks surface in beta.
6. **Coinbase** covers the current Advanced Trade API (api.coinbase.com);
   legacy retired APIs are out of scope. Simple buys/sells made without an
   order book fill can be absent from `fills` — CSV covers those.
7. **Binance ledger-CSV coexistence** — auto-sync refs collide with the
   wizard-recommended **Trade History** CSV (zero-dup holds there), but NOT
   with the full-ledger statement CSV's stitched refs for crypto-quoted
   fills, and stitched fiat/stable buys with base-denominated fees mismatch
   amounts (net-received vs gross-fill). Users who both auto-sync AND import
   the full ledger CSV can see duplicates for those two shapes — recommend
   the Trade History + Deposit & Withdrawal exports.
8. **Coinbase transfer quirks** — v2 `send` rows (outgoing) are unified by
   ccxt as type `'deposit'` (positive amount); the engine filters by
   `info.type ∈ {send, receive}` and fetches per-currency with
   `{currencyType: 'crypto'}`. Coinbase caps transfer history at 100 rows
   per account with no usable cursor (documented beta gap) — a truncation
   warning is surfaced at the cap.
9. **Binance raw transfer statuses** — deposits/withdrawals keep Binance's
   raw numeric status strings through ccxt; the normalizer includes only
   settled rows (`status === 'ok'` after ccxt unification) and counts the
   rest as `skippedUnsettled`.
10. **Initial-sync cost** — full-history means one empty-window probe per
    window per symbol back to the exchange's launch (worst case: 6.5-day
    trade windows). It's a one-time cost; incremental syncs only re-scan
    the overlap. Budgets above keep it bounded.

## Adding an exchange?

Follow the checklist in the repo-root `AGENTS.md` ("Adding an auto-sync
exchange") — it covers BOTH the relay edit points and every client-core
edit point in this module.
