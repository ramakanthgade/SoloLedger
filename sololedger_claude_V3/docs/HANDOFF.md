# SoloLedger current handoff — Dashboard period coherence

Updated: 2026-08-11

## Current behavior

- Dashboard financial sections consume one immutable `DashboardAsOfSnapshot` projected from one coherent Dexie readonly transaction.
- The selected period is published atomically with the snapshot. Period/input changes show a whole-page calculating state, so new nominal/effective dates never appear with old values.
- This tax year, Last tax year, dynamic prior FY, and Custom range use jurisdiction civil boundaries. `effectiveEnd = min(nominalEnd, coherent readAt)` and is re-derived for every read/jurisdiction change.
- Historical Total Net Worth replays transactions/postings and eligible openings through the cutoff. It is assets plus signed explicit liabilities. Unpriced known quantities are omitted from arithmetic but retained as internal partial evidence; the headline remains numeric Total Net Worth.
- Current endpoints require verified source authority and a comparable DeFi manifest. Restored, stale, mixed, incomplete, reconstructed/non-comparable CSV, or otherwise unverified slices fail closed for affected assets.
- Cost Basis is remaining holdings basis under FIFO/LIFO/HIFO/SpecID. Historical rows show Balance, Cost, Market Value, and safe ROI. Point-specific chart basis is calculated at every sample.
- In, Out, Income, Expenses, Trading Fees, and Realized Gains are selected-period totals. Their Transactions deep links carry exact dates/category/contributor IDs, and Transactions recalculates the destination summary from current rows using the shared category contract.
- India Realized Gains uses canonical matched lots, excludes derivatives, and retains positive matched lots only (no loss offset). India tax/TDS is not shown as calculated for other jurisdictions.
- Historical marks use strict legacy/canonical-v2 identities and an inclusive 48-hour age limit; current exact/safe spot marks use a 15-minute limit. Historical projection never falls back to current spot.
- Privacy mode hides value geometry/tooltips, allocation percentages/colors, ROI, limitation counts, and value-derived styling in addition to masking money.
- Dashboard contains no sync/source/reconciliation/Data Health controls. Connections owns those workflows; Transactions owns review/remediation.

Full formulas, category definitions, evidence behavior, price grammar, operational ownership, and external research are documented in [`dashboard-flow-aggregates.md`](./dashboard-flow-aggregates.md).

## Persistence and performance

- IndexedDB schema remains v18.
- Backup export remains format v6.
- No Dashboard migration, row rewrite, archive-node fetch, or server persistence was added.
- `src/lib/dashboard/dashboardAsOfProjection.perf.test.ts` covers 1,200 transactions, 30 assets, 2,160 marks, and 72 samples under a bounded pure-projection runtime.
- Existing performance coverage separately checks posting indexes, internal-transfer matching, DeFi visit counts, and Connections collection budgets.

## Verification commands

```bash
npx vitest run \
  src/lib/dashboard/dashboardPeriod.test.ts \
  src/lib/dashboard/dashboardHistoricalMarks.test.ts \
  src/lib/pricing/priceCacheKey.test.ts \
  src/lib/dashboard/dashboardCategoryAggregation.test.ts \
  src/lib/dashboard/dashboardAsOfProjection.test.ts \
  src/components/dashboard/dashboardAsOfInputSnapshot.test.ts \
  src/components/dashboard/DashboardTab.test.tsx \
  src/components/dashboard/NetWorthChart.test.ts \
  src/lib/storage/dbMigration.test.ts \
  src/lib/storage/backup.test.ts
npm run test:ledger-perf
npx tsc -b --pretty false
git diff --check
```

## Known boundary

The integrated Dashboard does not currently render a 24-hour trend. The retained trend contract is current-endpoint-only; any future presentation must remain absent for historical FY/custom cutoffs.
