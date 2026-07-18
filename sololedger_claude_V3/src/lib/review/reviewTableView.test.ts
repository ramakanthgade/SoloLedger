import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { filterRows, paginate, type RowFilterOptions } from '@/lib/review/reviewTableView';

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

/** Default "no-op" filter options — nothing is filtered out. */
function opts(over: Partial<RowFilterOptions> = {}): RowFilterOptions {
  return {
    showSpam: false,
    showNeedsPrice: false,
    showNeedsReview: false,
    assetFilter: 'all',
    typeFilter: 'all',
    flagFilter: 'all',
    walletFilter: 'all',
    fyBounds: null,
    instrumentFilter: 'all',
    query: '',
    isNeedsReview: () => false,
    isDerivative: () => false,
    ...over
  };
}

describe('filterRows', () => {
  it("flagFilter='spam' returns spam rows even when showSpam is false", () => {
    const spam = tx({ fiatValue: 100, isSpam: true });
    const clean = tx({ fiatValue: 100, isSpam: false });
    const rows = filterRows([spam, clean], opts({ flagFilter: 'spam', showSpam: false }));
    expect(rows).toEqual([spam]);
  });

  it("flagFilter='internal' returns internal-transfer rows", () => {
    const internal = tx({ fiatValue: 100, isInternalTransfer: true });
    const normal = tx({ fiatValue: 100, isInternalTransfer: false });
    const rows = filterRows([internal, normal], opts({ flagFilter: 'internal' }));
    expect(rows).toEqual([internal]);
  });

  it("flagFilter='internal' does NOT force-hide internal (non-spam) rows via spam gates", () => {
    // showSpam is false (default): the spam gate would normally drop nothing here,
    // but confirm an internal, non-spam row survives when filtering by internal.
    const internal = tx({ fiatValue: undefined, isInternalTransfer: true, isSpam: false });
    const rows = filterRows([internal], opts({ flagFilter: 'internal', showSpam: false }));
    expect(rows).toEqual([internal]);
  });

  it("flagFilter='all' leaves the default spam gate behaviour unchanged (spam hidden)", () => {
    const spam = tx({ fiatValue: 100, isSpam: true });
    const clean = tx({ fiatValue: 100, isSpam: false });
    const rows = filterRows([spam, clean], opts({ flagFilter: 'all', showSpam: false }));
    expect(rows).toEqual([clean]);
  });

  it("flagFilter='all' with showSpam shows ONLY spam rows (unchanged behaviour)", () => {
    const spam = tx({ fiatValue: 100, isSpam: true });
    const clean = tx({ fiatValue: 100, isSpam: false });
    const rows = filterRows([spam, clean], opts({ flagFilter: 'all', showSpam: true }));
    expect(rows).toEqual([spam]);
  });

  it('applies asset/type/query filters as before', () => {
    const a = tx({ asset: 'ETH', type: 'buy', fiatValue: 100 });
    const b = tx({ asset: 'SOL', type: 'sell', fiatValue: 100 });
    expect(filterRows([a, b], opts({ assetFilter: 'ETH' }))).toEqual([a]);
    expect(filterRows([a, b], opts({ typeFilter: 'sell' }))).toEqual([b]);
    expect(filterRows([a, b], opts({ query: 'eth' }))).toEqual([a]);
  });
});

describe('paginate', () => {
  it('yields the correct slice and page count', () => {
    const rows = Array.from({ length: 5 }, (_, i) => i);
    const p1 = paginate(rows, 1, 2);
    expect(p1.pageRows).toEqual([0, 1]);
    expect(p1.totalPages).toBe(3);
    expect(p1.safePage).toBe(1);

    const p2 = paginate(rows, 2, 2);
    expect(p2.pageRows).toEqual([2, 3]);
    expect(p2.safePage).toBe(2);

    const p3 = paginate(rows, 3, 2);
    expect(p3.pageRows).toEqual([4]);
    expect(p3.safePage).toBe(3);
  });

  it('clamps an out-of-range page to the last page', () => {
    const rows = Array.from({ length: 5 }, (_, i) => i);
    const p = paginate(rows, 99, 2);
    expect(p.safePage).toBe(3);
    expect(p.pageRows).toEqual([4]);
  });

  it('reports at least one page for an empty list', () => {
    const p = paginate([], 1, 200);
    expect(p.totalPages).toBe(1);
    expect(p.safePage).toBe(1);
    expect(p.pageRows).toEqual([]);
  });
});
