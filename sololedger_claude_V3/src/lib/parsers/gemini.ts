import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }
export const geminiParser: ExchangeParser = {
  id: 'gemini', label: 'Gemini',
  detect(headers) { const h = new Set(headers.map(key)); return ['date', 'time', 'type', 'symbol', 'quantity', 'price', 'fee', 'total'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[col(row, 'Type').trim().toLowerCase()]; const pair = parseTradingPair(col(row, 'Symbol')); const amount = Math.abs(safeNumber(col(row, 'Quantity')));
      const date = col(row, 'Date'); const time = col(row, 'Time'); const ts = safeTimestamp(time && !date.includes(time) ? `${date} ${time}` : date || time);
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const total = Math.abs(safeNumber(col(row, 'Total'))) || amount * Math.abs(safeNumber(col(row, 'Price'))); const fee = Math.abs(safeNumber(col(row, 'Fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('gem'), timestamp: ts, type, asset: pair.base, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD', fiatValue: quoteToFiatCurrency(pair.quote) ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? pair.quote : undefined, source: 'gemini', sourceRef: exchangeSourceRef('gemini', ts, type, pair.base, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default geminiParser;
