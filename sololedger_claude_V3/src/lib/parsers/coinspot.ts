import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out', send: 'transfer_out', receive: 'transfer_in' };
export const coinspotParser: ExchangeParser = {
  id: 'coinspot', label: 'CoinSpot',
  detect(headers) { const h = new Set(headers.map(normalizeHeader)); return ['date', 'action', 'coin', 'amount', 'rate', 'aud', 'audfee'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'Action').trim().toLowerCase()]; const asset = rowCol(row, 'Coin').trim().toUpperCase();
      const amount = Math.abs(safeNumber(rowCol(row, 'Amount'))); const ts = safeTimestampUtc(rowCol(row, 'Date'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const aud = Math.abs(safeNumber(rowCol(row, 'AUD'))); const fee = Math.abs(safeNumber(rowCol(row, 'AUD Fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('csp'), timestamp: ts, type, asset, amount, counterAsset: type === 'buy' || type === 'sell' ? 'AUD' : undefined,
        counterAmount: aud || undefined, fiatCurrency: 'AUD', fiatValue: aud || undefined,
        feeAmount: fee || undefined, feeAsset: fee ? 'AUD' : undefined, source: 'coinspot', sourceRef: exchangeSourceRef('coinspot', ts, type, asset, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default coinspotParser;
