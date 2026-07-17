import { describe, it, expect } from 'vitest';
import type { FlagReason, Transaction } from '@/types/transaction';
import {
  bulkFlagsPatch,
  bulkTypeImpactLines,
  bulkTypePatch,
  initialBulkFlagsSelection,
  summarizeBulkTypeChange
} from '@/lib/review/bulkEdit';

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
    source: 'rpc:helius',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    ...over
  } as Transaction;
}

describe('bulkTypePatch', () => {
  it('sets the type and strips auto-derived flags (mirrors TypeSelector.reclassify)', () => {
    const t = tx({ flags: ['possible_internal_transfer', 'missing_cost_basis', 'needs_review'] });
    const patch = bulkTypePatch(t, 'income');
    expect(patch.type).toBe('income');
    // possible_internal_transfer + missing_cost_basis removed; needs_review kept
    expect(patch.flags).toEqual(['needs_review']);
  });

  it('leaves rows with no flags untouched apart from the type', () => {
    const t = tx({ flags: [] });
    expect(bulkTypePatch(t, 'sell')).toEqual({ type: 'sell', flags: [] });
  });
});

describe('summarizeBulkTypeChange', () => {
  it('counts disposals created when switching transfers to sell', () => {
    const sel = [
      tx({ type: 'transfer_in' }),
      tx({ type: 'transfer_in' }),
      tx({ type: 'buy', fiatValue: 100 })
    ];
    const impact = summarizeBulkTypeChange(sel, 'sell');
    expect(impact.total).toBe(3);
    expect(impact.disposalsCreated).toBe(3);
    expect(impact.disposalsRemoved).toBe(0);
    expect(impact.missingFiat).toBe(2);
    expect(impact.fromCounts[0]).toEqual(['transfer_in', 2]);
  });

  it('counts disposals removed and rows already of the target type', () => {
    const sel = [
      tx({ type: 'sell', fiatValue: 5 }),
      tx({ type: 'trade', fiatValue: 5 }),
      tx({ type: 'transfer_in', fiatValue: 5 })
    ];
    const impact = summarizeBulkTypeChange(sel, 'transfer_in');
    expect(impact.alreadyOfType).toBe(1);
    expect(impact.disposalsRemoved).toBe(2);
    expect(impact.disposalsCreated).toBe(0);
    expect(impact.transfersCreated).toBe(2); // sell + trade rows change; the existing transfer_in doesn't
  });

  it('counts income rows for income target and trades as disposals', () => {
    const sel = [tx({ type: 'transfer_in' }), tx({ type: 'income' })];
    const impact = summarizeBulkTypeChange(sel, 'income');
    expect(impact.incomeCreated).toBe(1); // the existing income row is excluded
    expect(impact.alreadyOfType).toBe(1);
  });
});

describe('bulkTypeImpactLines', () => {
  it('produces a line per notable consequence and stays silent on zero impacts', () => {
    const impact = summarizeBulkTypeChange(
      [tx({ type: 'transfer_in' }), tx({ type: 'sell', fiatValue: 10 })],
      'sell'
    );
    const lines = bulkTypeImpactLines(impact);
    expect(lines.some((l) => l.includes('become taxable disposal'))).toBe(true);
    expect(lines.some((l) => l.includes('no fiat value'))).toBe(true);
    expect(lines.some((l) => l.includes('already "sell"'))).toBe(true);
    expect(lines.some((l) => l.includes('stop being disposals'))).toBe(false);
  });

  it('mentions income tax treatment when setting income', () => {
    const impact = summarizeBulkTypeChange([tx({ type: 'transfer_in' })], 'income');
    const lines = bulkTypeImpactLines(impact);
    expect(lines.some((l) => l.includes('taxable at fair-market value'))).toBe(true);
  });
});

describe('bulkFlagsPatch', () => {
  it('adds checked flags and removes unchecked ones (absolute apply)', () => {
    const t = tx({ flags: ['needs_review', 'duplicate_suspected'] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([
        ['needs_review', false],
        ['unrecognized_asset', true]
      ]),
      internal: t.isInternalTransfer,
      spam: !!t.isSpam
    });
    expect(patch.flags).toEqual(['duplicate_suspected', 'unrecognized_asset']);
    expect(patch.isInternalTransfer).toBe(false);
    expect(patch.isSpam).toBe(false);
  });

  it('marking internal also records possible_internal_transfer (mirrors FlagSelector)', () => {
    const t = tx({ flags: [] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map(),
      internal: true,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(true);
    expect(patch.flags).toContain('possible_internal_transfer');
  });

  it('unmarking internal removes possible_internal_transfer but keeps other flags', () => {
    const t = tx({
      flags: ['possible_internal_transfer', 'needs_review'],
      isInternalTransfer: true
    });
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([['needs_review', true]]),
      internal: false,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(false);
    expect(patch.flags).toEqual(['needs_review']);
  });

  it('sets the spam boolean independently of stored flags', () => {
    const t = tx({ flags: ['needs_review'] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([['needs_review', true]]),
      internal: false,
      spam: true
    });
    expect(patch.isSpam).toBe(true);
    expect(patch.flags).toEqual(['needs_review']);
  });
});

describe('initialBulkFlagsSelection', () => {
  it('checks a box only when EVERY selected row has it', () => {
    const sel = [
      tx({ flags: ['needs_review', 'missing_cost_basis'] }),
      tx({ flags: ['needs_review'] })
    ];
    const init = initialBulkFlagsSelection(sel);
    expect(init.flags.get('needs_review')).toBe(true);
    expect(init.flags.get('missing_cost_basis')).toBe(false);
    expect(init.internal).toBe(false);
    expect(init.spam).toBe(false);
  });

  it('checks internal/spam only when all rows share them', () => {
    const sel = [
      tx({ isInternalTransfer: true, isSpam: true }),
      tx({ isInternalTransfer: true, isSpam: false })
    ];
    const init = initialBulkFlagsSelection(sel);
    expect(init.internal).toBe(true);
    expect(init.spam).toBe(false);
  });

  it('handles an empty selection without throwing', () => {
    const init = initialBulkFlagsSelection([]);
    expect(init.internal).toBe(false);
    expect(init.flags.get('needs_review')).toBe(false);
  });
});
