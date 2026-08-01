/**
 * Derivatives (perps/futures) classification and tax-treatment helpers.
 * Treatment is resolved at report time from Settings — stored txs are not rewritten.
 */
import type { Jurisdiction, TaxSettings, Transaction } from '@/types/transaction';

export type InstrumentClass = 'spot' | 'derivative';
export type DerivativesTreatment = 'business_income' | 'capital_gains';

/** Jurisdiction defaults for the Settings toggle. */
export function defaultDerivativesTreatment(jurisdiction: Jurisdiction): DerivativesTreatment {
  // India / Canada: frequent perps trading is often treated as business income.
  // US / UAE: default to capital gains presentation (user can switch).
  if (jurisdiction === 'IN' || jurisdiction === 'CA') return 'business_income';
  return 'capital_gains';
}

export function resolveDerivativesTreatment(settings: TaxSettings): DerivativesTreatment {
  return settings.derivativesTreatment ?? defaultDerivativesTreatment(settings.jurisdiction);
}

export function isDerivativeTransaction(t: Pick<Transaction, 'instrumentClass' | 'source' | 'category'>): boolean {
  if (t.instrumentClass === 'derivative') return true;
  if (t.instrumentClass === 'spot') return false;
  if (t.source?.startsWith('hyperliquid')) return true;
  const cat = (t.category ?? '').toLowerCase();
  return cat === 'perp' || cat === 'perp_loss' || cat === 'perp_collateral' || cat === 'perp_funding' ||
    cat === 'options_collateral' || cat === 'options_premium' || cat === 'options_fee';
}

/** Realized perp profit rows (business income / CG profit). */
export function isDerivativeProfit(t: Transaction): boolean {
  return (
    isDerivativeTransaction(t) &&
    !t.isSpam &&
    !t.isInternalTransfer &&
    t.type === 'income' &&
    t.category !== 'perp_loss' &&
    // An Options premium credit is not realized profit by itself: lifecycle
    // matching (expiry/exercise/close) is required. Defer both premium sides
    // symmetrically rather than taxing credits while ignoring paid premiums.
    t.category !== 'options_premium'
  );
}

/** Trading fees + realized perp losses (business expenses). */
export function isDerivativeExpense(t: Transaction): boolean {
  if (!isDerivativeTransaction(t) || t.isSpam || t.isInternalTransfer) return false;
  if (t.category === 'perp_loss') return true;
  if (t.category === 'options_fee') return t.type === 'fee';
  return t.type === 'fee' && (t.category === 'perp' || t.category === 'perp_loss' || !t.category);
}

export function derivativeExpenseKind(t: Transaction): 'trading_fee' | 'realized_loss' {
  return t.category === 'perp_loss' ? 'realized_loss' : 'trading_fee';
}
