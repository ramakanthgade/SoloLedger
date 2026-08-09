import { describe, expect, it } from 'vitest';
import {
  automaticDecisionsRespectingPrecedence,
  backfillExactAssetSafetyRows,
  materializeImportedTransactionSafety,
  prepareTransactionSafetyPolicy,
  resolveAssetSafety,
  resolveTransactionSafetyPolicy,
  transactionsUnderCurrentSafetyPolicy
} from './assetSafety';
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

  it('trusts the production Ethereum contracts exactly despite automatic spam, while user-hidden still wins', () => {
    const contracts = [
      ['AWBTC', '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8'],
      ['AUSDC', '0xbcca60bb61934080951369a648fb03df4f96263c'],
      ['ZRO', '0x6985884c4392d348587b19cb9eaaf157f13271cd'],
      ['BUSD', '0x4fabb145d64652a948d72533023f6e7a623c7c53']
    ] as const;
    for (const [, contract] of contracts) {
      const exactSubject = assetSubjectKey('ethereum', contract);
      const automatic = evidence({ subjectKey: exactSubject });
      expect(resolveAssetSafety({
        subjectKey: exactSubject, chain: '0x1', contractAddress: contract.toUpperCase(), evidence: [automatic]
      }).state).toBe('trusted');
      expect(resolveAssetSafety({
        subjectKey: exactSubject, chain: 'ethereum', contractAddress: contract, evidence: [automatic],
        decision: { subjectKey: exactSubject, state: 'user_hidden', updatedAt: 20, origin: 'user' }
      }).state).toBe('user_hidden');
      expect(resolveAssetSafety({
        subjectKey: assetSubjectKey('ethereum', `${contract.slice(0, -1)}0`), chain: 'ethereum',
        contractAddress: `${contract.slice(0, -1)}0`
      }).state).toBe('unverified');
    }
    expect(contracts.map(([symbol]) => symbol)).toEqual(['AWBTC', 'AUSDC', 'ZRO', 'BUSD']);
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
    expect(result.transactions.map((row) => row.safetyState)).toEqual(['high_confidence_spam', 'high_confidence_spam']);
    expect(result.providerEvidence).toHaveLength(3);
    expect(result.automaticDecisions.map((row) => row.subjectKey)).toEqual([
      expect.stringMatching(/^event:ethereum:/),
      assetSubjectKey('ethereum', '0x1111111111111111111111111111111111111111')
    ]);
    expect(result.providerEvidence.find((row) => row.subjectKind === 'asset')).toMatchObject({
      subjectKey: assetSubjectKey('ethereum', '0x1111111111111111111111111111111111111111'),
      ruleId: 'possible_spam'
    });
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
    expect(metrics).toEqual({ evidenceIndexVisits: 10_000, transactionEvidenceLookups: 5_000 });
  });

  it('does not let refreshed automatic evidence overwrite user or trusted decisions', () => {
    const automatic: SafetyDecisionRow[] = [
      { subjectKey: 'asset:ethereum:0x1', state: 'high_confidence_spam', updatedAt: 2, origin: 'automatic' },
      { subjectKey: 'asset:ethereum:0x2', state: 'high_confidence_spam', updatedAt: 2, origin: 'automatic' },
      { subjectKey: 'asset:ethereum:0x3', state: 'high_confidence_spam', updatedAt: 2, origin: 'automatic' }
    ];
    expect(automaticDecisionsRespectingPrecedence(automatic, [
      { subjectKey: automatic[0].subjectKey, state: 'user_visible', updatedAt: 1, origin: 'user' },
      { subjectKey: automatic[1].subjectKey, state: 'trusted', updatedAt: 1, origin: 'automatic' },
      undefined
    ])).toEqual([automatic[2]]);
  });

  it('applies prior exact event and asset decisions to persisted state during reimport', () => {
    const row = transaction(20);
    const assetKey = assetSubjectKey(row.chain!, row.contractAddress);
    const visible = materializeImportedTransactionSafety([row], undefined, [{
      subjectKey: assetKey, state: 'user_visible', updatedAt: 19, origin: 'user',
      previousAutomaticState: 'high_confidence_spam'
    }]);
    expect(visible.transactions[0]).toMatchObject({ safetyState: 'user_visible', isSpam: false });
    expect(visible.automaticDecisions).toEqual([]);

    const hidden = materializeImportedTransactionSafety([row], undefined, [{
      subjectKey: row.safetySubjectKey!, state: 'user_hidden', updatedAt: 19, origin: 'user'
    }]);
    expect(hidden.transactions[0]).toMatchObject({ safetyState: 'user_hidden', isSpam: true });

    const trusted = materializeImportedTransactionSafety([row], undefined, [{
      subjectKey: assetKey, state: 'trusted', updatedAt: 19, origin: 'automatic'
    }]);
    expect(trusted.transactions[0]).toMatchObject({ safetyState: 'trusted', isSpam: false });
  });

  it('applies exact-contract policy without symbol scope and preserves an explicit event hide', () => {
    const flagged = transaction(30);
    const sameContract = { ...transaction(31), asset: 'DIFFERENT' };
    const sameSymbolOtherContract = {
      ...transaction(32),
      contractAddress: '0x2222222222222222222222222222222222222222'
    };
    const assetKey = assetSubjectKey(flagged.chain!, flagged.contractAddress);
    const hidden = transactionsUnderCurrentSafetyPolicy(
      [flagged, sameContract, sameSymbolOtherContract],
      [{ subjectKey: assetKey, state: 'high_confidence_spam', updatedAt: 1, origin: 'automatic' }]
    );
    expect(hidden.slice(0, 2)).toEqual([
      expect.objectContaining({ safetyState: 'high_confidence_spam', isSpam: true }),
      expect.objectContaining({ safetyState: 'high_confidence_spam', isSpam: true })
    ]);
    expect(hidden[2]).not.toMatchObject({ isSpam: true });

    const restored = transactionsUnderCurrentSafetyPolicy([flagged, sameContract], [
      { subjectKey: assetKey, state: 'user_visible', updatedAt: 2, origin: 'user' },
      { subjectKey: sameContract.safetySubjectKey!, state: 'user_hidden', updatedAt: 3, origin: 'user' }
    ]);
    expect(restored[0]).toMatchObject({ safetyState: 'user_visible', isSpam: false });
    expect(restored[1]).toMatchObject({ safetyState: 'user_hidden', isSpam: true });
  });

  it('builds one decision index for a scaled policy pass and preserves resolver parity', () => {
    const rows = Array.from({ length: 4_000 }, (_, index) => ({
      ...transaction(index + 100),
      contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`
    }));
    const decisions: SafetyDecisionRow[] = rows.map((row, index) => ({
      subjectKey: row.safetySubjectKey!,
      state: index % 2 === 0 ? 'user_hidden' : 'user_visible',
      updatedAt: index,
      origin: 'user'
    }));
    const metrics = { decisionIndexBuilds: 0, decisionIndexVisits: 0, transactionResolutions: 0 };
    const result = transactionsUnderCurrentSafetyPolicy(rows, decisions, metrics);

    expect(metrics).toEqual({
      decisionIndexBuilds: 1,
      decisionIndexVisits: decisions.length,
      transactionResolutions: rows.length
    });
    expect(result.filter((row) => row.isSpam)).toHaveLength(2_000);
    expect(result.filter((row) => row.safetyState === 'user_visible')).toHaveLength(2_000);

    const prepared = prepareTransactionSafetyPolicy(decisions);
    for (const row of [rows[0], rows[1], rows[rows.length - 1]]) {
      expect(prepared(row)).toEqual(resolveTransactionSafetyPolicy(row, decisions));
    }
  });

  it('reuses the exact ledger generation when the loaded policy snapshot is empty', () => {
    const rows = Array.from({ length: 30_000 }, (_, index) => transaction(index + 10_000));
    const metrics = { decisionIndexBuilds: 0, decisionIndexVisits: 0, transactionResolutions: 0 };

    const result = transactionsUnderCurrentSafetyPolicy(rows, [], metrics);

    expect(result).toBe(rows);
    expect(metrics).toEqual({
      decisionIndexBuilds: 0,
      decisionIndexVisits: 0,
      transactionResolutions: 0
    });
  });

  it('indexes transactions and exact asset identities once for scaled v17 backfill', () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => ({
      ...transaction(index + 10_000),
      contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      raw: undefined
    }));
    const providerEvidence: ProviderEvidenceRow[] = rows.map((row, index) => ({
      id: `backfill-evidence-${index}`,
      subjectKey: row.safetySubjectKey!,
      subjectKind: 'event',
      provider: 'moralis',
      ruleId: 'possible_spam',
      ruleVersion: '1',
      confidence: 0.95,
      observedAt: index
    }));
    const metrics = {
      transactionIndexVisits: 0,
      evidenceTransactionLookups: 0,
      assetIdentityLookups: 0
    };
    const result = backfillExactAssetSafetyRows({
      transactions: rows,
      providerEvidence,
      decisions: [],
      metrics
    });

    expect(metrics).toEqual({
      transactionIndexVisits: rows.length,
      evidenceTransactionLookups: providerEvidence.length,
      assetIdentityLookups: rows.length
    });
    expect(result.transactions.every((row) => row.isSpam && row.safetyState === 'high_confidence_spam')).toBe(true);
    expect(result.providerEvidence).toHaveLength(providerEvidence.length * 2);
    expect(result.decisions).toHaveLength(rows.length);
    expect(new Set(result.decisions.map((row) => row.subjectKey)).size).toBe(rows.length);
  });
});
