import type { Transaction, TxType } from '@/types/transaction';
import { makeId, safeNumber, safeTimestamp } from './types';

/** User-defined mapping from their CSV's headers to our fields, used when
 * auto-detection fails and the person manually maps columns in the UI. */
export interface ColumnMapping {
  timestamp: string;
  type: string;         // column holding a type string, mapped via typeValueMap
  asset: string;
  amount: string;
  fiatValue?: string;
  fiatCurrency?: string;
  feeAmount?: string;
  notes?: string;
  typeValueMap: Record<string, TxType>; // raw cell value -> TxType
}

export function parseWithMapping(rows: Record<string, string>[], mapping: ColumnMapping) {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  for (const row of rows) {
    const rawType = (row[mapping.type] || '').trim().toLowerCase();
    const mapped = mapping.typeValueMap[rawType];
    const timestamp = safeTimestamp(row[mapping.timestamp]);
    const asset = (row[mapping.asset] || '').trim();
    const amount = Math.abs(safeNumber(row[mapping.amount]));

    if (!mapped || !asset || !Number.isFinite(timestamp) || amount === 0) {
      skippedRows += 1;
      continue;
    }

    transactions.push({
      id: makeId('gen'),
      timestamp,
      type: mapped,
      asset,
      amount,
      fiatCurrency: (mapping.fiatCurrency && row[mapping.fiatCurrency]) || 'USD',
      fiatValue: mapping.fiatValue ? safeNumber(row[mapping.fiatValue]) : undefined,
      feeAmount: mapping.feeAmount ? safeNumber(row[mapping.feeAmount]) : undefined,
      source: 'manual_mapping',
      notes: mapping.notes ? row[mapping.notes] : undefined,
      flags: mapping.fiatValue ? [] : ['missing_cost_basis'],
      isInternalTransfer: false,
      raw: row
    });
  }

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} row(s) skipped — check your column mapping if this seems high.`);
  }

  return { transactions, skippedRows, warnings };
}
