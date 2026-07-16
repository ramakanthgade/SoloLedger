/**
 * India TDS (Section 194S — 1% on VDA transfers) reconciliation.
 *
 * Exchanges withhold 1% TDS on VDA transfers and deposit it against the user's
 * PAN. At filing time the user reconciles the TDS credit shown in their Form
 * 26AS / AIS against what their transaction history says was withheld. This
 * module produces that FY-scoped total plus by-month and by-exchange
 * breakdowns from the structured `tdsInr` fields captured by the parsers.
 *
 * Only in-FY rows are counted (using B7's IST-correct `isInFy`), and only rows
 * that actually carry an INR-denominated TDS figure contribute.
 */
import type { Transaction, Jurisdiction } from '@/types/transaction';
import { isInFy, IST_OFFSET_MS } from '@/lib/utils';
import { add, toNumber } from '@/lib/costBasis/decimal';

export interface TdsRow {
  /** Transaction id, for drill-down back to the source row. */
  txId: string;
  /** Epoch ms (UTC) of the withholding event. */
  date: number;
  /** Exchange / source the TDS was withheld by, e.g. "wazirx_trades". */
  exchange: string;
  /** Asset transferred on the taxable event. */
  asset: string;
  /** TDS value in INR for this row. */
  tdsInr: number;
}

export interface TdsReconciliation {
  /** Total INR TDS withheld across all in-FY rows. */
  totalTdsInr: number;
  /** INR TDS grouped by month key `YYYY-MM` (IST calendar). */
  byMonth: Record<string, number>;
  /** INR TDS grouped by exchange / source. */
  byExchange: Record<string, number>;
  /** Per-transaction rows that contributed, sorted oldest → newest. */
  rows: TdsRow[];
}

/** IST-local `YYYY-MM` month key for a UTC epoch (India runs at a fixed +05:30). */
function istMonthKey(timestampMs: number): string {
  const ist = new Date(timestampMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Aggregate the INR TDS withheld across `txs` for a single financial year.
 *
 * @param txs           all transactions (any FY, any source)
 * @param fy            financial year number (e.g. 2024 → FY 2024-25 for IN)
 * @param jurisdiction  drives FY boundaries; TDS is an India construct so this
 *                      is normally 'IN'.
 */
export function aggregateTds(
  txs: Transaction[],
  fy: number,
  jurisdiction: Jurisdiction
): TdsReconciliation {
  const rows: TdsRow[] = [];
  const byMonth: Record<string, number> = {};
  const byExchange: Record<string, number> = {};
  let total = 0;

  for (const tx of txs) {
    const tdsInr = tx.tdsInr;
    if (tdsInr == null || !(tdsInr > 0)) continue;
    if (!isInFy(tx.timestamp, fy, jurisdiction)) continue;

    rows.push({
      txId: tx.id,
      date: tx.timestamp,
      exchange: tx.source,
      asset: tx.asset,
      tdsInr
    });

    total = toNumber(add(total, tdsInr));

    const monthKey = istMonthKey(tx.timestamp);
    byMonth[monthKey] = toNumber(add(byMonth[monthKey] ?? 0, tdsInr));
    byExchange[tx.source] = toNumber(add(byExchange[tx.source] ?? 0, tdsInr));
  }

  rows.sort((a, b) => a.date - b.date);

  return { totalTdsInr: total, byMonth, byExchange, rows };
}
