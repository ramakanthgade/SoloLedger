import { describe, expect, it } from 'vitest';
import { derivePostings, type DerivedPosting } from '@/lib/ledger/derivedPostings';
import { preparePostingAggregation } from '@/lib/ledger/postingBalances';
import type { Transaction } from '@/types/transaction';
import type { AuthorityAssetRow, AuthoritySnapshotRow, EndpointProof } from './authoritySelection';
import type { SourceCoverageRow } from './sourceCoverage';
import {
  buildAuthorityBalanceModel,
  type AuthorityBalanceModelInput,
  type AuthorityBalanceModelMetrics
} from './authorityBalanceModel';

const NOW = 1_800_000_000_000;
const proof = (overrides: Partial<EndpointProof> = {}): EndpointProof => ({
  authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot',
  requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true,
  ...overrides
});
const snapshot = (overrides: Partial<AuthoritySnapshotRow> = {}): AuthoritySnapshotRow => ({
  snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', authorityKind: 'api',
  authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
  asOf: NOW, capturedAt: NOW, sourceIdentityId: 'c1', endpointProof: proof(), status: 'complete',
  ...overrides
});
const authorityAsset = (overrides: Partial<AuthorityAssetRow> = {}): AuthorityAssetRow => ({
  id: 'a1', snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', accountClass: 'spot',
  assetKey: 'asset:BTC', asset: 'BTC', quantity: 7, ...overrides
});
const posting = (overrides: Partial<DerivedPosting> = {}): DerivedPosting => ({
  id: 'p1', taxEventId: 't1', accountScopeId: 'exchange:c1', accountClass: 'spot',
  assetKey: 'asset:BTC', asset: 'BTC', signedQuantity: 2, role: 'principal', postingPhase: 10,
  ordinal: 0, effectiveAt: NOW, evidence: [], taxableEffect: 'source_transaction_only', ...overrides
});
const coverage = (overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow => ({
  id: 'c1', generation: 1, scopeId: 'exchange:c1', sourceIdentityId: 'c1', evidenceId: 'e1',
  kind: 'api', accountClasses: ['spot'], endpoints: ['history'], authoritySnapshotId: 's1',
  authorityAsOf: NOW, requestedHistoryStart: 0, requestedHistoryEnd: NOW,
  observedHistoryStart: 0, observedHistoryEnd: NOW, startedAt: 0, completedAt: NOW,
  status: 'complete', paginationExhausted: true,
  endpointOutcomes: [{
    endpoint: 'history', accountClass: 'spot', required: true, status: 'complete',
    requestedStart: 0, requestedEnd: NOW, observedStart: 0, observedEnd: NOW,
    paginationRequired: true, paginationExhausted: true
  }], ...overrides
});
const model = (overrides: Partial<AuthorityBalanceModelInput> = {}) => buildAuthorityBalanceModel({
  postings: [posting()], snapshots: [snapshot()], assets: [authorityAsset()], coverage: [coverage()],
  exchangeConnections: [{ id: 'c1', exchange: 'binance' }], now: NOW, comparisonAt: NOW, ...overrides
});

describe('buildAuthorityBalanceModel', () => {
  it('uses exactly one current coherent generation and includes authority-only assets', () => {
    const newer = snapshot({ snapshotId: 's2', generation: 2 });
    const rows = model({
      snapshots: [snapshot({ asOf: NOW - 1 }), newer],
      assets: [authorityAsset(), authorityAsset({ id: 'a2', snapshotId: 's2', generation: 2, assetKey: 'asset:ETH', asset: 'ETH', quantity: 4 })],
      coverage: [coverage({ id: 'c2', generation: 2, authoritySnapshotId: 's2' })]
    });
    expect(rows).toEqual([
      expect.objectContaining({ assetKey: 'asset:BTC', quantity: 0, selectedGeneration: 2, verificationStatus: 'verified_authority' }),
      expect.objectContaining({ assetKey: 'asset:ETH', quantity: 4, selectedGeneration: 2, verificationStatus: 'verified_authority' })
    ]);
  });

  it('rejects a generation whose asset rows are not coherent with its snapshot', () => {
    expect(model({ assets: [authorityAsset({ generation: 99 })] })[0]).toMatchObject({
      quantity: 2, authorityStatus: 'non_comparable', fallbackReason: 'non_comparable_authority'
    });
  });

  it.each([
    [snapshot({ asOf: NOW - 86_400_001 }), 'stale_authority'],
    [undefined, 'missing_authority'],
    [snapshot({ asOf: undefined }), 'non_comparable_authority']
  ] as const)('falls back for stale, missing, and non-comparable authority', (authority, reason) => {
    expect(model({ snapshots: authority ? [authority] : [], assets: authority ? [authorityAsset()] : [] })[0])
      .toMatchObject({ quantity: 2, postingQuantity: 2, verificationStatus: 'posting_fallback', fallbackReason: reason });
  });

  it('requires exact CSV time equality and complete coverage', () => {
    const csv = snapshot({
      authorityKind: 'csv', authorityClass: 'journal_final_balance', scopeId: 'file:f:spot',
      sourceIdentityId: 'f', endpointProof: proof({ authorityKind: 'csv', operation: 'journal', parametersClass: 'full' })
    });
    const csvAsset = authorityAsset({ scopeId: 'file:f:spot' });
    const csvCoverage = coverage({
      scopeId: 'file:f:spot', sourceIdentityId: 'f', kind: 'csv', parserId: 'other',
      supportedParser: true,
      declaredCompleteHistory: true, requiredSheets: ['journal'], presentSheets: ['journal'],
      recognizedCount: 1, parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 0,
      failedCount: 0, endpointOutcomes: [{
        endpoint: 'history', parserId: 'other', accountClass: 'spot', required: true, status: 'complete'
      }]
    });
    expect(model({ postings: [posting({ accountScopeId: 'file:f:spot' })], snapshots: [csv], assets: [csvAsset], coverage: [csvCoverage] })[0])
      .toMatchObject({ quantity: 7, verificationStatus: 'verified_authority' });
    expect(model({ postings: [posting({ accountScopeId: 'file:f:spot' })], snapshots: [csv], assets: [csvAsset], coverage: [csvCoverage], comparisonAt: NOW + 1 })[0])
      .toMatchObject({ quantity: 2, fallbackReason: 'stale_authority' });
    expect(model({ coverage: [coverage({ status: 'partial' })] })[0])
      .toMatchObject({ quantity: 2, fallbackReason: 'incomplete_coverage' });
  });

  it('uses a structurally complete untimestamped CSV class as a reconstructed, non-current quantity', () => {
    const csv = snapshot({
      authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: undefined,
      scopeId: 'file:f:spot', sourceIdentityId: 'f',
      endpointProof: proof({ authorityKind: 'csv', operation: 'journal', parametersClass: 'untimestamped' })
    });
    const csvAsset = authorityAsset({ scopeId: 'file:f:spot', quantity: 0 });
    const csvCoverage = coverage({
      scopeId: 'file:f:spot', sourceIdentityId: 'f', kind: 'csv', status: 'unknown',
      parserId: 'binance', supportedParser: true, declaredCompleteHistory: undefined,
      requiredSheets: ['journal'], presentSheets: ['journal'], recognizedCount: 1, parsedCount: 1,
      dedupedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
      endpointOutcomes: [{
        endpoint: 'history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete'
      }]
    });
    expect(model({
      postings: [posting({ accountScopeId: 'file:f:spot', signedQuantity: 12 })],
      snapshots: [csv], assets: [csvAsset], coverage: [csvCoverage], exchangeConnections: [],
      comparisonAt: undefined
    })[0]).toMatchObject({
      quantity: 0, postingQuantity: 12, authorityQuantity: 0,
      authorityStatus: 'non_comparable', coverageStatus: 'unknown',
      verificationStatus: 'reconstructed_authority', fallbackReason: 'non_comparable_authority'
    });
  });

  it('never applies an untimestamped reconstructed ending balance to a historical comparison', () => {
    const csv = snapshot({
      authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: undefined,
      scopeId: 'file:f:spot', sourceIdentityId: 'f',
      endpointProof: proof({ authorityKind: 'csv', operation: 'journal', parametersClass: 'untimestamped' })
    });
    const csvCoverage = coverage({
      scopeId: 'file:f:spot', sourceIdentityId: 'f', kind: 'csv', status: 'unknown',
      parserId: 'binance', supportedParser: true, declaredCompleteHistory: undefined,
      requiredSheets: ['journal'], presentSheets: ['journal'], recognizedCount: 1, parsedCount: 1,
      dedupedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
      endpointOutcomes: [{ endpoint: 'history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
    });
    expect(model({
      postings: [posting({ accountScopeId: 'file:f:spot', signedQuantity: 12, effectiveAt: NOW - 10 })],
      snapshots: [csv], assets: [authorityAsset({ scopeId: 'file:f:spot', quantity: 0 })],
      coverage: [csvCoverage], exchangeConnections: [], comparisonAt: NOW - 1
    })[0]).toMatchObject({ quantity: 12, verificationStatus: 'posting_fallback' });
  });

  it.each(['partial', 'failed'] as const)(
    'rejects reconstructed authority when linked CSV coverage is %s',
    (status) => {
      const csv = snapshot({
        authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: undefined,
        scopeId: 'file:f:spot', sourceIdentityId: 'f',
        endpointProof: proof({ authorityKind: 'csv', operation: 'journal', parametersClass: 'untimestamped' })
      });
      const csvCoverage = coverage({
        scopeId: 'file:f:spot', sourceIdentityId: 'f', kind: 'csv', status,
        parserId: 'binance', supportedParser: true, requiredSheets: ['journal'], presentSheets: ['journal'],
        recognizedCount: 2, parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 1,
        failedCount: status === 'failed' ? 1 : 0,
        endpointOutcomes: [{
          endpoint: 'history', parserId: 'binance', accountClass: 'spot', required: true,
          status, skippedCount: 1, exclusionReasons: ['bad row'], failedCount: status === 'failed' ? 1 : undefined
        }]
      });
      expect(model({
        postings: [posting({ accountScopeId: 'file:f:spot', signedQuantity: 12 })], snapshots: [csv],
        assets: [authorityAsset({ scopeId: 'file:f:spot', quantity: 0 })], coverage: [csvCoverage],
        exchangeConnections: [], comparisonAt: undefined
      })[0]).toMatchObject({ quantity: 12, verificationStatus: 'posting_fallback' });
    }
  );

  it('distinguishes exhaustive absence, non-exhaustive absence, and explicit zero', () => {
    const ethPosting = posting({ assetKey: 'asset:ETH', asset: 'ETH' });
    expect(model({ postings: [ethPosting], assets: [] })[0]).toMatchObject({ quantity: 0, authorityQuantity: 0 });
    const nonExhaustive = model({
      postings: [ethPosting],
      snapshots: [snapshot({ endpointProof: proof({ exhaustiveBalances: false }) })],
      assets: [authorityAsset()]
    });
    expect(nonExhaustive.find((row) => row.assetKey === 'asset:ETH'))
      .toMatchObject({ quantity: 2, fallbackReason: 'non_comparable_authority' });
    expect(model({ assets: [authorityAsset({ quantity: 0 })] })[0]).toMatchObject({
      quantity: 0, authorityQuantity: 0, verificationStatus: 'verified_authority'
    });
  });

  it('does not let an exhaustive current zero after FY end erase historical holdings', () => {
    const fyEnd = NOW - 10_000;
    const row = model({
      postings: [posting({ effectiveAt: fyEnd - 1_000, signedQuantity: 5 })],
      snapshots: [snapshot({ asOf: NOW })],
      assets: [],
      comparisonAt: fyEnd
    })[0];

    expect(row).toMatchObject({
      quantity: 5,
      postingQuantity: 5,
      authorityQuantity: 0,
      authorityStatus: 'non_comparable',
      verificationStatus: 'posting_fallback',
      fallbackReason: 'non_comparable_authority'
    });
  });

  it('isolates account classes and never extends Spot proof', () => {
    const funding = posting({ id: 'funding', accountClass: 'funding', signedQuantity: 9 });
    const rows = model({ postings: [posting(), funding] });
    expect(rows.find((row) => row.accountClass === 'spot')).toMatchObject({ quantity: 7 });
    expect(rows.find((row) => row.accountClass === 'funding')).toMatchObject({
      quantity: 9, fallbackReason: 'missing_authority'
    });
  });

  it('keeps posting-only manual and unresolved scopes explicit', () => {
    const rows = model({
      postings: [
        posting({ id: 'manual', accountScopeId: 'manual', accountClass: 'manual' }),
        posting({ id: 'unknown', accountScopeId: 'unresolved:t2', accountClass: 'unknown' })
      ], snapshots: [], assets: [], coverage: []
    });
    expect(rows[0]).toMatchObject({ scopeId: 'manual', quantity: 2, fallbackReason: 'missing_authority' });
    expect(rows[1]).toMatchObject({ scopeId: 'unresolved:t2', quantity: 2, scopeStatus: 'unresolved', fallbackReason: 'unresolved_scope' });
  });

  it('preserves wallet contract identity and Base58 case', () => {
    const walletProof = proof({
      authorityKind: 'rpc', requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], parametersClass: 'wallet'
    });
    const walletTransaction: Transaction = {
      id: 'wallet-tx', timestamp: NOW, type: 'transfer_in', asset: 'TOKEN', amount: 2,
      fiatCurrency: 'USD', source: 'rpc:helius', flags: [], isInternalTransfer: false,
      chain: 'solana', walletAddress: 'AbCDef', contractAddress: 'MintAbCdEf'
    };
    const [walletPosting] = derivePostings([walletTransaction], { exchangeConnections: [] });
    const scope = 'wallet:solana:solana:AbCDef';
    const contractKey = 'solana:MintAbCdEf';
    const walletSnapshot = snapshot({
      scopeId: scope, authorityKind: 'rpc', authorityClass: 'wallet_balance', accountClass: 'wallet',
      coveredAccountClasses: ['wallet'], endpointProof: walletProof
    });
    const row = model({
      postings: [walletPosting],
      snapshots: [walletSnapshot], assets: [authorityAsset({ scopeId: scope, accountClass: 'wallet', assetKey: contractKey, asset: 'TOKEN' })],
      coverage: [coverage({
        scopeId: scope, accountClasses: ['wallet'], kind: 'rpc', endpointOutcomes: [{
          endpoint: 'history', accountClass: 'wallet', required: true, status: 'complete', requestedStart: 0,
          requestedEnd: NOW, observedStart: 0, observedEnd: NOW, paginationRequired: true, paginationExhausted: true
        }]
      })], exchangeConnections: []
    })[0];
    expect(row).toMatchObject({ scopeId: scope, assetKey: contractKey, quantity: 7 });
  });

  it('associates exact ordinary Binance CSV authority only for one live connection', () => {
    const csv = snapshot({
      scopeId: 'file:f:spot', authorityKind: 'csv', authorityClass: 'journal_final_balance', sourceIdentityId: 'f',
      endpointProof: proof({ authorityKind: 'csv', operation: 'journal' })
    });
    const csvCoverage = coverage({
      scopeId: 'file:f:spot', sourceIdentityId: 'f', kind: 'csv', parserId: 'binance', declaredCompleteHistory: true,
      supportedParser: true,
      requiredSheets: ['spot'], presentSheets: ['spot'], recognizedCount: 1, parsedCount: 1, dedupedCount: 0,
      excludedCount: 0, skippedCount: 0, failedCount: 0, endpointOutcomes: [{
        endpoint: 'history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete'
      }]
    });
    const one = model({
      postings: [posting({ accountScopeId: 'exchange:live' })], snapshots: [csv],
      assets: [authorityAsset({ scopeId: 'file:f:spot' })], coverage: [csvCoverage],
      exchangeConnections: [{ id: 'live', exchange: 'binance' }]
    });
    expect(one[0]).toMatchObject({ scopeId: 'exchange:live', quantity: 7, verificationStatus: 'verified_authority' });
    const wrongLink = model({
      postings: [posting({ accountScopeId: 'exchange:live' })], snapshots: [csv],
      assets: [authorityAsset({ scopeId: 'file:f:spot' })],
      coverage: [{ ...csvCoverage, id: 'wrong-link', authoritySnapshotId: 'some-other-snapshot' }],
      exchangeConnections: [{ id: 'live', exchange: 'binance' }]
    });
    expect(wrongLink).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: 'exchange:live', quantity: 2, fallbackReason: 'missing_authority' }),
      expect.objectContaining({ scopeId: 'file:f:spot', selectedSnapshotId: 's1', fallbackReason: 'incomplete_coverage' })
    ]));
    const ambiguous = model({
      postings: [], snapshots: [csv], assets: [authorityAsset({ scopeId: 'file:f:spot' })], coverage: [csvCoverage],
      exchangeConnections: [{ id: 'one', exchange: 'binance' }, { id: 'two', exchange: 'binance' }]
    });
    expect(ambiguous[0]).toMatchObject({ scopeId: 'file:f:spot', scopeStatus: 'unresolved', fallbackReason: 'unresolved_scope' });
  });

  it('keeps Binance Options CSV authority file-scoped', () => {
    const optionsProof = proof({
      authorityKind: 'csv', requestedAccountClasses: ['options'], provenAccountClasses: ['options']
    });
    const optionsSnapshot = snapshot({
      scopeId: 'file:f:options', authorityKind: 'csv', authorityClass: 'journal_final_balance', accountClass: 'options',
      coveredAccountClasses: ['options'], endpointProof: optionsProof, asOf: undefined
    });
    const optionsCoverage = coverage({
      scopeId: 'file:f:options', kind: 'csv', accountClasses: ['options'], parserId: 'binance_options',
      supportedParser: true,
      declaredCompleteHistory: true, requiredSheets: ['options'], presentSheets: ['options'], recognizedCount: 1,
      parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
      endpointOutcomes: [{ endpoint: 'history', parserId: 'binance_options', accountClass: 'options', required: true, status: 'complete' }]
    });
    expect(model({
      postings: [posting({ accountScopeId: 'file:f:options', accountClass: 'options' })], snapshots: [optionsSnapshot],
      assets: [authorityAsset({ scopeId: 'file:f:options', accountClass: 'options' })], coverage: [optionsCoverage],
      comparisonAt: undefined
    })[0]).toMatchObject({
      scopeId: 'file:f:options', quantity: 7, authorityStatus: 'non_comparable',
      verificationStatus: 'reconstructed_authority'
    });

    const combined = model({
      postings: [
        posting({ accountScopeId: 'exchange:c1', accountClass: 'spot', assetKey: 'asset:USDT', asset: 'USDT' }),
        posting({ id: 'options-posting', accountScopeId: 'file:f:options', accountClass: 'options', assetKey: 'asset:USDT', asset: 'USDT' })
      ],
      snapshots: [snapshot(), { ...optionsSnapshot, snapshotId: 'options-snapshot' }],
      assets: [
        authorityAsset({ assetKey: 'asset:USDT', asset: 'USDT', quantity: 5 }),
        authorityAsset({
          id: 'options-usdt', snapshotId: 'options-snapshot', scopeId: 'file:f:options',
          accountClass: 'options', assetKey: 'asset:USDT', asset: 'USDT', quantity: 119.5193
        })
      ],
      coverage: [coverage(), { ...optionsCoverage, id: 'options-coverage', authoritySnapshotId: 'options-snapshot' }],
      comparisonAt: undefined
    });
    expect(combined).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: 'exchange:c1', accountClass: 'spot', quantity: 5, verificationStatus: 'verified_authority' }),
      expect.objectContaining({ scopeId: 'file:f:options', accountClass: 'options', quantity: 119.5193, verificationStatus: 'reconstructed_authority' })
    ]));
  });

  it('indexes thousands of adversarial scopes with linear posting visits', () => {
    const count = 6_000;
    const postings = Array.from({ length: count }, (_, index) => {
      const id = index.toString().padStart(5, '0');
      const accountClass = index % 3 === 0 ? 'unknown' : 'manual';
      const accountScopeId = index % 3 === 0
        ? `unresolved:${id}`
        : index % 3 === 1 ? `file:${id}:manual` : `manual:${id}`;
      return posting({
        id: `p-${id}`, taxEventId: `t-${id}`, accountScopeId, accountClass,
        effectiveAt: NOW - count + index
      });
    });
    const metrics: AuthorityBalanceModelMetrics = {
      postingIndexVisits: 0,
      postingBalanceVisits: 0,
      scopedPostingVisits: 0,
      coverageIndexVisits: 0,
      authorityIndexVisits: 0,
      authorityAssetIndexVisits: 0
    };

    const rows = model({
      postings, snapshots: [], assets: [], coverage: [], exchangeConnections: [], metrics
    });

    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((row) => row.scopeId))).toHaveLength(count);
    expect(metrics).toEqual({
      postingIndexVisits: count,
      postingBalanceVisits: count,
      scopedPostingVisits: count,
      coverageIndexVisits: 0,
      authorityIndexVisits: 0,
      authorityAssetIndexVisits: 0
    });
  });

  it('reuses prepared postings and retains the existing source identity guard', () => {
    const postings = [posting()];
    const preparedPostings = preparePostingAggregation(postings);

    expect(model({ postings, preparedPostings })).toEqual(model({ postings }));
    expect(() => model({ postings: [...postings], preparedPostings }))
      .toThrow('prepared posting aggregation source mismatch');
  });
});
