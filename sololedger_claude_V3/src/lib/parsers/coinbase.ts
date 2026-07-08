import type { Transaction, TxType } from '@/types/transaction';
import { makeId, normalizeFiatMagnitude, safeNumber, safeTimestamp, type ExchangeParser } from './types';

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
  'advanced trade buy': 'buy',
  'advanced trade sell': 'sell',
  send: 'transfer_out',
  receive: 'transfer_in',
  convert: 'trade',
  'staking income': 'income',
  'inflation reward': 'income',
  'coinbase earn': 'income',
  rewards: 'income',
  airdrop: 'income'
};

function col(row: Record<string, string>, ...keys: string[]): string {
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v])
  );
  for (const k of keys) {
    const hit = lower[k.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (hit != null && hit !== '') return hit;
  }
  return '';
}

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
      const rawType = col(row, 'Transaction Type').trim().toLowerCase();
      const mapped = TYPE_MAP[rawType];
      const timestamp = safeTimestamp(col(row, 'Timestamp', 'Date', 'Time'));
      const asset = col(row, 'Asset', 'Coin').trim();
      const amount = Math.abs(safeNumber(col(row, 'Quantity Transacted', 'Quantity', 'Amount')));

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
        fiatCurrency: (col(row, 'Spot Price Currency', 'Price Currency', 'Currency') || 'USD').trim(),
        fiatValue: normalizeFiatMagnitude(
          safeNumber(
            col(row, 'Subtotal', 'Total (inclusive of fees)', 'Total (inclusive of fees and/or spread)', 'Total')
          )
        ),
        feeAsset: undefined,
        feeAmount: normalizeFiatMagnitude(safeNumber(col(row, 'Fees', 'Fees and/or Spread'))),
        source: 'coinbase',
        sourceRef: col(row, 'ID') || undefined,
        notes: col(row, 'Notes') || undefined,
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
