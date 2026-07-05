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
import { formatCurrency } from '@/lib/utils';

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

  const targetYear = year ?? new Date().getFullYear();
  const fy = targetYear;

  const { disposals, lots, shortfalls } = calculateCostBasis(allTxs, {
    method: settings.defaultCostBasisMethod,
    specIdHints: hints
  });

  const matchedRows = buildMatchedGainRows(disposals, lots, allTxs);
  const incomeRows = buildIncomeRows(allTxs);
  const jurisdiction = JURISDICTIONS[settings.jurisdiction];

  const yearMatches = matchedRows.filter((r) => new Date(r.sellDate).getUTCFullYear() === fy);
  const yearIncome = incomeRows.filter((r) => new Date(r.date).getUTCFullYear() === fy);

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

  const lines = [
    `You are SoloLedger's AI Tax Advisor — a friendly, expert crypto tax assistant.`,
    `All data is 100% local on the user's device. Never ask for wallet addresses or private keys.`,
    ``,
    `## User's Tax Data Summary (${fy})`,
    `- Jurisdiction: ${jurisdiction.label} — ${jurisdiction.notes.slice(0, 120)}`,
    `- Reporting currency: ${cur}`,
    `- Cost basis method: ${settings.defaultCostBasisMethod}`,
    `- Total transactions in DB: ${allTxs.length}`,
    `- Transactions still missing a price: ${missingCount}`,
    `- Possible internal transfers (unverified): ${spamCount}`,
    ``,
    `## ${fy} Tax Year`,
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
    `- If data is missing (e.g. prices), explain what step to take in SoloLedger (Review → Fetch prices).`,
    `- Keep responses short unless asked for detail. Use bullet points for lists.`
  ];

  return lines.join('\n');
}
