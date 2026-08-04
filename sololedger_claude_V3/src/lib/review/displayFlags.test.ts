import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { displayFlags, matchesFlagFilter } from '@/lib/review/displayFlags';

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: over.id ?? `tx${seq}`,
    timestamp: over.timestamp ?? seq * 86_400_000,
    type: over.type ?? 'transfer_in',
    asset: over.asset ?? 'SOL',
    amount: over.amount ?? 1,
    fiatCurrency: 'INR',
    source: 'manual',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    ...over
  } as Transaction;
}

describe('displayFlags', () => {
  it('adds derived missing_market_value, not missing_cost_basis, when market value is absent', () => {
    const flags = displayFlags(tx({ type: 'buy', fiatValue: undefined, isInternalTransfer: false }));
    expect(flags).toContain('missing_market_value');
    expect(flags).not.toContain('missing_cost_basis');
  });

  it('does NOT add missing_market_value for internal transfers', () => {
    const flags = displayFlags(tx({ fiatValue: undefined, isInternalTransfer: true }));
    expect(flags).not.toContain('missing_market_value');
  });

  it('does NOT require market value for transfer types even before they are confirmed internal', () => {
    expect(displayFlags(tx({ type: 'transfer_in', fiatValue: undefined }))).not.toContain('missing_market_value');
    expect(displayFlags(tx({ type: 'transfer_out', fiatValue: undefined }))).not.toContain('missing_market_value');
  });

  it('does NOT add missing_cost_basis when a fiat value is present', () => {
    const flags = displayFlags(tx({ fiatValue: 100 }));
    expect(flags).not.toContain('missing_cost_basis');
  });

  it('preserves stored flags', () => {
    const flags = displayFlags(tx({ fiatValue: 100, flags: ['needs_review', 'duplicate_suspected'] }));
    expect(flags).toEqual(expect.arrayContaining(['needs_review', 'duplicate_suspected']));
  });

  it('does not surface a legacy stored missing_cost_basis without an engine shortfall', () => {
    const priced = tx({ fiatValue: 100, flags: ['missing_cost_basis'] });
    expect(displayFlags(priced)).not.toContain('missing_cost_basis');
    expect(displayFlags(priced, ['missing_cost_basis'])).toContain('missing_cost_basis');
  });
});

describe('matchesFlagFilter', () => {
  it('"all" keeps every row', () => {
    expect(matchesFlagFilter(tx({ fiatValue: 100 }), 'all')).toBe(true);
    expect(matchesFlagFilter(tx({ flags: ['needs_review'] }), 'all')).toBe(true);
  });

  it('narrows to rows carrying the chosen stored flag', () => {
    const flagged = tx({ fiatValue: 100, flags: ['needs_review'] });
    const other = tx({ fiatValue: 100, flags: ['duplicate_suspected'] });
    expect(matchesFlagFilter(flagged, 'needs_review')).toBe(true);
    expect(matchesFlagFilter(other, 'needs_review')).toBe(false);
  });

  it('matches missing market value separately from a derived engine basis shortfall', () => {
    const unpriced = tx({ type: 'buy', fiatValue: undefined, isInternalTransfer: false, flags: [] });
    const priced = tx({ fiatValue: 100, flags: [] });
    expect(matchesFlagFilter(unpriced, 'missing_market_value')).toBe(true);
    expect(matchesFlagFilter(unpriced, 'missing_cost_basis')).toBe(false);
    expect(matchesFlagFilter(priced, 'missing_cost_basis', ['missing_cost_basis'])).toBe(true);
    expect(matchesFlagFilter(priced, 'missing_cost_basis')).toBe(false);
  });

  it('narrows to spam rows for the "spam" filter', () => {
    const spam = tx({ fiatValue: 100, isSpam: true });
    const notSpam = tx({ fiatValue: 100, isSpam: false });
    expect(matchesFlagFilter(spam, 'spam')).toBe(true);
    expect(matchesFlagFilter(notSpam, 'spam')).toBe(false);
  });

  it('narrows to internal-transfer rows for the "internal" filter', () => {
    const internal = tx({ fiatValue: 100, isInternalTransfer: true });
    const notInternal = tx({ fiatValue: 100, isInternalTransfer: false });
    expect(matchesFlagFilter(internal, 'internal')).toBe(true);
    expect(matchesFlagFilter(notInternal, 'internal')).toBe(false);
  });
});
