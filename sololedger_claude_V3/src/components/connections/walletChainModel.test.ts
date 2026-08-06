import { describe, expect, it, vi } from 'vitest';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';
import type { ConnectionWorkspaceMetrics } from './connectionWorkspaceModel';
import {
  aggregateWalletTransactionCount,
  aggregateWalletCurrentValue,
  buildWalletChainSummaries,
  prepareWalletChainCollectionEvidence
} from './walletChainModel';

const NOW = 2_000_000;
const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'eth-in', timestamp: 1_500_000, type: 'transfer_in', asset: 'ETH', amount: 2,
    fiatCurrency: 'INR', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: ADDRESS,
    flags: [], isInternalTransfer: false, ...overrides
  };
}

function coverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'coverage-eth', generation: 1, scopeId: `wallet:${canonicalWalletIdentity('ethereum', ADDRESS)}`,
    sourceIdentityId: `ethereum:${ADDRESS}`, evidenceId: 'rpc-import', kind: 'rpc',
    accountClasses: ['wallet'], endpoints: ['asset-transfers'], startedAt: 1_700_000,
    completedAt: 1_800_000, status: 'complete', paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: 'asset-transfers', accountClass: 'wallet', required: true,
      status: 'complete', paginationRequired: true, paginationExhausted: true
    }],
    ...overrides
  };
}

function card(address = ADDRESS, chains = ['ethereum', 'polygon']): ConnectionCardData {
  return {
    id: `wallet:evm:${address}`, kind: 'wallet', lane: 'wallets', iconId: 'metamask',
    iconFallback: 'M', title: 'Main vault', subtitle: '0xaaaa…aaaa · Multi-chain',
    tags: ['Wallet app', `${chains.length} chains`], status: { tone: 'gain', label: 'Watching' },
    metaLine: 'Synced', walletRows: chains.map((chain, index) => ({
      id: `${chain}:${address}`, chain, address, lastSyncedAt: index === 0 ? 1_800_000 : 0, txCount: 99 - index
    }))
  };
}

function authority(chain: string, address: string, balances: Array<{ asset: string; quantity: number }>) {
  const scopeId = `wallet:${canonicalWalletIdentity(chain, address)}`;
  const snapshot: AuthoritySnapshotRow = {
    snapshotId: `snapshot:${chain}:${address}`, generation: 1, scopeId,
    authorityKind: 'rpc', authorityClass: 'wallet_balance', accountClass: 'wallet',
    coveredAccountClasses: ['wallet'], asOf: NOW - 1_000, capturedAt: NOW - 1_000,
    sourceIdentityId: `${chain}:${address}`,
    endpointProof: {
      authorityKind: 'rpc', provider: 'wallet-rpc', operation: 'balances', parametersClass: 'wallet',
      requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
    },
    status: 'complete'
  };
  const assets: AuthorityAssetRow[] = balances.map((balance, index) => ({
    id: `${snapshot.snapshotId}:${index}`, snapshotId: snapshot.snapshotId, generation: 1, scopeId,
    accountClass: 'wallet', assetKey: `asset:${balance.asset}`, asset: balance.asset, quantity: balance.quantity
  }));
  return { snapshot, assets };
}

function evidence(options: {
  card?: ConnectionCardData;
  transactions?: Transaction[];
  authorities?: ReturnType<typeof authority>[];
  coverageRows?: SourceCoverageRow[];
  priceRows?: Array<{ key: string; price: number; fetchedAt: number }>;
  metrics?: ConnectionWorkspaceMetrics;
} = {}) {
  const target = options.card ?? card();
  const authorities = options.authorities ?? [];
  return prepareWalletChainCollectionEvidence({
    transactions: options.transactions ?? [], exchangeConnections: [], openingBalances: [],
    snapshots: authorities.map((row) => row.snapshot), assets: authorities.flatMap((row) => row.assets),
    sourceCoverage: options.coverageRows ?? [], safetyDecisions: [], priceRows: options.priceRows ?? [],
    liveWalletRows: target.walletRows ?? [], settings: { reportingCurrency: 'INR' }, metrics: options.metrics
  });
}

function metrics(): ConnectionWorkspaceMetrics {
  return {
    coverageAssociationVisits: 0, authoritySnapshotIndexVisits: 0, authorityAssetIndexVisits: 0,
    authoritySelectorSnapshotVisits: 0, authoritySelectorAssetVisits: 0, postingAssetIndexVisits: 0,
    openingAssetIndexVisits: 0, authorityLabelIndexVisits: 0
  };
}

describe('wallet chain summaries', () => {
  it('uses exact per-chain activity and current exhaustive authority for value', () => {
    vi.setSystemTime(NOW);
    const target = card();
    const eth = authority('ethereum', ADDRESS, [{ asset: 'ETH', quantity: 2 }]);
    const polygon = authority('polygon', ADDRESS, []);
    const summaries = buildWalletChainSummaries(target, evidence({
      card: target, transactions: [transaction()], authorities: [eth, polygon], coverageRows: [coverage()],
      priceRows: [{ key: 'spot:sym:ETH:INR', price: 250_000, fetchedAt: NOW - 1_000 }]
    }), NOW);

    expect(summaries.map((summary) => summary.transactionCount)).toEqual([1, 0]);
    expect(summaries[0]).toMatchObject({
      lastActivityAt: 1_500_000, coverageStatus: 'complete', coverageAt: 1_800_000, syncAt: 1_800_000,
      currentValue: 500_000, pricedAssetCount: 1, unpricedAssetCount: 0
    });
    expect(summaries[1]).toMatchObject({ currentValue: 0, pricedAssetCount: 0, unpricedAssetCount: 0 });
    vi.useRealTimers();
  });

  it('projects persisted provider reasons and operation timestamps for partial coverage', () => {
    const target = card(ADDRESS, ['optimism']);
    const partial = coverage({
      id: 'coverage-op', sourceIdentityId: `optimism:${ADDRESS}`, scopeId: `wallet:evm:10:${ADDRESS}`,
      status: 'partial', completedAt: NOW - 2 * 60 * 60_000,
      endpointOutcomes: [{
        endpoint: 'asset-transfers', accountClass: 'wallet', required: true,
        status: 'partial', warning: 'RPC rate limit'
      }]
    });
    const [summary] = buildWalletChainSummaries(target, evidence({ card: target, coverageRows: [partial] }), NOW);
    expect(summary).toMatchObject({
      coverageStatus: 'partial', coverageReason: 'RPC rate limit', syncAt: NOW - 2 * 60 * 60_000
    });
  });

  it.each([
    ['never synced', { lastSyncedAt: 0 }],
    ['synced but missing current balance evidence', { lastSyncedAt: 1_800_000 }]
  ])('shows unknown for %s instead of manufacturing zero', (_label, row) => {
    const target = card(ADDRESS, ['polygon']);
    target.walletRows = [{ ...target.walletRows![0], ...row }];
    const [summary] = buildWalletChainSummaries(target, evidence({ card: target }), NOW);
    expect(summary).toMatchObject({ currentValue: null, pricedAssetCount: 0, unpricedAssetCount: 0 });
  });

  it('shows unknown when exhaustive current holdings are wholly unpriced', () => {
    const target = card(ADDRESS, ['ethereum']);
    const current = authority('ethereum', ADDRESS, [{ asset: 'UNKNOWN', quantity: 2 }]);
    const [summary] = buildWalletChainSummaries(target, evidence({
      card: target, authorities: [current], transactions: [transaction({ asset: 'UNKNOWN' })]
    }), NOW);
    expect(summary).toMatchObject({ currentValue: null, pricedAssetCount: 0, unpricedAssetCount: 1 });
  });

  it('preserves unknown in the wallet aggregate instead of coercing it to zero', () => {
    expect(aggregateWalletCurrentValue([
      { row: card().walletRows![0], transactionCount: 1, currentValue: 25, pricedAssetCount: 1, unpricedAssetCount: 0 },
      { row: card().walletRows![1], transactionCount: 0, currentValue: null, pricedAssetCount: 0, unpricedAssetCount: 0 }
    ])).toBeNull();
  });

  it('derives the collapsed wallet count from the same per-chain evidence as the expanded rows', () => {
    const rows = card().walletRows!;
    expect(aggregateWalletTransactionCount([
      { row: rows[0], transactionCount: 702, currentValue: 0, pricedAssetCount: 0, unpricedAssetCount: 0 },
      { row: rows[1], transactionCount: 207, currentValue: 0, pricedAssetCount: 0, unpricedAssetCount: 0 }
    ])).toBe(909);
  });

  it('indexes all transactions once even when multiple wallet cards are expanded', () => {
    const secondAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const first = card(ADDRESS, ['ethereum']);
    const second = card(secondAddress, ['ethereum']);
    const counter = metrics();
    const shared = prepareWalletChainCollectionEvidence({
      transactions: [transaction(), transaction({ id: 'second', walletAddress: secondAddress })],
      exchangeConnections: [], openingBalances: [], snapshots: [], assets: [], sourceCoverage: [],
      safetyDecisions: [], priceRows: [], liveWalletRows: [...first.walletRows!, ...second.walletRows!],
      settings: { reportingCurrency: 'INR' }, metrics: counter
    });

    buildWalletChainSummaries(first, shared, NOW);
    buildWalletChainSummaries(second, shared, NOW);
    expect(counter.attributionResolutionVisits).toBe(2);
    expect(shared.collectionIndex.transactionIdsByWallet.size).toBe(2);
  });
});
