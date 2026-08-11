# Dashboard period, valuation, and flow aggregates

The Dashboard is a financial, cutoff-aware view over one coherent local ledger snapshot. It does not combine a historical chart with current holdings, and it does not own import, sync, reconciliation, or Data Health operations.

## Period model

A Dashboard selection is a `DashboardPeriodSelection`:

```text
nominalStart  = inclusive jurisdiction-local start of the selected FY/range
nominalEnd    = inclusive jurisdiction-local end of the selected FY/range
effectiveEnd  = min(nominalEnd, coherentInput.revision.readAt)
```

The controls are **This tax year**, **Last tax year**, a dynamic prior-FY label, and **Custom range**. India FY boundaries are Apr 1 00:00:00.000 IST through Mar 31 23:59:59.999 IST. Other jurisdictions use the existing jurisdiction FY/calendar rules.

Custom ranges use civil dates. A future start, invalid date, or start after end is rejected. A valid future end remains the nominal end but clamps `effectiveEnd` to the coherent read clock. Every new coherent input read re-derives the selected preset against its `readAt`; FY rollover and jurisdiction changes therefore cannot leave stale boundaries. Preset intent is preserved by ID. Custom civil dates are reinterpreted for the new jurisdiction, with a safe fallback to This tax year if they are no longer valid.

The UI publishes the selected period together with its projected snapshot. It shows the nominal full range exactly once beside the controls and the effective cutoff exactly once (for example, `Data through Aug 12, 2026`). There is no repeated full-range subtitle or global cutoff in the hero, chart chrome, cards, holdings, or tax rail. Chart samples and tooltips never extend beyond `effectiveEnd`.

## Coherent input and atomic publication

`readDashboardAsOfInputSnapshot()` is the Dashboard's only persistence read boundary. One Dexie readonly transaction reads:

- transactions and source/account identities;
- authority snapshots/assets and source coverage;
- eligible opening balances;
- DeFi snapshots, rows, and retained wallet refresh manifests;
- price-cache rows;
- jurisdiction, reporting currency, configured cost method, and derivatives treatment;
- persisted SpecID hints and asset-safety decisions.

The result is cloned, deeply frozen, and tagged with an immutable revision token plus the clock captured inside that transaction. A single `liveQuery` invalidates the whole read when any dependency changes. Projection is pure and performs no IndexedDB reads.

`createDashboardAsOfAtomicPublisher()` assigns monotonically increasing request tokens. A newer input or period request supersedes older success and failure completions. The integrated Dashboard publishes `{ period, snapshot }` in one state update and renders a whole-page calculating state between requests; it never presents new period dates with old hero, chart, allocation, holdings, or tax values. A calculation failure renders one coherent error state rather than mixing the previous snapshot with new settings.

## Historical ledger-basis reconstruction

For `effectiveEnd < readAt`, `projectLedgerBasisNetWorthAtCutoff()` replays derived postings and eligible opening balances through each cutoff. It includes:

- acquisitions and openings before `nominalStart` when they remain in inventory at the cutoff;
- ordinary custody assets;
- explicit recorded liabilities;
- protocol supply/debt represented by stored decoded or imported ledger records.

It excludes post-cutoff events. It does not rewind a current authority balance, infer an unrecorded protocol position, query an archive node, or require a historical wallet-DeFi manifest.

Historical Total Net Worth remains numeric:

```text
Total Net Worth = sum(eligible-valued recorded assets)
                + sum(signed eligible-valued recorded liabilities)
```

Liabilities carry negative signed quantities and contributions. An unexplained negative non-liability custody balance is not converted into debt: it is marked incomplete, omitted from arithmetic, and linked internally to missing opening/history evidence.

A known quantity without an eligible mark remains an internal contributor but has no market value. It is omitted from arithmetic rather than assigned zero. The aggregate therefore keeps a numeric known subtotal under the **Total Net Worth** label while `valuationCompleteness` is `partial`, with separate missing-asset and missing-liability counts. Cost Basis and Unrealized P&L are likewise partial when positive holdings are not fully covered by remaining lots/opening-basis evidence. Later transaction, classification, opening-balance, SpecID, safety, or eligible-price changes invalidate the coherent input and recompute prior totals.

## Current endpoint authority

Only `effectiveEnd === readAt` may use current source authority and current DeFi manifests. Every non-verified authority slice fails closed for the affected asset. Restored, stale, mixed-generation, incomplete, reconstructed/non-comparable CSV, and invalid-manifest evidence cannot silently merge with posting fallback into a current net-worth value. Explicit liabilities are subtracted only when the current DeFi projection is comparable.

Current authority is never rewound into earlier chart points. The as-of snapshot exposes the authority/completeness reasons internally; the UI does not render evidence-taxonomy badges.

## Selected-period categories and Transactions deep links

Pre-period records can supply holdings and remaining lot basis, but only records satisfying

```text
nominalStart <= event timestamp <= effectiveEnd
```

can contribute to the six activity totals, selected-period TDS, or estimated India tax.

- **In** — reporting-currency transaction-time value of external `transfer_in` principal. Confirmed and paired self-transfers are excluded.
- **Out** — corresponding external `transfer_out` principal value, with the same internal-transfer exclusion.
- **Income** — `income` records and the shared income taxonomy (rewards, mining, airdrops, forks, lending interest, salary, cashback, DeFi/staking/genesis/mainnet rewards, and other income). Principal deposits are not Income.
- **Expenses** — the shared expense taxonomy: cost, payment, donation, lost, tax, loan fee, margin fee, and funding fee.
- **Trading Fees** — standalone fees, supported execution-fee categories, and positive inline fees, but only when the row is not already classified as an Expense.
- **Realized Gains** — canonical matched-lot, non-derivative disposal gains under the configured cost method. It does not merge derivative, margin, income, or other business results.

Each card opens Transactions with the same `nominalStart`, `effectiveEnd`, exact category, and exact contributor transaction IDs. Transactions applies the same category predicates and revalues the filtered summary from current rows rather than trusting a copied Dashboard amount. Realized Gains is recomputed from the canonical disposal/lot result. This keeps all six destination totals aligned with the Dashboard while allowing a newer coherent ledger revision to update the destination honestly.

## Cost basis, ROI, fees, and India tax

**Cost Basis** is remaining holdings basis at the effective cutoff, not fiat invested during the selected period. The configured FIFO, LIFO, HIFO, or SpecID method is used. Persisted SpecID hints reference deterministic lot identities and are applied only to lots available by the cutoff.

Historical holdings show Balance, Cost, Market Value, and:

```text
ROI = (marketValue - cost) / cost
```

ROI is unavailable when cost is zero/missing/undercovered or market value is unavailable. Current holdings show quantity/value, average cost, current price, and Unrealized P&L. Unrealized P&L uses only the intersection with eligible market value and complete cost evidence; it is not zero-filled.

Trading Fees are displayed separately for transparency. Category aggregation does not mutate disposal matching, basis, or proceeds, and the displayed fee total is never subtracted from holdings or gains a second time. Any fee treatment already represented by the canonical transaction/cost-engine input therefore remains single-counted.

For India, Realized Gains uses `buildMatchedGainRows()` and includes only positive matched lots in the selected period. Loss lots do not offset gain lots under the SoloLedger Section 115BBH calculation. Estimated tax is calculated from that positive matched-lot total; TDS is selected-period-only and shown only for India. Dashboard tax estimates are not calculated for US, Canada, or UAE. Custom-period tax copy explicitly says it is not a filing-year total.

The as-of integration does not currently display a 24-hour trend. If trend presentation is reintroduced, the existing contract permits it only at a current endpoint with eligible comparison marks; it must remain absent for historical FY/custom cutoffs.

## Price identity and freshness

The shared strict parser accepts persisted v18 key grammars:

```text
sym:<symbol>:<DD-MM-YYYY>:<currency>
ctr:<platform>:<contract>:<DD-MM-YYYY>:<currency>
sym:v2:<canonicalId>:<DD-MM-YYYY>:<currency>
ctr:v2:<canonicalId>:<platform>:<contract>:<DD-MM-YYYY>:<currency>
spot:sym:<symbol>:<currency>
spot:ctr:<platform>:<contract>:<currency>
```

Canonical IDs are resolved at the transaction/sample timestamp so migration-window identities select the ID valid then. Exact platform+contract candidates take precedence. Symbol fallback is allowed only by the existing exact-asset safety policy. Malformed keys, ambiguous canonical identity, mismatched contracts, and unsafe symbol fallback are unavailable rather than guessed.

Historical date-keyed marks are always `estimated`, including a close on the same civil date. The chosen mark must satisfy:

```text
markAt <= cutoff
cutoff - markAt <= 48 hours
```

Exactly 48 hours is eligible; 48 hours plus 1 ms is stale. Future marks and current spot fallback are forbidden for historical samples.

Current endpoints prefer exact contract spot, then explicitly safe symbol spot. `fetchedAt` must not be in the future and must be no more than 15 minutes old. Reporting-currency contributors use a direct unit mark of 1.

Stored `PriceCacheRow` provenance is limited to key, price, and `fetchedAt`. Optional calculation disclosure may translate that evidence into mark/cache dates where necessary, but must not invent provider, venue, confidence, or close-methodology claims.

## Evidence, disclosure, and privacy

Projection rows, aggregates, and chart points carry internal quantity/valuation status, completeness, cutoff/mark timestamps, reason codes, contributor IDs, and missing counts. Presentation rules are deliberately quieter:

- complete sections show values without evidence badges;
- estimated/partial sections use one short plain-language note;
- a missing row may say `Price unavailable for this date`;
- at most one **How this was calculated** disclosure explains ledger reconstruction and limitations;
- internal status names are not rendered as chips or repeated row labels.

Dashboard privacy mode masks headline, period-card, holdings, and tax values; removes chart value geometry and tooltips; hides allocation geometry, colors, and percentages; hides ROI and disclosure counts; and removes gain/loss sign styling that could reveal a masked value. Non-value axis scaffolding may remain visible.

## Operational ownership matrix

| Surface | Dashboard | Connections / Transactions |
| --- | --- | --- |
| Financial period, net worth, chart, allocation, holdings, tax | Owns | — |
| Activity contributor review | Deep-links only | Transactions owns filtering and recalculated summaries |
| Sources, sync status/history, Sync now, Add source | Removed | Connections owns |
| Reconciliation and Data Health workspace | Removed | Connections owns |
| Opening-balance/source remediation | Contextual disclosure link only when needed | Connections/Transactions own |
| App-wide import progress banner | Hidden while Dashboard is active | Visible on operational tabs |

Moving Data Health removes its independent reads/model assembly from Dashboard critical paint. Connections retains source cards, detail/history, reconciliation, opening balances, exact remediation intents, and browser-back restoration.

## Performance and compatibility

`dashboardAsOfProjection.perf.test.ts` explicitly projects 1,200 deterministic transactions across 30 assets, 2,160 historical marks, and 72 chart samples under a bounded runtime. It invokes the pure projection with complete in-memory inputs, so projection cannot perform per-row Dexie reads. Existing performance tests separately cover prepared posting indexes, internal-transfer matching, DeFi generation/row visit counts, and Connections collection budgets.

This work does not change persistence: IndexedDB remains schema v18, backup export remains format v6, and there is no data rewrite. Restored authority evidence remains stale/non-authoritative.

## External research

Product direction was checked against official Koinly documentation; these references support the general period-end and ledger-history model, not SoloLedger tax or authority semantics.

1. Koinly, [Dashboard explained](https://support.koinly.io/en/articles/9489954-dashboard-explained), official support article, updated **June 4, 2026**, accessed **August 11, 2026**. It documents current-year/custom timeframe behavior, selected-period breakdowns, end-of-selected-period holdings/value semantics, Expenses versus Trading Fees, remaining-holdings Cost Basis, fee inclusion in basis, and asset ROI.
2. Koinly, [My graph is incorrect](https://support.koinly.io/en/articles/9490040-my-graph-is-incorrect), official support article, accessed **August 11, 2026**. It explains that historical graphs are reconstructed from transaction history because connected APIs do not provide historical balances.

SoloLedger does **not** claim Koinly parity. The future-ending nominal FY plus effective cutoff, exactly-once top copy, India positive-matched-lot no-offset calculation, TDS scope, canonical asset-safety policy, 48-hour historical/15-minute current freshness, current authority fail-closed rules, local coherent IndexedDB read, and atomic publication are SoloLedger contracts and override any analogy to another product.
