import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Papa from 'papaparse';
import type { Transaction } from '@/types/transaction';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read a fixture CSV into header-keyed rows (mirrors the app's Papa usage). */
export function loadFixtureRows(relativePath: string): Record<string, string>[] {
  const text = readFileSync(join(HERE, relativePath), 'utf8');
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy'
  });
  return (parsed.data as Record<string, string>[]).map((row) => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) clean[k] = String(v ?? '').trim();
    return clean;
  });
}

/**
 * Normalize a Transaction[] for golden comparison: drop the volatile `id` and
 * the `raw` blob (source-row echo, not part of the normalized contract), and
 * sort deterministically so ordering differences don't cause false failures.
 */
export function normalizeForSnapshot(txs: Transaction[]): Omit<Transaction, 'id' | 'raw'>[] {
  return txs
    .map(({ id: _id, raw: _raw, ...rest }) => ({
      ...rest,
      flags: [...(rest.flags ?? [])].sort()
    }))
    .sort((a, b) =>
      a.timestamp - b.timestamp ||
      a.type.localeCompare(b.type) ||
      a.asset.localeCompare(b.asset) ||
      a.amount - b.amount
    );
}

export function loadExpected(relativePath: string): unknown {
  const text = readFileSync(join(HERE, relativePath), 'utf8');
  return JSON.parse(text);
}
