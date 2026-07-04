import type { Transaction, TxType } from '@/types/transaction';
import { makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';

/**
 * Binance "Transaction History" export (Account > Transaction History > Export).
 * Columns vary by export type; this targets the common generic export:
 * User_ID, UTC_Time, Account, Operation, Coin, Change, Remark
 */

const OP_MAP: Record<string, TxType> = {
  buy: 'buy',
  sell: 'sell',
  transaction_related: 'trade',
  'transaction buy': 'buy',
  'transaction sold': 'sell',
  transfer: 'transfer_in', // sign of Change determines in/out, corrected below
  deposit: 'transfer_in',
  withdraw: 'transfer_out',
  'staking rewards': 'income',
  'staking purchase': 'defi_deposit',
  'staking redemption': 'defi_withdraw',
  'pos savings interest': 'income',
  'savings interest': 'income',
  'commission history': 'income',
  distribution: 'income',
  'cash voucher distribution': 'income',
  airdrop: 'income',
  fee: 'fee'
};

export const binanceParser: ExchangeParser = {
  id: 'binance',
  label: 'Binance',

  detect(headers) {
    const h = headers.map((x) => x.toLowerCase());
    return h.includes('operation') && h.includes('coin') && h.includes('change');
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    for (const row of rows) {
      const rawOp = (row['Operation'] || '').trim().toLowerCase();
      let mapped = OP_MAP[rawOp];
      const timestamp = safeTimestamp(row['UTC_Time']);
      const asset = (row['Coin'] || '').trim();
      const change = safeNumber(row['Change']);
      const amount = Math.abs(change);

      if (!mapped || !asset || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows += 1;
        continue;
      }

      if (mapped === 'transfer_in' && change < 0) mapped = 'transfer_out';

      transactions.push({
        id: makeId('bn'),
        timestamp,
        type: mapped,
        asset,
        amount,
        // Binance's generic export doesn't include fiat value per row — this
        // is flagged for the user to fill in via price lookup or manual entry.
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'binance',
        sourceRef: undefined,
        notes: row['Remark'],
        flags: ['missing_cost_basis'],
        isInternalTransfer: false,
        raw: row
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — unrecognized operation type or missing data.`);
    }
    warnings.push(
      'Binance exports usually omit fiat value per transaction — imported rows are flagged for you to fill in during Review.'
    );

    return { transactions, skippedRows, warnings };
  }
};
