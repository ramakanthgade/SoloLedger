import type { DashboardPeriodCategory } from './dashboardAsOfModel';
import type { Disposal, Jurisdiction, Lot, Transaction } from '@/types/transaction';
import { buildMatchedGainRows } from '@/lib/costBasis/matchedGains';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';

export const DASHBOARD_EXPENSE_CATEGORIES = new Set<Transaction['category']>([
  'cost', 'payment', 'donation', 'lost', 'tax', 'loan_fee', 'margin_fee', 'funding_fee'
]);

export const DASHBOARD_EXECUTION_FEE_CATEGORIES = new Set<Transaction['category']>([
  'futures_fee', 'options_fee', 'other_fee'
]);

export const DASHBOARD_INCOME_CATEGORIES = new Set<Transaction['category']>([
  'reward', 'mining', 'airdrop', 'fork', 'lending_interest', 'salary', 'other_income',
  'cashback', 'defi_reward', 'mining_reward', 'staking_reward', 'genesis_reward', 'mainnet_reward'
]);

/** Canonical, disjoint activity classification shared by Dashboard and Transactions. */
export function transactionMatchesDashboardCategory(
  transaction: Transaction,
  category: Exclude<DashboardPeriodCategory, 'realizedCapitalGains'>
): boolean {
  const expense = DASHBOARD_EXPENSE_CATEGORIES.has(transaction.category);
  switch (category) {
    case 'in': return transaction.type === 'transfer_in' && !transaction.isInternalTransfer;
    case 'out': return transaction.type === 'transfer_out' && !transaction.isInternalTransfer;
    case 'income': return transaction.type === 'income' || DASHBOARD_INCOME_CATEGORIES.has(transaction.category);
    case 'expenses': return expense;
    case 'tradingFees':
      return !expense && (transaction.type === 'fee' ||
        DASHBOARD_EXECUTION_FEE_CATEGORIES.has(transaction.category) ||
        (transaction.feeAmount != null && transaction.feeAmount > 0));
  }
}

/** Revalues a linked summary from current rows without trusting the source-screen total. */
export function currentDashboardCategoryValue(
  transaction: Transaction,
  category: Exclude<DashboardPeriodCategory, 'realizedCapitalGains'>,
  reportingCurrency: string
): number | undefined {
  if (category === 'tradingFees' && transaction.type !== 'fee' &&
      transaction.feeAmount != null && transaction.feeAmount > 0) {
    if ((transaction.feeAsset ?? transaction.asset).toUpperCase() === reportingCurrency.toUpperCase()) {
      return transaction.feeAmount;
    }
  }
  if (transaction.fiatCurrency.toUpperCase() !== reportingCurrency.toUpperCase() ||
      transaction.fiatValue == null || !Number.isFinite(transaction.fiatValue)) return undefined;
  return Math.abs(transaction.fiatValue);
}

/** Canonical matched-lot realized gains shared by Dashboard and Transactions. */
export function dashboardRealizedGainSummary(input: {
  transactions: readonly Transaction[];
  disposals: readonly Disposal[];
  lots: readonly Lot[];
  nominalStart: number;
  effectiveEnd: number;
  jurisdiction: Jurisdiction;
  transactionIds?: readonly string[];
}): { value: number; transactionIds: string[] } {
  const transactionById = new Map(input.transactions.map((transaction) => [transaction.id, transaction]));
  const selectedIds = input.transactionIds ? new Set(input.transactionIds) : undefined;
  const rows = buildMatchedGainRows(
    [...input.disposals], [...input.lots], [...input.transactions]
  ).filter((row) => {
    const transaction = transactionById.get(row.sellTxId);
    return row.sellDate >= input.nominalStart && row.sellDate <= input.effectiveEnd &&
      (!selectedIds || selectedIds.has(row.sellTxId)) &&
      transaction != null && !isDerivativeTransaction(transaction) &&
      (input.jurisdiction !== 'IN' || row.gain > 0);
  });
  return {
    value: rows.reduce((sum, row) => sum + row.gain, 0),
    transactionIds: [...new Set(rows.map((row) => row.sellTxId))]
  };
}

export function currentDashboardFilterSummary(input: {
  transactions: readonly Transaction[];
  category: DashboardPeriodCategory;
  nominalStart: number;
  effectiveEnd: number;
  reportingCurrency: string;
  transactionIds?: readonly string[];
  disposals?: readonly Disposal[];
  lots?: readonly Lot[];
  jurisdiction?: Jurisdiction;
  valueForTransaction?: (transaction: Transaction, category: Exclude<DashboardPeriodCategory, 'realizedCapitalGains'>) => number | undefined;
}): number {
  const category = input.category;
  const ids = input.transactionIds ? new Set(input.transactionIds) : undefined;
  const currentRows = input.transactions.filter((transaction) =>
    transaction.timestamp >= input.nominalStart && transaction.timestamp <= input.effectiveEnd &&
    (!ids || ids.has(transaction.id)));
  if (category === 'realizedCapitalGains') {
    return dashboardRealizedGainSummary({
      transactions: currentRows,
      disposals: input.disposals ?? [],
      lots: input.lots ?? [],
      nominalStart: input.nominalStart,
      effectiveEnd: input.effectiveEnd,
      jurisdiction: input.jurisdiction ?? 'IN',
      transactionIds: input.transactionIds
    }).value;
  }
  return currentRows.filter((transaction) => transactionMatchesDashboardCategory(transaction, category))
    .reduce((sum, transaction) => sum +
      (input.valueForTransaction?.(transaction, category) ??
        currentDashboardCategoryValue(transaction, category, input.reportingCurrency) ?? 0), 0);
}
