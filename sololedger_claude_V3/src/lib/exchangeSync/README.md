# Exchange Auto-Sync (client core)

Pull trades/deposits/withdrawals directly from a user's exchange API key
(read-only) into the normal SoloLedger transaction store — initial full
history + incremental syncs — with zero new dedup machinery: synced rows use
stable `sourceRef`s, and connectors with a verified vendor-export mapping make
those refs collide with their CSV parser twins so the existing
`deduplicateTransactions()` removes them automatically. Gate.io API replay
idempotence is proven; its CSV collision is fixture-demonstrated only because
the existing beta CSV schema has no verified vendor-export provenance.

Supported exchanges: **binance, coinbase, kraken, okx, kucoin, bybit, gateio, htx, cryptocom, bitfinex, gemini, btcmarkets, mexc, bitvavo, bitstamp, bitget** — the
`ExchangeId` union in `types.ts` (one name, no aliases). Binance is the
original live-validated path; Bybit adds a real-ccxt replay pipeline and an
order-level CSV-twin dedup contract. Exchange-specific caveats remain below.

**Hosted-only.** All exchange traffic egresses through the SoloLedger relay
(the browser can't reach the exchanges directly — CORS + user IP privacy),
so auto-sync requires Hosted (SaaS) mode with the server flag
`exchangeSyncEnabled`. In local/BYOK mode every entry point fails closed as
`not_hosted` (see `AUTO_SYNC_HOSTED_ONLY` in `index.ts`).

The browser never talks directly to Bitget. Signed exchange traffic rides the
JWT- and active-subscription-gated `GET/POST /api/proxy/exchange/<id>/<path>`
relay, whose per-exchange policy fixes the upstream host and exact method/path
allowlist. Bitget is restricted to GET-only public spot metadata, spot account
assets, fills, deposits, and withdrawals on `api.bitget.com`.

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
| `mexc.ts` | MEXC's frozen symbol universe, strict durable checkpoint validation, and recursive closed-window trade/transfer traversal. |
| `syncJob.ts` | module-level job store (survives tab navigation) + `useExchangeSyncJob()` hook + the four public entry points. |
| `index.ts` | barrel — the only import site the UI (Section C) should use. |
| `__fixtures__/` | recorded-shape API responses per exchange + Binance CSV twins + `binanceReplay.ts` (shared replay scaffolding for tests). |

## Request flow

```
UI → syncJob (single-slot job store)
   → engine.syncConnection(connectionId, {mode})
      ├─ validating: createClient → loadMarkets + fetchBalance
     ├─ fetching:   deposits → withdrawals → (binance/gemini: symbol discovery) → trades
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
  coinbase/okx/kucoin/bybit. Bybit V5 executions use 6.5 d windows plus the
  opaque `nextPageCursor`; deposits/withdrawals use 29 d windows plus cursor
  (limits 100 and 50 respectively). Kraken trades paginate by `ofs` (50 fills
  per call) inside one window. Gate.io trades/deposits/withdrawals use strict
  29 d forward windows. Trades use 1-based pages (limit 1000); wallet history
  uses offsets (deposit limit 500, withdrawal limit 100). Before Gate's
  ~100,000 maximum offset would be exceeded, a still-dense window is bisected
  and replayed; an unsplittable same-second window returns partial/nonadvancing
  instead of skipping data or looping. Binance has its separate fromId/23.5 h plan.
- HTX matchresults require a symbol, so sync iterates every loaded active spot
  market (plus persisted still-active known symbols). Each symbol uses
  47.5-hour windows, limit 500, and raw response `id` pagination via `from` +
  `direct=next` (never ccxt's unified trade id). CCXT sorts parsed results, so
  the client captures the exact final item `id` from `last_json_response`
  before consuming the parsed page; it never guesses by numeric min/max. A
  per-client async mutex owns the complete clear/request/capture section, so
  concurrent calls cannot steal CCXT's shared response slot. All symbols
  share one 8,000-physical-attempt trade budget. Time windows are outermost;
  every active symbol must exhaust a window before its durable frontier can
  advance. A small additive connection checkpoint records completed symbols
  in the first unfinished window, so capped follow-up syncs resume fairly and
  later symbols cannot starve. The
  120-day retention floor clamps initial and stale incremental cursors with
  explicit CSV guidance. Deposit/withdraw history uses native record-id
  pagination at limit 100; `since` is treated as a local stop floor because
  it does not filter that endpoint server-side. Physical attempts, including
  retries, share a hard cap and interrupted windows remain replayable.
- Budgets: `MAX_PAGES_PER_PHASE = 200` caps **data pages** (pages with
  rows); empty-window probes have their own `MAX_EMPTY_HOPS_PER_PHASE =
  4000` so an initial sync can skip across silent years without going
  partial. A tripped budget = PARTIAL success (rows kept, warning) — never
  an error. For Bybit, an unfinished opaque-cursor chain retains the start
  of that time window as its durable timestamp cursor; the next sync replays
  the window and cannot skip rows hidden behind the unpersisted token. Once
  every window is exhausted, the cursor advances to the verified `now`
  frontier even for empty accounts or accounts whose last activity is old.
- Crypto.com Exchange retains only active spot markets from its mixed public
  instruments catalog and strictly excludes derivative or unresolved private
  trades. `private/get-trades` uses 23.5-hour windows, limit 100, and walks
  newest-first pages backward by the oldest returned millisecond; native
  `trade_id` dedups inclusive boundaries. A dense full page sharing one oldest
  millisecond returns partial/nonadvancing. Deposits and withdrawals each scan
  independent 89-day windows with `page_size=200`, zero-based pages, and their
  own verified frontiers. Every physical attempt, including retries, consumes
  the phase cap. All three endpoints clamp initial and stale incremental starts
  to the Exchange API's 180-day retention floor. Pending transfers keep an
  endpoint-specific durable checkpoint at the oldest pending timestamp, even
  after the normal seven-day overlap has passed; each successful sync clears
  the checkpoint only after every observed pending row settles or becomes a
  known terminal failure/cancellation. Structural request-cap interruption
  retains the prior checkpoint. Terminal failed/canceled rows do not hold the
  cursor back.
- Gemini `mytrades` requires a symbol, so every active spot market is scanned
  fairly in round-robin order. Full raw 500-row responses advance by Gemini's
  documented timestamp recipe; CCXT-filtered length is never used as fullness
  evidence, and native `tid` removes page overlap. One retry-inclusive phase
  budget and a durable per-symbol checkpoint make bounded scans resumable.
  Combined `/v1/transfers` is fetched once at 50 rows/page, exhaustively
  timestamp-paginated and then split. Every physical request/retry is spaced
  by at least five seconds. Pending rows hold the shared frontier; known
  failed/canceled rows are terminal exclusions. Reward is imported as income;
  AdminDebit/AdminCredit require review; unknown types make coverage partial.
- BTC Markets newest-first history uses exclusive numeric record-id cursors,
  never timestamps. Initial backfill follows `BM-BEFORE` through `before=...`;
  incremental sync follows the saved id and `BM-AFTER` through `after=...`.
  Unified `since` is not passed because pinned CCXT 4.5.68 incorrectly maps
  milliseconds into that native-id parameter. Trades and one combined transfer
  stream use limit 200 and retry-inclusive bounded budgets. Full pages without
  an advancing header, repeated pages/cursors, and unknown activity fail closed.
  Budget termination atomically persists a separate continuation checkpoint,
  so committed backfills and incremental scans resume at the next native page.
  Future-dated or malformed trades retain bounded native-ID replay evidence
  independently of that checkpoint, preventing a later resumed exhaustion
  from advancing past unsafe economics.
  `Accepted`/`Pending Authorization`, unknown, future-dated, and malformed
  transfers retain bounded native-ID replay evidence without pinning newer
  settled history; `Complete` settles and `Cancelled`/`Failed` are terminal exclusions. API retention is
  undocumented. API v3 was announced on 2019-11-19, but that date is not a
  documented history-retention floor: endpoint exhaustion establishes an
  observed frontier, not account-lifetime completeness.
- MEXC scans every loaded spot market, including inactive markets, plus the
  connection's frozen known symbols and queryable recent `/api/v3/symbol/offline`
  entries. Trades require a symbol and are available only for the last month;
  deposits and withdrawals are separate endpoints available only for the last
  90 days. Each endpoint uses a frozen inclusive requested range. A full
  100-row trade page or 1,000-row transfer page recursively bisects that range;
  a short page proves structural exhaustion only inside the retention floor.
  Per-symbol trade windows run in fair rounds and persist `nextSymbolIndex`.
  Saturated 1 ms windows, malformed/repeated pages, unsafe rows, request-budget
  interruption, and unqueryable recent offline symbols retain exact durable
  replay evidence. Ordinary cursors advance only after the corresponding
  frozen frontier is completely exhausted. On resume, each endpoint independently
  appends an overlapped closed range through the new frozen `now`; an exact
  unresolved deposit replay therefore cannot stop trades or withdrawals from
  scanning newer activity. Coverage records the greatest frozen end actually
  queried, not merely the newly checkpointed target. Export older records from MEXC;
  SoloLedger has no MEXC CSV parser and makes no API/CSV deduplication promise.
- Bitvavo first exhausts official `GET /v2/account/history` as a sparse
  activity/economic index. Every fixed `fromDate`/`toDate` range validates the
  `{items,currentPage,totalPages,maxItems}` envelope, exhausts `maxItems=100`
  pages without order assumptions, and re-fetches page 1 before acceptance;
  unstable metadata gets bounded restarts and dense ranges are date-bisected.
  Buy/sell currency pairs derive padded native-fill intervals, so SoloLedger
  never performs a blind multi-year scan for every market. Unresolved/delisted
  pairs retain account-history economics and fail closed for fill coverage.
  `GET /v2/trades` uses windows no wider than 23.5 hours, newest-first native
  `tradeIdTo` continuation, and adaptive time bisection when exclusive cursor
  evidence is missing, repeated or nonadvancing. The `tradeIdTo` older and
  `tradeIdFrom` newer directions and exclusivity were recorded against the
  public endpoint on 2026-08-09. Per-symbol high-water and all current plus
  previously known symbols are committed atomically with transactions.
  Account-history buy/sell economics are first retained as durable connection
  metadata, associated with the symbol/range task identities that must finish.
  Across runs, persisted plus incoming native fills are reconciled only after
  those tasks exhaust. An exact unambiguous complete-order match discards the
  deferred metadata while preserving every fill ID, timestamp and economic
  field; an unmatched candidate is then imported under its unique
  `transactionId`, and ambiguity aborts without cursor advancement. No
  undocumented link to fill/order/txId and no Price Guarantee label is inferred.
  `GET /v2/depositHistory` and `/v2/withdrawalHistory` are account-wide and
  newest-first, using adaptive disjoint date partitions. Pending, unknown and
  future-dated rows retain a durable endpoint replay start; canceled is
  terminal. Missing/malformed evidence fails closed. Transfer identity includes
  endpoint kind, raw txId/provider evidence, timestamp, asset, amount, fee,
  address and paymentId, then storage scopes it by connection/exchange/kind.
  Indistinguishable duplicate multiplicity aborts advancement rather than
  destructively deduplicating. A first sync cannot discover activity absent
  from account history or a market delisted before that sync. Price Guarantee
  and other non-fill buy/sell economics are covered only through account
  history. This connector never claims account-lifetime coverage or API↔CSV
  deduplication.


- Bitstamp uses one mixed `/api/v2/user_transactions/` account ledger for
  trades, deposits, withdrawals, and other activity. The connector walks it
  oldest-to-newest with native numeric `since_id`, `sort=asc`, and limit 1000;
  it never uses `offset`, whose documented maximum of 200,000 cannot prove
  exhaustive history on larger accounts. Saturation is determined from the
  raw response count. Pinned CCXT's unified transfer parser is deliberately
  bypassed: documented type 0/1 rows encode economics in one signed, nonzero
  dynamic currency field (for example `btc: "0.25"`) and do not provide
  synthetic `currency`/`amount`; the connector validates that raw decimal,
  direction, native ID, status, fee, and timestamp directly so sub-unit values
  cannot be truncated. Saturated pages resume inclusively at the maximum ID
  with durable consumed type/ID pairs, because trade/deposit/withdrawal kinds
  can share a numeric ID and a page boundary can split those rows. Failed and
  canceled transfers are terminal exclusions. Type 2 rows are inspected before
  CCXT trade parsing: only a raw boolean `self_trade: true` is accepted as a
  self-trade, and it never creates ordinary acquisition/disposal lots. A
  strictly valid `self_trade_order_id`, spot market, timestamp, and quote-asset
  fee retain one standalone fee effect; a proven zero fee is an explicit
  no-beneficial-ownership-change exclusion. Ambiguous flags, linkage, markets,
  or fees retain unresolved native-ID replay evidence. Complementary rows are
  never paired by timestamp/amount heuristics; only immutable linkage could
  support pairing if a future documented shape proves it end to end.
  Retry-inclusive request budgets
  persist that exact native continuation atomically with imported rows. Up to
  100 pending, malformed, future-dated, or unresolved native IDs replay behind
  the forward frontier; exceeding that bound fails closed with CSV guidance.
  The public market response is mixed, so connector callers receive active
  spot markets only while the complete catalog remains available to identify
  and exclude confirmed perpetual trades. Unknown symbols remain unresolved,
  and unsupported mixed-ledger types make coverage partial rather than
  silently complete. Bitstamp documents no account-lifetime retention
  guarantee, so endpoint exhaustion remains `retention_unverified` partial
  coverage and proves only the observed API frontier.
- Bitget classic spot v2 history walks newest-first with the exclusive native
  `idLessThan` cursor at limit 100. Native raw response order and page fullness
  are authoritative because CCXT may sort unified rows. Missing, malformed,
  repeated, or non-decreasing native IDs fail closed without moving the prior
  verified frontier. Retry-inclusive request budgets persist durable endpoint
  checkpoints only after the staged rows commit. Trades freeze the complete
  spot-symbol scan (including inactive markets and persisted delisted symbols)
  and resume fairly; the global trade cursor is the minimum verified frontier
  across symbols. Pinned CCXT 4.5.68 is forced to classic spot (`uta: false`,
  spot market type only, currency loading disabled), and its unconditional
  margin-currency catalog call is locally replaced with an empty response, so
  no swap, UTA-settings, or margin-currency transport occurs. Bitget documents
  only 90 days on these API history surfaces: retain spot fill/order and wallet
  exports for older tax records. Export/API native-ID parity is unverified, so
  CSV auto-deduplication is not promised.
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
| bybit | aggregate executions by `trade.order` → `sourceRef = orderId` (== CSV `Order ID`); durable `execId` evidence is unioned across syncs and recomputes the order row | withdrawals prefer `withdrawId`; deposits use `txid + txIndex/native id` before formula fallback |
| gateio | `trade.id` (closest available counterpart to beta CSV `ID`; equivalence is not live-verified) | `transfer.id` (same beta caveat) |
| htx | aggregate fills by `trade.order` → `sourceRef = orderId`; durable raw `id` evidence is unioned across syncs; API identity is connection-scoped while explicit sourceRef matching preserves CSV reconciliation | native wallet record `transfer.id` (fixture-matched to CSV `order-id`/`id`) |
| cryptocom | native Exchange `trade_id`; identity is connection- and immutable `raw.exchangeSyncKind=trade`-scoped | native Exchange wallet record `id`; identity is connection- and immutable `raw.exchangeSyncKind=deposit/withdrawal`-scoped, with txid retained as evidence |
| bitfinex | native Trade id; connection- and immutable-kind scoped; intentionally does **not** collide with beta CSV because parity is unverified | native Movement id; connection- and immutable-kind scoped; no Movements CSV backfill exists |
| gemini | native `tid`, prefixed `trade:` and connection-scoped | native `eid`/`withdrawalId`, direction-prefixed and connection-scoped |
| btcmarkets | native trade `id`, connection + immutable `trade` kind scoped | native transfer `id`, connection + immutable direction scoped |
| mexc | native trade `id`, scoped by connection + exchange + immutable `trade` kind | withdrawal native `id`; deposits use the exact provider evidence tuple (`txId`/`transHash`, network, coin, time, amount, address, memo, index), scoped by immutable direction; no CSV identity promise |
| bitvavo | native fill UUID, connection + immutable `trade` kind scoped; unmatched account-history `transactionId` uses immutable `account_history` kind | composite provider evidence, connection + immutable deposit/withdrawal kind scoped |
| bitstamp | native mixed-ledger `id`, connection + immutable `trade` kind scoped | native mixed-ledger `id`, connection + immutable deposit/withdrawal kind scoped |
| bitget | native `tradeId`, connection + immutable `trade` kind scoped; no promised CSV collision | native `orderId`, connection + immutable deposit/withdrawal kind scoped; no promised CSV collision |

Crypto.com normalized rows persist `raw.exchangeSyncKind` as immutable source
provenance, so later user reclassification of `Transaction.type` cannot change
dedup identity. For rows written before that field existed, key migration first
recovers kind from immutable raw evidence (`tradeId`, `transferType`, or
`clientWid`). Only legacy transfer rows from the connector's earliest revision,
which retained no endpoint marker at all, use `type` as a final compatibility
fallback.

Crypto.com's `private/user-balance` response covers whole Exchange-account
custody and does not prove an exhaustive spot-only subledger. Sync still calls
it for credential validation and asset discovery, but omits it from spot
operation coverage entirely, creates no spot authority snapshot, and does not
persist `exchangeBalances` that could replace history-derived holdings.

`dedup.contract.test.ts` proves the established connector collisions pairwise
(real CSV parsers vs real ccxt parsing) and end-to-end: CSV import → replay
sync → **zero net-new rows**, CSV twins survive (they win the survivor score).
Gate.io separately proves API↔API replay idempotence and exercises both CSV/API
orders against hand-authored twins; that fixture is not evidence that Gate's
current vendor export populates its beta `ID` column with the same native ids.

## Validation tiers

1. **Fixture tests (CI)** — everything under `src/lib/exchangeSync/*.test.ts`.
2. **Public-endpoint tunnel probes (live)** — relay repo
   `server/scripts/live-verify-exchange-tunnel.mjs` tier 2.
3. **Auth-path probes (live, dummy keys)** — same script tier 3; assert each
   exchange's distinctive auth response. Evidence is exchange-specific:
   Bitfinex `10100` / `digest invalid` proves bfx auth-header/key reachability,
   not signature/body integrity. Byte-exact Bitfinex signed-body forwarding is
   covered by `server/src/routes/exchangeTunnel.test.ts`.
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

Bitvavo is the explicit mixed-provenance exception: `time.recorded.json`,
`public-trades.recorded.json`, and `dummy-balance-305.recorded.json` were
recorded from `api.bitvavo.com` on 2026-08-09. Private account fixtures remain
clearly marked hand-authored because no real credentials were supplied. The
format-valid 64-character dummy signed balance request returned exact HTTP 403
`errorCode:305`; unknown-key validation occurs before any real-secret check,
so this proves route/header reachability, not credential or permission validity.

Gate.io fixtures carry their own `gateio/provenance.json`: they are
schema-faithful transcriptions of official API v4 examples and CCXT 4.5.68's
`gate` parser comments, with `_recorded: false`. The replay tests still drive
the real CCXT client and signing/tunnel path; they are not evidence from a
live Gate.io account.

HTX fixtures carry `htx/provenance.json` plus per-file `_recorded: false`
markers. They transcribe official spot examples and CCXT 4.5.68 parser comments;
real-CCXT replay proves request/parse behavior, not live export equivalence.

Crypto.com Exchange fixtures carry `cryptocom/provenance.json` and
`_recorded: false` markers. They are schema-faithful official-example
transcriptions. There is intentionally no CSV twin: the existing `cryptocom`
CSV parser imports Crypto.com **App** history, which is a separate product and
must never auto-dedup with `cryptocom_api` Exchange rows.

Gemini fixtures carry `gemini/provenance.json` and `_recorded: false`
markers. They are hand-authored from documented v1 shapes and replay the real
CCXT 4.5.68 signing/parser path. `transactionHistory.csv` is an economic twin,
not an identity twin: Gemini CSV has no native fill or transfer ID.

BTC Markets fixtures carry `btcmarkets/provenance.json` and `_recorded: false`.
They are schema-faithful hand-authored v3 responses replayed through the real
pinned CCXT class. No BTC Markets CSV parser exists; API↔CSV deduplication is
explicitly unavailable rather than approximated with an economic collision.

MEXC fixtures carry `mexc/provenance.json` with `_recorded: false`, pinned
CCXT `4.5.68`, and host `api.mexc.com`. They are schema-faithful hand-authored
spot v3 shapes, not real-account evidence. The connector remains Beta; full
read-only real-account validation is deferred and no CSV equivalence is claimed.

Bitstamp fixtures carry `bitstamp/provenance.json` and `_recorded: false`.
They are schema-faithful hand-authored responses based on the current native
OpenAPI and CCXT 4.5.68 parser examples. Replay drives the real pinned signing,
transport, mixed-ledger parsing, spot/perpetual classification, normalization,
and account-plus-kind identity. No CSV identity collision is invented.

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
5. **API↔CSV guarantees vary by export** — Binance Trade History and Bybit
   order-history fixtures have explicit zero-net-new contracts. The remaining
   connectors guarantee API↔API dedup and match CSV on native ids where
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
11. **Bybit execution retention** — V5 advertises two years of execution
    history. Any requested start (initial or incremental) older than
    `now − 2 years` is clamped, records endpoint-level partial coverage, and
    warns that older spot orders require a one-time CSV import. Spot itself
    launched 2021-07-15, which remains the launch floor.
12. **Bybit CSV scope** — the existing Bybit CSV parser covers spot order
    history only, not deposits or withdrawals. API trade executions are
    aggregated to the CSV's order granularity so `Order ID` refs collide.
    A CSV survivor keeps the recoverable API execution evidence rather than
    being overwritten; orders gaining later fills are safely updated without
    double-counting overlap executions. Replays preserve the stored row's
    complete review state (including reclassification, spam, manual fiat,
    notes/category/flags, internal-transfer and TDS fields) while refreshing
    only execution-derived economics/evidence. Transfer API rows remain
    API-idempotent but have no CSV-twin guarantee. Complete withdrawal history
    requires the read-only key to belong to the Bybit master account / master UID.
13. **Gate.io CSV schema is beta** — the existing generic Gate.io parser has
    one `ID` column across trades and transfers, but its export provenance is
    not documented and no live account was available to verify that it equals
    API v4 fill ids (`trade.id`) or wallet record ids (`d…` / `w…`). The API
    connector uses those native ids because they are the strongest stable
    references available, and hand-authored CSV twins exercise the intended
    collision. Real exports may diverge; do not treat the fixture collision as
    a universal zero-duplicate guarantee. API↔API replay remains idempotent.
14. **HTX export equivalence is beta/unverified** — API fills are aggregated
    to the existing CSV parser's filled-order granularity and native wallet
    record IDs are mapped to its generic ID fields. Hand-authored CSV/API twins
    prove collision in both import orders, but no live HTX export was available
    to establish universal parity. Durable raw fill evidence still makes API
    replay and later-fill reconciliation safe while preserving user review state.
    HTX `filled-fees` remain signed in `raw.htxFills`: maker rebates are never
    converted to expenses. SoloLedger posts only a positive net fee when all
    fee-bearing fills use one currency; pure/net rebates remain evidence-only
    and produce an explicit sync warning because the transaction fee model is
    expense-only.
15. **Crypto.com Exchange is not the Crypto.com App** — Exchange API balances
    are whole Exchange-account wallet truth, not an isolated spot subledger.
    Only deposit status `1` and withdrawal status `5` settle. The API exposes
    180 days; older Exchange history requires a Crypto.com Exchange export or
    Exchange Support. The App CSV parser cannot backfill it, and identical
    txids/economics across App CSV and Exchange API intentionally remain two
    rows.
16. **Bitfinex is explicitly retention-limited beta** — `auth/r/trades/hist`
    exposes approximately 7 days and `auth/r/movements/hist` approximately
    90 days. Movements are fetched once and split by signed amount into
    deposits/withdrawals; only settled statuses import. The existing Bitfinex
    CSV beta supports the Trades schema only, cannot backfill Movements, and
    API↔CSV trade-ID parity is unverified. API rows are therefore idempotent
    within a connection/kind but never auto-deduplicated against CSV rows.
17. **Gemini CSV/API identity intentionally diverges** — Gemini's CSV parser
    uses a second-resolution formula (`timestamp + type + asset + amount`),
    while `/v1/mytrades` can contain distinct fills with identical values in
    one second. Using that formula for API rows could silently erase a fill.
    Auto-sync preserves native `tid`/`eid`/`withdrawalId` evidence and scopes
    it by connection. API replay is idempotent, but importing a CSV twin can
    leave a duplicate that requires review. Only Gemini `Complete`/`Advanced`
    transfers (CCXT `ok`) import; all are flagged possible internal transfers.
    No Gemini retention limit is fabricated.
18. **MEXC is retention-limited Beta** — API trades cover only the last month
    and deposits/withdrawals only the last 90 days. Exhausting every recursive
    window proves coverage only within those moving floors, never lifetime
    completeness. MEXC documents website trade exports up to 540 days; export
    older records before they age out. SoloLedger currently has no MEXC CSV
    parser and does not promise API/CSV deduplication. Real-account validation
    is deferred; fixtures and dummy-key relay probes do not replace it.

## Adding an exchange?

Follow the checklist in the repo-root `AGENTS.md` ("Adding an auto-sync
exchange") — it covers BOTH the relay edit points and every client-core
edit point in this module.
