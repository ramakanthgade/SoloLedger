/** Shared header lookup helpers for exchange parsers. */

import { normalizeHeader } from './tableExtract';

export function headerMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    map[h.toLowerCase().replace(/[^a-z0-9]/g, '')] = h;
  }
  return map;
}

export function col(map: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const hit = map[k.replace(/[^a-z0-9]/g, '')];
    if (hit) return hit;
  }
  return undefined;
}

/** Find first header whose normalized form includes any of the needles. */
export function colIncludes(map: Record<string, string>, ...needles: string[]): string | undefined {
  const entries = Object.entries(map);
  for (const needle of needles) {
    const n = needle.replace(/[^a-z0-9]/g, '');
    for (const [norm, original] of entries) {
      if (norm.includes(n)) return original;
    }
  }
  return undefined;
}

/**
 * First non-empty cell of `row` among the given column names, matched on
 * normalized headers (same normalization as `headerMap`). First match wins;
 * empty/missing cells are skipped. Returns '' when nothing matches.
 */
export function rowCol(row: Record<string, string>, ...names: string[]): string {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [normalizeHeader(k), v])
  );
  for (const name of names) {
    const hit = normalized[normalizeHeader(name)];
    if (hit != null && hit !== '') return hit;
  }
  return '';
}
