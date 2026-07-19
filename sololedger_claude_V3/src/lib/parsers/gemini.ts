import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
export const geminiParser: ExchangeParser = {
  id: 'gemini', label: 'Gemini',
  detect(headers) {
    const h = new Set(headers.map(normalizeHeader));
    // Real Gemini exports label the time column "Time (UTC)" → 'timeutc'.
    const hasTime = h.has('time') || h.has('timeutc');
    return hasTime && ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'total'].every((x) => h.has(x));
  },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'Type').trim().toLowerCase()]; const pair = parseTradingPair(rowCol(row, 'Symbol')); const amount = Math.abs(safeNumber(rowCol(row, 'Quantity')));
      const date = rowCol(row, 'Date'); const time = rowCol(row, 'Time (UTC)', 'Time'); const ts = safeTimestampUtc(time && !date.includes(time) ? `${date} ${time}` : date || time);
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const total = Math.abs(safeNumber(rowCol(row, 'Total'))) || amount * Math.abs(safeNumber(rowCol(row, 'Price'))); const fee = Math.abs(safeNumber(rowCol(row, 'Fee'))); const transfer = type.startsWith('transfer_');
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('gem'), timestamp: ts, type, asset: pair.base, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteFiat ?? 'USD', fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? pair.quote : undefined, source: 'gemini', sourceRef: exchangeSourceRef('gemini', ts, type, pair.base, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default geminiParser;
