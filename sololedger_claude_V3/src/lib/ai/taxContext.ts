/**
 * Builds a concise tax context string from the user's local IndexedDB data.
 * This is injected as a system prompt so the AI knows the user's actual position
 * without the user having to explain it.
 *
 * HONEST DISCLOSURE: what this produces is an AGGREGATED SUMMARY — holdings,
 * cost basis, realized gains, income totals and the user's jurisdiction. Raw
 * transactions, wallet addresses, transaction hashes and personal identifiers
 * are NEVER included. When the AI Advisor is enabled this summary (plus the
 * user's typed question) is what leaves the device — so the context builder is
 * split into a PURE, unit-testable boundary (`buildTaxContext`) that a test can
 * assert never contains address / tx-hash substrings, and an async orchestrator
 * (`buildTaxContextFromDb`) that gathers the aggregates from local storage.
 */
import { db, getSettings } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildMatchedGainRows, buildIncomeRows } from '@/lib/costBasis/matchedGains';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import { formatCurrency, getCurrentFy, getFyLabel, isInFy } from '@/lib/utils';

/** A single open-position holding, aggregated by asset. */
export interface HoldingSummary {
  asset: string;
  qty: number;
  cost: number;
}

/**
 * The complete aggregated summary that is turned into the system prompt.
 * By construction this shape carries ONLY aggregated figures and asset symbols —
 * there is no field for wallet addresses, transaction hashes, or raw rows, so
 * the pure builder cannot leak them.
 */
export interface TaxContextInput {
  fyLabel: string;
  jurisdictionLabel: string;
  jurisdictionNotes: string;
  reportingCurrency: string;
  costBasisMethod: string;
  totalTransactions: number;
  missingPriceCount: number;
  possibleInternalTransferCount: number;
  duplicateSourceRefCount: number;
  possibleDuplicateTxCount: number;
  realizedGain: number;
  disposalCount: number;
  totalIncome: number;
  shortfallCount: number;
  topHoldings: HoldingSummary[];
}

/**
 * PURE context-builder boundary. Given the aggregated summary, produce the
 * system prompt string. No IndexedDB, no network, no personal identifiers —
 * fully deterministic and unit-testable.
 */
export function buildTaxContext(input: TaxContextInput): string {
  const cur = input.reportingCurrency;
  const fmt = (n: number) => formatCurrency(n, cur);

  const holdingLines =
    input.topHoldings.length > 0
      ? input.topHoldings
          .map((h) => `  ${h.asset}: ${h.qty.toPrecision(4)} units, cost basis ${fmt(h.cost)}`)
          .join('\n')
      : `  No open lots found. All acquired assets have been disposed of, or no buy/income events exist.`;

  const lines = [
    `You are SoloLedger's AI Tax Advisor — a friendly, expert crypto tax assistant.`,
    `What you receive is an AGGREGATED SUMMARY of the user's tax position (holdings, cost basis, realized gains, income totals and jurisdiction), plus the question they typed. Raw transactions, wallet addresses and transaction hashes are NOT sent and are not available to you — you can only reason from the aggregated figures below.`,
    ``,
    `## User's Tax Data Summary (${input.fyLabel})`,
    `- Jurisdiction: ${input.jurisdictionLabel} — ${input.jurisdictionNotes}`,
    `- Reporting currency: ${cur}`,
    `- Cost basis method: ${input.costBasisMethod}`,
    `- Total transactions in DB: ${input.totalTransactions}`,
    `- Transactions still missing a price: ${input.missingPriceCount}`,
    `- Possible internal transfers (unverified): ${input.possibleInternalTransferCount}`,
    `- Duplicate source references (same sourceRef, multiple DB rows): ${input.duplicateSourceRefCount}`,
    `- Possible exact duplicates (same asset+amount+time): ${input.possibleDuplicateTxCount}`,
    ``,
    `## ${input.fyLabel} Tax Year`,
    `- Realized gain/loss: ${fmt(input.realizedGain)} across ${input.disposalCount} disposal(s)`,
    `- Income (staking, airdrops, rewards): ${fmt(input.totalIncome)}`,
    input.shortfallCount > 0
      ? `- Warning: ${input.shortfallCount} disposal(s) could not be fully matched to prior acquisitions.`
      : `- All disposals matched to acquisitions.`,
    ``,
    `## Open Positions (cost basis)`,
    holdingLines,
    ``,
    `## Instructions`,
    `- Answer questions clearly and concisely. Use ${cur} for all monetary figures.`,
    `- For India: mention the 30% flat VDA tax rate (Section 115BBH), no loss setoff, 1% TDS where relevant.`,
    `- If asked about specific tax advice, recommend consulting a CA (Chartered Accountant).`,
    `- If data is missing, explain what step to take in SoloLedger (Review → Fetch prices, Import → Sync).`,
    `- Keep responses short unless asked for detail. Use bullet points for lists.`,
    `- If asked about duplicates: share the duplicate counts above. Duplicates often appear when a wallet is re-synced before Noves trades are protected. Suggest: Review → select duplicates → mark as internal or spam.`,
    `- You cannot see individual transaction rows, wallet addresses or transaction hashes — only the aggregated summaries above. Be honest about this.`
  ];

  return lines.join('\n');
}

/**
 * Async orchestrator: gathers the aggregated summary from the user's local
 * IndexedDB data and hands it to the pure `buildTaxContext` builder.
 */
export async function buildTaxContextFromDb(year?: number): Promise<string> {
  const [settings, allTxs, hints] = await Promise.all([
    getSettings(),
    db.transactions.toArray(),
    db.specIdHints.toArray().then((rows) => {
      const m: Record<string, string[]> = {};
      for (const r of rows) m[r.txId] = r.preferredLotIds;
      return m;
    })
  ]);

  const targetYear = year ?? getCurrentFy(settings.jurisdiction);
  const fy = targetYear;
  const fyLabel = getFyLabel(fy, settings.jurisdiction);

  const { disposals, lots, shortfalls } = calculateCostBasis(allTxs, {
    method: settings.defaultCostBasisMethod,
    specIdHints: hints
  });

  const matchedRows = buildMatchedGainRows(disposals, lots, allTxs);
  const incomeRows = buildIncomeRows(allTxs);
  const jurisdiction = JURISDICTIONS[settings.jurisdiction];

  const yearMatches = matchedRows.filter((r) => isInFy(r.sellDate, fy, settings.jurisdiction));
  const yearIncome = incomeRows.filter((r) => isInFy(r.date, fy, settings.jurisdiction));

  const totalGain = yearMatches.reduce((s, r) => s + r.gain, 0);
  const totalIncome = yearIncome.reduce((s, r) => s + r.fiatValue, 0);

  // Holdings summary (Portfolio)
  const holdings = new Map<string, { qty: number; cost: number }>();
  for (const lot of lots) {
    if (lot.amountRemaining <= 0) continue;
    const h = holdings.get(lot.asset) ?? { qty: 0, cost: 0 };
    h.qty += lot.amountRemaining;
    h.cost += lot.amountRemaining * lot.costBasisPerUnit;
    holdings.set(lot.asset, h);
  }
  const topHoldings: HoldingSummary[] = [...holdings.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(([asset, { qty, cost }]) => ({ asset, qty, cost }));

  const missingCount = allTxs.filter(
    (t) => t.fiatValue == null && !t.isInternalTransfer
  ).length;

  const spamCount = allTxs.filter((t) => (t.flags ?? []).includes('possible_internal_transfer')).length;

  // --- Duplicate detection ---
  const sourceRefCounts = new Map<string, number>();
  for (const t of allTxs) {
    if (t.sourceRef) sourceRefCounts.set(t.sourceRef, (sourceRefCounts.get(t.sourceRef) ?? 0) + 1);
  }
  const duplicateSourceRefs = [...sourceRefCounts.entries()].filter(([, count]) => count > 1);
  const duplicateAssetAmountCounts = new Map<string, number>();
  for (const t of allTxs) {
    const key = `${t.asset}:${t.amount.toFixed(6)}:${t.timestamp}`;
    duplicateAssetAmountCounts.set(key, (duplicateAssetAmountCounts.get(key) ?? 0) + 1);
  }
  const possibleDuplicateTxs = [...duplicateAssetAmountCounts.entries()].filter(([, c]) => c > 1).length;

  return buildTaxContext({
    fyLabel,
    jurisdictionLabel: jurisdiction.label,
    jurisdictionNotes: jurisdiction.notes.slice(0, 120),
    reportingCurrency: settings.reportingCurrency,
    costBasisMethod: settings.defaultCostBasisMethod,
    totalTransactions: allTxs.length,
    missingPriceCount: missingCount,
    possibleInternalTransferCount: spamCount,
    duplicateSourceRefCount: duplicateSourceRefs.length,
    possibleDuplicateTxCount: possibleDuplicateTxs,
    realizedGain: totalGain,
    disposalCount: yearMatches.length,
    totalIncome,
    shortfallCount: shortfalls.length,
    topHoldings
  });
}
