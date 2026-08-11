/**
 * Pure view helpers for the redesigned Review ledger — date grouping and
 * numbered pagination. Kept separate from ReviewTab.tsx so they are unit
 * testable without rendering the tab (which never settles under jsdom).
 */
import { isValidTxHashForChain } from '@/lib/parsers/explorer';

export interface RowGroup<T> {
  /** UTC day key `YYYY-MM-DD`, or 'all' when grouping is disabled. */
  key: string;
  rows: T[];
}

/**
 * Real chain hash when available. Legacy on-chain rows retain sourceRef only
 * when it passes the chain-aware explorer validator; internal provider event
 * ids (for example `moralis:event:…`) must never be presented as tx hashes.
 * Off-chain rows may still expose their sourceRef as an exchange order id.
 */
export function reviewTransactionHash(
  transaction: Readonly<{ txHash?: string; sourceRef?: string; chain?: string }>
): string | undefined {
  if (transaction.txHash) return transaction.txHash;
  if (!transaction.sourceRef) return undefined;
  if (!transaction.chain) return transaction.sourceRef;
  return isValidTxHashForChain(transaction.chain, transaction.sourceRef) ? transaction.sourceRef : undefined;
}

/**
 * Group an already date-sorted row list into UTC-day buckets, preserving row
 * order. Adjacent rows sharing a day merge into one group, so the caller's
 * sort (newest-first or oldest-first) is respected.
 */
export function groupRowsByDate<T extends { timestamp: number }>(rows: T[]): RowGroup<T>[] {
  const groups: RowGroup<T>[] = [];
  for (const row of rows) {
    const key = new Date(row.timestamp).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

/** "2026-07-22" → "Jul 22, 2026" (always UTC — the ledger is UTC throughout). */
export function formatGroupDateLabel(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Numbered pagination window: `[1, '…', 4, 5, 6, '…', 42]` style. Always
 * shows first/last and a ±1 window around the current page; single-page and
 * short (≤7) lists come back fully expanded with no ellipses.
 */
export function pageNumberList(current: number, total: number): (number | '…')[] {
  if (total <= 0) return [];
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev !== 0 && p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}
