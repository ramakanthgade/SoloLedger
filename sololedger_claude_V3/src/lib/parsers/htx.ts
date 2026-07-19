import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdraw: 'transfer_out', 'staking-reward': 'income' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }
function timestamp(value: string): number { const n = Number(value); return value.trim() && Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : safeTimestamp(value); }
export const htxParser: ExchangeParser = {
  id: 'htx', label: 'HTX',
  detect(headers) { const h = new Set(headers.map(key)); return ['id', 'symbol', 'type', 'filled', 'feeasset', 'orderid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[col(row, 'type').trim().toLowerCase()]; const pair = parseTradingPair(col(row, 'symbol'));
      const amount = Math.abs(safeNumber(col(row, 'filled', 'amount'))); const ts = timestamp(col(row, 'time', 'timestamp', 'id'));
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(col(row, 'price'))); const total = amount * price; const fee = Math.abs(safeNumber(col(row, 'fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('htx'), timestamp: ts, type, asset: pair.base, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD', fiatValue: quoteToFiatCurrency(pair.quote) ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? col(row, 'fee-asset').toUpperCase() || pair.quote : undefined,
        source: 'htx', sourceRef: col(row, 'order-id', 'id') || exchangeSourceRef('htx', ts, type, pair.base, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default htxParser;
