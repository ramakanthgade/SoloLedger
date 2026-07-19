import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

const TYPE_MAP: Record<string, TxType> = { buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdrawal: 'transfer_out', staking: 'income' };
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string { const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v])); for (const x of names) if (n[key(x)] != null && n[key(x)] !== '') return n[key(x)]; return ''; }

export const bitfinexParser: ExchangeParser = {
  id: 'bitfinex', label: 'Bitfinex',
  detect(headers) { const h = new Set(headers.map(key)); return headers.some((x) => x.trim() === '#') && ['date', 'pair', 'amount', 'price', 'fee', 'feecurrency'].every((x) => h.has(x)); },
  parse(rows) {
    const transactions: Transaction[] = []; let skippedRows = 0;
    for (const row of rows) {
      const signedAmount = safeNumber(col(row, 'Amount')); const rawPair = col(row, 'Pair', 'Symbol'); const pair = parseTradingPair(rawPair);
      const explicit = col(row, 'Type', 'Action').trim().toLowerCase();
      const type = TYPE_MAP[explicit] ?? (signedAmount > 0 ? 'buy' : signedAmount < 0 ? 'sell' : undefined);
      const asset = pair.base; const amount = Math.abs(signedAmount); const ts = safeTimestamp(col(row, 'Date', 'Time'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows++; continue; }
      const price = Math.abs(safeNumber(col(row, 'Price'))); const total = amount * price; const fee = Math.abs(safeNumber(col(row, 'Fee'))); const transfer = type.startsWith('transfer_');
      transactions.push({ id: makeId('bfx'), timestamp: ts, type, asset, amount, counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD', fiatValue: quoteToFiatCurrency(pair.quote) ? total || undefined : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? col(row, 'Fee Currency').toUpperCase() || pair.quote : undefined,
        source: 'bitfinex', sourceRef: col(row, '#', 'ID') || exchangeSourceRef('bitfinex', ts, type, asset, amount), flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};
export default bitfinexParser;
