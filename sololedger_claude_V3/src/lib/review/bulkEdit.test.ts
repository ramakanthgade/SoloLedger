import { describe, it, expect } from 'vitest';
import type { FlagReason, Transaction } from '@/types/transaction';
import {
  ALL_FLAGS,
  BULK_FLAG_CHECKBOXES,
  DISPOSAL_TYPES,
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

  it('excludes internal-transfer / spam rows from taxable impact counts (engine skips them)', () => {
    const sel = [
      tx({ type: 'transfer_in' }),
      tx({ type: 'transfer_in', isInternalTransfer: true }),
      tx({ type: 'transfer_in', isSpam: true })
    ];
    const disposal = summarizeBulkTypeChange(sel, 'sell');
    // Only the plain transfer_in becomes a taxable disposal.
    expect(disposal.disposalsCreated).toBe(1);
    expect(disposal.total).toBe(3);

    const income = summarizeBulkTypeChange(sel, 'income');
    expect(income.incomeCreated).toBe(1);
  });

  it('counts disposalsRemoved only for taxable (non-internal/spam) rows', () => {
    const sel = [
      tx({ type: 'sell', fiatValue: 5 }),
      tx({ type: 'sell', fiatValue: 5, isSpam: true })
    ];
    const impact = summarizeBulkTypeChange(sel, 'transfer_out');
    expect(impact.disposalsRemoved).toBe(1);
    expect(impact.transfersCreated).toBe(2); // display-level: both rows change type
  });
});

describe('DISPOSAL_TYPES', () => {
  it('contains the disposal types and excludes acquisitions/transfers', () => {
    expect(DISPOSAL_TYPES.has('sell')).toBe(true);
    expect(DISPOSAL_TYPES.has('trade')).toBe(true);
    expect(DISPOSAL_TYPES.has('gift_sent')).toBe(true);
    expect(DISPOSAL_TYPES.has('nft_sell')).toBe(true);
    expect(DISPOSAL_TYPES.has('buy')).toBe(false);
    expect(DISPOSAL_TYPES.has('transfer_in')).toBe(false);
    expect(DISPOSAL_TYPES.has('income')).toBe(false);
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

  it('warns that a trade is two-sided when setting trade', () => {
    const impact = summarizeBulkTypeChange([tx({ type: 'transfer_out' })], 'trade');
    const lines = bulkTypeImpactLines(impact);
    expect(lines.some((l) => l.includes('two-sided'))).toBe(true);
  });

  it('omits the two-sided-trade warning when every selected row is already a trade', () => {
    const impact = summarizeBulkTypeChange([tx({ type: 'trade', fiatValue: 1 })], 'trade');
    const lines = bulkTypeImpactLines(impact);
    expect(lines.some((l) => l.includes('two-sided'))).toBe(false);
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
      hint: 'unchecked',
      internal: t.isInternalTransfer,
      spam: !!t.isSpam
    });
    expect(patch.flags).toEqual(['duplicate_suspected', 'unrecognized_asset']);
    expect(patch.isInternalTransfer).toBe(false);
    expect(patch.isSpam).toBe(false);
  });

  it('confirming internal REMOVES the possible_internal_transfer hint (mutually exclusive end states)', () => {
    // User screenshot flow: a row carrying the yellow hint is confirmed
    // internal via Set flags — the hint must disappear, not sit alongside the
    // blue "internal" badge. Hint box indeterminate ('mixed') — internal wins.
    const t = tx({ flags: ['possible_internal_transfer', 'needs_review'] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map(),
      hint: 'mixed',
      internal: true,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(true);
    expect(patch.flags).toEqual(['needs_review']);
  });

  it('internal wins: hint checkbox checked but internal checked ⇒ hint still removed', () => {
    const t = tx({ flags: ['possible_internal_transfer'] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map(),
      hint: 'checked',
      internal: true,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(true);
    expect(patch.flags).not.toContain('possible_internal_transfer');
  });

  it('confirming internal never ADDS a phantom hint to rows that never had one', () => {
    const t = tx({ flags: [], isInternalTransfer: true });
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([['needs_review', true]]),
      hint: 'unchecked',
      internal: true,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(true);
    expect(patch.flags).toEqual(['needs_review']);
  });

  it('leaving "internal" unchecked NEVER strips a stored possible_internal_transfer (no bulk data loss)', () => {
    // Typical RPC import: heuristic flag stored, but not marked internal.
    const t = tx({
      flags: ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false
    });
    // User bulk-adds needs_review; "Internal transfer" box left unchecked
    // (its initial state because the rows aren't uniformly internal). A
    // uniform hinted selection starts the hint box CHECKED, so a default
    // apply preserves it.
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([
        ['missing_cost_basis', true],
        ['duplicate_suspected', false],
        ['unrecognized_asset', false],
        ['needs_review', true]
      ]),
      hint: 'checked',
      internal: false,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(false);
    // possible_internal_transfer + missing_cost_basis preserved, needs_review added
    expect(patch.flags).toEqual(
      expect.arrayContaining(['possible_internal_transfer', 'missing_cost_basis', 'needs_review'])
    );
    expect(patch.flags).toHaveLength(3);
  });

  it('hint checkbox round-trip: checked sets the hint, unchecked removes it (deliberate bulk set/remove)', () => {
    const t = tx({ flags: [] });
    const added = bulkFlagsPatch(t, {
      flags: new Map(),
      hint: 'checked',
      internal: false,
      spam: false
    });
    expect(added.flags).toEqual(['possible_internal_transfer']);
    const removed = bulkFlagsPatch({ ...t, flags: added.flags } as Transaction, {
      flags: new Map(),
      hint: 'unchecked',
      internal: false,
      spam: false
    });
    expect(removed.flags).toEqual([]);
  });

  it('internal UNCHECKED + hint box explicitly unchecked removes the hint (absolute apply)', () => {
    const t = tx({ flags: ['possible_internal_transfer'], isInternalTransfer: false });
    const patch = bulkFlagsPatch(t, {
      flags: new Map(),
      hint: 'unchecked',
      internal: false,
      spam: false
    });
    expect(patch.isInternalTransfer).toBe(false);
    expect(patch.flags).toEqual([]);
  });

  it("hint 'mixed' (indeterminate) leaves each row's stored hint exactly as it was", () => {
    const hinted = tx({ flags: ['possible_internal_transfer', 'needs_review'] });
    const plain = tx({ flags: ['duplicate_suspected'] });
    const sel = {
      flags: new Map<FlagReason, boolean>([['unrecognized_asset', true]]),
      hint: 'mixed' as const,
      internal: false,
      spam: false
    };
    // Hinted row keeps the hint; non-hinted row gains nothing.
    expect(bulkFlagsPatch(hinted, sel).flags).toEqual(
      expect.arrayContaining(['possible_internal_transfer', 'needs_review', 'unrecognized_asset'])
    );
    expect(bulkFlagsPatch(plain, sel).flags).toEqual(['duplicate_suspected', 'unrecognized_asset']);
  });

  it('sets the spam boolean independently of stored flags', () => {
    const t = tx({ flags: ['needs_review'] });
    const patch = bulkFlagsPatch(t, {
      flags: new Map<FlagReason, boolean>([['needs_review', true]]),
      hint: 'unchecked',
      internal: false,
      spam: true
    });
    expect(patch.isSpam).toBe(true);
    expect(patch.flags).toEqual(['needs_review']);
  });
});

describe('bulkFlagsPatch — full Set-flags flows (initial selection → apply)', () => {
  it('Item 4 flow: rows with the hint + internal checked ⇒ only internal set, hint gone, other flags preserved', () => {
    // Both rows carry the hint AND needs_review, so both boxes start checked;
    // the user checks "Internal transfer" and applies.
    const rows = [
      tx({ flags: ['possible_internal_transfer', 'needs_review'] }),
      tx({ flags: ['possible_internal_transfer', 'needs_review'] })
    ];
    const init = initialBulkFlagsSelection(rows);
    expect(init.hint).toBe('checked');
    expect(init.flags.get('needs_review')).toBe(true);
    const sel = { ...init, internal: true };
    for (const t of rows) {
      const patch = bulkFlagsPatch(t, sel);
      expect(patch.isInternalTransfer).toBe(true);
      // Hint gone (confirming internal wins), unrelated stored flag kept —
      // unlike the removed "Mark N as internal" button, which wiped flags: [].
      expect(patch.flags).toEqual(['needs_review']);
    }
  });

  it('Item 5 flow: applying needs_review to 14 already-internal rows adds no phantom hint', () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      tx({ id: `int${i}`, flags: [], isInternalTransfer: true })
    );
    const init = initialBulkFlagsSelection(rows);
    expect(init.internal).toBe(true); // box pre-checked: every row is internal
    expect(init.hint).toBe('unchecked'); // no row carries the hint
    const sel = { ...init, flags: new Map(init.flags) };
    sel.flags.set('needs_review', true);
    for (const t of rows) {
      const patch = bulkFlagsPatch(t, sel);
      // Exactly { isInternalTransfer: true, flags: [needs_review] } — the old
      // contract resurrected a phantom possible_internal_transfer here.
      expect(patch.isInternalTransfer).toBe(true);
      expect(patch.flags).toEqual(['needs_review']);
    }
  });

  it('OFF-side protection: internal unchecked + default hint box leaves RPC hints intact on all rows', () => {
    const rows = [
      tx({ flags: ['possible_internal_transfer'], isInternalTransfer: false }),
      tx({ flags: ['possible_internal_transfer', 'missing_cost_basis'], isInternalTransfer: false })
    ];
    const init = initialBulkFlagsSelection(rows);
    expect(init.internal).toBe(false);
    expect(init.hint).toBe('checked'); // uniform hinted selection
    const sel = { ...init, flags: new Map(init.flags) };
    sel.flags.set('needs_review', true);
    for (const t of rows) {
      const patch = bulkFlagsPatch(t, sel);
      expect(patch.isInternalTransfer).toBe(false);
      expect(patch.flags).toContain('possible_internal_transfer');
      expect(patch.flags).toContain('needs_review');
    }
  });

  it('F1 regression: MIXED selection + default apply (hint box never touched) leaves every hint untouched', () => {
    // Some rows hinted, some not → the hint box starts INDETERMINATE; the user
    // bulk-applies needs_review without touching it.
    const rows = [
      tx({ flags: ['possible_internal_transfer'], isInternalTransfer: false }),
      tx({ flags: [], isInternalTransfer: false }),
      tx({ flags: ['possible_internal_transfer'], isInternalTransfer: false })
    ];
    const init = initialBulkFlagsSelection(rows);
    expect(init.hint).toBe('mixed');
    const sel = { ...init, flags: new Map(init.flags) };
    sel.flags.set('needs_review', true);
    const [p0, p1, p2] = rows.map((t) => bulkFlagsPatch(t, sel));
    // Hinted rows KEEP their RPC-imported hint (the F1 bug stripped it)…
    expect(p0.flags).toEqual(['possible_internal_transfer', 'needs_review']);
    expect(p2.flags).toEqual(['possible_internal_transfer', 'needs_review']);
    // …and the non-hinted row does NOT gain one.
    expect(p1.flags).toEqual(['needs_review']);
    for (const p of [p0, p1, p2]) expect(p.isInternalTransfer).toBe(false);
  });

  it('mixed selection + user deliberately CHECKS the hint box ⇒ hint set on all rows', () => {
    const rows = [tx({ flags: ['possible_internal_transfer'] }), tx({ flags: [] })];
    const init = initialBulkFlagsSelection(rows);
    expect(init.hint).toBe('mixed');
    // First click from the dash checks the box.
    const sel = { ...init, hint: 'checked' as const };
    for (const t of rows) {
      expect(bulkFlagsPatch(t, sel).flags).toContain('possible_internal_transfer');
    }
  });

  it('mixed selection + user deliberately UNCHECKES the hint box ⇒ hint removed from all rows', () => {
    // Both rows share needs_review (box stays checked); only the hint is mixed.
    const rows = [
      tx({ flags: ['possible_internal_transfer', 'needs_review'] }),
      tx({ flags: ['needs_review'] })
    ];
    const init = initialBulkFlagsSelection(rows);
    expect(init.hint).toBe('mixed');
    // Clicking a checked box unchecks it (click-through from the dash: mixed
    // → checked → unchecked).
    const sel = { ...init, hint: 'unchecked' as const };
    const [p0, p1] = rows.map((t) => bulkFlagsPatch(t, sel));
    expect(p0.flags).toEqual(['needs_review']);
    expect(p1.flags).toEqual(['needs_review']);
  });

  it('uniform hinted selection + uncheck ⇒ hint removed from all rows (deliberate removal preserved)', () => {
    const rows = [
      tx({ flags: ['possible_internal_transfer'] }),
      tx({ flags: ['possible_internal_transfer'] })
    ];
    const init = initialBulkFlagsSelection(rows);
    expect(init.hint).toBe('checked');
    const sel = { ...init, hint: 'unchecked' as const };
    for (const t of rows) {
      expect(bulkFlagsPatch(t, sel).flags).toEqual([]);
    }
  });
});

describe('BULK_FLAG_CHECKBOXES', () => {
  it('offers every stored flag as a checkbox, including possible_internal_transfer', () => {
    expect(BULK_FLAG_CHECKBOXES).toEqual(ALL_FLAGS);
    expect(BULK_FLAG_CHECKBOXES).toContain('possible_internal_transfer');
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

  it('hint box is tri-state: checked when ALL rows hinted, mixed when some are, unchecked when none are', () => {
    const allHinted = initialBulkFlagsSelection([
      tx({ flags: ['possible_internal_transfer'] }),
      tx({ flags: ['possible_internal_transfer', 'needs_review'] })
    ]);
    expect(allHinted.hint).toBe('checked');

    const mixed = initialBulkFlagsSelection([
      tx({ flags: ['possible_internal_transfer'] }),
      tx({ flags: [] })
    ]);
    expect(mixed.hint).toBe('mixed');

    const noneHinted = initialBulkFlagsSelection([tx({ flags: ['needs_review'] })]);
    expect(noneHinted.hint).toBe('unchecked');
  });

  it('keeps the hint out of the absolute-flags map (it lives in the tri-state field)', () => {
    const init = initialBulkFlagsSelection([tx({ flags: ['possible_internal_transfer'] })]);
    expect(init.flags.has('possible_internal_transfer')).toBe(false);
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
    expect(init.hint).toBe('unchecked');
  });
});
