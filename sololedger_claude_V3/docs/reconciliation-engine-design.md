# Reconciliation Engine — Design Doc

**Status:** UPDATED 2026-07-27 — fetch-completeness is the PRIMARY bug (proven
with the user's real Binance CSV exports); reconciliation is the detection
layer. Phase ordering revised accordingly.
**Author:** Hermes
**Date:** 2026-07-27
**Case study:** Ramakanth's Binance account (backup `sololedger-backup-2026-07-27`
+ Binance CSV ground truth: Trade / Deposit / Withdrawal / full Transaction History)

---

## 0. CORRECTED ROOT-CAUSE DIAGNOSIS (supersedes earlier display-first framing)

The definitive three-way diff — Binance CSV ground truth vs SoloLedger backup
vs Koinly — established that the dominant bug is **incomplete trade fetching**,
not (only) display/reconciliation:

| Data | Binance CSV (truth) | SoloLedger | Koinly | Coverage |
|---|---|---|---|---|
| **Spot trade fills** | **9,289** | 648 | ~3,119 (order-grouped) | **SL = 7%** ❌ |
| Deposits | 225 | 225 | 247 | ✅ 100% |
| Withdrawals | 277 | 277 | 330 | ✅ 100% |
| **Full ledger rows** | **28,928** | 1,150 | — | — |

**Transfers are complete; trades are catastrophically under-pulled (648 of
9,289).** Per-asset breakdown:

- **0% coverage (fully-divested assets):** HNT (6,284 fills → **0 pulled**),
  NPXS, BNB, FLOW, DOT, BUSD, CND, BOND, ICX, CMT, XTZ, LINK, POWR, RCN, SKL,
  APT, REQ, SALT, CITY, KNC, RDN.
- **Partial coverage:** ETH 9%, USDC 3%, WBTC 8%, BTC 19%, LPT 26%, GRT 28%,
  SOL 38%, AR 47% — their fills on **BUSD / non-discovered quote pairs** missed.
- **~100% coverage:** UNI, TRX, JTO, STX, 0G (currently held → discovered).

**Root cause — the symbol-discovery blind spot.** Binance's `myTrades` requires
a symbol and there is no "all my trades" endpoint. The engine discovered
symbols from `current balances ∪ transfer currencies` — but an asset bought
AND fully sold to zero leaves **no balance and no transfer trace**, so its
symbols were never scanned. BUSD-quoted pairs died the same way (BUSD is a
sunset stablecoin, zero balance).

**It is NOT a dedup bug.** All 648 surviving `tradeId`s are unique with zero
false collisions; deposits/withdrawals are 100% complete. The "1414→1150"
drop was genuine overlap dedup, correct behavior.

**Fix (implemented on `fix/binance-trade-completeness`):** the INITIAL
(cursorless) sync probes **every live spot symbol** (`allSpotSymbols`) instead
of asset-derived discovery. A never-traded symbol costs exactly one empty
`myTrades` call (the fromId scan short-circuits), so the full scan is bounded.
Traded symbols persist to `knownSymbols`, so incremental syncs keep the cheap
asset-derived path. This takes trade coverage from 7% → ~100%.

**Why the dashboard was so wrong:** the ledger was missing 93% of trades, so
both quantities AND cost basis were computed on a fragment. Phantom deposit
-address balances were a *secondary* symptom. Fixing fetch-completeness is the
prerequisite; reconciliation (below) is what **detects** this class of gap
automatically in future.

**Multi-account coverage gap (separate, later):** the full Transaction History
ledger (28,928 rows) shows Binance accounts SoloLedger's spot-only sync never
touches — USD-M Futures (434), Coin-M Futures (428), Cross Margin (20),
Options (3), plus Realized PnL (248), Funding Fees (25), P2P (66), dust
convert (86), Binance Convert (22), rebates/referrals (208+165), staking/
launchpool/airdrops. This folds into the CCXT phase, not the reconciliation
engine.

---

## 1. The problem, stated precisely

With **only Binance imported**, the Dashboard shows holdings that match
**neither** Binance's actual balances **nor** the sum of the imported ledger.

Ground truth (from the user's live Binance portal, 2026-07-27):

| Asset | Binance actual | Dashboard (now) | Ledger-implied | Correct? |
|---|---|---|---|---|
| BTC | **0.0000049** (~$0.03) | 17.8 | +9.17 | ❌ ~4 orders off |
| USDT | **0.00000046** | 1,339,334 | +233,068 | ❌ |
| ETH | ~0 | 410 | −329 | ❌ |
| UNI | **120.001444** | — | +120.001444 | ✅ ledger exact |
| ROSE | **11,454.80** | — | +11,454.80 | ✅ ledger exact |
| **Total** | **$635.78 spot / ~$759 all accounts** | ₹72 crore (~$8.6M) | — | ❌ ~10,000× overstated |

Two facts in that table are the whole diagnosis:

1. **UNI and ROSE ledger-implied balances match Binance to the wei.** The
   transaction *pull* is accurate and complete for those assets. The math
   works when the data is complete.
2. **BTC / USDT / ETH diverge wildly in both directions** (some overstated,
   some negative). The wrongness is concentrated where the ledger
   *reconstruction* diverges from reality — deposit-address phantoms and
   un-netted withdrawals to not-yet-imported wallets.

### Root cause

The Dashboard **never asks an exchange "what is my balance?"** It reconstructs
quantity by summing the transaction ledger (`buildPortfolioHoldings`), then
`reconcileHoldings` applies on-chain truth **only for wallet addresses that
have a `walletBalances` row**. For exchange accounts it hits this branch
(`dashboardModel.ts`):

> *"exchange / manual sources → always tx-derived (no address to check)."*

But the sync engine **already calls `fetchBalance()`** on every sync
(`engine.syncConnection` → `client.fetchBalance()`) and then **throws the
result away** — it uses balances only for symbol discovery, never persists
them as a truth anchor. So the Dashboard has no exchange-side balance to
reconcile against and falls back to a ledger reconstruction that is wrong
whenever the history is incomplete or contains deposit-address artifacts.

---

## 2. The user's spec (the correct mental model)

> *"The Dashboard should be the sum of all balances of all wallets imported.
> And these balances must equal the sum of all transactions in those wallets.
> Unless deposit/withdrawal addresses are marked internal transfers, they
> shouldn't count."*

And the critical refinement (why `fetchBalance()` **alone** is wrong):

> *"If you show balances by running only fetchBalance(), how will we know the
> sum of all transactions pulled also equals the balance left over? There'd be
> no cross-check of whether we have all the data."*

**Both numbers are needed, and the *gap* between them is the diagnostic.**

This is the Koinly model:
- **Authoritative balance** (exchange `fetchBalance` / on-chain RPC) = what
  you actually hold → drives the Dashboard quantity.
- **Ledger reconstruction** = what your recorded history implies → drives cost
  basis and capital gains.
- **Reconciliation** compares the two per asset per source. A non-zero delta
  is a *completeness signal*, surfaced — never silently hidden.

---

## 3. Design

### 3.1 Persist an exchange balance truth anchor (mirror `walletBalances`)

The sync already fetches balances. Persist them instead of discarding.

New Dexie table (db **v10**), deliberately mirroring `WalletBalanceRow`:

```ts
export interface ExchangeBalanceRow {
  /** `${connectionId}:${asset.toUpperCase()}` */
  id: string;
  connectionId: string;        // FK → exchangeConnections.id
  exchange: string;            // 'binance' | … (denormalized for cheap filter)
  asset: string;               // uppercase ticker
  /** free + used (total) from ccxt Balances — what the exchange says you hold. */
  amount: number;
  /** ms epoch of the successful fetch. */
  asOf: number;
  source: 'exchange_api';
}
```

- Rows are **replaced wholesale per connection** on each successful sync
  (same "replace per address" contract as `walletBalances`), so a vanished
  asset becomes a confirmed-zero (drains phantoms) rather than a stale row.
- Written in `persistSyncedRows` (engine.ts) alongside the cursor update —
  i.e. **only post-save**, preserving the existing cursor-safety invariant.
- `fetchBalance()` returns ccxt's unified `Balances`; flatten
  `{ BTC: {free, used, total}, … }` → per-asset `total > 0 ? total : 0`
  **including explicit zeros** for previously-seen assets (a confirmed zero is
  data, exactly like the on-chain anchor).

No new network calls. No change to fetch volume. Pure persistence of data the
sync already has.

### 3.2 Reconciliation computation (pure, testable)

New module `src/lib/reconcile/sourceReconcile.ts` (no ccxt/db runtime imports
— consumes rows), paralleling how `reconcileHoldings` works but keyed by
**source**, not by wallet address:

```ts
export interface SourceAssetRecon {
  asset: string;
  /** What the source's authority says (exchange balance / on-chain). */
  authorityQty: number;
  /** What the ledger implies for THIS source's rows only. */
  ledgerQty: number;
  /** authorityQty − ledgerQty. 0 ⇒ fully reconciled. */
  delta: number;
  /** Relative severity for sorting/surfacing. */
  status: 'reconciled' | 'ledger_under' | 'ledger_over' | 'no_authority';
}
export interface SourceReconResult {
  connectionId: string;
  exchange: string;
  assets: SourceAssetRecon[];      // sorted by |delta| desc
  reconciledCount: number;
  divergentCount: number;
  /** assets with authority balance but ledger can't explain it (missing history) */
  unexplainedCount: number;
}
```

Computation per connection, per asset:
- `authorityQty` = the `ExchangeBalanceRow.amount` (or `0` when the connection
  has a row set but no row for that asset ⇒ confirmed zero).
- `ledgerQty` = `buildPortfolioHoldings`-consistent sum **restricted to that
  connection's transactions** (`importBatchId === connectionId`).
- `status`:
  - `|delta| ≤ ε` → `reconciled`
  - `authorityQty > ledgerQty` → `ledger_under` (**the ledger is missing
    in-side history** — e.g. buys never discovered, deposits not imported)
  - `authorityQty < ledgerQty` → `ledger_over` (**the ledger records holdings
    the source no longer has** — e.g. un-netted withdrawals to not-yet-imported
    wallets, or deposit-address phantoms)
  - no balance rows for the connection yet → `no_authority` (first sync before
    v10, or sync predates the feature)

`ε` is a per-asset dust threshold (e.g. `max(1e-8, authorityQty * 1e-6)`) so
$0.00000046 USDT dust doesn't page anyone.

### 3.3 What the Dashboard shows

**Quantity = authority when available, ledger otherwise.**

In `DashboardTab` / `valueHoldings` pipeline:
- For each holding, if its asset has an `ExchangeBalanceRow` for a connected
  exchange (or a `WalletBalanceRow` for a watched wallet), use the
  **authority quantity** → matches Binance/Koinly.
- `qtySource` already exists on `ReconciledHolding` (`'on-chain' | 'tx-history'`);
  extend with `'exchange-api'` so the UI can label it.
- **Cost basis stays ledger-derived** (per-unit cost × authority qty) — gains
  math is unchanged; only the *quantity* anchoring changes.

Net effect on the case study: BTC shows **0.0000049**, USDT shows **~0**,
ETH shows **0** — matching Binance. UNI/ROSE already matched and stay matched.
The ₹72 crore phantom collapses to ~$759.

### 3.4 The reconciliation report (the cross-check the user demanded)

A new **Data Health** surface (extends the existing card that already shows
"30 transactions need a price"):

> **Binance — reconciliation**
> ✅ 31 assets reconciled
> ⚠️ 4 assets don't fully reconcile:
> - **BTC**: Binance shows 0.0000049, ledger implies 9.17 → **8.99 BTC of
>   withdrawals/transfers not accounted for** (import the destination wallets,
>   or mark transfers internal)
> - **USDT**: ledger implies 233k more than Binance holds → likely withdrawn
>   to an un-imported wallet
> - **ETH**: ledger is 329 short → in-side history missing (possibly bought
>   elsewhere, or trades not discovered)

Each divergent row gets a CTA: **"Why?"** → drill into the per-asset
ledger-vs-authority breakdown (deposits, withdrawals, buys, sells summed), so
the user can see *which side* is missing.

This turns the silent wrong number into an **actionable completeness
diagnostic** — exactly Koinly's "missing transactions" warnings.

### 3.5 Internal-transfer linking (kills the phantoms properly)

The BTC phantom exists because withdrawals to the user's **own** MetaMask/
Phantom/etc. aren't yet marked internal (those wallets aren't imported). The
reconcile report **names** this instead of hiding it.

When the user later imports the destination wallet:
- Existing `possible_internal_transfer` flag + `counterpartyAddress` already
  capture the withdrawal side.
- An auto-linker (extending the existing `auto-internal-transfers` work —
  see `origin/cursor/auto-internal-transfers-f944` branch) matches
  exchange `transfer_out` ↔ wallet `transfer_in` by (asset, amount, ~time,
  txHash) and sets `isInternalTransfer` on both.
- Internal transfers net to zero in `buildPortfolioHoldings` (already
  implemented) → the phantom disappears **and** the reconciliation delta for
  that asset closes.

So the reconciliation engine is also the **feedback loop** that tells the user
"import your other wallets to close these gaps" — which is precisely the
journey the user is on.

---

## 4. Why this generalizes to every exchange / wallet / future CCXT work

The principle is source-type-agnostic:

| Source type | Authority | Ledger source |
|---|---|---|
| Exchange (Binance, +104 CCXT) | `fetchBalance()` | synced trades/transfers |
| Watched wallet (BTC, EVM, Solana) | on-chain RPC balance (`walletBalances` — exists) | imported on-chain txs |
| CSV import | none (no authority) | CSV rows |
| Manual entry | none | manual rows |

- **CCXT expansion** gets reconciliation *for free*: every new exchange syncs
  through the same `persistSyncedRows`, so persisting `fetchBalance()` once
  covers all 104. The reconcile computation only needs `connectionId` +
  `importBatchId`, both already present.
- **Watched wallets** already have the authority anchor (`walletBalances`);
  the same `SourceAssetRecon` shape just reads from a different table.
- **CSV/manual** sources have no authority → `status: 'no_authority'`, shown
  as ledger-derived (current behavior), no regression.

This is the foundation CCXT needs **before** scaling to 104 exchanges —
otherwise we multiply the silent-wrong-balance bug by 104.

---

## 5. Implementation plan (phased, independently shippable)

**Phase 1 — persist + display (the visible fix), ~small**
1. db v10: `exchangeBalances` table + `ExchangeBalanceRow`.
2. `engine.persistSyncedRows`: persist flattened balances post-save.
3. Dashboard: authority-quantity for exchange holdings + `qtySource:'exchange-api'`.
4. Tests: fixture balances → assert dashboard qty matches balance, not ledger sum.

**Phase 2 — reconciliation report (the cross-check)**
5. `sourceReconcile.ts` (pure) + unit tests (incl. the UNI/ROSE exact-match
   and BTC/USDT divergent cases from the real backup).
6. Data Health UI: per-connection reconciliation summary + per-asset drill-down.

**Phase 3 — internal-transfer auto-link (phantom killer)**
7. Auto-link exchange `transfer_out` ↔ wallet `transfer_in` on import.
8. Reconciliation deltas close as wallets are imported; report updates live.

**Phase 4 — CCXT readiness**
9. Confirm new exchanges persist balances through the shared path; add a
   reconcile assertion to the per-exchange onboarding checklist (AGENTS.md).

Phases 1–2 are the core ask and are small + safe. Phase 3 builds on existing
branches. Phase 4 is a checklist line.

---

## 6. Test strategy (grounded in the real backup)

- **Fixture:** sanitize the real backup's Binance rows into a test fixture
  (mask addresses/ids). It already contains the exact divergent patterns
  (UNI/ROSE exact, BTC/USDT/ETH divergent) — a gift for testing.
- **Unit:** `sourceReconcile` against that fixture → assert UNI/ROSE =
  `reconciled`, BTC/USDT = `ledger_over`, ETH = `ledger_under`.
- **Integration:** engine sync → `exchangeBalances` persisted → dashboard qty
  = balance. Mirror the existing `DashboardTab.test.tsx` round-4 reconcile
  tests (they already seed phantom + balance rows).
- **Regression:** existing 200 exchangeSync/storage/portfolio/dashboard tests
  must stay green (authority display is additive; ledger cost basis unchanged).

---

## 7. Stretch — background sync + notify-on-complete (the Koinly email pattern)

Koinly's "we'll email you when sync finishes" maps onto SoloLedger's hosted
mode cleanly:

- The `exchangeSyncJob` store already runs syncs with phase/progress and
  survives tab navigation (module-level store). A long initial sync currently
  requires the tab to stay open.
- **Hosted-mode enhancement:** run the sync as a **server-side job** on the
  relay (the tunnel already proxies signed requests), with the client polling
  a job id — or, lighter, a **service-worker / `Background Sync`** that
  completes the in-flight sync if the tab is backgrounded, then surfaces a
  result banner + optional email/push via the existing SaaS notification
  channel on completion.
- The single-slot + cursor-safety invariants already make this resumable and
  crash-safe, so promoting it to a background job is mostly orchestration, not
  new correctness logic.

Out of scope for the reconciliation engine itself, but noted as a natural
follow-on since the user explicitly wants it. Recommend a separate ticket.

---

## 8. Open questions for the user (fold in Koinly findings)

1. Does Koinly's Binance balance show ~$759 (balance-authority) — confirming
   the model?
2. What do Koinly's "missing transaction" warnings look like for this account
   (BTC/USDT/ETH)? Match our proposed reconciliation report?
3. How does Koinly classify the deposit addresses — internal transfer
   candidates, or ignored?
4. Transaction count Koinly pulls vs our 1414 staged / 1150 saved — any
   categories it has that we don't (P2P, convert-dust, Earn)?

These answers tune Phase 2's report copy and Phase 3's linker, and confirm
whether any *fetch*-side gaps (beyond reconciliation) remain.
