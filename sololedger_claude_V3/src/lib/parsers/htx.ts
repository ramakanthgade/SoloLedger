import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeEpochTimestamp, safeNumber, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdraw: 'transfer_out', 'staking-reward': 'income' };
export const htxParser: ExchangeParser = {
  id: 'htx', label: 'HTX',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return ['id', 'symbol', 'type', 'filled', 'feeasset', 'orderid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'type').trim().toLowerCase()]; const pair = parseTradingPair(rowCol(row, 'symbol'));
      // Timestamp must come from a real time column — never the order id.
      const amount = Math.abs(safeNumber(rowCol(row, 'filled', 'amount'))); const ts = safeEpochTimestamp(rowCol(row, 'time', 'timestamp'));
      if (!type || !pair.base || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(rowCol(row, 'price'))); const total = amount * price; const fee = Math.abs(safeNumber(rowCol(row, 'fee'))); const transfer = type.startsWith('transfer_');
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('htx'), timestamp: ts, type, asset: pair.base, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteFiat ?? 'USD', fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'fee-asset').toUpperCase() || pair.quote : undefined,
        source: 'htx', sourceRef: rowCol(row, 'order-id', 'id') || exchangeSourceRef('htx', ts, type, pair.base, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default htxParser;
