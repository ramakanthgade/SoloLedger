import type { Transaction, TxType } from '@/types/transaction';
import { makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';

/**
 * Coinbase "Transaction History" CSV export.
 * Expected headers (Coinbase changes these occasionally, hence the flexible
 * lookup below rather than fixed indices):
 * Timestamp, Transaction Type, Asset, Quantity Transacted, Spot Price Currency,
 * Spot Price at Transaction, Subtotal, Total (inclusive of fees), Fees, Notes
 */

const TYPE_MAP: Record<string, TxType> = {
  buy: 'buy',
  sell: 'sell',
  send: 'transfer_out',
  receive: 'transfer_in',
  convert: 'trade',
  'staking income': 'income',
  'inflation reward': 'income',
  'coinbase earn': 'income',
  rewards: 'income',
  airdrop: 'income'
};

export const coinbaseParser: ExchangeParser = {
  id: 'coinbase',
  label: 'Coinbase',

  detect(headers) {
    const h = headers.map((x) => x.toLowerCase());
    return h.includes('transaction type') && h.includes('asset') && h.includes('quantity transacted');
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    for (const row of rows) {
      const rawType = (row['Transaction Type'] || '').trim().toLowerCase();
      const mapped = TYPE_MAP[rawType];
      const timestamp = safeTimestamp(row['Timestamp']);
      const asset = (row['Asset'] || '').trim();
      const amount = Math.abs(safeNumber(row['Quantity Transacted']));

      if (!mapped || !asset || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows += 1;
        continue;
      }

      transactions.push({
        id: makeId('cb'),
        timestamp,
        type: mapped,
        asset,
        amount,
        fiatCurrency: (row['Spot Price Currency'] || 'USD').trim(),
        fiatValue: safeNumber(row['Subtotal'] || row['Total (inclusive of fees)']),
        feeAsset: undefined,
        feeAmount: safeNumber(row['Fees']),
        source: 'coinbase',
        sourceRef: row['ID'] || undefined,
        notes: row['Notes'],
        flags: mapped === 'transfer_in' || mapped === 'transfer_out' ? ['possible_internal_transfer'] : [],
        isInternalTransfer: false,
        raw: row
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — unrecognized transaction type or missing data.`);
    }

    return { transactions, skippedRows, warnings };
  }
};
