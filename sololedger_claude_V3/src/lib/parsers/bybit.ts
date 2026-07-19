import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell' };

export const bybitParser: ExchangeParser = {
  id: 'bybit', label: 'Bybit',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return ['symbol', 'side', 'volume', 'total', 'feecurrency', 'orderid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'Side').trim().toLowerCase()];
      const pair = parseTradingPair(rowCol(row, 'Symbol'));
      const amount = Math.abs(safeNumber(rowCol(row, 'Volume'))); const ts = safeTimestampUtc(rowCol(row, 'Time'));
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const total = Math.abs(safeNumber(rowCol(row, 'Total'))); const fee = Math.abs(safeNumber(rowCol(row, 'Fee')));
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('bb'), timestamp: ts, type, asset: pair.base, amount,
        counterAsset: pair.quote, counterAmount: total || undefined, fiatCurrency: quoteFiat ?? 'USD',
        fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'Fee Currency').toUpperCase() || pair.quote : undefined,
        source: 'bybit', sourceRef: rowCol(row, 'Order ID') || exchangeSourceRef('bybit', ts, type, pair.base, amount), flags: [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default bybitParser;
