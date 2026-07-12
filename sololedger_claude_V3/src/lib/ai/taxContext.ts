/**
 * Builds a concise tax context string from the user's local IndexedDB data.
 * This is injected as a system prompt so the AI knows the user's actual position
 * without the user having to explain it.
 *
 * Never includes wallet addresses, transaction hashes, or personal identifiers —
 * only aggregated financial figures and a handful of recent transactions.
 */
import { db, getSettings } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildMatchedGainRows, buildIncomeRows } from '@/lib/costBasis/matchedGains';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import { formatCurrency, getCurrentFy, getFyLabel, isInFy } from '@/lib/utils';

export async function buildTaxContext(year?: number): Promise<string> {
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

  const cur = settings.reportingCurrency;
  const fmt = (n: number) => formatCurrency(n, cur);

  // Holdings summary (Portfolio)
  const holdings = new Map<string, { qty: number; cost: number }>();
  for (const lot of lots) {
    if (lot.amountRemaining <= 0) continue;
    const h = holdings.get(lot.asset) ?? { qty: 0, cost: 0 };
    h.qty += lot.amountRemaining;
    h.cost += lot.amountRemaining * lot.costBasisPerUnit;
    holdings.set(lot.asset, h);
  }
  const topHoldings = [...holdings.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(([asset, { qty, cost }]) => `  ${asset}: ${qty.toPrecision(4)} units, cost basis ${fmt(cost)}`);

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

  const lines = [
    `You are SoloLedger's AI Tax Advisor — a friendly, expert crypto tax assistant.`,
    `All data is 100% local on the user's device. You can only access the summary data shown below.`,
    ``,
    `## User's Tax Data Summary (${fyLabel})`,
    `- Jurisdiction: ${jurisdiction.label} — ${jurisdiction.notes.slice(0, 120)}`,
    `- Reporting currency: ${cur}`,
    `- Cost basis method: ${settings.defaultCostBasisMethod}`,
    `- Total transactions in DB: ${allTxs.length}`,
    `- Transactions still missing a price: ${missingCount}`,
    `- Possible internal transfers (unverified): ${spamCount}`,
    `- Duplicate transaction hashes (same sourceRef, multiple DB rows): ${duplicateSourceRefs.length}`,
    `- Possible exact duplicates (same asset+amount+time): ${possibleDuplicateTxs}`,
    ``,
    `## ${fyLabel} Tax Year`,
    `- Realized gain/loss: ${fmt(totalGain)} across ${yearMatches.length} disposal(s)`,
    `- Income (staking, airdrops, rewards): ${fmt(totalIncome)}`,
    shortfalls.length > 0
      ? `- Warning: ${shortfalls.length} disposal(s) could not be fully matched to prior acquisitions.`
      : `- All disposals matched to acquisitions.`,
    ``,
    `## Open Positions (cost basis)`,
    topHoldings.length > 0
      ? topHoldings.join('\n')
      : `  No open lots found. All acquired assets have been disposed of, or no buy/income events exist.`,
    ``,
    `## Instructions`,
    `- Answer questions clearly and concisely. Use ${cur} for all monetary figures.`,
    `- For India: mention the 30% flat VDA tax rate (Section 115BBH), no loss setoff, 1% TDS where relevant.`,
    `- If asked about specific tax advice, recommend consulting a CA (Chartered Accountant).`,
    `- If data is missing, explain what step to take in SoloLedger (Review → Fetch prices, Import → Sync).`,
    `- Keep responses short unless asked for detail. Use bullet points for lists.`,
    `- If asked about duplicates: share the duplicate counts above. Duplicates often appear when a wallet is re-synced before Noves trades are protected. Suggest: Review → select duplicates → mark as internal or spam.`,
    `- You cannot see individual transaction rows — only the aggregated summaries above. Be honest about this.`
  ];

  return lines.join('\n');
}
