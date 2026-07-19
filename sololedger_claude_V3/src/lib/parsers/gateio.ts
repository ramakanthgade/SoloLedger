import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
export const gateioParser: ExchangeParser = {
  id: 'gateio', label: 'Gate.io',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return ['id', 'pair', 'type', 'amount', 'feecurrency', 'total'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'Type').trim().toLowerCase()]; const pair = parseTradingPair(rowCol(row, 'Pair')); const asset = pair.base;
      const amount = Math.abs(safeNumber(rowCol(row, 'Amount'))); const ts = safeTimestampUtc(rowCol(row, 'Time'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const total = Math.abs(safeNumber(rowCol(row, 'Total'))); const fee = Math.abs(safeNumber(rowCol(row, 'Fee'))); const transfer = type.startsWith('transfer_');
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('gate'), timestamp: ts, type, asset, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteFiat ?? 'USD', fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'Fee Currency').toUpperCase() || pair.quote : undefined,
        source: 'gateio', sourceRef: rowCol(row, 'ID') || exchangeSourceRef('gateio', ts, type, asset, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default gateioParser;
