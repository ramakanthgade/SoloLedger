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
    let failedRows = 0;
    let malformedRows = 0;
    let firstSupportedType: string | null = null;
    if (rows.length === 0) return {
      transactions,
      skippedRows,
      warnings: ['Sheet has no data rows.'],
      evidence: {
        coveredAccountClasses: ['options'],
        requiredOutcomes: [{
          id: 'binance_options:options', accountClass: 'options', required: true,
          status: 'failed', reason: 'Sheet has no data rows.'
        }],
        recognizedCount: 0, parsedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 1,
        exclusionReasons: [], skippedReasons: [], failureReasons: [{ reason: 'Sheet has no data rows.', count: 1 }]
      }
    };

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'time');
    const typeCol = col(map, 'type');
    const amountCol = col(map, 'amount');
    const assetCol = col(map, 'asset');
    if (!timeCol || !typeCol || !amountCol || !assetCol) {
      return {
        transactions,
        skippedRows: rows.length,
        warnings: ['Binance Options columns not found (need Time, Type, Amount, Asset).'],
        evidence: {
          coveredAccountClasses: ['options'],
          requiredOutcomes: [{
            id: 'binance_options:options', accountClass: 'options', required: true,
            status: 'failed', reason: 'Required Binance Options columns are missing.'
          }],
          recognizedCount: 0, parsedCount: 0, excludedCount: 0, skippedCount: rows.length,
          failedCount: 1, exclusionReasons: [],
          skippedReasons: [{ reason: 'Required Binance Options columns are missing.', count: rows.length }],
          failureReasons: [{ reason: 'Required Binance Options sheet could not be parsed.', count: 1 }]
        }
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
      if (!shape) {
        failedRows += 1;
        skippedRows += 1;
        continue;
      }
      if (!Number.isFinite(timestamp) || !asset || signedAmount === 0) {
        malformedRows += 1;
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

    const optionsBalanceIncluded =
      transactions.length > 0 && skippedRows === 0 && firstSupportedType === 'opening_transfer';
    const balanceSnapshot = transactions.reduce<Record<string, number>>((balances, transaction) => {
      const signed = Number((transaction.raw as Record<string, unknown> | undefined)?._signedAmount);
      if (Number.isFinite(signed)) balances[transaction.asset] = (balances[transaction.asset] ?? 0) + signed;
      return balances;
    }, {});
    return {
      transactions,
      skippedRows,
      warnings: skippedRows > 0 ? [`${skippedRows} unsupported Binance Options row(s) skipped.`] : [],
      balanceSnapshot,
      // A journal can establish an absolute balance only when it begins with
      // funding, not an arbitrary period outflow from an unknown prior balance.
      optionsBalanceIncluded,
      optionsCoverageThrough: transactions.length > 0
        ? Math.max(...transactions.map((t) => t.timestamp))
        : undefined,
      evidence: {
        coveredAccountClasses: ['options'],
        requiredOutcomes: [{
          id: 'binance_options:options', accountClass: 'options', required: true,
          status: optionsBalanceIncluded ? 'complete' : failedRows > 0 ? 'failed' : 'partial',
          reason: optionsBalanceIncluded
            ? undefined
            : failedRows > 0 ? 'Unsupported Binance Options row types were present.'
              : 'The journal does not establish its opening balance.',
          recognizedCount: transactions.length,
          parsedCount: transactions.length,
          excludedCount: 0,
          skippedCount: malformedRows,
          failedCount: failedRows,
          skippedReasons: malformedRows > 0
            ? [{ reason: 'Missing time, asset, or non-zero amount.', count: malformedRows }] : [],
          failureReasons: failedRows > 0
            ? [{ reason: 'Unsupported Binance Options row type.', count: failedRows }] : []
        }],
        recognizedCount: transactions.length,
        parsedCount: transactions.length,
        excludedCount: 0,
        skippedCount: malformedRows,
        failedCount: failedRows,
        exclusionReasons: [],
        skippedReasons: malformedRows > 0
          ? [{ reason: 'Missing time, asset, or non-zero amount.', count: malformedRows }]
          : [],
        failureReasons: failedRows > 0
          ? [{ reason: 'Unsupported Binance Options row type.', count: failedRows }]
          : []
      }
    };
  }
};
