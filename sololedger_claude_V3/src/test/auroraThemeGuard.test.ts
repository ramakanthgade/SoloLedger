import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Theme guard — Ember & Slate (formerly the Aurora theme guard).
 *
 * History: the Aurora migration replaced the old light-palette Tailwind color
 * names (`ink` / `mist` / `emerald` / `navy` / `teal` / `gold` / `pink`) with
 * semantic tokens. The Ember & Slate redesign (locked 25 Jul 2026) then
 * renamed the Aurora brand accents to the new canonical tokens:
 *
 *   `violet` → `primary`  (burnt ember #C2410C / dark peach #F2A260)
 *   `blue`   → `accent`   (amber #B45309 / dark #ECB44A)
 *   `teal`   → `accent`   (amber; multi-stop brand gradients became the
 *                          ember→amber `--aurora` / `bg-aurora`)
 *
 * Glass hairlines moved from `border-white/10` (invisible on the light warm
 * paper canvas) to theme-flipping `border-hi/10`.
 *
 * This test scans every `src/**\/*.{ts,tsx}` file (excluding tests) and FAILS
 * if any retired class token or retired Aurora hex reappears, keeping both
 * migrations verifiably complete and preventing regressions.
 */

const OLD_TOKENS_STRICT = ['ink', 'mist', 'emerald', 'navy', 'gold', 'pink', 'violet', 'blue', 'teal'];

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

// e.g. `text-ink-950`, `bg-emerald/10`, `border-violet`, `text-teal` — retired
// class tokens. All Aurora brand tokens are now forbidden in every form:
// bare, with a numeric scale, or with a slash-opacity.
const strictPattern = new RegExp(
  `\\b(?:${prefixAlt})-(?:${OLD_TOKENS_STRICT.join('|')})(?:-[0-9]+)?(?:/[0-9]+)?\\b`,
  'g'
);

// Retired Aurora palette hexes (case-insensitive). The ember→amber brand
// gradient, moss gains, crimson losses and the charcoal-hearth canvas make
// every one of these a bug if it reappears in source.
const OLD_HEXES = [
  '7C5CFF', // aurora violet
  '4EA8FF', // aurora blue
  '22E1C3', // aurora teal
  '2CE5A6', // aurora gain
  'FF5C7A', // aurora loss
  'FFB020', // aurora warn
  '0A0B1A', // aurora canvas
  '12132A', // aurora elev-1
  '1A1B38', // aurora elev-2
  '232551', // aurora elev-3
  'F5F6FF', // aurora text-hi
  'B4B7D9', // aurora text-mid
  '7C80A8', // aurora text-low
  '565A82', // aurora text-faint
  'A78BFA' // light-violet gradient stop
];
const hexPattern = new RegExp(`#(?:${OLD_HEXES.join('|')})\\b`, 'gi');

/**
 * Documented allow-list: exact `path::token` entries that are intentionally
 * exempt.
 *
 * - `lib/export/pdfTheme.ts` — the PDF export still carries the Aurora header
 *   hexes on purpose: it is restyled in the Reports+PDF step of the redesign
 *   (locked guardrail: PDF body stays light/ink-friendly with a solid
 *   non-gradient header). Remove this entry when that step lands.
 */
const ALLOW_LIST = new Set<string>([
  'lib/export/pdfTheme.ts::#12132A',
  'lib/export/pdfTheme.ts::#0A0B1A'
]);

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

describe('Theme guard (Ember & Slate): no legacy palette classes or hexes remain', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no retired Tailwind color-class tokens (ink/mist/emerald/navy/gold/pink/violet/blue/teal)', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = file.slice(SRC_DIR.length + 1);
      const text = readFileSync(file, 'utf8');

      strictPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = strictPattern.exec(text)) !== null) {
        const token = match[0];
        if (ALLOW_LIST.has(`${rel}::${token}`)) continue;
        offenders.push(`${rel}: ${token}`);
      }
    }

    expect(
      offenders,
      `Found ${offenders.length} retired palette class token(s). Use Ember & Slate tokens (primary/accent/gain/loss/warn):\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('has no retired Aurora hex values', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = file.slice(SRC_DIR.length + 1);
      const text = readFileSync(file, 'utf8');

      hexPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = hexPattern.exec(text)) !== null) {
        const token = match[0].toUpperCase();
        if (ALLOW_LIST.has(`${rel}::${token}`)) continue;
        offenders.push(`${rel}: ${match[0]}`);
      }
    }

    expect(
      offenders,
      `Found ${offenders.length} retired Aurora hex value(s). Use the Ember & Slate tokens from src/index.css:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
