import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }

export const bybitParser: ExchangeParser = {
  id: 'bybit', label: 'Bybit',
  detect(headers) { const h = new Set(headers.map(key)); return ['symbol', 'side', 'volume', 'total', 'feecurrency', 'orderid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[col(row, 'Side').trim().toLowerCase()];
      const pair = parseTradingPair(col(row, 'Symbol'));
      const amount = Math.abs(safeNumber(col(row, 'Volume'))); const ts = safeTimestamp(col(row, 'Time'));
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const total = Math.abs(safeNumber(col(row, 'Total'))); const fee = Math.abs(safeNumber(col(row, 'Fee')));
      transactions.push({ id: makeId('bb'), timestamp: ts, type, asset: pair.base, amount,
        counterAsset: pair.quote, counterAmount: total || undefined, fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD',
        fiatValue: quoteToFiatCurrency(pair.quote) ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? col(row, 'Fee Currency').toUpperCase() || pair.quote : undefined,
        source: 'bybit', sourceRef: col(row, 'Order ID') || exchangeSourceRef('bybit', ts, type, pair.base, amount), flags: [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default bybitParser;
