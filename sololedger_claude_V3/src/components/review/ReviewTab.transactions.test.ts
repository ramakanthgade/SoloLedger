import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Wiring guards for the 2026-07-25 live-feedback round (items 10 + 11 + the
 * needs-price grammar fix) — grep-based for the same reason as
 * ReviewTab.detectSwaps.test.ts: a full ReviewTab render never settles under
 * jsdom. The pure logic behind the wiring is unit-tested in
 * rowAnatomy.test.ts (flow model + summaries), spamVisibility.test.ts
 * (default-hide contract) and bulkEdit.test.ts (needsPriceLine).
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'ReviewTab.tsx'), 'utf8');
const brandSource = readFileSync(resolve(here, 'brandIcons.tsx'), 'utf8');

describe('ReviewTab — item 7/10: page renamed to Transactions', () => {
  it('renders the page title as Transactions (both the list and the empty state)', () => {
    const titles = source.match(/<h2 className="page-title">Transactions<\/h2>/g) ?? [];
    expect(titles.length).toBe(2);
    expect(source).not.toContain('<h2 className="page-title">Review</h2>');
  });
});

describe('ReviewTab — item 11: spam hidden by default', () => {
  it('passes the showSpam state through to the shared row filter (default off)', () => {
    expect(source).toContain("const [showSpam, setShowSpam] = useState(false);");
    expect(source).toContain('filterRows(transactions, {');
    expect(source).toContain('showSpam,');
  });

  it('the Spam chip reads "Spam (N)" in both states with the total spam count', () => {
    expect(source).toContain('`Spam (${spamTxCount}) ✕`');
    expect(source).toContain('`Spam (${spamTxCount})`');
    expect(source).not.toContain('`Spam: ${spamTxCount}`');
  });

  it('counts the default (non-spam) view in the header pill', () => {
    expect(source).toContain('(transactions.length - spamTxCount).toLocaleString');
  });
});

describe('ReviewTab — item 10: richer rows + click-anywhere details', () => {
  it('drives the row-face flow and the Details summary from the pure rowAnatomy helpers', () => {
    expect(source).toContain("from './rowAnatomy'");
    expect(source).toContain('txFlow(t,');
    expect(source).toContain('buildTxSummary(t,');
  });

  it('clicking anywhere on the row face toggles the Details panel', () => {
    expect(source).toContain('onClick={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}');
  });

  it('keeps the accessible expand/collapse button (keyboard path) with its aria state', () => {
    expect(source).toContain("aria-label={expanded ? 'Collapse transaction details' : 'Expand transaction details'}");
    expect(source).toContain('aria-expanded={expanded}');
  });

  it('stops row-internal controls from toggling the panel (stopPropagation)', () => {
    // The bulk-select label, both selector popovers and the chevron all swallow
    // the click so it cannot double-toggle the row's expansion.
    const stops = source.match(/e\.stopPropagation\(\)/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(4);
  });

  it('shows the facts grid with date, hash/order id, source, both legs, value, cost basis and gain', () => {
    expect(source).toContain('<DetailRow label="Date">');
    expect(source).toContain('<DetailRow label={hashFactLabel}>');
    expect(source).toContain('<DetailRow label="Source">');
    expect(source).toContain('<DetailRow label="From">');
    expect(source).toContain('<DetailRow label="To">');
    expect(source).toContain('<DetailRow label="Value">');
    expect(source).toContain('<DetailRow label="Cost basis">');
    expect(source).toContain('<DetailRow label="Gain">');
  });

  it('resolves wallet names live from the lookup-address table (renames update rows in place)', () => {
    expect(source).toContain('useLiveQuery(() => getLookupAddresses(), [])');
    expect(source).toContain('walletLabels.get(addr.toLowerCase())');
  });
});

describe('ReviewTab — round 4: compact aligned rows (no middle desert)', () => {
  it('lays the row on aligned tracks with a flexible flow column', () => {
    // select · type (8.5rem) · flexible flow · source+chevron — with the
    // source context in a fixed 13.5rem right-aligned block on every row.
    expect(source).toContain('lg:grid-cols-[auto_8.5rem_minmax(0,1fr)_auto]');
    expect(source).not.toContain('lg:justify-start');
    expect(source).toContain('lg:w-[13.5rem]');
  });

  it('the flow content stays capped inside its flexible alignment track', () => {
    expect(source).not.toContain('lg:flex-1');
    expect(source).toContain('lg:max-w-[34rem]');
  });

  it('a disposal with no cost-basis data renders "—" in the details facts, not an invented ₹0.00', () => {
    expect(source).toContain('pricedDisposal.costBasis > 0');
  });
});

describe('ReviewTab — grammar fix: needs-price banner is plural-aware', () => {
  it('delegates to needsPriceLine and no longer hardcodes "still need a price"', () => {
    expect(source).toContain('needsPriceLine(missingPriceTxs.length)');
    expect(source).not.toContain('still need a price');
  });
});

describe('brandIcons — icons always resolve', () => {
  it('falls back to the letter chip when an icon file fails to load', () => {
    expect(brandSource).toContain('if (loadFailed) return <>{fallback}</>;');
    expect(brandSource).toContain('onError={onError}');
  });
});
