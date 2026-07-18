/**
 * Pure row-visibility + pagination derivation for the Review tab.
 *
 * The `filtered`/`pageRows` memos in `ReviewTab.tsx` used to inline this logic,
 * which made it impossible to unit-test (a full `<ReviewTab/>` render never
 * settles under jsdom because of the heavy Dexie `useLiveQuery` chains — see
 * `ReviewTab.detectSwaps.test.ts`). Extracting it here keeps the filtering and
 * pagination behaviour identical while making it directly testable.
 *
 * Only the row-visibility predicate and pagination slice are extracted — the
 * sort (which depends on component-local sort state) stays in `ReviewTab`.
 * Heavy per-row predicates (`isNeedsReview`, derivative detection) are injected
 * so this module stays free of Dexie/RPC imports.
 */
import type { FlagReason, Transaction, TxType } from '@/types/transaction';
import { matchesFlagFilter } from '@/lib/review/displayFlags';

export interface RowFilterOptions {
  showSpam: boolean;
  showNeedsPrice: boolean;
  showNeedsReview: boolean;
  assetFilter: string;
  typeFilter: TxType | 'all';
  flagFilter: FlagReason | 'all' | 'spam' | 'internal';
  walletFilter: string;
  fyBounds: { start: number; end: number } | null;
  instrumentFilter: 'all' | 'spot' | 'derivative';
  query: string;
  /** Injected so this module avoids importing the RPC reward-suggestion code. */
  isNeedsReview: (t: Transaction) => boolean;
  /** Injected so this module avoids importing the tax/derivatives helpers. */
  isDerivative: (t: Transaction) => boolean;
}

/** Keep only the rows visible for the current filter selection. */
export function filterRows(txs: Transaction[], opts: RowFilterOptions): Transaction[] {
  return txs.filter((t) => {
    // Spam gates: skipped entirely when the Flags filter itself targets spam,
    // so the "Spam" filter surfaces spam rows even while `showSpam` is off.
    if (opts.flagFilter !== 'spam') {
      if (!opts.showSpam && t.isSpam) return false;
      if (opts.showSpam && !t.isSpam) return false;
    }
    if (opts.showNeedsPrice && !(t.fiatValue == null && !t.isSpam)) return false;
    if (opts.showNeedsReview && !opts.isNeedsReview(t)) return false;
    if (opts.assetFilter !== 'all' && t.asset !== opts.assetFilter) return false;
    if (opts.typeFilter !== 'all' && t.type !== opts.typeFilter) return false;
    if (opts.flagFilter !== 'all' && !matchesFlagFilter(t, opts.flagFilter)) return false;
    if (
      opts.walletFilter !== 'all' &&
      t.walletAddress?.toLowerCase() !== opts.walletFilter.toLowerCase()
    )
      return false;
    if (opts.fyBounds && (t.timestamp < opts.fyBounds.start || t.timestamp > opts.fyBounds.end))
      return false;
    if (opts.instrumentFilter === 'derivative' && !opts.isDerivative(t)) return false;
    if (opts.instrumentFilter === 'spot' && opts.isDerivative(t)) return false;
    if (
      opts.query &&
      !`${t.asset} ${t.type} ${t.source} ${t.walletAddress ?? ''} ${t.notes ?? ''}`
        .toLowerCase()
        .includes(opts.query.toLowerCase())
    )
      return false;
    return true;
  });
}

export interface PaginationResult<T> {
  pageRows: T[];
  totalPages: number;
  safePage: number;
}

/** Slice `rows` for the requested page, clamping the page to the valid range. */
export function paginate<T>(rows: T[], page: number, pageSize: number): PaginationResult<T> {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return { pageRows: rows.slice(start, start + pageSize), totalPages, safePage };
}
