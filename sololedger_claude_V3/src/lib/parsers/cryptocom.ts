import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';

const TYPE_MAP: Record<string, TxType> = {
  crypto_deposit: 'transfer_in', crypto_withdrawal: 'transfer_out', crypto_purchase: 'buy',
  crypto_sale: 'sell', staking_reward: 'income', crypto_earn_interest: 'income', crypto_exchange: 'trade'
};
function key(v: string): string { return v.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function col(row: Record<string, string>, ...names: string[]): string {
  const n = Object.fromEntries(Object.entries(row).map(([k, v]) => [key(k), v]));
  for (const name of names) if (n[key(name)] != null && n[key(name)] !== '') return n[key(name)];
  return '';
}

export const cryptocomParser: ExchangeParser = {
  id: 'cryptocom', label: 'Crypto.com',
  detect(headers) {
    const h = new Set(headers.map(key));
    return ['transactionkind', 'nativeamount', 'nativecurrency', 'transactionhash'].every((x) => h.has(x));
  },
  parse(rows) {
    const transactions: Transaction[] = [];
    let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[col(row, 'transaction_kind', 'type').trim().toLowerCase()];
      const asset = col(row, 'currency').trim().toUpperCase();
      const amount = Math.abs(safeNumber(col(row, 'amount')));
      const ts = safeTimestamp(col(row, 'timestamp', 'date'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows += 1; continue; }
      const nativeValue = Math.abs(safeNumber(col(row, 'native_amount')));
      const nativeCurrency = col(row, 'native_currency').trim().toUpperCase() || 'USD';
      const transfer = type === 'transfer_in' || type === 'transfer_out';
      const description = col(row, 'description');
      const mentioned = [...description.toUpperCase().matchAll(/\b[A-Z0-9]{2,10}\b/g)].map((m) => m[0]);
      const counterAsset = type === 'trade' ? [...mentioned].reverse().find((x) => x !== asset) : undefined;
      transactions.push({
        id: makeId('cdc'), timestamp: ts, type, asset, amount,
        counterAsset, fiatCurrency: nativeCurrency, fiatValue: nativeValue || undefined,
        source: 'cryptocom', sourceRef: col(row, 'transaction_hash') || exchangeSourceRef('cryptocom', ts, type, asset, amount),
        notes: description || undefined, flags: transfer ? ['possible_internal_transfer'] : [],
        isInternalTransfer: false, raw: row
      });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};

export default cryptocomParser;
