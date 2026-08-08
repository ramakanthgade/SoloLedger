import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { activeTransactionSurface, filterRows, visibleAssetOptions, type RowFilterOptions } from '@/lib/review/reviewTableView';
import { transactionsUnderCurrentSafetyPolicy } from '@/lib/safety/assetSafety';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { TEST_TAX_SETTINGS } from '@/test/taxSettings';

/**
 * Item 11 — spam hidden by default. The visibility rules themselves live in
 * the pure `filterRows` (src/lib/review/reviewTableView.ts, shared with the
 * tab unchanged); this suite pins the contract the Transactions page relies
 * on: the default view excludes spam absolutely, the Spam chip reveals it for
 * review/unflag, and the Flags dropdown's "Spam" option surfaces it too.
 */

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `tx${seq}`,
    timestamp: seq * 86_400_000,
    type: 'transfer_in',
    asset: 'SOL',
    amount: 1,
    fiatCurrency: 'USD',
    source: 'rpc:solana',
    flags: [],
    isInternalTransfer: false,
    ...over
  } as Transaction;
}

function opts(over?: Partial<RowFilterOptions>): RowFilterOptions {
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
    isNeedsReview: (t) => (t.flags ?? []).includes('needs_review'),
    isDerivative: () => false,
    ...over
  };
}

describe('filterRows — spam hidden by default (item 11)', () => {
  const clean = tx({ asset: 'ETH', type: 'buy', fiatValue: 100 });
  const spam = tx({ asset: 'SCAM', isSpam: true });

  it('excludes spam rows from the default view (flag filter "all", chip off)', () => {
    const rows = filterRows([clean, spam], opts());
    expect(rows.map((t) => t.id)).toEqual([clean.id]);
  });

  it('keeps excluding spam when other filters narrow the default view', () => {
    const rows = filterRows(
      [clean, spam],
      opts({ typeFilter: 'transfer_in' }) // the spam row matches the type
    );
    expect(rows).toEqual([]);
  });

  it('the Spam chip reveals exactly the spam rows for review/unflag', () => {
    const rows = filterRows([clean, spam], opts({ showSpam: true }));
    expect(rows.map((t) => t.id)).toEqual([spam.id]);
  });

  it('the Flags dropdown "Spam" option surfaces spam even with the chip off', () => {
    const rows = filterRows([clean, spam], opts({ flagFilter: 'spam' }));
    expect(rows.map((t) => t.id)).toEqual([spam.id]);
  });

  it('never leaks spam into the Needs-price view', () => {
    const priced = tx({ type: 'buy', asset: 'ABC', fiatValue: undefined });
    const rows = filterRows([priced, spam], opts({ showNeedsPrice: true }));
    expect(rows.map((t) => t.id)).toEqual([priced.id]);
  });

  it('derives asset options from only the active normal or spam audit surface', () => {
    expect(visibleAssetOptions(activeTransactionSurface([spam, clean], false))).toEqual(['ETH']);
    expect(visibleAssetOptions(activeTransactionSurface([spam, clean], true))).toEqual(['SCAM']);
  });

  it('moves older exact-contract rows to Spam and keeps missing-basis analysis on the same snapshot', () => {
    const contract = '0x1111111111111111111111111111111111111111';
    const older = tx({ id: 'older', type: 'sell', asset: 'OLD', chain: 'ethereum', contractAddress: contract, fiatValue: 100 });
    const later = tx({ id: 'later', type: 'buy', asset: 'NEW', chain: 'ethereum', contractAddress: contract, fiatValue: 50 });
    const decisions = [{
      subjectKey: `asset:ethereum:${contract}`, state: 'high_confidence_spam' as const,
      updatedAt: 10, origin: 'automatic' as const
    }];
    const policyRows = transactionsUnderCurrentSafetyPolicy([older, later], decisions);
    expect(activeTransactionSurface(policyRows, false)).toEqual([]);
    expect(activeTransactionSurface(policyRows, true).map((row) => row.id)).toEqual(['older', 'later']);
    const result = calculateCostBasis(policyRows, {
      method: 'FIFO', settings: TEST_TAX_SETTINGS, safetyDecisions: decisions
    });
    expect(result.shortfalls).toEqual([]);
    expect(result.flags).toEqual([]);
  });
});
