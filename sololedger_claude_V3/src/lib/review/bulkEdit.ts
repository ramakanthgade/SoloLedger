/**
 * Bulk-edit helpers for the Review tab — pure, unit-testable logic behind the
 * "Set type" (with impact summary) and "Set flags" bulk actions.
 *
 * Semantics deliberately mirror the per-row controls in ReviewTab.tsx:
 *  - Type change: sets `type` and strips the auto-derived flags
 *    (`possible_internal_transfer`, `missing_cost_basis`). `bulkTypePatch` is
 *    the single implementation — the per-row `TypeSelector` calls it too, so
 *    bulk and per-row edits can never diverge.
 *  - Flag change: absolute apply — a checked flag is added to every selected
 *    row, an unchecked one is removed. `isInternalTransfer` / `isSpam` are real
 *    booleans (not stored flags), so they are patched as booleans. The
 *    `possible_internal_transfer` hint is a real checkbox too, but TRI-STATE
 *    (mixed = leave each row's hint untouched), with ONE precedence rule —
 *    confirming internal wins (mirrors the per-row `FlagSelector`, where
 *    marking internal clears the hint). The full contract lives on
 *    `bulkFlagsPatch`; the initial checkbox state rules on
 *    `initialBulkFlagsSelection`.
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

/** Stored flags offered as checkboxes in the bulk "Set flags" dropdown — ALL
 *  of them, including `possible_internal_transfer` (explicit user request).
 *  Apply semantics: see `bulkFlagsPatch`. */
export const BULK_FLAG_CHECKBOXES: readonly FlagReason[] = ALL_FLAGS;

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

/** The three states of the bulk "Possible internal transfer" hint checkbox —
 *  the dropdown's only non-absolute control. 'mixed' renders as an
 *  indeterminate dash and means "leave every row's stored hint untouched". */
export type BulkHintState = 'checked' | 'unchecked' | 'mixed';

/** What the user picked in the bulk "Set flags" dropdown. */
export interface BulkFlagsSelection {
  /** Checked state for each ABSOLUTE flag checkbox (BULK_FLAG_CHECKBOXES minus
   *  `possible_internal_transfer`, which is tri-state — see `hint`). */
  flags: ReadonlyMap<FlagReason, boolean>;
  /** Tri-state for the `possible_internal_transfer` hint checkbox. */
  hint: BulkHintState;
  /** Checked state for the isInternalTransfer boolean. */
  internal: boolean;
  /** Checked state for the isSpam boolean. */
  spam: boolean;
}

/**
 * The patch applied to one row for a bulk "Set flags": stored flags are set
 * absolutely (checked → present, unchecked → absent), with TWO special cases.
 *
 * 1. The `possible_internal_transfer` hint checkbox is TRI-STATE (the only
 *    non-absolute control): 'checked' sets the hint on every selected row,
 *    'unchecked' removes it from every row, and 'mixed' — shown as an
 *    indeterminate dash when only some selected rows carry the hint — leaves
 *    each row's stored hint UNTOUCHED. 'mixed' is what makes a default apply
 *    on a mixed selection safe: RPC imports store the hint on rows with
 *    `isInternalTransfer: false` as review evidence, and stripping it from
 *    hinted rows the user never asked to change would be silent data loss.
 *    Deliberate bulk set/remove stays possible via an explicit click.
 *
 * 2. "Internal transfer" CHECKED confirms the row as internal: it sets the
 *    `isInternalTransfer` boolean AND removes the hint regardless of the hint
 *    checkbox (confirming internal wins — a row cannot be both a "possible"
 *    and a confirmed internal transfer, and the user expects the yellow hint
 *    to disappear on confirm). UNCHECKED clears only the boolean and NEVER
 *    touches the hint itself.
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
  // Hint tri-state: 'mixed' leaves this row's stored hint exactly as it was.
  if (sel.hint === 'checked') next.add('possible_internal_transfer');
  else if (sel.hint === 'unchecked') next.delete('possible_internal_transfer');
  // Confirming internal wins over the hint checkbox: "possible" and
  // "confirmed" internal are mutually exclusive end states.
  if (sel.internal) next.delete('possible_internal_transfer');

  return {
    flags: [...next] as FlagReason[],
    isInternalTransfer: sel.internal,
    isSpam: sel.spam
  };
}

/** Initial checkbox state for the bulk "Set flags" dropdown: an absolute
 *  flag box starts checked only when EVERY selected row has it. The
 *  `possible_internal_transfer` hint is the one TRI-STATE box: 'checked' when
 *  every selected row carries the hint, 'unchecked' when none do, and 'mixed'
 *  (indeterminate dash) when only some do — so a default apply on a mixed
 *  selection leaves RPC-imported hints intact (`bulkFlagsPatch` skips the
 *  hint for 'mixed'; bulk set/remove requires an explicit click). */
export function initialBulkFlagsSelection(selectedTxs: Transaction[]): BulkFlagsSelection {
  const flags = new Map<FlagReason, boolean>();
  for (const f of BULK_FLAG_CHECKBOXES) {
    if (f === 'possible_internal_transfer') continue; // tri-state — see `hint`
    flags.set(f, selectedTxs.length > 0 && selectedTxs.every((t) => (t.flags ?? []).includes(f)));
  }
  const hinted = selectedTxs.filter((t) =>
    (t.flags ?? []).includes('possible_internal_transfer')
  ).length;
  const hint: BulkHintState =
    hinted === 0 ? 'unchecked' : hinted === selectedTxs.length ? 'checked' : 'mixed';
  return {
    flags,
    hint,
    internal: selectedTxs.length > 0 && selectedTxs.every((t) => t.isInternalTransfer),
    spam: selectedTxs.length > 0 && selectedTxs.every((t) => !!t.isSpam)
  };
}
