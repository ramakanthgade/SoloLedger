const valuationBrand: unique symbol = Symbol('TransactionValuationRow');

export type TransactionValuationKind = 'fiat_valuation' | 'fee_expense';

export interface TransactionValuationRow {
  readonly kind: TransactionValuationKind;
  readonly transactionId: string;
  readonly currency: string;
  readonly amount?: number;
  readonly completeness: 'priced' | 'unpriced' | 'partial';
  readonly [valuationBrand]: true;
}

export interface TransactionValuationInput {
  kind: TransactionValuationKind;
  transactionId: string;
  currency: string;
  amount?: number;
  completeness?: TransactionValuationRow['completeness'];
}

/** Sole constructor for non-custody fiat illustrations. */
export function buildTransactionValuationRow(input: TransactionValuationInput): TransactionValuationRow {
  if (input.kind !== 'fiat_valuation' && input.kind !== 'fee_expense') throw new Error('invalid valuation kind');
  if (!input.transactionId.trim() || !input.currency.trim()) throw new Error('valuation identity is required');
  if (input.amount != null && (!Number.isFinite(input.amount) || input.amount < 0)) {
    throw new Error('valuation amount must be a finite non-negative number');
  }
  const completeness = input.completeness ?? (input.amount == null ? 'unpriced' : 'priced');
  if (completeness !== 'priced' && completeness !== 'unpriced' && completeness !== 'partial') {
    throw new Error('invalid valuation completeness');
  }
  if ((completeness === 'priced') !== (input.amount != null)) {
    throw new Error('priced valuation completeness must match amount availability');
  }
  return Object.freeze({ ...input, completeness, [valuationBrand]: true as const });
}

export function assertTransactionValuationRows(values: readonly unknown[]): asserts values is readonly TransactionValuationRow[] {
  let transactionId: string | undefined;
  let currency: string | undefined;
  for (const value of values) {
    if (typeof value !== 'object' || value == null || (value as Record<PropertyKey, unknown>)[valuationBrand] !== true) {
      throw new Error('unbranded transaction valuation row');
    }
    const row = value as TransactionValuationRow;
    if ((row.kind !== 'fiat_valuation' && row.kind !== 'fee_expense') ||
      !['priced', 'unpriced', 'partial'].includes(row.completeness) ||
      !row.transactionId.trim() || !row.currency.trim() ||
      (row.amount != null && (!Number.isFinite(row.amount) || row.amount < 0)) ||
      ((row.completeness === 'priced') !== (row.amount != null))) {
      throw new Error('invalid transaction valuation row');
    }
    transactionId ??= row.transactionId;
    currency ??= row.currency;
    if (row.transactionId !== transactionId || row.currency !== currency) {
      throw new Error('mixed transaction valuation rows');
    }
  }
}
