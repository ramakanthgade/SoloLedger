import { describe, it, expect } from 'vitest';
import {
  shouldAutoResolveTokenNames,
  markTokenResolveAutoRun,
  showTokenResolveBanner,
  showLlamaBanner,
  showLlamaResultMessage,
  shouldAutoApplyDca,
  dcaGroupSignature,
  showDcaBanner,
  shouldRunDcaRepair,
  markDcaRepairDone,
  TOKEN_RESOLVE_AUTO_SESSION_KEY,
  DCA_REPAIR_DONE_KEY
} from '@/lib/review/hostedAuto';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map
  };
}

describe('token-name auto-resolution gate', () => {
  it('fires once per session in hosted mode when there is work', () => {
    const storage = fakeStorage();
    expect(
      shouldAutoResolveTokenNames({ hosted: true, unresolvedCount: 4, inFlight: false }, storage)
    ).toBe(true);
    markTokenResolveAutoRun(storage);
    expect(
      shouldAutoResolveTokenNames({ hosted: true, unresolvedCount: 4, inFlight: false }, storage)
    ).toBe(false);
    expect(storage.getItem(TOKEN_RESOLVE_AUTO_SESSION_KEY)).toBe('1');
  });

  it('never fires for local/BYOK, with no work, or while one is in flight', () => {
    const storage = fakeStorage();
    expect(shouldAutoResolveTokenNames({ hosted: false, unresolvedCount: 4, inFlight: false }, storage)).toBe(false);
    expect(shouldAutoResolveTokenNames({ hosted: true, unresolvedCount: 0, inFlight: false }, storage)).toBe(false);
    expect(shouldAutoResolveTokenNames({ hosted: true, unresolvedCount: 4, inFlight: true }, storage)).toBe(false);
  });

  it('the manual banner is local/BYOK-only', () => {
    expect(showTokenResolveBanner(true, 4)).toBe(false);
    expect(showTokenResolveBanner(false, 4)).toBe(true);
    expect(showTokenResolveBanner(false, 0)).toBe(false);
  });
});

describe('DefiLlama banner + result visibility', () => {
  it('banner is local/BYOK-only', () => {
    expect(showLlamaBanner(true, 7)).toBe(false);
    expect(showLlamaBanner(false, 7)).toBe(true);
    expect(showLlamaBanner(false, 0)).toBe(false);
  });

  it('hosted sees the result line ONLY when rows were actually flagged', () => {
    expect(showLlamaResultMessage(true, 'DefiLlama: 3 mints checked — no new reward suggestions.', 0)).toBe(false);
    expect(showLlamaResultMessage(true, 'DefiLlama: 3 mints checked — 2 suggested reward incomes flagged for review.', 2)).toBe(true);
    expect(showLlamaResultMessage(true, null, 2)).toBe(false);
    // Local/BYOK always see the outcome (including failures).
    expect(showLlamaResultMessage(false, 'DefiLlama suggestion failed: boom', 0)).toBe(true);
  });
});

describe('DCA auto-apply gate + signature loop-guard', () => {
  const groups = [
    { depositTx: { id: 'dep1' }, unclassifiedFillTxs: [{ id: 'f2' }, { id: 'f1' }] },
    { depositTx: { id: 'dep2' }, unclassifiedFillTxs: [{ id: 'f3' }] }
  ];

  it('signature is deterministic regardless of ordering', () => {
    const shuffled = [
      { depositTx: { id: 'dep2' }, unclassifiedFillTxs: [{ id: 'f3' }] },
      { depositTx: { id: 'dep1' }, unclassifiedFillTxs: [{ id: 'f1' }, { id: 'f2' }] }
    ];
    expect(dcaGroupSignature(groups)).toBe(dcaGroupSignature(shuffled));
  });

  it('signature changes when the underlying rows change', () => {
    const changed = [
      { depositTx: { id: 'dep1' }, unclassifiedFillTxs: [{ id: 'f1' }, { id: 'f2' }, { id: 'f4' }] }
    ];
    expect(dcaGroupSignature(groups)).not.toBe(dcaGroupSignature(changed));
  });

  it('fires for NEW work but never twice for the same rows (skip-path loop guard)', () => {
    const sig = dcaGroupSignature(groups);
    const base = { hosted: true, groupCount: 2, inFlight: false, repairActive: false };
    // First sight of this work → fire.
    expect(shouldAutoApplyDca({ ...base, lastAttemptedSignature: null, currentSignature: sig })).toBe(true);
    // Same rows after a skipped/finished run → do not refire.
    expect(shouldAutoApplyDca({ ...base, lastAttemptedSignature: sig, currentSignature: sig })).toBe(false);
    // New rows (import/sync) → fire again.
    expect(shouldAutoApplyDca({ ...base, lastAttemptedSignature: sig, currentSignature: sig + '|x' })).toBe(true);
  });

  it('never fires for local/BYOK, in-flight, repairing, or no groups', () => {
    const sig = 's';
    expect(shouldAutoApplyDca({ hosted: false, groupCount: 1, inFlight: false, repairActive: false, lastAttemptedSignature: null, currentSignature: sig })).toBe(false);
    expect(shouldAutoApplyDca({ hosted: true, groupCount: 1, inFlight: true, repairActive: false, lastAttemptedSignature: null, currentSignature: sig })).toBe(false);
    expect(shouldAutoApplyDca({ hosted: true, groupCount: 1, inFlight: false, repairActive: true, lastAttemptedSignature: null, currentSignature: sig })).toBe(false);
    expect(shouldAutoApplyDca({ hosted: true, groupCount: 0, inFlight: false, repairActive: false, lastAttemptedSignature: null, currentSignature: '' })).toBe(false);
  });

  it('the manual banner is local/BYOK-only', () => {
    expect(showDcaBanner(true, 1)).toBe(false);
    expect(showDcaBanner(false, 1)).toBe(true);
    expect(showDcaBanner(false, 0)).toBe(false);
  });
});

describe('one-time DCA repair gate', () => {
  it('runs once in hosted mode and only after a real outcome is recorded', () => {
    const storage = fakeStorage();
    expect(shouldRunDcaRepair(true, storage)).toBe(true);
    markDcaRepairDone(storage);
    expect(shouldRunDcaRepair(true, storage)).toBe(false);
    expect(storage.getItem(DCA_REPAIR_DONE_KEY)).toBe('1');
  });

  it('never runs for local/BYOK', () => {
    expect(shouldRunDcaRepair(false, fakeStorage())).toBe(false);
  });
});
