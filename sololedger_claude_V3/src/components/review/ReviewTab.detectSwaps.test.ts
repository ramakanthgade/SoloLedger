import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Item 5 guard (grep-based, per the Task 2 plan): the manual "Detect swaps"
 * buttons were removed from BOTH the swap banner and the filter toolbar, while
 * the informational swap banner (the "possible DEX swaps waiting to be merged"
 * count) still renders. Full ReviewTab render never settles under jsdom (heavy
 * Dexie useLiveQuery chains — see App.tabs.test.tsx), so we assert against the
 * component source instead. build + lint separately catch dangling references.
 */
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'ReviewTab.tsx'),
  'utf8'
);

describe('ReviewTab — Detect-swaps buttons removed (Item 5)', () => {
  it('no longer defines or calls the manual runSwapDetection handler', () => {
    expect(source).not.toContain('runSwapDetection');
  });

  it('keeps the informational swap banner with its count', () => {
    expect(source).toContain('possible DEX swap');
    expect(source).toContain('potentialSwapPairs > 0');
  });

  it('does not render a "Detect swaps" / "Detect DEX swaps" button label', () => {
    expect(source).not.toContain('Detect DEX swaps');
    expect(source).not.toContain('Detect swaps');
  });
});

describe('ReviewTab — Flags filter (Item 4)', () => {
  it('renders a Flags filter select wired to flagFilter state', () => {
    expect(source).toContain('aria-label="Flags filter"');
    expect(source).toContain('setFlagFilter');
    expect(source).toContain('All flags');
  });
});
