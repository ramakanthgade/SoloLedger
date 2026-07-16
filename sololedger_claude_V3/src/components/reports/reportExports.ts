/**
 * India report view helpers (Task T4).
 *
 * Pure, framework-free builders shared by the Schedule VDA and TDS
 * reconciliation views. Keeping these out of the React components makes the
 * row/CSV/PDF shaping unit-testable against seeded fixtures.
 *
 * Nothing here computes tax advice — the builders only shape figures the tax
 * layer (B2/B3/B4) already produced. All monetary CSV columns keep RAW decimals
 * so no precision is lost; the components format for display via `formatCurrency`.
 */
import type { Transaction, Jurisdiction } from '@/types/transaction';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import type { ScheduleVdaReport } from '@/lib/reports/scheduleVDA';
import type { TdsReconciliation } from '@/lib/tax/tds';
import { istDateKey } from '@/lib/reports/scheduleVDA';
import { isInFy } from '@/lib/utils';
import { add, mul, toNumber } from '@/lib/costBasis/decimal';

/**
 * Supported Indian exchanges whose CSV/statement exports SoloLedger imports.
 * Used to render friendly counterparty names in the TDS reconciliation view
 * and import guidance. (Reference set: WazirX, CoinDCX, CoinSwitch, ZebPay,
 * Mudrex.)
 */
export const INDIA_CEX_LABELS: Record<string, string> = {
  wazirx: 'WazirX',
  coindcx: 'CoinDCX',
  coinswitch: 'CoinSwitch',
  zebpay: 'ZebPay',
  mudrex: 'Mudrex'
};

const OTHER_SOURCE_LABELS: Record<string, string> = {
  binance: 'Binance',
  coinbase: 'Coinbase',
  kraken: 'Kraken',
  manual: 'Manual entry'
};

/** Human-readable label for a raw `Transaction.source` string. */
export function prettyExchangeLabel(source: string): string {
  const base = source
    .toLowerCase()
    .replace(/_(trades|ledger|deposits|withdrawals|tds|transactions)$/i, '')
    .replace(/^rpc:/, '');
  if (INDIA_CEX_LABELS[base]) return INDIA_CEX_LABELS[base];
  if (OTHER_SOURCE_LABELS[base]) return OTHER_SOURCE_LABELS[base];
  // Title-case the remaining token(s) as a reasonable fallback.
  return base
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Allocate each disposal's Section 194S TDS across its per-lot Schedule VDA
 * rows, proportional to the consideration (proceeds) share of each row.
 *
 * TDS is withheld per SALE transaction, but the Schedule VDA row model is
 * per-matched-lot, so a single sale that consumes multiple buy lots must have
 * its TDS split across those rows to avoid double-counting. The split is
 * proportional to each row's proceeds; the last row in a group absorbs any
 * rounding remainder so the per-transaction total is preserved exactly.
 *
 * Returns a map keyed by `MatchedGainRow.id` (== `ScheduleVdaRow.id`).
 */
export function allocateTdsToRows(
  matchedRows: MatchedGainRow[],
  transactions: Transaction[],
  fy: number,
  jurisdiction: Jurisdiction
): Record<string, number> {
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const inFy = matchedRows.filter((r) => isInFy(r.sellDate, fy, jurisdiction));

  // Group the in-FY rows by their sell (disposal) transaction.
  const byTx = new Map<string, MatchedGainRow[]>();
  for (const r of inFy) {
    const list = byTx.get(r.sellTxId);
    if (list) list.push(r);
    else byTx.set(r.sellTxId, [r]);
  }

  const out: Record<string, number> = {};
  for (const [txId, rows] of byTx) {
    const tds = txById.get(txId)?.tdsInr;
    if (tds == null || !(tds > 0)) {
      for (const r of rows) out[r.id] = 0;
      continue;
    }
    const totalProceeds = rows.reduce((s, r) => s + Math.max(0, r.proceeds), 0);
    if (!(totalProceeds > 0)) {
      // Even split when proceeds carry no signal.
      const share = toNumber(mul(tds, 1 / rows.length));
      let running = 0;
      rows.forEach((r, i) => {
        const v = i === rows.length - 1 ? toNumber(add(tds, -running)) : share;
        out[r.id] = v;
        running = toNumber(add(running, v));
      });
      continue;
    }
    let running = 0;
    rows.forEach((r, i) => {
      const v =
        i === rows.length - 1
          ? toNumber(add(tds, -running))
          : toNumber(mul(tds, Math.max(0, r.proceeds) / totalProceeds));
      out[r.id] = v;
      running = toNumber(add(running, v));
    });
  }
  return out;
}

/** A Schedule VDA display/export row (B4 row + IST dates + allocated TDS). */
export interface ScheduleVdaTableRow {
  id: string;
  asset: string;
  acquisitionDate: number;
  transferDate: number;
  acquisitionDateKey: string;
  transferDateKey: string;
  costOfAcquisition: number;
  considerationReceived: number;
  incomeGain: number;
  tdsInr: number;
}

/** Totals across the Schedule VDA table (footer row). */
export interface ScheduleVdaTotals {
  costOfAcquisition: number;
  considerationReceived: number;
  incomeGain: number;
  tdsInr: number;
}

/**
 * Shape the B4 `ScheduleVdaReport` into display rows, joining the per-row TDS
 * allocation. Preserves the report's row ordering (newest transfer first).
 */
export function buildScheduleVdaTableRows(
  report: ScheduleVdaReport,
  tdsByRowId: Record<string, number> = {}
): ScheduleVdaTableRow[] {
  return report.rows.map((r) => ({
    id: r.id,
    asset: r.asset,
    acquisitionDate: r.acquisitionDate,
    transferDate: r.transferDate,
    acquisitionDateKey: istDateKey(r.acquisitionDate),
    transferDateKey: istDateKey(r.transferDate),
    costOfAcquisition: r.costOfAcquisition,
    considerationReceived: r.considerationReceived,
    incomeGain: r.incomeGain,
    tdsInr: tdsByRowId[r.id] ?? 0
  }));
}

/** Sum the Schedule VDA table columns for the footer. */
export function sumScheduleVdaTotals(rows: ScheduleVdaTableRow[]): ScheduleVdaTotals {
  return rows.reduce<ScheduleVdaTotals>(
    (acc, r) => ({
      costOfAcquisition: toNumber(add(acc.costOfAcquisition, r.costOfAcquisition)),
      considerationReceived: toNumber(add(acc.considerationReceived, r.considerationReceived)),
      incomeGain: toNumber(add(acc.incomeGain, r.incomeGain)),
      tdsInr: toNumber(add(acc.tdsInr, r.tdsInr))
    }),
    { costOfAcquisition: 0, considerationReceived: 0, incomeGain: 0, tdsInr: 0 }
  );
}

/** A per-exchange TDS reconciliation row (import-side; user-supplied 26AS optional). */
export interface TdsExchangeRow {
  /** Raw `Transaction.source`. */
  exchange: string;
  /** Friendly display label (e.g. "CoinDCX"). */
  label: string;
  /** Number of TDS deductions imported from this source. */
  deductions: number;
  /** Total INR TDS withheld per the user's imports. */
  tdsInr: number;
}

/**
 * Aggregate the B3 TDS reconciliation into per-exchange rows (sorted highest
 * TDS first). Import-side only — no 26AS/AIS figures (MVP does not ingest them).
 */
export function buildTdsExchangeRows(recon: TdsReconciliation): TdsExchangeRow[] {
  const counts = new Map<string, number>();
  for (const r of recon.rows) counts.set(r.exchange, (counts.get(r.exchange) ?? 0) + 1);

  return Object.entries(recon.byExchange)
    .map(([exchange, tdsInr]) => ({
      exchange,
      label: prettyExchangeLabel(exchange),
      deductions: counts.get(exchange) ?? 0,
      tdsInr
    }))
    .sort((a, b) => b.tdsInr - a.tdsInr);
}

/** Quote a CSV field only when it contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the TDS reconciliation to CSV. Import-side figures are RAW decimals.
 * Any USER-ENTERED Form 26AS amounts (`entered26as`, keyed by raw source) are
 * appended as clearly-labelled, user-supplied columns — never app-verified.
 */
export function serializeTdsReconciliationCsv(
  recon: TdsReconciliation,
  fyLabel: string,
  entered26as: Record<string, number> = {}
): string {
  const rows = buildTdsExchangeRows(recon);
  const hasUserEntries = Object.values(entered26as).some((v) => Number.isFinite(v) && v > 0);

  const header = hasUserEntries
    ? ['exchange', 'deductions', 'tds_in_your_imports_inr', 'form_26as_amount_inr_user_entered', 'delta_inr_user_supplied']
    : ['exchange', 'deductions', 'tds_in_your_imports_inr'];

  const lines: string[] = [`# TDS reconciliation (Section 194S) — ${fyLabel}`, header.join(',')];

  for (const r of rows) {
    if (hasUserEntries) {
      const entered = entered26as[r.exchange];
      const has = Number.isFinite(entered) && entered != null;
      const delta = has ? toNumber(add(entered as number, -r.tdsInr)) : '';
      lines.push(
        [csvField(r.label), String(r.deductions), String(r.tdsInr), has ? String(entered) : '', delta === '' ? '' : String(delta)].join(',')
      );
    } else {
      lines.push([csvField(r.label), String(r.deductions), String(r.tdsInr)].join(','));
    }
  }

  lines.push('');
  lines.push(`# Total TDS in your imports (Section 194S): ${recon.totalTdsInr}`);
  lines.push('# This total is what your imported transaction history shows was withheld.');
  lines.push('# Compare it with your Form 26AS / AIS to confirm your TDS credit before filing.');
  if (hasUserEntries) {
    lines.push('# The "form_26as_amount" and "delta" columns are amounts YOU entered — not verified by this app.');
  }
  lines.push('# This is a reconciliation aid, not tax advice. Confirm final figures with your CA.');
  return lines.join('\n');
}
