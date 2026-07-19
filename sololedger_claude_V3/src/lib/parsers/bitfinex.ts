import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out', staking: 'income' };

export const bitfinexParser: ExchangeParser = {
  id: 'bitfinex', label: 'Bitfinex',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return headers.some((x) => x.trim() === '#') && ['date', 'pair', 'amount', 'price', 'fee', 'feecurrency'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const signedAmount = safeNumber(rowCol(row, 'Amount')); const rawPair = rowCol(row, 'Pair', 'Symbol'); const pair = parseTradingPair(rawPair);
      const explicit = rowCol(row, 'Type', 'Action').trim().toLowerCase();
      const type = TYPE_MAP[explicit] ?? (signedAmount > 0 ? 'buy' : signedAmount < 0 ? 'sell' : undefined);
      const asset = pair.base; const amount = Math.abs(signedAmount); const ts = safeTimestampUtc(rowCol(row, 'Date', 'Time'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(rowCol(row, 'Price'))); const total = amount * price; const fee = Math.abs(safeNumber(rowCol(row, 'Fee'))); const transfer = type.startsWith('transfer_');
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('bfx'), timestamp: ts, type, asset, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteFiat ?? 'USD', fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'Fee Currency').toUpperCase() || pair.quote : undefined,
        source: 'bitfinex', sourceRef: rowCol(row, '#', 'ID') || exchangeSourceRef('bitfinex', ts, type, asset, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default bitfinexParser;
