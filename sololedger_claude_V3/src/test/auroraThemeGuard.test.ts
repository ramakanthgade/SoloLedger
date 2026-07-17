import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Aurora theme guard (Task T1).
 *
 * The Aurora migration replaced the old light-palette Tailwind color names
 * (`ink` / `mist` / `emerald` / `navy` / `teal` / `gold` / `pink`) with the
 * new semantic tokens (`base` / `elev-*` / `hi` / `mid` / `low` / `violet` /
 * `blue` / `teal(new)` / `gain` / `loss` / `warn`).
 *
 * This test scans every `src/**\/*.{ts,tsx}` file (excluding tests) and FAILS
 * if any old color token still appears with a Tailwind class prefix. It keeps
 * the migration verifiably complete and prevents regressions.
 *
 * Note: `teal` was BOTH an old token and is a locked Aurora token. Because the
 * old `teal-*` scale is fully gone and the new `teal` is used bare (never with
 * a numeric scale like `teal-500`), the guard only forbids the *old* forms:
 * `teal` followed by a numeric scale (`-50`..`-900`) or a slash-opacity on such
 * a scale. Bare `text-teal` / `bg-teal` (the new token) is allowed.
 */

const OLD_TOKENS_STRICT = ['ink', 'mist', 'emerald', 'navy', 'gold', 'pink'];

const CLASS_PREFIXES = [
  'text',
  'bg',
  'border',
  'ring',
  'from',
  'to',
  'via',
  'fill',
  'stroke',
  'divide',
  'placeholder',
  'shadow',
  'decoration',
  'outline',
  'accent',
  'caret',
  'ring-offset'
];

const prefixAlt = CLASS_PREFIXES.join('|');

// e.g. `text-ink-950`, `bg-emerald/10`, `border-navy` — old strict tokens.
const strictPattern = new RegExp(
  `\\b(?:${prefixAlt})-(?:${OLD_TOKENS_STRICT.join('|')})(?:-[0-9]+)?(?:/[0-9]+)?\\b`,
  'g'
);

// e.g. `text-teal-600`, `bg-teal-50`, `from-teal-500/40` — the OLD teal scale.
// Bare `text-teal` (new Aurora token) has no numeric scale, so it is allowed.
const oldTealPattern = new RegExp(
  `\\b(?:${prefixAlt})-teal-[0-9]+(?:/[0-9]+)?\\b`,
  'g'
);

/**
 * Documented allow-list: exact `path::token` entries that are intentionally
 * exempt. Currently empty — no exceptions are needed after the migration.
 */
const ALLOW_LIST = new Set<string>([]);

const SRC_DIR = resolve(__dirname, '..');

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

describe('Aurora theme guard: no legacy palette classes remain', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no old Tailwind color-class tokens (ink/mist/emerald/navy/gold/pink/old-teal)', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = file.slice(SRC_DIR.length + 1);
      const text = readFileSync(file, 'utf8');

      for (const pattern of [strictPattern, oldTealPattern]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const token = match[0];
          if (ALLOW_LIST.has(`${rel}::${token}`)) continue;
          offenders.push(`${rel}: ${token}`);
        }
      }
    }

    expect(
      offenders,
      `Found ${offenders.length} legacy palette class token(s). Migrate them to Aurora tokens:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
