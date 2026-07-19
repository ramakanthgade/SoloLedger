import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }
export const okxParser: ExchangeParser = {
  id: 'okx', label: 'OKX',
  detect(headers) { const h = new Set(headers.map(key)); return ['type', 'pair', 'fillsz', 'fillpx', 'feeccy', 'ordid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const rawType = (col(row, 'side') || col(row, 'type')).trim().toLowerCase(); const type = TYPE_MAP[rawType];
      const pair = parseTradingPair(col(row, 'pair')); const asset = pair.base; const amount = Math.abs(safeNumber(col(row, 'fillSz', 'amount'))); const ts = safeTimestamp(col(row, 'time'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(col(row, 'fillPx'))); const total = amount * price; const fee = Math.abs(safeNumber(col(row, 'fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('okx'), timestamp: ts, type, asset, amount, counterAsset: pair.quote,
        counterAmount: total || undefined, fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD', fiatValue: quoteToFiatCurrency(pair.quote) ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? col(row, 'feeCcy').toUpperCase() || pair.quote : undefined,
        source: 'okx', sourceRef: col(row, 'ordId') || exchangeSourceRef('okx', ts, type, asset, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default okxParser;
