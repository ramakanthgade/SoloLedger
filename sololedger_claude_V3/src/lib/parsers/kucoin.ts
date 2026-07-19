import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

const TYPE_MAP: Record<string, TxType> = {
  buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdraw: 'transfer_out', staking: 'income'
};

function key(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string {
  const normalized = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v]));
  for (const name of names) if (normalized[key(name)] != null && normalized[key(name)] !== '') return normalized[key(name)];
  return '';
}
function timestamp(value: string): number {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : safeTimestamp(value);
}

export const kucoinParser: ExchangeParser = {
  id: 'kucoin', label: 'KuCoin',
  detect(headers) {
    const h = new Set(headers.map(key));
    return ['tradeid', 'symbol', 'side', 'funds', 'feecurrency'].every((x) => h.has(x));
  },
  parse(rows) {
    const transactions: Transaction[] = [];
    let skippedRows = 0;
    for (const row of rows) {
      const rawType = col(row, 'side', 'type').trim().toLowerCase();
      const type = TYPE_MAP[rawType];
      const pair = parseTradingPair(col(row, 'symbol'));
      const asset = (pair.base || col(row, 'feeCurrency')).toUpperCase();
      const amount = Math.abs(safeNumber(col(row, 'size', 'amount')));
      const ts = timestamp(col(row, 'time', 'timestamp'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows += 1; continue; }
      const total = Math.abs(safeNumber(col(row, 'funds', 'total')));
      const fee = Math.abs(safeNumber(col(row, 'fee')));
      const transfer = type === 'transfer_in' || type === 'transfer_out';
      transactions.push({
        id: makeId('kc'), timestamp: ts, type, asset, amount,
        counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteToFiatCurrency(pair.quote) ?? 'USD',
        fiatValue: quoteToFiatCurrency(pair.quote) ? (total || undefined) : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? col(row, 'feeCurrency').toUpperCase() || pair.quote : undefined,
        source: 'kucoin', sourceRef: col(row, 'tradeId', 'orderId') || exchangeSourceRef('kucoin', ts, type, asset, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row
      });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};

export default kucoinParser;
