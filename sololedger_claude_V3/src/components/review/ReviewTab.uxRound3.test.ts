import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * ReviewTab wiring guards for the 2026-07-19 UX round (Items 3–5), grep-based
 * for the same reason as ReviewTab.detectSwaps.test.ts: a full ReviewTab
 * render never settles under jsdom (heavy Dexie useLiveQuery chains), so we
 * assert against the component source. The pure logic behind the wiring lives
 * in src/lib/review/llamaAutoSuggest.ts and src/lib/review/bulkEdit.ts and is
 * unit-tested in their own suites; lint + build catch dangling references.
 */
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'ReviewTab.tsx'),
  'utf8'
);

describe('ReviewTab — Item 3: DefiLlama auto-run gated on EFFECTIVE price lookup', () => {
  it('resolves the flag via getEffectiveSettings (server config in SaaS mode), not the local singleton', () => {
    expect(source).toContain("import { getEffectiveSettings } from '@/lib/saas/effectiveSettings'");
    expect(source).toContain('getEffectiveSettings()');
  });

  it('runs the guarded auto-run effect via the pure helpers and the session mark', () => {
    expect(source).toContain('shouldAutoRunLlamaSuggestions');
    expect(source).toContain('markLlamaAutoRun');
    // The effect fires the existing handler so the outcome surfaces via llamaMsg.
    expect(source).toContain('void suggestRewardIncome()');
  });

  it('no longer gates the auto-run on the raw local settings flag', () => {
    // The old effect read settings?.priceApiEnabled straight from the local
    // Dexie singleton and silently never fired for the hosted admin.
    expect(source).not.toContain("const key = 'sololedger_defillama_auto_v1';");
  });

  it('selects the banner variant from the effective flag via the shared helper', () => {
    expect(source).toContain('llamaBannerHint(priceLookupEnabled === true)');
  });
});

describe('ReviewTab — Item 4: duplicate bulk Mark buttons removed', () => {
  it('no longer defines the bulkMarkInternal / bulkMarkSpam handlers', () => {
    expect(source).not.toContain('bulkMarkInternal');
    expect(source).not.toContain('bulkMarkSpam');
  });

  it('no longer renders the "Mark N as internal" / "Mark N as spam" bulk buttons', () => {
    expect(source).not.toContain('Mark {selected.size} as internal');
    expect(source).not.toContain('Mark {selected.size} as spam');
  });

  it('keeps the bulk Set flags dropdown and the Delete button', () => {
    expect(source).toContain('Set flags ({selected.size})');
    expect(source).toContain('Delete {selected.size}');
  });

  it('documents the confirming-internal-wins precedence in the Set flags dropdown', () => {
    expect(source).toContain('Confirming “Internal transfer” clears the “Possible internal transfer” hint.');
  });
});
