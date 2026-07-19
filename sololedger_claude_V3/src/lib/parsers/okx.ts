import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
export const okxParser: ExchangeParser = {
  id: 'okx', label: 'OKX',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return ['type', 'pair', 'fillsz', 'fillpx', 'feeccy', 'ordid'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const rawType = (rowCol(row, 'side') || rowCol(row, 'type')).trim().toLowerCase(); const type = TYPE_MAP[rawType];
      const pair = parseTradingPair(rowCol(row, 'pair')); const asset = pair.base; const amount = Math.abs(safeNumber(rowCol(row, 'fillSz', 'amount'))); const ts = safeTimestampUtc(rowCol(row, 'time'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(rowCol(row, 'fillPx'))); const total = amount * price; const fee = Math.abs(safeNumber(rowCol(row, 'fee'))); const transfer = type.startsWith('transfer_');
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({ id: makeId('okx'), timestamp: ts, type, asset, amount, counterAsset: pair.quote,
        counterAmount: total || undefined, fiatCurrency: quoteFiat ?? 'USD', fiatValue: quoteFiat ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'feeCcy').toUpperCase() || pair.quote : undefined,
        source: 'okx', sourceRef: rowCol(row, 'ordId') || exchangeSourceRef('okx', ts, type, asset, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default okxParser;
