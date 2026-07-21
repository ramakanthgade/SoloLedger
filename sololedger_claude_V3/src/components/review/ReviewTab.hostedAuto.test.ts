import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * ReviewTab wiring guards for the 2026-07-21 hosted-automation round,
 * grep-based for the same reason as ReviewTab.uxRound3.test.ts: a full
 * ReviewTab render never settles under jsdom. The pure logic lives in
 * src/lib/review/hostedAuto.ts (unit-tested in its own suite).
 */
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'ReviewTab.tsx'),
  'utf8'
);

describe('ReviewTab — hosted token-name auto-resolution', () => {
  it('auto-resolves via the guarded hosted effect', () => {
    expect(source).toContain('shouldAutoResolveTokenNames');
    expect(source).toContain('markTokenResolveAutoRun');
    expect(source).toContain('void resolveTokenSymbols()');
  });

  it('renders the manual banner only outside hosted mode', () => {
    expect(source).toContain('showTokenResolveBanner(hosted, unresolvedSymbolTxs.length)');
  });
});

describe('ReviewTab — DefiLlama auto-check for hosted', () => {
  it('keeps the guarded auto-run (effective price lookup) intact', () => {
    expect(source).toContain('shouldAutoRunLlamaSuggestions');
    expect(source).toContain('markLlamaAutoRun');
    expect(source).toContain('void suggestRewardIncome()');
  });

  it('renders the manual banner only outside hosted mode', () => {
    expect(source).toContain('showLlamaBanner(hosted, solanaTransferInCount)');
  });

  it('shows the result line in hosted mode only when rows were flagged', () => {
    expect(source).toContain('showLlamaResultMessage(hosted, llamaMsg, llamaSuggested)');
  });
});

describe('ReviewTab — DCA hosted auto-classify + repair', () => {
  it('detects on the unfiltered transaction set (parity with importJob)', () => {
    expect(source).toContain('setDcaGroups(detectDcaGroups(transactions))');
  });

  it('runs the one-time repair before hosted auto-apply', () => {
    expect(source).toContain('repairDcaMisclassifications');
    expect(source).toContain('shouldRunDcaRepair(hosted)');
    expect(source).toContain('markDcaRepairDone()');
  });

  it('auto-applies with the signature loop-guard', () => {
    expect(source).toContain('shouldAutoApplyDca');
    expect(source).toContain('dcaGroupSignature(dcaGroups)');
    expect(source).toContain('lastDcaAttemptRef');
  });

  it('renders the manual banner only outside hosted mode', () => {
    expect(source).toContain('showDcaBanner(hosted, dcaGroups.length)');
  });

  it('never references other crypto-tax apps by name in user-facing copy', () => {
    expect(source).not.toMatch(/koinly|koinx|cointracker|coinledger|cointracking|tokentax|zenledger|accointing|coinpanda/i);
    expect(source).toContain('Recommended approach:');
  });

  it('dropped the old once-per-session auto-apply guard', () => {
    expect(source).not.toContain('sololedger_review_dca_auto_v1');
  });
});
