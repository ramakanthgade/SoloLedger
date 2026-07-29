# Internal-Transfer Auto-Link — Design Doc

**Status:** DRAFT 2026-07-30 — design only, no implementation yet.
**Author:** Hermes
**Builds on:** reconciliation-engine-design.md §3.5, `feat/auto-internal-transfers` (merged #64),
`origin/cursor/auto-internal-transfers-f944`, PR #66 (phantom-holdings fix).

---

## 1. The problem

A withdrawal from Binance to the user's **own** MetaMask/Phantom/Ledger is, economically,
a non-taxable internal transfer. Auto-linking the two legs matters for two reasons —
and it is important to state them precisely, because the *phantom-balance* framing is
easy to get backwards (a recorded withdrawal already nets the ledger down):

1. **Tax correctness (the primary win).** A recorded exchange `transfer_out` to an
   own wallet is, today, a candidate to be misread as a **disposal** (taxable) when it
   is really a move between the user's own accounts (non-taxable under India VDA rules —
   no change of ownership). Linking it to the wallet's `transfer_in` marks both
   `isInternalTransfer`, removing it from the disposal set. This is the correctness fix.
2. **Cross-source Dashboard netting.** When both sources are imported, an un-linked pair
   can double-present the same coins (once as an exchange out that wasn't netted, once as
   a wallet in). Linking makes the pair net to zero across sources in
   `buildPortfolioHoldings`.

**What auto-link does NOT fix — the `ledger_over` phantom class.** A `ledger_over`
reconciliation delta means the ledger implies MORE of an asset than the exchange holds.
For a *recorded* withdrawal the ledger is already netted down by the out leg, so there is
no delta to close — and marking that leg internal would actually *raise* the ledger-implied
qty (see §6). The real `ledger_over` class is **missing out-side records** — withdrawals
that happened but were never imported (e.g. the destination wallet's side exists but the
exchange side was never pulled, or vice versa). Auto-link cannot fix that, because there
is no out leg to link; only **backfilling the missing history** (the fetch-completeness
work in §0 of the reconciliation design) closes it. This doc's scope is the two wins
above, not the missing-records class.

3. **Manual burden.** Today the user must hand-mark own-wallet transfers in Review. The
   user's standing rule: **eliminate manual steps where the system is 100% sure**
   (auto-confirm provably intra-account transfers; only surface genuinely ambiguous
   external Deposit/Withdraw).

---

## 2. What already exists (do not rebuild)

| Piece | Where | Role |
|---|---|---|
| `isInternalTransfer: boolean` | `types/transaction.ts` | Confirmed non-taxable internal move. Nets to zero in `buildPortfolioHoldings`. |
| `'possible_internal_transfer'` flag | `types/transaction.ts` | Heuristic hint set by stitchers/parsers on orphan transfer legs. |
| `counterpartyAddress?: string` | `types/transaction.ts` | The other side's address, when derivable (on-chain to/from, or exchange withdrawal address). |
| Auto-internal for exchange self-transfers | `feat/auto-internal-transfers` (#64) | Auto-confirms provably intra-account Spot↔Funding/Futures/Options moves on the SAME exchange. |
| Cross-group trade pairing | `ledgerStitch.ts` (#66) | Pairs timestamp-split Buy/Sell legs — the matching-heuristic precedent this doc extends. |
| `ledger_over` reconciliation | `lib/reconcile/sourceReconcile.ts` | Detects the un-linked withdrawal as a completeness gap. |

**Gap:** nothing yet links an exchange `transfer_out` to a **different** source's
`transfer_in` (a watched wallet, or another exchange). That cross-source link is the work.

---

## 3. Matching model

An internal transfer is a **pair**: one `transfer_out` (the send) and one `transfer_in`
(the receive) that are the same economic event. Auto-link = find the counterpart and set
`isInternalTransfer` on **both** legs.

### 3.1 Match signals (ranked by strength)

| Signal | Strength | Notes |
|---|---|---|
| **txHash equality** | Definitive | On-chain withdrawal: the exchange's `transfer_out.sourceRef`/txHash equals the wallet's `transfer_in` txHash. 100% confident. |
| **counterpartyAddress ↔ own address** | Definitive | The withdrawal's `counterpartyAddress` is a watched/own wallet address (or a deposit address of another connected exchange). |
| **Asset + amount within fee tolerance + time window** | Strong heuristic | Same asset; `|amount_out − amount_in| ≤ network fee` (the receive is the send minus gas); timestamps within a chain-typical window. |
| **Exchange→exchange via deposit address book** | Strong | Binance withdrawal to a known Coinbase deposit address. |

### 3.2 Confidence tiers (maps to the user's auto-confirm rule)

| Tier | Condition | Action |
|---|---|---|
| **AUTO-CONFIRM** | txHash equal, OR counterpartyAddress is a known own-address | Set `isInternalTransfer=true` on both legs, link them, **no Review step**. |
| **SUGGEST** | Asset+amount+time match but no address/hash proof | Set `possible_internal_transfer` + surface in Review as a one-tap confirm. |
| **LEAVE** | No counterpart within tolerance | Leave as external Deposit/Withdraw (the `ledger_over` row the recon report shows). |

### 3.3 Tolerances (initial, tunable)

- **Amount:** `|amount_out − amount_in| ≤ max(networkFee, amount_out * 1e-4)`. Per-chain fee table
  (BTC ~0.0002, ETH ~0.005, SOL ~0.000005, stablecoins ~1). The receive is always ≤ the send.
- **Time window:** BTC/EVM ±1h, Solana ±5min, exchange→exchange ±24h (exchange processing delays).
- **Direction:** `transfer_out.timestamp ≤ transfer_in.timestamp` (send precedes receive).

---

## 4. Data model changes

Minimal, additive (no destructive migration):

1. **`linkedTransferId?: string`** on `Transaction` — the id of the counterpart leg once
   auto-linked. Lets the UI render the pair as one internal move and lets the linker be
   idempotent (skip already-linked legs).
2. **`internalLinkConfidence?: 'txhash' | 'address' | 'heuristic'`** — provenance so Review
   can show *why* it was linked and the recon report can trust it.
3. **Own-address registry** (read-only): the union of watched wallet addresses
   (`lookupAddresses`) + per-connection exchange deposit addresses. Used by the
   counterpartyAddress tier. No new table needed — derive at link time.

Dexie version bump: there is **no** `isInternalTransfer` index today (`*flags` is a
multi-entry index on the flags array; `isInternalTransfer` is a plain boolean field), and
none is **needed** — the linker queries by `importBatchId` / `asset` / `timestamp` (indexed)
or filters in-memory. If a dedicated `linkedTransferId` index is wanted for the Review pair
view, bump to v11 with a migration note. **Recommendation: v11 with
`transactions: '..., linkedTransferId'` only if the Review UI needs a direct pair lookup;
otherwise derive in-memory and skip the bump.**

---

## 5. Algorithm (pure, testable — mirrors sourceReconcile)

New module `src/lib/reconcile/internalTransferLink.ts` (no db/ccxt runtime imports —
consumes rows, returns patches), paralleling `sourceReconcile.ts`:

```
linkInternalTransfers(txs, ownAddresses) -> Array<{ outId, inId, confidence }>
```

1. Partition: `outs` = `transfer_out` (and `gift_sent`) not already internal/linked;
   `ins` = `transfer_in` (and `gift_received`) not already internal/linked.
2. **Pass 1 — txHash:** index `ins` by txHash; for each `out` with a txHash, exact-match.
   confidence `txhash`.
3. **Pass 2 — address:** for each `out` with `counterpartyAddress ∈ ownAddresses`, match
   an `in` whose `walletAddress`/`toAddr` equals it AND same asset AND amount within fee
   AND time window. confidence `address`.
4. **Pass 3 — heuristic:** for remaining, match same asset + amount within fee + time
   window + direction. confidence `heuristic` → tier SUGGEST (flag, don't auto-confirm).
5. One `in` matches at most one `out` (nearest timestamp wins) — same consumed-set pattern
   as `stitchCrossGroupSimpleTrades` to avoid double-pairing (the guard-removal lesson).

Then a persistence pass applies `isInternalTransfer=true` + `linkedTransferId` +
`internalLinkConfidence` to both legs for tiers AUTO-CONFIRM, and only the flag for SUGGEST.

**When it runs:** (a) after any wallet/connection import completes (post-save hook in
`persistSyncedRows`), and (b) on demand when the user imports a wallet that the Data Health
recon report or Review flagged as a likely destination ("import the destination wallet, or
mark the transfer internal").

---

## 6. How it feeds the reconciliation engine — the scope-aware internal rule

The shipped `ledgerImpliedQty` (sourceReconcile.ts) **skips** internal-transfer legs and
**subtracts** non-internal `transfer_out`. This creates a subtle trap the linker must not
fall into:

> Marking a *recorded* cross-source withdrawal `isInternalTransfer` and skipping it would
> **raise** the ledger-implied qty for the exchange scope (the out leg no longer subtracts),
> turning an already-`reconciled` asset into a `ledger_over`. That is the exact regression
> this section exists to prevent.

**Rule: whether an internal leg is skipped depends on whether its counterpart is in the
SAME reconciliation scope.**

- **Same scope (both legs on the same connection, e.g. Spot↔Funding on Binance):** the two
  legs net to zero *within* `ledgerImpliedQty`, so both are skipped. No change to the
  connection's ledger qty — correct, because the coins never left the exchange.
- **Cross scope (exchange `transfer_out` → a *wallet* `transfer_in`, or → a *different*
  exchange):** the out leg **MUST STILL SUBTRACT** on the exchange's reconciliation, even
  though it is marked `isInternalTransfer` for tax purposes. The coins genuinely left the
  exchange's custody — the exchange's `fetchBalance` dropped — so the exchange-scope
  ledger must drop too. Marking it internal is a *tax/disposal* statement (not a taxable
  event), **not** a *custody* statement.

So `ledgerImpliedQty` needs one refinement when the linker ships: an internal leg is
skipped **only if** `linkedTransferId` points to a counterpart in the **same**
`importBatchId`/connection scope; a cross-scope internal `transfer_out` keeps its `-amount`
on the exchange side. The wallet side's reconciliation already anchors to on-chain
`walletBalances`, so the receive leg is correctly counted there.

**Net effect:**
- **Tax engine:** both legs `isInternalTransfer` → neither is a disposal. (The primary win.)
- **Exchange reconciliation:** the cross-source out still subtracts → the exchange's
  `ledgerQty` correctly reflects that the coins left → stays `reconciled` against the lower
  `fetchBalance`. No phantom, no regression.
- **Dashboard netting:** `buildPortfolioHoldings` nets the pair to zero across sources
  (it already keys internal transfers to zero regardless of scope) → no double-count.
- `internalLinkConfidence` lets the recon report distinguish "closed by proof" (txhash/
  address) from "closed by heuristic" (still reviewable).

**What still needs the missing-history backfill (out of scope here):** the `ledger_over`
class caused by withdrawals that were *never imported at all* (no out leg exists to link).
Only the fetch-completeness work (reconciliation design §0) closes that — linking cannot.

---

## 7. Edge cases + honesty rules

- **Fee-only difference is normal.** Receive < send by gas is expected; do NOT flag the
  difference as a taxable loss. The fee is already captured as a separate `fee` row or
  `feeAmount` on the send.
- **One-to-many splits** (a batch withdrawal settled as multiple on-chain receives): match
  greedily by nearest timestamp but cap at 1:1 per pass; leftover `ins` stay external.
  Document as a known limitation — batch settlement linking is a follow-up.
- **Never invent a counterpart.** If no `in` exists within tolerance, the `out` stays an
  external transfer (and remains a disposal *candidate* until the user confirms it was to an
  own wallet). Auto-link only ever *closes* a gap the data actually supports; it never
  fabricates one.
- **Idempotent.** Re-running must not double-link or re-flag already-linked legs
  (`linkedTransferId` guard).
- **Spam/isSpam legs excluded** from matching.

---

## 8. Test plan (synthetic, no author-machine data)

- txHash-equal pair → AUTO-CONFIRM both legs, `linkedTransferId` set both ways.
- counterpartyAddress in own-addresses → AUTO-CONFIRM.
- Asset+amount+time only → SUGGEST flag, `isInternalTransfer` stays false.
- Receive within fee tolerance (send − gas) → matches; outside tolerance → no match.
- Send after receive (wrong direction) → no match.
- One `in` candidate for two `outs` → nearest timestamp wins, other stays external.
- Idempotency: second run produces zero new patches.
- **Scope-aware recon (the §6 rule):** a *same-scope* internal pair (both legs on conn1) is
  skipped by `ledgerImpliedQty` → conn1 ledger qty unchanged. A *cross-scope* internal out
  (conn1 `transfer_out` → wallet `transfer_in`, both marked internal) **still subtracts** on
  conn1's `ledgerImpliedQty` → conn1 stays `reconciled` against the lower `fetchBalance`,
  NOT pushed to `ledger_over`. This is the regression guard for the §6 trap.
- **Tax engine:** both legs of a linked pair excluded from the disposal set.

---

## 9. Rollout / gate

**Data/calculation logic** (affects taxable-vs-internal classification) → **PR → Vorflux
AUTO REVIEW → test → merge**, per the change-gate framework. Accuracy-over-cost: a wrong
auto-link misstates tax, so tier AUTO-CONFIRM is deliberately conservative (proof only);
anything ambiguous degrades to SUGGEST, never silent.

## 10. Open questions for the user

1. Fee tolerance: fixed per-chain table (proposed) vs a % of amount — which do you prefer?
2. Exchange→exchange window: is ±24h right given Binance/Coinbase processing, or tighter?
3. Should SUGGEST matches auto-resolve after N days untouched, or always need a tap?
