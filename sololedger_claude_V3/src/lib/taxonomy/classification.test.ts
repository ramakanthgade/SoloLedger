import { describe, expect, it } from 'vitest';
import {
  applyClassificationEvidence,
  canResetClassification,
  CLASSIFICATION_AUTOMATION_THRESHOLD,
  classificationBaselineEvidence,
  confirmClassification,
  mayAutoApply,
  rejectClassificationSuggestion,
  resetClassification,
  userClassificationPatch
} from './classification';
import type { ClassificationEvidence, Transaction } from '@/types/transaction';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx', timestamp: 1, type: 'transfer_in', asset: 'USDC', amount: 1,
    fiatCurrency: 'USD', source: 'fixture', flags: [], isInternalTransfer: false,
    ...overrides
  };
}

function evidence(overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence {
  return {
    type: 'income', category: 'reward', origin: 'rule', confidence: 0.9,
    ruleId: 'reward-registry:exact', ruleVersion: 'b5.1', observedAt: 10,
    allowlisted: true, explanation: 'fixture', ...overrides
  };
}

describe('classification resolver', () => {
  it('pins the inclusive 0.90 threshold and keeps 0.8999 as a suggestion', () => {
    expect(CLASSIFICATION_AUTOMATION_THRESHOLD).toBe(0.9);
    expect(mayAutoApply(evidence({ confidence: 0.8999 }))).toBe(false);
    expect(mayAutoApply(evidence({ confidence: 0.9 }))).toBe(true);
    expect(mayAutoApply(evidence({ confidence: Number.NaN }))).toBe(false);
    expect(mayAutoApply(evidence({ confidence: 1.0001 }))).toBe(false);
  });

  it('never auto-applies a non-allowlisted deterministic rule', () => {
    expect(mayAutoApply(evidence({ ruleId: 'unknown', allowlisted: true }))).toBe(false);
    expect(applyClassificationEvidence(tx(), [evidence({ ruleId: 'unknown' })], 20).type).toBe('transfer_in');
  });

  it('requires an approved rule id and version pair', () => {
    const staleEvidence = evidence({ ruleVersion: 'b4.9' });
    expect(mayAutoApply(staleEvidence)).toBe(false);
    const resolved = applyClassificationEvidence(tx(), [staleEvidence], 20);
    expect(resolved.type).toBe('transfer_in');
    expect(resolved.category).toBeUndefined();
    expect(resolved.categoryOrigin).toBeUndefined();
    expect(resolved.classificationEvidence).toContainEqual(staleEvidence);
  });

  it('uses exact parser/provider evidence before deterministic rules', () => {
    const resolved = applyClassificationEvidence(tx(), [
      evidence({ category: 'reward', observedAt: 30 }),
      evidence({ origin: 'provider', ruleId: 'provider:exact', category: 'airdrop', confidence: 1, observedAt: 5 })
    ], 40);
    expect(resolved).toMatchObject({ type: 'income', category: 'airdrop', categoryOrigin: 'provider', categoryConfidence: 1 });
  });

  it('preserves a user lock across reimport and reset reapplies retained exact evidence', () => {
    const automatic = applyClassificationEvidence(tx(), [evidence({ category: 'staking_reward', confidence: 1 })], 20);
    const user = { ...automatic, ...userClassificationPatch(automatic, 'income', 'salary', 30) };
    const reimported = applyClassificationEvidence(user, [evidence({ category: 'airdrop', confidence: 1, observedAt: 40 })], 40);
    expect(reimported).toMatchObject({ category: 'salary', categoryOrigin: 'user', categoryLocked: true });
    expect(resetClassification(reimported, 50)).toMatchObject({
      category: 'airdrop', categoryOrigin: 'rule', categoryLocked: false,
      categoryRuleId: 'reward-registry:exact', categoryUpdatedAt: 50
    });
  });

  it('keeps structural type and semantic category as separate compatible axes', () => {
    expect(() => userClassificationPatch(tx({ type: 'sell' }), 'sell', 'staking_reward')).toThrow(/not compatible/);
    expect(userClassificationPatch(tx(), 'transfer_in', 'loan')).toMatchObject({ type: 'transfer_in', category: 'loan' });
  });

  it('retains a parser baseline on the first user edit and only enables reset when a baseline exists', () => {
    const parser = tx({
      type: 'income', category: 'airdrop', categoryOrigin: 'parser', categoryConfidence: 1,
      categoryRuleId: 'parser:airdrop', categoryRuleVersion: '1', categoryUpdatedAt: 5
    });
    const edited = { ...parser, ...userClassificationPatch(parser, 'income', 'salary', 10) };
    expect(canResetClassification(edited)).toBe(true);
    expect(resetClassification(edited, 20)).toMatchObject({
      type: 'income', category: 'airdrop', categoryOrigin: 'parser', categoryRuleId: 'parser:airdrop', categoryLocked: false
    });
    const manual = tx({ category: 'other', categoryOrigin: 'user', categoryLocked: true });
    expect(canResetClassification(manual)).toBe(false);
    expect(resetClassification(manual)).toEqual(manual);
  });

  it('captures a structural-only legacy baseline before a suggestion mutates a fresh row', () => {
    expect(classificationBaselineEvidence(tx(), 10)).toContainEqual(expect.objectContaining({
      type: 'transfer_in', category: undefined, origin: 'legacy', confidence: 0,
      ruleId: 'legacy:stored-baseline', ruleVersion: '1', observedAt: 10
    }));
  });

  it('durably confirms or rejects a suggestion even when displayed values do not change', () => {
    const suggested = tx({
      type: 'income', category: 'defi_reward', categoryOrigin: 'suggestion', categoryLocked: false,
      flags: ['needs_review'],
      classificationEvidence: [
        evidence({ type: 'transfer_in', category: 'other', origin: 'legacy', confidence: 0, ruleId: 'legacy:stored' }),
        evidence({ origin: 'suggestion', confidence: 0.7, ruleId: 'defillama:reward-token', category: 'defi_reward' })
      ]
    });
    expect(confirmClassification(suggested, 20)).toMatchObject({
      type: 'income', category: 'defi_reward', categoryOrigin: 'user', categoryLocked: true, flags: []
    });
    expect(rejectClassificationSuggestion(suggested, 20)).toMatchObject({
      type: 'transfer_in', category: 'other', categoryOrigin: 'user', categoryLocked: true, flags: []
    });
  });
});
