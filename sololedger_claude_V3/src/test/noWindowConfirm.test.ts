import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * No-window.confirm guard (Task T2).
 *
 * Every blocking `window.confirm` was replaced with the accessible
 * `ConfirmDialog` primitive. This test scans `src/**\/*.{ts,tsx}` (excluding
 * tests) and FAILS if any `window.confirm(` call reappears, so destructive
 * actions always route through the a11y dialog.
 */
const SRC_DIR = resolve(__dirname, '..');
const CONFIRM_PATTERN = /window\.confirm\s*\(/g;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

describe('No window.confirm remains in src', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has zero window.confirm calls', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC_DIR.length + 1);
      const text = readFileSync(file, 'utf8');
      CONFIRM_PATTERN.lastIndex = 0;
      if (CONFIRM_PATTERN.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Found window.confirm in:\n${offenders.join('\n')}\nUse the ConfirmDialog primitive instead.`
    ).toEqual([]);
  });
});
