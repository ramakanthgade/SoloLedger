# SoloLedger Roadmap — Master Task List

**Owner:** Ramakanth + Hermes (CEO mode). **Updated:** 2026-07-30.
**North star:** any crypto user with basic understanding files taxes with the **fewest clicks** — SoloLedger does the work automatically. Every task is judged by: does it reduce clicks or increase trust?

**How to use:** each task has a status — `TODO` / `IN PROGRESS` / `DONE` / `BLOCKED` — and an owner. Update statuses as work lands; link the PR when done.

---

## Tier 1 — Core product correctness & trust (do first)

| # | Task | Status | Owner | Notes / PR |
|---|---|---|---|---|
| 1 | **Validate phantom fix live** — Binance re-import (wipe old CSV batch → CSV first → API resync), confirm Dashboard shows real balances | TODO | Ramakanth | ~15 min. Everything else builds on this being right. |
| 2 | **Internal-transfer linker implementation** — per docs/internal-transfer-autolink-design.md (#71). Fold in Koinly tolerances: 12h window, ≤20% diff, chronology, likeness; txHash/own-address = auto-confirm tier | TODO | Hermes | Kills phantoms + auto-nets own-wallet transfers = fewer Review steps. Data/calc gate → Vorflux. |
| 3 | **DeFi data handling test** — real DeFi txs end-to-end via Moralis (7,200+ protocols); fix classification gaps | TODO | Hermes + Ramakanth | Test wallet available (Polygon). |
| 4 | **India crypto-income tax rule verification** — is staking/airdrop/mining income slab-rate or 30%+4%cess? Does the 1% TDS credit apply to income vs only capital gains? Read actual Income Tax Act §115BBH/§194S + CBDT guidance, NOT blog summaries | TODO | Hermes | Accuracy-over-cost doctrine. Then fix Schedule VDA calc if needed. |
| 5 | **Schedule VDA + 194S TDS attribution** — per-transaction TDS tracking (exchange-deducted vs self-deducted) + CA-ready Schedule VDA export | TODO | Hermes | India home-turf differentiator (benchmark P2). Data/calc gate. |

## Tier 2 — Coverage & onboarding (the "fewest clicks" multiplier)

| # | Task | Status | Owner | Notes / PR |
|---|---|---|---|---|
| 6 | **CCXT — integrate the other ~104 exchanges** — CCXT loader → shared save path → per-exchange symbol discovery. Recon engine makes this safe (persist fetchBalance per connection = free recon) | TODO | Hermes + Vorflux | Data/calc gate. Start with top 5 by user demand. |
| 7 | **CSV importer coverage** — sample CSVs from WazirX, CoinDCX, ZebPay, Kraken, Coinbase, KuCoin, OKX, Bybit… test imports, fix parsers. Research **monid.ai** vs Firecrawl for crawling exchange CSV format docs/sample files (research crawl only, never user data) | TODO | Hermes | monid.ai = cheaper Firecrawl alternative Ramakanth found — evaluate first. |
| 8 | **Competitor-migration onboarding** — one-click import of Koinly/CoinTracker/CoinLedger export CSVs + "why switch" flow | TODO | Hermes + Vorflux | Switching reason = privacy (on-device) + India-depth (TDS/VDA) + price. |

## Tier 3 — UX polish & differentiation

| # | Task | Status | Owner | Notes / PR |
|---|---|---|---|---|
| 9 | **UI/UX sweep across all screens** — systematic per-screen pass (dogfood session per screen) | TODO | Hermes | Direct-merge gate (UI/UX). |
| 10 | **Landing page rewrite** — less verbatim, clearer use cases; lead with privacy + India + "fewest clicks" | TODO | Hermes | Uses #13 pain-point research for messaging. |
| 11 | **AI advisor (private)** — on-device/redacted AI for light (explain a tx) + heavy (tax planning). Deliverable: architecture + cost model + tier pricing proposal | TODO | Hermes (design first) | Privacy is the constraint — no raw ledger leaves device. |

## Tier 4 — Business & launch

| # | Task | Status | Owner | Notes / PR |
|---|---|---|---|---|
| 12 | **Pricing model** — competitor comparison (Koinly per-year-lifetime-tx vs CoinTracker all-years-sub) + break-even subscriber math + recommended tiers | TODO | Hermes | Feeds #11 AI-tier pricing. |
| 13 | **India crypto-tax pain-point deep research** — most severe user pain points → product priorities + landing messaging | TODO | Hermes (research) | Can run on a cloud agent once one works. |
| 14 | **Domain integration — sololedger.ai** (bought on Cloudflare) — advice: soft-launch only. Point at "coming soon/waitlist" page early; full app cutover after Tier 1 validated | TODO | Hermes + Ramakanth | Do NOT put the app on the real domain before #1 passes. |
| 15 | **Pvt Ltd registration (Hyderabad) + payment gateway** — step-by-step guide + Razorpay vs Stripe for India SaaS. LAST, only when product is launch-ready | TODO | Hermes (doc) | Deferred by design. |

## Hermes additions (gaps not in the original list)

| # | Task | Status | Owner | Notes / PR |
|---|---|---|---|---|
| 16 | **Background sync + notify-on-complete** ("we'll email/notify when sync finishes") — zero-click auto-sync | TODO | Hermes + Vorflux | Koinly pattern Ramakanth liked. Huge for "works automatically". |
| 17 | **Data-confidence score per source** — extend Data Health into one-glance "how complete is my data" | TODO | Hermes | Builds on #70 recon report. Trust feature competitors can't match. |
| 18 | **Real-data regression harness** — anonymized fixture from the 28,928-row Binance export; every future change tested against real complexity | TODO | Hermes | Needs Ramakanth's exported backup file handoff. |
| 19 | **Error-recovery UX** — failed sync resumes cleanly ("Resume", not "start over"); surface existing cursor-safety work | TODO | Hermes + Vorflux | Click reduction + trust. |
| 20 | **Public changelog / status page** — "what changed and why your numbers are right" | TODO | Hermes | Trust-builder for converting Koinly users. |

---

## Suggested next-session order

1. #1 (Ramakanth validates phantom fix live)
2. #4 (Hermes verifies India income-tax rule from the actual tax code)
3. Claude Code setup (10 min — console.anthropic.com key) + live test on one task
4. #2 internal-transfer linker implementation

## Cloud-agent note (2026-07-30)

Railway Hermes is NOT usable for autonomous work (terminal blocks on git approval headless → deadlock; no web-search key). Plan: Claude Code with a console.anthropic.com API key, tested on one task before trusting overnight. Cursor cancelled; Codex needs an OpenAI key.

## Recently completed (for reference)

PR #65 import-count fix · #66 reconciliation engine backbone · #67 Dashboard authority-quantity + logos · #68 Transactions logos + native-asset display · #70 Data Health reconciliation report · #71 internal-transfer autolink design · #72 Koinly benchmark — all merged to main 2026-07-29/30.
