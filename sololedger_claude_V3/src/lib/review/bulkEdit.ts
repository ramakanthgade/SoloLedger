/**
 * Bulk-edit helpers for the Review tab — pure, unit-testable logic behind the
 * "Set type" (with impact summary) and "Set flags" bulk actions.
 *
 * Semantics deliberately mirror the per-row controls in ReviewTab.tsx so bulk
 * and per-row edits can never diverge:
 *  - Type change: sets `type` and strips the auto-derived flags
 *    (`possible_internal_transfer`, `missing_cost_basis`). `bulkTypePatch` is
 *    the single implementation — the per-row `TypeSelector` calls it too, so
 *    bulk and per-row edits can never diverge.
 *  - Flag change: absolute apply — a checked flag is added to every selected
 *    row, an unchecked one is removed. `isInternalTransfer` / `isSpam` are real
 *    booleans (not stored flags), so they are patched as booleans; marking
 *    internal also records the `possible_internal_transfer` stored flag.
 *    INTENTIONAL DIVERGENCE from per-row `FlagSelector`: per-row "mark
 *    internal" REPLACES the whole flags array with `['possible_internal_
 *    transfer']`. In bulk that would silently wipe unrelated stored flags
 *    (e.g. `needs_review`) on dozens of rows — data loss at scale — so here
 *    we only toggle membership of `possible_internal_transfer` and leave
 *    every other stored flag intact. `possible_internal_transfer` is governed
 *    ONLY by the "Internal transfer" control (see `BULK_FLAG_CHECKBOXES`); it
 *    is not offered as its own checkbox, so the two controls can never fight
 *    over it and strip it from non-internal rows.
 *  - `missing_cost_basis` is partly DERIVED (see `displayFlags`: shown whenever
 *    a row has no fiat value and isn't internal). Storing/removing it here only
 *    affects the stored flag; the derived badge still appears on unpriced rows.
 */

import type { FlagReason, Transaction, TxType } from '@/types/transaction';

/** Types that create a taxable disposal of the outgoing asset (display-level;
 *  matches ReviewTab's own DISPOSAL_TYPES, incl. trades). */
export const DISPOSAL_TYPES: ReadonlySet<TxType> = new Set([
  'sell',
  'trade',
  'gift_sent',
  'nft_sell'
]);

/** All stored flags, in display order — the single list behind the per-row
 *  FlagSelector checkboxes. */
export const ALL_FLAGS: readonly FlagReason[] = [
  'possible_internal_transfer',
  'missing_cost_basis',
  'duplicate_suspected',
  'unrecognized_asset',
  'needs_review'
];

/** Stored flags offered as checkboxes in the bulk "Set flags" dropdown.
 *  `possible_internal_transfer` is deliberately EXCLUDED here: it is governed
 *  solely by the dropdown's "Internal transfer" control (see `bulkFlagsPatch`).
 *  Offering it as its own checkbox too created a two-source conflict where the
 *  "Internal transfer" box always won and could silently strip a stored
 *  `possible_internal_transfer` flag from rows that are not internal. */
export const BULK_FLAG_CHECKBOXES: readonly FlagReason[] = ALL_FLAGS.filter(
  (f) => f !== 'possible_internal_transfer'
);

/** Flags stripped whenever a row's type changes (they are re-derived from the
 *  new type / fiat state by the rest of the app). */
const TYPE_CHANGE_STRIPPED_FLAGS: readonly FlagReason[] = [
  'possible_internal_transfer',
  'missing_cost_basis'
];

/** The patch applied to one row when its type changes — used by both the bulk
 *  "Set type" action and the per-row TypeSelector. */
export function bulkTypePatch(t: Transaction, newType: TxType): Partial<Transaction> {
  return {
    type: newType,
    flags: (t.flags ?? []).filter(
      (f) => !TYPE_CHANGE_STRIPPED_FLAGS.includes(f)
    ) as FlagReason[]
  };
}

export interface BulkTypeImpact {
  /** Number of selected rows the change applies to. */
  total: number;
  newType: TxType;
  /** Rows already of `newType` (applying is a harmless no-op for these). */
  alreadyOfType: number;
  /** Current-type histogram of the selected rows, sorted by count desc. */
  fromCounts: [TxType, number][];
  /** Rows that START creating a taxable disposal (were not a disposal type).
   *  Excludes internal-transfer / spam rows, which the cost-basis engine
   *  skips entirely, so they never become taxable disposals. */
  disposalsCreated: number;
  /** Rows that STOP being a taxable disposal (excludes internal/spam rows). */
  disposalsRemoved: number;
  /** Rows becoming `income` (taxable at fair-market value on receipt).
   *  Excludes internal/spam rows, which the engine skips. */
  incomeCreated: number;
  /** Rows becoming non-taxable transfers. */
  transfersCreated: number;
  /** Selected rows with no fiat value (will still need a price). */
  missingFiat: number;
}

/** Summarize what a bulk "Set type" would do — shown in the confirm dialog. */
export function summarizeBulkTypeChange(
  selectedTxs: Transaction[],
  newType: TxType
): BulkTypeImpact {
  const fromMap = new Map<TxType, number>();
  let alreadyOfType = 0;
  let disposalsCreated = 0;
  let disposalsRemoved = 0;
  let incomeCreated = 0;
  let missingFiat = 0;

  const newIsDisposal = DISPOSAL_TYPES.has(newType);

  for (const t of selectedTxs) {
    fromMap.set(t.type, (fromMap.get(t.type) ?? 0) + 1);
    const isTargetType = t.type === newType;
    if (isTargetType) alreadyOfType++;
    if (t.fiatValue == null) missingFiat++;
    // The cost-basis engine skips internal-transfer / spam rows, so a type
    // change on them never affects taxable disposals or income.
    if (t.isInternalTransfer || t.isSpam) continue;
    const wasDisposal = DISPOSAL_TYPES.has(t.type);
    if (!wasDisposal && newIsDisposal) disposalsCreated++;
    if (wasDisposal && !newIsDisposal) disposalsRemoved++;
    if (newType === 'income' && !isTargetType) incomeCreated++;
  }

  const fromCounts = [...fromMap.entries()].sort((a, b) => b[1] - a[1]);

  return {
    total: selectedTxs.length,
    newType,
    alreadyOfType,
    fromCounts,
    disposalsCreated,
    disposalsRemoved,
    incomeCreated,
    transfersCreated:
      newType === 'transfer_in' || newType === 'transfer_out'
        ? selectedTxs.length - alreadyOfType
        : 0,
    missingFiat
  };
}

/** One concise consequence line per notable impact, for the confirm dialog. */
export function bulkTypeImpactLines(impact: BulkTypeImpact): string[] {
  const rowCount = (n: number) => `${n} row${n === 1 ? '' : 's'}`;
  const lines: string[] = [];
  if (impact.newType === 'trade' && impact.total - impact.alreadyOfType > 0) {
    lines.push(
      'Heads-up: a trade is two-sided, but the counter-asset/amount can only be set per row — review each new trade row afterwards.'
    );
  }
  if (impact.disposalsCreated > 0) {
    lines.push(
      `${rowCount(impact.disposalsCreated)} become taxable disposal${impact.disposalsCreated === 1 ? '' : 's'} — they will appear in Capital Gains once priced.`
    );
  }
  if (impact.disposalsRemoved > 0) {
    lines.push(
      `${rowCount(impact.disposalsRemoved)} stop being disposals — they leave Capital Gains.`
    );
  }
  if (impact.incomeCreated > 0) {
    lines.push(
      `${rowCount(impact.incomeCreated)} become income — taxable at fair-market value on receipt.`
    );
  }
  if (impact.transfersCreated > 0) {
    lines.push(
      `${rowCount(impact.transfersCreated)} become non-taxable transfers.`
    );
  }
  if (impact.missingFiat > 0) {
    lines.push(
      `${rowCount(impact.missingFiat)} still have no fiat value — fetch prices afterwards.`
    );
  }
  if (impact.alreadyOfType > 0) {
    lines.push(
      `${rowCount(impact.alreadyOfType)} ${impact.alreadyOfType === 1 ? 'is' : 'are'} already "${impact.newType}" (unchanged).`
    );
  }
  return lines;
}

/** What the user picked in the bulk "Set flags" dropdown (absolute apply). */
export interface BulkFlagsSelection {
  /** Checked state for each stored flag offered as a checkbox
   *  (BULK_FLAG_CHECKBOXES — `possible_internal_transfer` is NOT included, it
   *  is governed by `internal`). */
  flags: ReadonlyMap<FlagReason, boolean>;
  /** Checked state for the isInternalTransfer boolean. */
  internal: boolean;
  /** Checked state for the isSpam boolean. */
  spam: boolean;
}

/**
 * The patch applied to one row for a bulk "Set flags" — mirrors FlagSelector:
 * stored flags are set absolutely (checked → present, unchecked → absent).
 *
 * `possible_internal_transfer` is special: it is NOT one of the bulk checkboxes
 * (BULK_FLAG_CHECKBOXES excludes it). It is governed only by the "Internal
 * transfer" control, which additionally sets the `isInternalTransfer` boolean.
 * Marking internal FORCE-ADDS the `possible_internal_transfer` stored flag, but
 * leaving internal unchecked NEVER removes it. This is deliberate: the checkbox
 * initializes to "all selected rows are internal", so an unchecked box is
 * ambiguous (rows that were never internal look the same as rows the user
 * actively unmarked). RPC imports routinely store `possible_internal_transfer`
 * as a hint on rows with `isInternalTransfer: false`; deleting it on every bulk
 * "Set flags" would silently wipe that hint across dozens of rows. Bulk edits
 * therefore only ever ADD this flag — removal is left to the per-row selector.
 */
export function bulkFlagsPatch(
  t: Transaction,
  sel: BulkFlagsSelection
): Partial<Transaction> {
  const next = new Set(t.flags ?? []);
  for (const [flag, on] of sel.flags) {
    if (on) next.add(flag);
    else next.delete(flag);
  }
  if (sel.internal) next.add('possible_internal_transfer');

  return {
    flags: [...next] as FlagReason[],
    isInternalTransfer: sel.internal,
    isSpam: sel.spam
  };
}

/** Initial checkbox state for the bulk "Set flags" dropdown: a box starts
 *  checked only when EVERY selected row has it. Only the flags offered as
 *  checkboxes (BULK_FLAG_CHECKBOXES) are included; `possible_internal_transfer`
 *  is represented by the `internal` control instead. */
export function initialBulkFlagsSelection(selectedTxs: Transaction[]): BulkFlagsSelection {
  const flags = new Map<FlagReason, boolean>();
  for (const f of BULK_FLAG_CHECKBOXES) {
    flags.set(f, selectedTxs.length > 0 && selectedTxs.every((t) => (t.flags ?? []).includes(f)));
  }
  return {
    flags,
    internal: selectedTxs.length > 0 && selectedTxs.every((t) => t.isInternalTransfer),
    spam: selectedTxs.length > 0 && selectedTxs.every((t) => !!t.isSpam)
  };
}
