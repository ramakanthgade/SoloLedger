import type { Transaction, TxType } from '@/types/transaction';
import { makeId, normalizeFiatMagnitude, safeNumber, safeTimestamp } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

/** User-defined mapping from their CSV's headers to our fields, used when
 * auto-detection fails and the person manually maps columns in the UI. */
export interface ColumnMapping {
  timestamp: string;
  type: string;
  asset: string;
  amount: string;
  /** Total fiat paid/received (e.g. Binance "Total" column) — preferred over price×qty */
  totalValue?: string;
  /** Price per unit — used with amount when totalValue column is absent */
  pricePerUnit?: string;
  fiatValue?: string;
  fiatCurrency?: string;
  feeAmount?: string;
  feeAsset?: string;
  notes?: string;
  typeValueMap: Record<string, TxType>;
  /** When asset column holds pairs like SOLUSDT, extract base asset automatically */
  assetIsTradingPair?: boolean;
}

export const DEFAULT_TYPE_VALUE_MAP: Record<string, TxType> = {
  buy: 'buy',
  sell: 'sell',
  b: 'buy',
  s: 'sell',
  'transaction buy': 'buy',
  'transaction sold': 'sell',
  deposit: 'transfer_in',
  withdraw: 'transfer_out',
  withdrawal: 'transfer_out',
  transfer: 'transfer_in',
  income: 'income',
  reward: 'income',
  staking: 'income',
  airdrop: 'income',
  fee: 'fee'
};

export function guessTypeValueMap(distinctValues: string[]): Record<string, TxType> {
  const map: Record<string, TxType> = {};
  for (const val of distinctValues) {
    const key = val.trim().toLowerCase();
    if (DEFAULT_TYPE_VALUE_MAP[key]) map[key] = DEFAULT_TYPE_VALUE_MAP[key];
  }
  return map;
}

function resolveFiat(
  row: Record<string, string>,
  mapping: ColumnMapping,
  quote?: string
): { fiatValue?: number; fiatCurrency: string } {
  const explicit = mapping.fiatValue ? Math.abs(safeNumber(row[mapping.fiatValue])) : 0;
  if (explicit > 0) {
    const cur =
      (mapping.fiatCurrency && row[mapping.fiatCurrency]?.trim().toUpperCase()) ||
      quoteToFiatCurrency(quote) ||
      'USD';
    return { fiatValue: explicit, fiatCurrency: cur };
  }

  const total = mapping.totalValue ? Math.abs(safeNumber(row[mapping.totalValue])) : 0;
  if (total > 0) {
    return { fiatValue: total, fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
  }

  const qty = Math.abs(safeNumber(row[mapping.amount]));
  const price = mapping.pricePerUnit ? safeNumber(row[mapping.pricePerUnit]) : 0;
  if (price > 0 && qty > 0) {
    return { fiatValue: price * qty, fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
  }

  return { fiatCurrency: quoteToFiatCurrency(quote) ?? 'USD' };
}

export function parseWithMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  reportingCurrency = 'USD'
) {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawType = (row[mapping.type] || '').trim().toLowerCase();
    const mapped = mapping.typeValueMap[rawType];
    const timestamp = safeTimestamp(row[mapping.timestamp]);
    const assetRaw = (row[mapping.asset] || '').trim();
    const { base, quote } = mapping.assetIsTradingPair !== false
      ? parseTradingPair(assetRaw)
      : { base: assetRaw.toUpperCase(), quote: undefined };
    const amount = Math.abs(safeNumber(row[mapping.amount]));

    if (!mapped || !base || !Number.isFinite(timestamp) || amount === 0) {
      skippedRows += 1;
      continue;
    }

    const { fiatValue, fiatCurrency } = resolveFiat(row, mapping, quote);
    const feeAmount = mapping.feeAmount ? Math.abs(safeNumber(row[mapping.feeAmount])) : undefined;
    const feeAsset = mapping.feeAsset ? (row[mapping.feeAsset] || '').trim().toUpperCase() : undefined;

    transactions.push({
      id: makeId('gen'),
      timestamp,
      type: mapped,
      asset: base,
      amount,
      counterAsset: quote,
      fiatCurrency: fiatCurrency || reportingCurrency,
      fiatValue: normalizeFiatMagnitude(fiatValue),
      feeAmount: feeAmount && feeAmount > 0 ? feeAmount : undefined,
      feeAsset: feeAsset || undefined,
      source: 'manual_mapping',
      sourceRef: `row:${i}`,
      notes: mapping.notes ? row[mapping.notes] : assetRaw !== base ? `Pair ${assetRaw}` : undefined,
      flags: fiatValue != null && Math.abs(fiatValue) > 0 ? [] : ['missing_cost_basis'],
      isInternalTransfer: false,
      raw: row
    });
  }

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} row(s) skipped — check type mapping and required columns.`);
  }
  if (transactions.some((t) => t.fiatValue == null)) {
    warnings.push(
      'Some rows have no fiat value. Map a Total or Fiat column, or use Review → Fetch missing prices after import (uses asset + date via CoinGecko).'
    );
  }

  return { transactions, skippedRows, warnings };
}
