# Competitor UX Benchmark — Koinly-first (with CoinTracker standouts)

**Purpose:** learn how Koinly (and secondarily CoinTracker) present information so SoloLedger
can **adapt** the best patterns — customized to a privacy-first, India-tax app. Never copied verbatim.
**Compiled:** 2026-07-30 by Hermes, from Koinly's Help Center + guides + a CoinTracker-authored
comparison. Sources cited per claim.
**User preference:** Koinly's design and information presentation are the reference; CoinTracker is
mined only for standout features Koinly lacks.

---

## 1. Dashboard / Portfolio

**What Koinly does** (source: support.koinly.io/en/articles/9489954-dashboard-explained):
- **Timeframe selector top-right** (default = current year) drives the whole page.
- **Chart area:** Total value (current market value of all crypto, *excludes* fiat/NFT/LP),
  Cost basis, Unrealized gains (= Total value − Cost basis). Custom dates → values reflect
  end-of-last-day of the period.
- **Breakdown area (bottom):** In (deposits, valued at time of deposit), Out (withdrawals),
  Income, Expenses, Trading Fees, Realized Gains. **Each row is clickable** → jumps to the
  Transactions page pre-filtered to the contributing set.
- **Assets area (holdings table):** Asset (name + icon), Balance, Cost, Market Value,
  ROI (`(market value − cost)/cost %`), 24h trend.
- **"View reported balances" toggle (3-dot menu):** switch between *reported* (API snapshot)
  and *calculated* (from your transactions) balances. Reported balances are current-date only.

**SoloLedger should…**
- Keep our **Breakdown rows clickable** (In/Out/Income/Realized gains → pre-filtered
  Transactions). Koinly's "click a total → see its transactions" is a high-trust pattern we
  partially have via Insights; make the money-strip numbers drill down too.
- Adopt the **per-asset columns exactly as a mental model**: Balance · Cost · Market Value ·
  ROI% · 24h. We have these; ensure ROI% uses Koinly's formula `(mv − cost)/cost` so numbers
  match user expectations set by Koinly.
- Our **"Reconciled to exchange balance / on-chain / Estimated from tx history" caption is a
  differentiator Koinly lacks at the row level** — keep it; it's the honest analogue of their
  reported-vs-calculated toggle, but surfaced per-holding instead of buried in a menu.

---

## 2. Transactions page (MOST IMPORTANT)

**What Koinly does** (sources: support.koinly.io/en/articles/9490024 + 9490046 + Reddit/usage):
- A crypto-to-crypto trade/swap is shown as the **original pair** — e.g. a send leg of 1 ETH
  and a receive leg of 0.08 BTC — NOT flattened to a single fiat number. The fiat value is the
  *valuation* used for tax, shown alongside, not the headline.
- A merged internal **Transfer** renders as ONE row: send amount → receive amount, with the
  difference surfaced as a **transfer fee**. (Koinly *merges* the two legs into a single
  "Transfer" transaction type.)
- Each row carries the source wallet/exchange icon + the asset icon; types are visually
  distinguished (Exchange / Transfer / Income / Deposit / Withdrawal / Cost).

**SoloLedger should…**
- ✅ **Already shipped (PR #68):** our `rowAnatomy` now keeps the original pair for
  crypto-to-crypto sell/buy (`Sold 954.5 LPT for 4850.60 USDT (≈ ₹4,04,700)`) with ₹ as a
  subline — this matches Koinly exactly. Keep it.
- **Differentiate on the internal-transfer presentation:** Koinly *merges* two legs into one
  "Transfer" row. SoloLedger's PR #71 design instead keeps both legs but links them
  (`linkedTransferId`) and nets to zero — **better for an append-only ledger + India audit
  trail** (we never rewrite history). Present the pair as a single visual group in Review,
  but keep both underlying rows. This is a deliberate, defensible divergence.
- **Colored icons everywhere (PR #68 done)** — Koinly never shows black/mono glyphs; our move
  to CDN colored logos + colored exchange marks closes that gap.

---

## 3. Reconciliation / "missing transactions" warnings (our key differentiator)

**What Koinly does** (source: support.koinly.io/en/articles/9490038):
- Downloads **two** datasets per API sync: full transaction history **and** a balance
  snapshot ("📠 Reported balances"). It computes "🧮 Calculated balances" from transactions
  and reports `Difference = Koinly Balance − API Balance`.
- Surfaces a **yellow warning triangle** next to mismatched assets in the wallet.
- Crucially: **Calculated balances drive tax reports; Reported balances are ONLY a
  cross-check** ("not used in reports at all"). Users can "Ignore reported balances".
- Enumerates common mismatch causes with **fix / no-fix verdicts**: Rounding (no fix), Open
  Orders (no fix), Staked assets (no fix), Delayed update (no fix), Reflection/taxed tokens
  (fix), Spam (fix), **Other missing transactions (fix — API limits)**, manual-entry errors (fix).

**SoloLedger should…**
- ✅ **Our reconciliation engine is architecturally ahead here.** Koinly treats the API
  balance as a *throwaway cross-check* and the *calculated* (ledger) balance as the tax truth.
  SoloLedger's model (design §3.3, shipped PR #67) anchors **display quantity to the authority
  (fetchBalance / on-chain)** *and* keeps the ledger for cost basis — then **surfaces the gap
  as the diagnostic**. Koinly *hides* the gap in a toggle; we *name* it in the Data Health card.
  This is the wedge: **Koinly tells you "something's off, go figure it out"; SoloLedger tells
  you "exchange shows 0.0000049 BTC, ledger implies 9.17 → 8.99 BTC of withdrawals not
  accounted for — import the destination wallet or mark it internal."**
- **Adopt their fix/no-fix taxonomy** in our Data Health drill-down: dust/rounding (ε threshold
  already in `sourceReconcile`), open orders, staked assets → "expected, no action"; missing
  history → "action needed". Prevents alarm fatigue.
- **CTA wording:** mirror Koinly's actionable tone but stay on-device: "Import the destination
  wallet" / "Mark the transfer internal" (already in PR #70 copy).

---

## 4. Internal-transfer handling

**What Koinly does** (source: support.koinly.io/en/articles/9490024):
- **Auto-merges** a deposit + withdrawal into one Transfer when ALL pass: (1) same asset,
  (2) within **12 hours**, (3) withdrawal **before** deposit, (4) deposit ≤ withdrawal,
  (5) difference ≤ **20%**, (6) hash matches / one or both lack a hash.
- Bridging: same token across chains (ETH→ETH) merges; different token (BTC→WBTC) does NOT
  auto-merge (fails likeness) but can be merged manually (shows as Exchange, gains computed).

**SoloLedger should…**
- **Calibrate our PR #71 tolerances against Koinly's concrete numbers:** they use **12h** window
  and **20% max difference** (looser than my draft's per-chain fee table + tighter %).
  Recommendation: adopt **12h + ≤20%** as the *heuristic* (SUGGEST) tier to match user
  expectations, but keep **txHash / own-address** as the stricter *auto-confirm* tier (Koinly
  merges on weaker signals than we should auto-confirm — a wrong merge misstates tax).
- **Handle bridging the same way:** same-token cross-chain = internal; wrapped-token
  (BTC→WBTC) = NOT auto-internal (it's a disposal/swap for tax). Add this to the linker spec.
- Our **scope-aware custody rule (PR #71 §6, just fixed)** is something Koinly doesn't
  document — a genuine technical edge. Keep it.

---

## 5. India-specific (TDS / Schedule VDA / 115BBH)

**What Koinly does** (source: koinly.io/guides/crypto-tax-india):
- Covers Section **115BBH** (flat **30% + 4% cess** on VDA gains, no loss offset/carry-forward,
  no ST/LT distinction) and Section **194S** (**1% TDS** on transfer, thresholds ₹50k/₹10k).
- Reports gains in **Schedule VDA** of ITR-2 (ITR-3 if business income). P2P/international may
  need self-deduction of TDS.
- Koinly generates an India tax report but is fundamentally a global tool retrofitted to India.

**SoloLedger should…**
- **This is our home turf — out-execute, don't just match.** We already compute 30% + 4% cess
  (`estimateIndiaVDA`), aggregate TDS (`aggregateTds`), and flag "losses can't offset gains".
- **Differentiate on what Koinly glosses over:** (a) per-transaction **194S TDS tracking with
  exchange-vs-self-deducted attribution** (Koinly lumps it); (b) **Schedule VDA-ready export**
  formatted for direct ITR-2 entry (CA-friendly); (c) **no-loss-offset enforcement** surfaced
  *before* the user assumes a loss reduces tax (Koinly lets users discover this at filing).
- Lean into **privacy**: Koinly uploads everything to their cloud; SoloLedger computes India tax
  **on-device**. For India users wary of the ITD, "your ledger never leaves your browser" is a
  real selling point Koinly structurally cannot match.

---

## 6. CoinTracker standouts worth borrowing (that Koinly lacks)

Source: cointracker.io/blog/koinly-vs-cointracker (CoinTracker-authored, so discount the bias;
cross-checked against countonsheep + coinledger reviews):

1. **Tax-Loss Harvesting dashboard.** CoinTracker has a built-in TLH tool that surfaces
   unrealized-loss lots by asset and date. Koinly only gives raw gain/loss data for manual TLH.
   → **SoloLedger:** we already detect "biggest unrealized loss" (Insight). Extend to a proper
   **TLH surface**: list holdings with unrealized losses + the exact lots to sell to realize
   them. *India nuance:* since VDA losses **can't offset gains**, TLH is less about tax and more
   about portfolio rebalancing — frame it honestly ("realize a loss to exit a position", not
   "harvest to save tax", because in India it won't reduce VDA tax).
2. **Polished, customizable dashboard + best-in-class mobile app (4.8★ vs Koinly 3.3★).**
   → SoloLedger: prioritize a clean, low-density mobile layout for the Dashboard and
   Transactions (our lg:grid work is a start; mobile card view needs the same rigor).
3. **One subscription covers all prior tax years** (Koinly charges per year on *lifetime*
   transaction count, which ratchets cost up). → pricing-model note for later, not a UI feature.

---

## TL;DR — prioritized actions for SoloLedger

| Priority | Action | Source pattern | Status |
|---|---|---|---|
| P0 | Keep original crypto pair + ₹ subline on Transactions | Koinly §2 | ✅ Done (PR #68) |
| P0 | Colored logos/icons everywhere | Koinly §2 | ✅ Done (PR #68) |
| P0 | Data Health recon = authority-vs-ledger gap, named with a Why? | **Our edge** over Koinly §3 | ✅ Done (PR #70) |
| P1 | Internal-transfer auto-link w/ scope-aware custody rule | Koinly §4 + **our §6 edge** | Design (PR #71) |
| P1 | Calibrate link tolerances: 12h + ≤20% heuristic; txHash/address auto-confirm | Koinly §4 | Fold into PR #71 impl |
| P1 | Fix/no-fix taxonomy in recon drill-down (dust/orders/staked vs missing) | Koinly §3 | Enhance PR #70 |
| P2 | Clickable Breakdown totals → pre-filtered Transactions | Koinly §1 | New |
| P2 | 194S TDS attribution + Schedule VDA export + no-loss-offset surfacing | **Our India edge** §5 | New |
| P2 | TLH surface (honest India framing: rebalancing, not tax-saving) | CoinTracker §6 | New |
| P3 | Mobile layout polish (Dashboard + Transactions) | CoinTracker §6 | Ongoing |

**The strategic takeaway:** Koinly's *reported-vs-calculated* model treats the exchange balance
as a disposable cross-check and the ledger as truth. SoloLedger's authority-anchored model +
named-gap Data Health report is a genuine architectural advantage — **we should market it as
"we show you *why* your numbers don't match, on-device, and tell you exactly how to fix it,"**
which neither Koinly nor CoinTracker does.
