/** Binance Options signed cash-journal export (Time, Type, Amount, Asset). */
import type { FlagReason, Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeNumber, safeTimestampUtc, type ExchangeParser } from './types';
import { col, headerMap } from './headerMap';

function normalizedType(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hasOptionsRows(rows: Record<string, string>[], typeCol: string): boolean {
  const types = new Set(rows.map((row) => normalizedType(row[typeCol])).filter(Boolean));
  return types.has('premium') && (types.has('commission_fee') || types.has('transfer'));
}

function txShape(rawType: string, incoming: boolean): {
  type: TxType;
  category: string;
  internal: boolean;
  flags: FlagReason[];
  notes: string;
} | null {
  if (rawType === 'transfer') {
    return {
      type: incoming ? 'transfer_in' : 'transfer_out',
      category: 'options_collateral',
      // These rows are the signed cash journal for the Options subaccount.
      // Keeping them non-internal lets both deposits and withdrawals affect
      // holdings; the derivative category still keeps them out of spot tax.
      internal: false,
      flags: [],
      notes: 'Binance Options collateral transfer'
    };
  }
  if (rawType === 'commission_fee') {
    return {
      type: incoming ? 'income' : 'fee',
      category: 'options_fee',
      internal: false,
      flags: incoming ? ['needs_review'] : [],
      notes: incoming ? 'Binance Options commission rebate' : 'Binance Options commission fee'
    };
  }
  if (rawType === 'premium') {
    return {
      type: incoming ? 'income' : 'fee',
      category: 'options_premium',
      internal: false,
      flags: ['needs_review'],
      notes: incoming ? 'Binance Options premium received' : 'Binance Options premium paid'
    };
  }
  return null;
}

export const binanceOptionsParser: ExchangeParser = {
  id: 'binance_options',
  label: 'Binance Options',

  detect(headers, _ctx, rows = []) {
    const map = headerMap(headers);
    const timeCol = col(map, 'time');
    const typeCol = col(map, 'type');
    return Boolean(
      timeCol && typeCol && col(map, 'amount') && col(map, 'asset') &&
      hasOptionsRows(rows, typeCol)
    );
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const refOccurrences = new Map<string, number>();
    let skippedRows = 0;
    let firstSupportedType: string | null = null;
    if (rows.length === 0) return { transactions, skippedRows, warnings: ['Sheet has no data rows.'] };

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'time');
    const typeCol = col(map, 'type');
    const amountCol = col(map, 'amount');
    const assetCol = col(map, 'asset');
    if (!timeCol || !typeCol || !amountCol || !assetCol) {
      return {
        transactions,
        skippedRows: rows.length,
        warnings: ['Binance Options columns not found (need Time, Type, Amount, Asset).']
      };
    }

    for (const row of rows) {
      const rawType = normalizedType(row[typeCol]);
      // Binance exports this wall-clock column in UTC. Anchoring it prevents
      // browser timezone from changing tax dates and source refs.
      const timestamp = safeTimestampUtc(row[timeCol]);
      const signedAmount = safeNumber(row[amountCol]);
      const asset = (row[assetCol] ?? '').trim().toUpperCase();
      const shape = txShape(rawType, signedAmount > 0);
      if (!shape || !Number.isFinite(timestamp) || !asset || signedAmount === 0) {
        skippedRows += 1;
        continue;
      }
      const amount = Math.abs(signedAmount);
      firstSupportedType ??= rawType === 'transfer' && signedAmount > 0 ? 'opening_transfer' : rawType;
      const stable = asset === 'USDT' || asset === 'USDC';
      const direction = signedAmount > 0 ? 'credit' : 'debit';
      const baseRef = exchangeSourceRef(
        'binance_options', timestamp, `${rawType}_${direction}`, asset, amount
      );
      const occurrence = (refOccurrences.get(baseRef) ?? 0) + 1;
      refOccurrences.set(baseRef, occurrence);
      transactions.push({
        id: makeId('binopt'),
        timestamp,
        type: shape.type,
        asset,
        amount,
        fiatCurrency: 'USD',
        fiatValue: stable ? amount : undefined,
        source: 'binance_options',
        sourceRef: occurrence === 1 ? baseRef : `${baseRef}~${occurrence}`,
        notes: shape.notes,
        flags: stable ? shape.flags : [...shape.flags, 'missing_cost_basis'],
        isInternalTransfer: shape.internal,
        category: shape.category,
        instrumentClass: 'derivative',
        raw: { ...row, _signedAmount: signedAmount, _optionsKind: rawType }
      });
    }

    return {
      transactions,
      skippedRows,
      warnings: skippedRows > 0 ? [`${skippedRows} unsupported Binance Options row(s) skipped.`] : [],
      // A journal can establish an absolute balance only when it begins with
      // funding, not an arbitrary period outflow from an unknown prior balance.
      optionsBalanceIncluded:
        transactions.length > 0 && skippedRows === 0 && firstSupportedType === 'opening_transfer',
      optionsCoverageThrough: transactions.length > 0
        ? Math.max(...transactions.map((t) => t.timestamp))
        : undefined
    };
  }
};
