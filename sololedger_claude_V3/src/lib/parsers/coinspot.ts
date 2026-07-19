import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }
export const coinspotParser: ExchangeParser = {
  id: 'coinspot', label: 'CoinSpot',
  detect(headers) { const h = new Set(headers.map(key)); return ['date', 'action', 'coin', 'amount', 'rate', 'aud', 'audfee'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[col(row, 'Action').trim().toLowerCase()]; const asset = col(row, 'Coin').trim().toUpperCase();
      const amount = Math.abs(safeNumber(col(row, 'Amount'))); const ts = safeTimestamp(col(row, 'Date'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const aud = Math.abs(safeNumber(col(row, 'AUD'))); const fee = Math.abs(safeNumber(col(row, 'AUD Fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('csp'), timestamp: ts, type, asset, amount, counterAsset: type === 'buy' || type === 'sell' ? 'AUD' : undefined,
        counterAmount: aud || undefined, fiatCurrency: 'AUD', fiatValue: aud || undefined,
        feeAmount: fee || undefined, feeAsset: fee ? 'AUD' : undefined, source: 'coinspot', sourceRef: exchangeSourceRef('coinspot', ts, type, asset, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default coinspotParser;
