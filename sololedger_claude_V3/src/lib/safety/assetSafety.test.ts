import { describe, expect, it } from 'vitest';
import { materializeImportedTransactionSafety, resolveAssetSafety } from './assetSafety';
import { assetSubjectKey } from './canonicalAssets';
import type { ProviderEvidenceRow, SafetyDecisionRow } from './types';
import type { Transaction } from '@/types/transaction';

const subjectKey = assetSubjectKey('ethereum', '0x1111111111111111111111111111111111111111');
function evidence(over: Partial<ProviderEvidenceRow> = {}): ProviderEvidenceRow {
  return {
    id: 'ev-1', subjectKey, subjectKind: 'asset', provider: 'moralis',
    ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.9, observedAt: 10, ...over
  };
}

describe('five-state asset safety', () => {
  it('pins 0.8999 vs 0.90 and the allowlisted rule version audit', () => {
    expect(resolveAssetSafety({ subjectKey, evidence: [evidence({ confidence: 0.8999 })] }).state)
      .toBe('unverified');
    expect(resolveAssetSafety({ subjectKey, evidence: [evidence()] })).toMatchObject({
      state: 'high_confidence_spam', excluded: true,
      automaticEvidence: { provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.9 }
    });
    expect(resolveAssetSafety({ subjectKey, evidence: [evidence({ ruleVersion: '2' })] }).state)
      .toBe('unverified');
  });

  it('applies user > exact trusted > automatic spam > unverified precedence', () => {
    const spam = [evidence()];
    expect(resolveAssetSafety({ subjectKey, chain: 'ethereum', contractAddress: '0x1111111111111111111111111111111111111111', evidence: spam }).state)
      .toBe('high_confidence_spam');
    expect(resolveAssetSafety({
      subjectKey: assetSubjectKey('ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
      chain: 'ethereum', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      evidence: [evidence({ subjectKey: assetSubjectKey('ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') })]
    }).state).toBe('trusted');
    const decision = (state: 'user_hidden' | 'user_visible'): SafetyDecisionRow => ({
      subjectKey, state, updatedAt: 20, origin: 'user'
    });
    expect(resolveAssetSafety({ subjectKey, evidence: spam, decision: decision('user_hidden') }).state).toBe('user_hidden');
    expect(resolveAssetSafety({ subjectKey, evidence: spam, decision: decision('user_visible') })).toMatchObject({
      state: 'user_visible', excluded: false
    });
  });

  it('never trusts a same-symbol or Unicode lookalike contract', () => {
    expect(resolveAssetSafety({
      subjectKey, chain: 'ethereum', contractAddress: '0x1111111111111111111111111111111111111111'
    })).toMatchObject({ state: 'unverified', warned: true, exactContractPriceOnly: true });
  });
});

describe('import safety materialization', () => {
  function transaction(index: number, ruleVersion = '1'): Transaction {
    const eventSubject = `event:ethereum:0x${index.toString(16)}:0x1111111111111111111111111111111111111111:${index}:in`;
    return {
      id: `tx-${index}`, timestamp: index, type: 'transfer_in', asset: 'TOK', amount: 1,
      fiatCurrency: 'USD', source: 'rpc:moralis', isInternalTransfer: false,
      flags: [],
      chain: 'ethereum', txHash: `0x${index.toString(16)}`,
      contractAddress: '0x1111111111111111111111111111111111111111', safetySubjectKey: eventSubject,
      raw: { safetyEvidence: [{
        id: `e-${index}`, provider: 'moralis', ruleId: 'possible_spam', ruleVersion,
        confidence: 0.95, observedAt: index
      }] }
    };
  }

  it('materializes only through the allowlisted resolver and retains revoked-rule evidence', () => {
    const result = materializeImportedTransactionSafety([transaction(1), transaction(2, 'revoked')]);
    expect(result.transactions.map((row) => row.safetyState)).toEqual(['high_confidence_spam', 'unverified']);
    expect(result.providerEvidence).toHaveLength(2);
    expect(result.automaticDecisions).toHaveLength(1);
  });

  it('retains suspicious evidence without suppressing a proved wallet-initiated send', () => {
    const proved = { ...transaction(3), type: 'transfer_out' as const, outboundInitiation: 'wallet_initiated' as const };
    const result = materializeImportedTransactionSafety([proved]);
    expect(result.transactions[0].safetyState).toBe('unverified');
    expect(result.providerEvidence).toHaveLength(1);
    expect(result.automaticDecisions).toEqual([]);
  });

  it('indexes a large evidence fixture once instead of scanning per transaction', () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => transaction(index + 10));
    const metrics = { evidenceIndexVisits: 0, transactionEvidenceLookups: 0 };
    const result = materializeImportedTransactionSafety(rows, metrics);
    expect(result.transactions).toHaveLength(5_000);
    expect(metrics).toEqual({ evidenceIndexVisits: 5_000, transactionEvidenceLookups: 5_000 });
  });
});
