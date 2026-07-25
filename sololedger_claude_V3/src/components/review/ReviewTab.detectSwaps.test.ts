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

describe('ReviewTab — round 2 UI fixes (Task 1)', () => {
  it('adds Spam and Internal options to the Flags filter dropdown (Issue 3)', () => {
    expect(source).toContain('<option value="spam">Spam</option>');
    expect(source).toContain('<option value="internal">Internal</option>');
  });

  it('left-anchors the per-row Flags popover so it opens into the row (Issue 1, Ember & Slate layout)', () => {
    // The redesigned date-grouped row places the FlagSelector in the MIDDLE
    // column (lg) or under the type block (mobile) — no longer the last
    // table column — so the popover left-anchors and opens into the row.
    // Right-anchoring here would clip it against the row's left edge.
    expect(source).toContain('absolute left-0 top-9 z-30 min-w-[15rem]');
    expect(source).not.toContain('absolute right-0 top-7 z-30 min-w-[14rem]');
  });

  it('renders the shared pagination bar both above and below the list (Issue 2)', () => {
    const topOfList = source.indexOf('Date-grouped ledger');
    const firstPager = source.indexOf("renderPagination('')");
    const secondPager = source.indexOf("renderPagination('pt-1', { utcNote: true })");
    expect(topOfList).toBeGreaterThan(-1);
    expect(firstPager).toBeGreaterThan(-1);
    expect(secondPager).toBeGreaterThan(-1);
    // Top bar precedes the date-grouped list; bottom bar follows it.
    expect(firstPager).toBeLessThan(topOfList);
    expect(secondPager).toBeGreaterThan(topOfList);
  });
});
