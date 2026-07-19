import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

const TYPE_MAP: Record<string, TxType> = {
  crypto_deposit: 'transfer_in', crypto_withdrawal: 'transfer_out', crypto_purchase: 'buy',
  crypto_sale: 'sell', staking_reward: 'income', crypto_earn_interest: 'income', crypto_exchange: 'trade'
};

export const cryptocomParser: ExchangeParser = {
  id: 'cryptocom', label: 'Crypto.com',
  detect(headers) {
    const h = new Set(headers.map(normalizeHeader));
    return ['transactionkind', 'nativeamount', 'nativecurrency', 'transactionhash'].every((x) => h.has(x));
  },
  parse(rows) {
    const transactions: Transaction[] = [];
    let skippedRows = 0;
    for (const row of rows) {
      const type = TYPE_MAP[rowCol(row, 'transaction_kind', 'type').trim().toLowerCase()];
      const asset = rowCol(row, 'currency').trim().toUpperCase();
      const amount = Math.abs(safeNumber(rowCol(row, 'amount')));
      // Real app exports use "Timestamp (UTC)" — parsed as UTC, not local time.
      const ts = safeTimestampUtc(rowCol(row, 'Timestamp (UTC)', 'timestamp', 'date'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows += 1; continue; }
      const nativeValue = Math.abs(safeNumber(rowCol(row, 'native_amount')));
      const nativeCurrency = rowCol(row, 'native_currency').trim().toUpperCase() || 'USD';
      const transfer = type === 'transfer_in' || type === 'transfer_out';
      // Real app exports use "Transaction Description".
      const description = rowCol(row, 'Transaction Description', 'description');
      // The counter asset of an exchange row is only recoverable from the
      // description text (e.g. "Exchange ETH for BTC") — scan it for trades only.
      let counterAsset: string | undefined;
      if (type === 'trade') {
        const mentioned = [...description.toUpperCase().matchAll(/\b[A-Z0-9]{2,10}\b/g)].map((m) => m[0]);
        counterAsset = mentioned.reverse().find((x) => x !== asset);
      }
      transactions.push({
        id: makeId('cdc'), timestamp: ts, type, asset, amount,
        counterAsset, fiatCurrency: nativeCurrency, fiatValue: nativeValue || undefined,
        source: 'cryptocom', sourceRef: rowCol(row, 'transaction_hash') || exchangeSourceRef('cryptocom', ts, type, asset, amount),
        notes: description || undefined, flags: transfer ? ['possible_internal_transfer'] : [],
        isInternalTransfer: false, raw: row
      });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};

export default cryptocomParser;
