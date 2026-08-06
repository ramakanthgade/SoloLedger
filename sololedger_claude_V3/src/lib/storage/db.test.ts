import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect } from 'vitest';
import {
  clearAllData,
  commitWalletBalanceOperation,
  commitCsvImportGeneration,
  deduplicateTransactions,
  db,
  deleteCsvImportAndTransactions,
  deleteLookupAddressAndTransactions,
  deleteOpeningBalance,
  deleteTransactionsByIds,
  getAuthorityAssetsForSnapshot,
  getAuthoritySnapshotsForScope,
  getSourceCoverageForGeneration,
  getSourceCoverageForScope,
  getSourceCoverageAssociationsForScope,
  listOpeningBalances,
  openingBalanceId,
  reserveAuthorityGeneration,
  reserveWalletBalanceOperation,
  saveAuthorityGeneration,
  saveSourceCoverage,
  selectOpeningBalance,
  transactionExchangeKey,
  filterAlreadyImported,
  transactionSourceKey,
  transactionImportKey,
  updateAccountOwnership,
  updateReciprocalTransferPair,
  updateWalletLabel,
  upsertCsvImport,
  upsertLookupAddress,
  upsertOpeningBalance,
  walletBalanceId
} from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { binanceSpotEndpointProof } from '@/lib/reconcile/authoritySelection';
import { buildCsvImportEvidenceGeneration } from '@/lib/parsers/importEvidence';
import { binanceOptionsParser } from '@/lib/parsers/binanceOptions';

describe('transactionExchangeKey', () => {
  it('builds an exchange key for recognised exchange sources with a sourceRef', () => {
    expect(transactionExchangeKey({ source: 'binance', sourceRef: 'abc123' })).toBe('ex:abc123');
    expect(transactionExchangeKey({ source: 'coinbase', sourceRef: 'ref-9' })).toBe('ex:ref-9');
    expect(transactionExchangeKey({ source: 'wazirx-spot', sourceRef: 'w1' })).toBe('ex:w1');
  });

  it('builds an exchange key for the newer exchange CSV parser sources', () => {
    const sources = ['kraken', 'kucoin', 'cryptocom', 'bybit', 'okx', 'gateio', 'bitfinex', 'gemini', 'htx', 'coinspot'];
    for (const source of sources) {
      expect(transactionExchangeKey({ source, sourceRef: 'row-1' })).toBe('ex:row-1');
    }
  });

  it('returns null when there is no sourceRef', () => {
    expect(transactionExchangeKey({ source: 'binance', sourceRef: undefined })).toBeNull();
  });

  it('returns null for non-exchange sources', () => {
    expect(transactionExchangeKey({ source: 'ethereum', sourceRef: 'x' })).toBeNull();
  });
});

describe('transactionSourceKey', () => {
  it('joins lowercased wallet, sourceRef and asset key', () => {
    const key = transactionSourceKey({
      sourceRef: '0xHASH',
      walletAddress: '0xABC',
      asset: 'eth',
      contractAddress: undefined
    });
    expect(key).toBe('0xabc|0xHASH|ETH');
  });

  it('prefers the contract address over the display symbol', () => {
    const key = transactionSourceKey({
      sourceRef: 'sig',
      walletAddress: '0xWallet',
      asset: 'USDC',
      contractAddress: '0xTokenContract'
    });
    expect(key).toBe('0xwallet|sig|0xtokencontract');
  });

  it('returns null without a wallet address', () => {
    expect(
      transactionSourceKey({
        sourceRef: 'sig',
        walletAddress: undefined,
        asset: 'ETH',
        contractAddress: undefined
      })
    ).toBeNull();
  });

  it('preserves Base58 wallet/mint case while folding EVM wallet/contract identity', () => {
    expect(transactionSourceKey({
      sourceRef: 'sig', walletAddress: 'Base58Case', chain: 'solana',
      asset: 'TOKEN', contractAddress: 'MintCase'
    })).toBe('Base58Case|sig|solana:MintCase');
    expect(transactionSourceKey({
      sourceRef: 'sig', walletAddress: '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', chain: 'ethereum',
      asset: 'USDC', contractAddress: '0x00000000000000000000000000000000000000AA'
    })).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|sig|evm:1:0x00000000000000000000000000000000000000aa');
  });
});

describe('transactionImportKey', () => {
  it('includes a precision-stable amount (4dp for amounts >= 1)', () => {
    const key = transactionImportKey({
      sourceRef: 'sig',
      walletAddress: '0xWallet',
      asset: 'ETH',
      amount: 1.23456,
      contractAddress: undefined
    });
    // 4dp tier (reconciled with exchangeSourceRef/stableAmountKey) so a
    // re-import produces the same key regardless of import path.
    expect(key).toBe('sig|0xwallet|ETH|1.2346');
  });

  it('returns null when required fields are missing', () => {
    expect(
      transactionImportKey({
        sourceRef: undefined,
        walletAddress: '0xWallet',
        asset: 'ETH',
        amount: 1,
        contractAddress: undefined
      })
    ).toBeNull();
  });
});

describe('v11 authority persistence', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('retains distinct same-contract events in one transaction and rejects exact event re-imports', async () => {
    const base = manualTransaction('event-1', 100);
    Object.assign(base, {
      source: 'rpc:alchemy', sourceRef: 'alchemy:event:log:1', txHash: '0xtransaction',
      chain: 'ethereum', walletAddress: '0x1111111111111111111111111111111111111111',
      contractAddress: '0x2222222222222222222222222222222222222222', asset: 'TOKEN'
    });
    const sibling = { ...base, id: 'event-2', sourceRef: 'alchemy:event:log:2' };
    await db.transactions.bulkPut([base, sibling]);

    expect(await deduplicateTransactions()).toBe(0);
    expect(await db.transactions.count()).toBe(2);
    expect(await filterAlreadyImported([
      { ...base, id: 'event-1-reimport' },
      { ...base, id: 'event-3', sourceRef: 'alchemy:event:log:3' }
    ])).toEqual([expect.objectContaining({ id: 'event-3' })]);
  });

  it('reserves monotonic source generations and atomically saves immutable coherent rows', async () => {
    await db.exchangeConnections.put({
      id: 'source-1', exchange: 'binance', apiKey: 'k', secret: 's', credentialsState: 'ready',
      authorityGeneration: 0, revision: 0, createdAt: 1, cursors: {}, status: 'idle'
    });
    expect(await reserveAuthorityGeneration('source-1')).toBe(1);
    expect(await reserveAuthorityGeneration('source-1')).toBe(2);
    expect(await db.exchangeConnections.get('source-1')).toMatchObject({ authorityGeneration: 2, revision: 2 });

    const snapshot = {
      snapshotId: 'snapshot-2', generation: 2, scopeId: 'exchange:source-1', authorityKind: 'api' as const,
      authorityClass: 'exchange_balance' as const, accountClass: 'spot' as const,
      coveredAccountClasses: ['spot' as const], asOf: 100, capturedAt: 101, sourceIdentityId: 'source-1',
      endpointProof: binanceSpotEndpointProof(), status: 'complete' as const
    };
    const assets = [{
      id: 'snapshot-2:BTC', snapshotId: 'snapshot-2', generation: 2, scopeId: 'exchange:source-1',
      accountClass: 'spot' as const, assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    }];
    await saveAuthorityGeneration(snapshot, assets);
    expect(await getAuthoritySnapshotsForScope('exchange:source-1', 'spot')).toEqual([snapshot]);
    expect(await getAuthorityAssetsForSnapshot('snapshot-2')).toEqual(assets);
    await expect(saveAuthorityGeneration(snapshot, assets)).rejects.toThrow('immutable');
    expect(await db.authoritySnapshots.count()).toBe(1);
    expect(await db.authorityAssets.count()).toBe(1);
  });

  it('CAS-guards exact wallet identity and rejects an older in-flight generation', async () => {
    const address = '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA';
    await db.lookupAddresses.put({
      id: `ethereum:${address}`, chain: 'ethereum', address, lastSyncedAt: 1, txCount: 0,
      authorityGeneration: 0, revision: 0
    });
    const first = await reserveWalletBalanceOperation('ethereum', address, 10);
    const newer = await reserveWalletBalanceOperation('ethereum', address, 20);
    const endpointOutcomes = [{
      endpoint: 'ethereum:wallet:evm:1:native:eth_getBalance',
      accountClass: 'wallet' as const, required: true, status: 'complete' as const
    }];
    expect(await commitWalletBalanceOperation({
      operation: first, rows: [{ asset: 'ETH', amount: 1 }], provider: 'alchemy',
      operationName: 'eth_getBalance', endpointOutcomes, status: 'complete', asOf: 30, capturedAt: 30
    })).toBe(false);
    expect(await commitWalletBalanceOperation({
      operation: newer, rows: [{ asset: 'ETH', amount: 2 }], provider: 'alchemy',
      operationName: 'eth_getBalance', endpointOutcomes, status: 'complete', asOf: 30, capturedAt: 30
    })).toBe(true);
    expect(await db.walletBalances.toArray()).toEqual([
      expect.objectContaining({ chain: 'ethereum', address: address.toLowerCase(), amount: 2 })
    ]);
    expect(await db.lookupAddresses.get(`ethereum:${address}`)).toMatchObject({
      authorityGeneration: 2, revision: 3
    });
    await expect(reserveWalletBalanceOperation('ethereum', address.toLowerCase(), 40))
      .resolves.toMatchObject({ sourceIdentityId: `ethereum:${address}` });
  });

  it('folds EVM identity but preserves distinct-case Base58 wallet identities', async () => {
    const upperSolana = 'Vote111111111111111111111111111111111111111';
    const lowerSolana = 'vote111111111111111111111111111111111111111';
    await upsertLookupAddress('ethereum', '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', 0);
    await upsertLookupAddress('ethereum', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0);
    await upsertLookupAddress('solana', upperSolana, 0);
    await upsertLookupAddress('solana', lowerSolana, 0);
    expect((await db.lookupAddresses.toArray()).map((row) => row.id).sort()).toEqual([
      'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', `solana:${upperSolana}`, `solana:${lowerSolana}`
    ]);
    const solanaRows = (await db.lookupAddresses.where('chain').equals('solana').toArray());
    expect(new Set(solanaRows.map((row) => row.sourceIncarnation)).size).toBe(2);

    expect(walletBalanceId('solana', upperSolana, 'TOKEN', 'MintCase')).not.toBe(
      walletBalanceId('solana', lowerSolana, 'TOKEN', 'mintCase')
    );
    expect(walletBalanceId('ethereum', '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', 'USDC', '0x00000000000000000000000000000000000000AA')).toBe(
      walletBalanceId('ethereum', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'USDC', '0x00000000000000000000000000000000000000aa')
    );
  });

  it('writes wallet-app identity and preserves it when a connection is renamed', async () => {
    const id = 'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await db.lookupAddresses.put({
      id,
      chain: 'ethereum',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lastSyncedAt: 1,
      txCount: 0
    });

    await updateWalletLabel(id, 'MetaMask', 'metamask');
    expect(await db.lookupAddresses.get(id)).toMatchObject({
      label: 'MetaMask',
      walletAppId: 'metamask'
    });

    await updateWalletLabel(id, 'Long-term savings');

    expect(await db.lookupAddresses.get(id)).toMatchObject({
      label: 'Long-term savings',
      walletAppId: 'metamask'
    });
  });

  it('sets initial wallet identity at row creation without overwriting existing metadata', async () => {
    await upsertLookupAddress('ethereum', '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', 0, undefined, {
      label: 'MetaMask',
      walletAppId: 'metamask'
    });
    expect(await db.lookupAddresses.get('ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      label: 'MetaMask',
      walletAppId: 'metamask'
    });

    await upsertLookupAddress('ethereum', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, undefined, {
      label: 'Stale form name',
      walletAppId: 'ledger'
    });
    expect(await db.lookupAddresses.get('ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      label: 'MetaMask',
      walletAppId: 'metamask'
    });
  });

  it('serializes competing initial identities without replacing the committed winner', async () => {
    await Promise.all([
      upsertLookupAddress('ethereum', '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', 0, undefined, {
        label: 'MetaMask wallet', walletAppId: 'metamask'
      }),
      upsertLookupAddress('ethereum', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, undefined, {
        label: 'Ledger wallet', walletAppId: 'ledger'
      })
    ]);

    const stored = await db.lookupAddresses.get('ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect([
      ['MetaMask wallet', 'metamask'],
      ['Ledger wallet', 'ledger']
    ]).toContainEqual([stored?.label, stored?.walletAppId]);
  });

  it('rejects incoherent generations without a partial write', async () => {
    await expect(saveAuthorityGeneration({
      snapshotId: 'bad', generation: 1, scopeId: 'exchange:x', authorityKind: 'api',
      authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: 100, capturedAt: 100, sourceIdentityId: 'x', endpointProof: binanceSpotEndpointProof(),
      status: 'complete'
    }, [{
      id: 'bad:BTC', snapshotId: 'other', generation: 1, scopeId: 'exchange:x',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    }])).rejects.toThrow('not coherent');
    expect(await db.authoritySnapshots.count()).toBe(0);
    expect(await db.authorityAssets.count()).toBe(0);
  });

  it('appends immutable coverage and reads it through indexed scope/generation queries', async () => {
    const coverage = {
      id: 'coverage-3', generation: 3, scopeId: 'exchange:source-1', sourceIdentityId: 'source-1',
      evidenceId: 'operation-3', kind: 'api' as const, accountClasses: ['spot' as const],
      endpoints: ['trades'], startedAt: 1, completedAt: 2, status: 'partial' as const,
      endpointOutcomes: [{
        endpoint: 'trades', accountClass: 'spot' as const, required: true, status: 'partial' as const,
        paginationRequired: true, paginationExhausted: false
      }]
    };
    await saveSourceCoverage(coverage);
    expect(await getSourceCoverageForScope('exchange:source-1')).toEqual([coverage]);
    expect(await getSourceCoverageForGeneration('source-1', 3)).toEqual([coverage]);
    await expect(saveSourceCoverage({
      ...coverage, status: 'complete',
      endpointOutcomes: [{ ...coverage.endpointOutcomes[0], status: 'complete' }]
    })).rejects.toThrow('immutable');
    expect(await db.sourceCoverage.get(coverage.id)).toEqual(coverage);
  });

  it('atomically commits CSV rows, dedup, legacy metadata, revision, authority, and coverage', async () => {
    const tx = manualTransaction('csv-tx', 100);
    tx.source = 'binance';
    tx.sourceRef = 'same';
    tx.importBatchId = 'csv-atomic';
    const saved = await commitCsvImportGeneration({
      id: 'csv-atomic', fileName: 'history.csv', parserId: 'binance', transactions: [tx],
      completedAt: 200,
      metadata: {
        balanceSnapshot: { BTC: 7 }, optionsBalanceUnavailable: true,
        optionsBalanceIncluded: true, optionsCoverageThrough: 150
      },
      buildGeneration: ({ generation, savedAfterDedup, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-atomic', parserId: 'binance', parsedBeforeDedup: 1,
          savedAfterDedup, generation, completedAt,
          evidence: {
            coveredAccountClasses: ['spot'],
            finalBalanceSnapshots: [{ accountClass: 'spot', balances: { BTC: 7 } }],
            requiredOutcomes: [{
              id: 'history', accountClass: 'spot', required: true, status: 'complete',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0
            }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });
    expect(saved).toBe(1);
    expect(await db.csvImports.get('csv-atomic')).toMatchObject({
      txCount: 1, authorityGeneration: 1, revision: 1, balanceSnapshot: { BTC: 7 },
      optionsBalanceUnavailable: true, optionsBalanceIncluded: true, optionsCoverageThrough: 150
    });
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot).toMatchObject({ scopeId: 'file:csv-atomic:spot', asOf: undefined });
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      scopeId: 'file:csv-atomic:spot', authoritySnapshotId: snapshot.snapshotId
    });
  });

  it('atomically reconciles every CSV survivor count when a newer import dedups an older import to zero', async () => {
    const commit = async (id: string, transaction: Transaction) => commitCsvImportGeneration({
      id, fileName: `${id}.csv`, parserId: 'binance', transactions: [transaction], completedAt: 100,
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: id, parserId: 'binance', parsedBeforeDedup: 1,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot'],
            requiredOutcomes: [{
              id: 'history', accountClass: 'spot', required: true, status: 'complete',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
              parsedTransactionRows: [{ transactionId: transaction.id, sourceRowCount: 1 }]
            }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });
    const older = manualTransaction('older-row', 100);
    Object.assign(older, { source: 'binance', sourceRef: 'same-economic-row', importBatchId: 'older-import' });
    await commit('older-import', older);
    const newer = {
      ...older, id: 'newer-row', importBatchId: 'newer-import', fiatValue: 100
    };

    await commit('newer-import', newer);

    expect(await db.transactions.toArray()).toEqual([expect.objectContaining({ id: 'newer-row' })]);
    expect(await db.csvImports.bulkGet(['older-import', 'newer-import'])).toEqual([
      expect.objectContaining({ id: 'older-import', txCount: 0 }),
      expect.objectContaining({ id: 'newer-import', txCount: 1 })
    ]);
  });

  it('preserves a locked user classification and retains fresh parser evidence across a real CSV reimport', async () => {
    const commit = (id: string, transaction: Transaction) => commitCsvImportGeneration({
      id, fileName: `${id}.csv`, parserId: 'binance', transactions: [transaction], completedAt: 200,
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: id, parserId: 'binance', parsedBeforeDedup: 1,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot'],
            requiredOutcomes: [{ id: 'history', accountClass: 'spot', required: true, status: 'complete',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0 }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });
    const locked = {
      ...manualTransaction('locked-row', 100), source: 'binance', sourceRef: 'classification-reimport',
      importBatchId: 'locked-import', type: 'income' as const, category: 'salary' as const,
      categoryOrigin: 'user' as const, categoryLocked: true, categoryConfidence: 1,
      categoryRuleId: 'user:manual', categoryRuleVersion: '1', categoryUpdatedAt: 150
    };
    await commit('locked-import', locked);
    await commit('fresh-import', {
      ...locked, id: 'fresh-row', importBatchId: 'fresh-import', type: 'fee', category: 'funding_fee',
      categoryOrigin: 'parser', categoryLocked: false, categoryConfidence: undefined,
      categoryRuleId: undefined, categoryRuleVersion: undefined, categoryUpdatedAt: undefined,
      raw: { Operation: 'Funding Fee' }
    });

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'locked-row', type: 'income', category: 'salary', categoryOrigin: 'user', categoryLocked: true
    });
    expect(rows[0].classificationEvidence).toContainEqual(expect.objectContaining({
      ruleId: 'binance-ledger:funding-fee', ruleVersion: 'b5.1', category: 'funding_fee'
    }));
  });

  it('reconciles CSV counts when Review deletes transaction rows by id', async () => {
    const rows = [manualTransaction('review-delete-1', 100), manualTransaction('review-delete-2', 101)]
      .map((row) => ({ ...row, source: 'binance', importBatchId: 'review-csv' }));
    await db.csvImports.put({
      id: 'review-csv', fileName: 'review.csv', importedAt: 1, txCount: 2, parserId: 'binance'
    });
    await db.transactions.bulkPut(rows);

    expect(await deleteTransactionsByIds([rows[0].id])).toBe(1);

    expect(await db.csvImports.get('review-csv')).toMatchObject({ txCount: 1 });
  });

  it('reconciles an affected CSV count for standalone dedup from a non-CSV caller', async () => {
    const csv = manualTransaction('older-csv-row', 100);
    Object.assign(csv, {
      source: 'binance', sourceRef: 'standalone-shared', importBatchId: 'older-csv'
    });
    const nonCsv = {
      ...csv, id: 'manual-winner', source: 'manual_mapping', importBatchId: undefined,
      sourceRef: 'standalone-shared', fiatValue: 100
    };
    // Both stable-ref sources share one exchange dedup key; fiatValue makes the
    // non-CSV row survive even though dedup runs outside a CSV commit.
    await db.csvImports.put({
      id: 'older-csv', fileName: 'older.csv', importedAt: 1, txCount: 1, parserId: 'binance'
    });
    await db.transactions.bulkPut([csv, nonCsv]);

    expect(await deduplicateTransactions()).toBe(1);

    expect(await db.transactions.toArray()).toEqual([expect.objectContaining({ id: 'manual-winner' })]);
    expect(await db.csvImports.get('older-csv')).toMatchObject({ txCount: 0 });
  });

  it('atomically persists one exact CSV coverage row per account class', async () => {
    const funding = manualTransaction('funding-tx', 100);
    funding.importBatchId = 'csv-multi';
    const margin = manualTransaction('margin-tx', 101);
    margin.importBatchId = 'csv-multi';
    await commitCsvImportGeneration({
      id: 'csv-multi', fileName: 'multi.csv', parserId: 'binance', transactions: [funding, margin],
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-multi', parserId: 'binance', parsedBeforeDedup: 2,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['funding', 'margin'],
            requiredOutcomes: [
              { id: 'funding', accountClass: 'funding', required: true, status: 'complete',
                recognizedCount: 3, parsedCount: 3, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: funding.id, sourceRowCount: 3 }] },
              { id: 'margin', accountClass: 'margin', required: true, status: 'complete',
                recognizedCount: 3, parsedCount: 3, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: margin.id, sourceRowCount: 3 }] }
            ],
            recognizedCount: 6, parsedCount: 6, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });

    expect(await db.sourceCoverage.orderBy('scopeId').toArray()).toEqual([
      expect.objectContaining({ scopeId: 'file:csv-multi:funding', accountClasses: ['funding'], parsedCount: 3 }),
      expect.objectContaining({ scopeId: 'file:csv-multi:margin', accountClasses: ['margin'], parsedCount: 3 })
    ]);
    expect(await getSourceCoverageAssociationsForScope('exchange:binance-live', 'funding', [
      { id: 'binance-live', exchange: 'binance' }
    ])).toEqual([
      expect.objectContaining({
        scopeStatus: 'resolved', accountScopeId: 'exchange:binance-live', accountClass: 'funding',
        linkedSourceIdentityId: 'binance-live',
        coverage: expect.objectContaining({
          sourceIdentityId: 'csv-multi', scopeId: 'file:csv-multi:funding'
        })
      })
    ]);
    expect(await getSourceCoverageAssociationsForScope('file:csv-multi:funding', 'funding', []))
      .toHaveLength(1);
    expect(await getSourceCoverageAssociationsForScope('exchange:binance-live', 'funding', [
      { id: 'binance-live', exchange: 'binance' }, { id: 'binance-other', exchange: 'binance' }
    ])).toEqual([]);
  });

  it('uses exact per-class mappings after global dedup for mixed Spot and Options duplicates', async () => {
    const spot = manualTransaction('spot-duplicate', 100);
    Object.assign(spot, {
      source: 'binance', sourceRef: 'shared-duplicate', importBatchId: 'csv-class-dedup',
      parserAccountClass: 'spot' as const
    });
    const options = { ...spot, id: 'options-duplicate', parserAccountClass: 'options' as const };

    await commitCsvImportGeneration({
      id: 'csv-class-dedup', fileName: 'mixed.xlsx', parserId: 'binance', transactions: [spot, options],
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-class-dedup', parserId: 'binance', parsedBeforeDedup: 2,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot', 'options'],
            requiredOutcomes: [
              { id: 'spot-sheet', accountClass: 'spot', required: true, status: 'complete',
                recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: spot.id, sourceRowCount: 1 }] },
              { id: 'options-sheet', accountClass: 'options', required: true, status: 'complete',
                recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: options.id, sourceRowCount: 1 }] }
            ],
            recognizedCount: 2, parsedCount: 2, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });

    expect((await db.transactions.where('importBatchId').equals('csv-class-dedup').toArray()).map((row) => row.id))
      .toEqual([options.id]);
    expect(await db.sourceCoverage.orderBy('scopeId').toArray()).toEqual([
      expect.objectContaining({ accountClasses: ['options'], parsedCount: 1, dedupedCount: 0, status: 'complete' }),
      expect.objectContaining({ accountClasses: ['spot'], parsedCount: 0, dedupedCount: 1, status: 'complete' })
    ]);
  });

  it('rejects duplicate logical CSV snapshots atomically even when their ids differ', async () => {
    const tx = manualTransaction('duplicate-snapshot-tx', 100);
    tx.importBatchId = 'csv-duplicate-snapshot';
    await expect(commitCsvImportGeneration({
      id: 'csv-duplicate-snapshot', fileName: 'two-spot-sheets.xlsx', parserId: 'binance', transactions: [tx],
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) => {
        const rows = buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-duplicate-snapshot', parserId: 'binance', parsedBeforeDedup: 1,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot'],
            finalBalanceSnapshots: [{ accountClass: 'spot', balances: { BTC: 1 } }],
            requiredOutcomes: [{
              id: 'spot-sheet', accountClass: 'spot', required: true, status: 'complete',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
              parsedTransactionRows: [{ transactionId: tx.id, sourceRowCount: 1 }]
            }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        });
        return {
          ...rows,
          snapshots: [...rows.snapshots, { ...rows.snapshots[0], snapshotId: `${rows.snapshots[0].snapshotId}:duplicate` }]
        };
      }
    })).rejects.toThrow('source, generation, scope, and class must be unique');

    expect(await db.transactions.count()).toBe(0);
    expect(await db.csvImports.count()).toBe(0);
    expect(await db.authoritySnapshots.count()).toBe(0);
    expect(await db.sourceCoverage.count()).toBe(0);
  });

  it('runs the shared coverage validator inside the atomic CSV commit', async () => {
    const tx = manualTransaction('invalid-coverage-tx', 100);
    tx.importBatchId = 'csv-invalid-coverage';
    await expect(commitCsvImportGeneration({
      id: 'csv-invalid-coverage', fileName: 'snapshot-only.csv', parserId: 'binance', transactions: [tx],
      buildGeneration: ({ generation, completedAt }) => ({
        snapshots: [], assets: [], coverage: [{
          id: `csv-invalid-coverage:${generation}:coverage:unknown`, generation,
          scopeId: 'file:csv-invalid-coverage:unknown', sourceIdentityId: 'csv-invalid-coverage',
          evidenceId: `csv-invalid-coverage:${generation}:unknown`, kind: 'csv',
          accountClasses: ['unknown'], endpoints: ['snapshot'], startedAt: completedAt,
          completedAt, status: 'complete', endpointOutcomes: [], parserId: 'binance',
          supportedParser: true, requiredSheets: ['snapshot'], presentSheets: ['snapshot'],
          recognizedCount: 0, parsedCount: 0, dedupedCount: 0, excludedCount: 0,
          skippedCount: 0, failedCount: 0, declaredCompleteHistory: true
        }]
      })
    })).rejects.toThrow('complete_coverage_missing_required_in_scope_endpoint');

    expect(await db.transactions.count()).toBe(0);
    expect(await db.csvImports.count()).toBe(0);
    expect(await db.sourceCoverage.count()).toBe(0);
  });

  it('atomically rejects complete CSV coverage with a required partial outcome', async () => {
    const tx = manualTransaction('contradictory-coverage-tx', 100);
    tx.importBatchId = 'csv-contradictory-coverage';
    await expect(commitCsvImportGeneration({
      id: 'csv-contradictory-coverage', fileName: 'contradictory.csv', parserId: 'binance', transactions: [tx],
      buildGeneration: ({ generation, completedAt }) => ({
        snapshots: [], assets: [], coverage: [{
          id: `csv-contradictory-coverage:${generation}:spot`, generation,
          scopeId: 'file:csv-contradictory-coverage:spot', sourceIdentityId: 'csv-contradictory-coverage',
          evidenceId: `csv-contradictory-coverage:${generation}:spot`, kind: 'csv', accountClasses: ['spot'],
          endpoints: ['complete-sheet', 'partial-sheet'], startedAt: completedAt, completedAt,
          status: 'complete', parserId: 'binance', supportedParser: true,
          declaredCompleteHistory: true, requiredSheets: ['complete-sheet', 'partial-sheet'],
          presentSheets: ['complete-sheet', 'partial-sheet'], recognizedCount: 0, parsedCount: 0,
          dedupedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
          endpointOutcomes: [
            { endpoint: 'complete-sheet', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' },
            { endpoint: 'partial-sheet', parserId: 'binance', accountClass: 'spot', required: true, status: 'partial' }
          ]
        }]
      })
    })).rejects.toThrow('complete_coverage_has_incomplete_required_outcome');
    expect(await db.transactions.count()).toBe(0);
    expect(await db.sourceCoverage.count()).toBe(0);
  });

  it('rolls back transaction inserts, dedup deletions, source revision, and evidence when final persistence fails', async () => {
    const existing = manualTransaction('existing', 100);
    existing.source = 'binance';
    existing.sourceRef = 'same';
    await db.transactions.put(existing);
    const incoming = { ...existing, id: 'incoming', importBatchId: 'csv-rollback', fiatValue: 100 };

    await expect(commitCsvImportGeneration({
      id: 'csv-rollback', fileName: 'bad.csv', parserId: 'binance', transactions: [incoming],
      buildGeneration: () => { throw new Error('forced evidence failure'); }
    })).rejects.toThrow('forced evidence failure');

    expect(await db.transactions.toArray()).toEqual([existing]);
    expect(await db.csvImports.get('csv-rollback')).toBeUndefined();
    expect(await db.authoritySnapshots.count()).toBe(0);
    expect(await db.authorityAssets.count()).toBe(0);
    expect(await db.sourceCoverage.count()).toBe(0);
  });
});

describe('v15 account identity contracts', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it('accepts an explicit durable CSV account independently from file hash/generation', async () => {
    await db.accountIdentities.put({
      id: 'csv-account:durable-account', kind: 'csv', canonicalKey: 'csv-account:durable-account',
      ownershipStatus: 'owned', ownershipOrigin: 'user', ownershipConfirmedAt: 1,
      createdAt: 1, updatedAt: 1, lifecycleRevision: 0
    });
    await upsertCsvImport('file-hash-one', 'monthly-statement.csv', 'binance', 0, undefined, 'csv-account:durable-account');
    await upsertCsvImport('file-hash-two', 'renamed-statement.csv', 'binance', 0, undefined, 'csv-account:durable-account');
    expect((await db.csvImports.bulkGet(['file-hash-one', 'file-hash-two'])).map((row) => row?.accountIdentityId))
      .toEqual(['csv-account:durable-account', 'csv-account:durable-account']);
    await expect(upsertCsvImport('file-hash-three', 'same-name.csv', 'binance', 0, undefined, 'missing'))
      .rejects.toThrow(/does not exist/i);
  });

  it('updates ownership atomically with lifecycle compare-and-set', async () => {
    await db.accountIdentities.put({
      id: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'wallet', canonicalKey: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownershipStatus: 'unknown', ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0
    });
    await expect(updateAccountOwnership('wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      status: 'owned', origin: 'user'
    }, 0, 10)).resolves.toMatchObject({ ownershipStatus: 'owned', lifecycleRevision: 1 });
    await expect(updateAccountOwnership('wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      status: 'not_owned', origin: 'user'
    }, 0, 20)).rejects.toThrow(/changed/i);
    expect(await db.accountIdentities.get('wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      ownershipStatus: 'owned', lifecycleRevision: 1
    });
  });

  it('persists valid incoming Options commission rebates without downgrading parser semantics', async () => {
    const [rebate] = binanceOptionsParser.parse([{
      Time: '2026-01-02 03:04:05', Type: 'commission_fee', Amount: '2.5', Asset: 'USDT'
    }]).transactions;
    await commitCsvImportGeneration({
      id: 'options-rebate-file', fileName: 'options.csv', parserId: 'binance_options',
      transactions: [{ ...rebate, importBatchId: 'options-rebate-file' }],
      buildGeneration: ({ generation, savedAfterDedup, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'options-rebate-file', parserId: 'binance_options',
          parsedBeforeDedup: 1, savedAfterDedup, generation, completedAt,
          evidence: {
            coveredAccountClasses: ['options'],
            requiredOutcomes: [{
              id: 'options', accountClass: 'options', required: true, status: 'partial',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0
            }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });
    expect(await db.transactions.get(rebate.id)).toMatchObject({
      type: 'income', category: 'options_fee', categoryOrigin: 'parser',
      instrumentClass: 'derivative', amount: 2.5
    });
  });

  it('atomically validates reciprocal pair writes and rolls back both legs on invalid updates', async () => {
    const outgoing = manualTransaction('pair-out', 1);
    outgoing.type = 'transfer_out';
    const incoming = manualTransaction('pair-in', 2);
    await db.transactions.bulkPut([outgoing, incoming]);
    await expect(updateReciprocalTransferPair({
      pairId: 'pair-atomic', outgoingTransactionId: outgoing.id, incomingTransactionId: incoming.id,
      decision: 'confirmed', method: 'exact_onchain_event', matcherVersion: 'b4-v1', decidedAt: 3
    })).resolves.toEqual([
      expect.objectContaining({ linkedTransferId: incoming.id, isInternalTransfer: true }),
      expect.objectContaining({ linkedTransferId: outgoing.id, isInternalTransfer: true })
    ]);

    const third = manualTransaction('pair-third', 4);
    await db.transactions.put(third);
    await expect(updateReciprocalTransferPair({
      pairId: 'pair-invalid', outgoingTransactionId: outgoing.id, incomingTransactionId: third.id,
      decision: 'confirmed', method: 'heuristic', matcherVersion: 'b4-v1', decidedAt: 5
    })).rejects.toThrow();
    expect(await db.transactions.get(outgoing.id)).toMatchObject({
      internalTransferPairId: 'pair-atomic', linkedTransferId: incoming.id, isInternalTransfer: true
    });
    const unchangedThird = await db.transactions.get(third.id);
    expect(unchangedThird?.isInternalTransfer).toBe(false);
    expect(unchangedThird?.internalTransferPairId).toBeUndefined();
  });
});

function manualTransaction(id: string, timestamp: number): Transaction {
  return {
    id, timestamp, type: 'transfer_in', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
    source: 'manual', flags: [], isInternalTransfer: false
  };
}

describe('absolute opening-balance persistence', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  const base = {
    scopeId: 'manual', accountClass: 'manual' as const, assetKey: 'asset:BTC', asset: 'btc',
    absoluteQuantity: 5, effectiveAt: 100, provenance: 'user_confirmed' as const
  };

  it('uses a deterministic logical id and idempotently corrects the same key', async () => {
    const created = await upsertOpeningBalance(base, 1_000);
    expect(created.id).toBe(openingBalanceId(base));
    expect(created.asset).toBe('BTC');
    const repeated = await upsertOpeningBalance(base, 2_000);
    expect(repeated).toEqual(created);
    const corrected = await upsertOpeningBalance({ ...base, absoluteQuantity: 7, note: ' corrected ' }, 3_000);
    expect(corrected).toMatchObject({ id: created.id, createdAt: 1_000, updatedAt: 3_000, absoluteQuantity: 7, note: 'corrected' });
    expect(await db.openingBalances.count()).toBe(1);
  });

  it('atomically rejects stale update and delete revisions without recreating rows', async () => {
    const created = await upsertOpeningBalance(base, 1_000);
    const updated = await upsertOpeningBalance(
      { ...base, absoluteQuantity: 6 }, 2_000, { expectedUpdatedAt: created.updatedAt }
    );
    await expect(upsertOpeningBalance(
      { ...base, absoluteQuantity: 7 }, 3_000, { expectedUpdatedAt: created.updatedAt }
    )).rejects.toThrow(/changed in another tab/i);
    await expect(deleteOpeningBalance(created.id, { expectedUpdatedAt: created.updatedAt }))
      .rejects.toThrow(/changed in another tab/i);
    expect(await db.openingBalances.get(created.id)).toEqual(updated);
    expect(await deleteOpeningBalance(created.id, { expectedUpdatedAt: updated.updatedAt })).toBe(true);
    await expect(upsertOpeningBalance(
      base, 4_000, { expectedUpdatedAt: updated.updatedAt }
    )).rejects.toThrow(/changed in another tab/i);
    expect(await db.openingBalances.count()).toBe(0);
  });

  it('atomically rejects a create/create collision and preserves existing source evidence', async () => {
    const source = await upsertOpeningBalance({
      ...base, provenance: 'source_snapshot', evidenceRef: 'snapshot:trusted'
    }, 1_000, { mode: 'create' });
    await expect(upsertOpeningBalance({
      ...base, absoluteQuantity: 99, provenance: 'user_confirmed', note: 'stale creator'
    }, 2_000, { mode: 'create' })).rejects.toThrow(/already exists.*exact date/i);
    expect(await db.openingBalances.get(source.id)).toEqual(source);
    expect(await db.openingBalances.get(source.id)).toMatchObject({
      provenance: 'source_snapshot', evidenceRef: 'snapshot:trusted', absoluteQuantity: 5
    });
  });

  it('selects by cutoff and keeps deterministic historical supersession', async () => {
    const older = await upsertOpeningBalance(base, 1_000);
    const newer = await upsertOpeningBalance({ ...base, effectiveAt: 200, absoluteQuantity: 9 }, 2_000);
    expect(await db.openingBalances.get(older.id)).toMatchObject({ supersededAt: 200 });
    expect((await selectOpeningBalance('manual', 'manual', 'asset:BTC', 199))?.id).toBe(older.id);
    expect((await selectOpeningBalance('manual', 'manual', 'asset:BTC', 200))?.id).toBe(newer.id);
    expect(await selectOpeningBalance('manual', 'manual', 'asset:BTC', 99)).toBeUndefined();
    expect((await listOpeningBalances('manual', 'manual', 'asset:BTC')).map((row) => row.id)).toEqual([older.id, newer.id]);

    expect(await deleteOpeningBalance(newer.logicalKey)).toBe(true);
    expect((await db.openingBalances.get(older.id))?.supersededAt).toBeUndefined();
    expect(await deleteOpeningBalance(newer.id)).toBe(false);
  });

  it('rejects invalid snapshots and exact-time source activity', async () => {
    for (const input of [
      { ...base, absoluteQuantity: Number.NaN },
      { ...base, absoluteQuantity: -1 },
      { ...base, scopeId: 'unresolved:x' },
      { ...base, assetKey: 'asset:ETH' },
      { ...base, scopeId: 'wallet:bitcoin:abc', accountClass: 'spot' as const }
    ]) await expect(upsertOpeningBalance(input)).rejects.toThrow();

    await db.transactions.put(manualTransaction('same-time', 100));
    await expect(upsertOpeningBalance(base)).rejects.toThrow('conflicts with source activity');
    expect(await db.openingBalances.count()).toBe(0);
  });

  it('atomically requires an exact live source scope and matching custody class', async () => {
    await db.exchangeConnections.put({
      id: 'live-exchange', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    await db.csvImports.put({
      id: 'live-csv', fileName: 'history.csv', importedAt: 1, txCount: 0, parserId: 'binance'
    });
    await db.lookupAddresses.put({
      id: 'bitcoin:abc', chain: 'bitcoin', address: 'abc', lastSyncedAt: 1, txCount: 0
    });

    await expect(upsertOpeningBalance({
      ...base, scopeId: 'exchange:live-exchange', accountClass: 'spot'
    })).resolves.toMatchObject({ scopeId: 'exchange:live-exchange', accountClass: 'spot' });
    await expect(upsertOpeningBalance({
      ...base, scopeId: 'file:live-csv:spot', accountClass: 'spot', effectiveAt: 101
    })).resolves.toMatchObject({ scopeId: 'file:live-csv:spot', accountClass: 'spot' });
    await expect(upsertOpeningBalance({
      ...base, scopeId: 'wallet:bitcoin:bitcoin:abc', accountClass: 'wallet', effectiveAt: 102
    })).resolves.toMatchObject({ scopeId: 'wallet:bitcoin:bitcoin:abc', accountClass: 'wallet' });

    await db.exchangeConnections.delete('live-exchange');
    await expect(upsertOpeningBalance({
      ...base, scopeId: 'exchange:live-exchange', accountClass: 'spot', effectiveAt: 103
    })).rejects.toThrow(/not live/i);
    await expect(upsertOpeningBalance({
      ...base, scopeId: 'file:live-csv:spot', accountClass: 'options', effectiveAt: 104
    })).rejects.toThrow(/class is inconsistent/i);
    await expect(upsertOpeningBalance({
      ...base, scopeId: 'wallet:bitcoin:bitcoin:missing', accountClass: 'wallet', effectiveAt: 105
    })).rejects.toThrow(/not live/i);
    expect(await db.openingBalances.count()).toBe(3);
  });

  it('never creates or mutates transactions, tax lots, or disposals', async () => {
    const transaction = manualTransaction('tax-source', 50);
    await db.transactions.put(transaction);
    await db.lots.put({
      id: 'lot-1', asset: 'BTC', acquiredAt: 50, sourceTxId: transaction.id,
      amountOriginal: 1, amountRemaining: 1, costBasisTotal: 100, costBasisPerUnit: 100,
      acquisitionType: 'buy'
    });
    const before = {
      transactions: await db.transactions.toArray(), lots: await db.lots.toArray(), disposals: await db.disposals.toArray()
    };
    const row = await upsertOpeningBalance({ ...base, effectiveAt: 100 });
    await deleteOpeningBalance(row.id);
    expect({
      transactions: await db.transactions.toArray(), lots: await db.lots.toArray(), disposals: await db.disposals.toArray()
    }).toEqual(before);
  });

  it('clearAllData removes every v11 evidence store', async () => {
    await db.sourceCoverage.put({
      id: 'coverage', generation: 1, scopeId: 'manual', sourceIdentityId: 'manual', evidenceId: 'e',
      kind: 'manual', accountClasses: ['manual'], endpoints: ['manual'], startedAt: 1, completedAt: 2,
      status: 'unknown', endpointOutcomes: []
    });
    await db.authoritySnapshots.put({
      snapshotId: 'failed', generation: 1, scopeId: 'manual', authorityKind: 'csv',
      authorityClass: 'journal_final_balance', accountClass: 'manual', coveredAccountClasses: ['manual'],
      capturedAt: 1, sourceIdentityId: 'manual', endpointProof: {
        authorityKind: 'csv', provider: 'manual', operation: 'none', parametersClass: 'none',
        requestedAccountClasses: ['manual'], provenAccountClasses: ['manual']
      }, status: 'failed'
    });
    await upsertOpeningBalance(base, 1);
    await clearAllData();
    expect(await Promise.all([
      db.authoritySnapshots.count(), db.authorityAssets.count(), db.sourceCoverage.count(), db.openingBalances.count()
    ])).toEqual([0, 0, 0, 0]);
  });
});

describe('v11 file and wallet source deletion', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  it.each([
    { kind: 'csv' as const, sourceId: 'csv-1', scopeId: 'file:csv-1:spot' },
    { kind: 'wallet' as const, sourceId: 'bitcoin:abc', scopeId: 'wallet:bitcoin:bitcoin:abc' }
  ])('removes authority, coverage, and openings owned by a $kind source', async ({ kind, sourceId, scopeId }) => {
    if (kind === 'csv') {
      await db.csvImports.put({ id: sourceId, fileName: 'history.csv', importedAt: 1, txCount: 1, parserId: 'binance' });
      await db.transactions.put({
        id: 'owned-tx', timestamp: 1, type: 'buy', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
        source: 'binance', importBatchId: sourceId, flags: [], isInternalTransfer: false
      });
    } else {
      await db.lookupAddresses.put({
        id: sourceId, chain: 'bitcoin', address: 'abc', lastSyncedAt: 1, txCount: 1
      });
      await db.transactions.put({
        id: 'owned-tx', timestamp: 1, type: 'transfer_in', asset: 'BTC', amount: 1,
        fiatCurrency: 'USD', source: 'bitcoin', chain: 'bitcoin', walletAddress: 'abc',
        flags: [], isInternalTransfer: false
      });
    }
    await db.authoritySnapshots.put({
      snapshotId: 'owned-snapshot', generation: 1, scopeId, authorityKind: kind === 'csv' ? 'csv' : 'rpc',
      authorityClass: kind === 'csv' ? 'journal_final_balance' : 'wallet_balance',
      accountClass: kind === 'csv' ? 'spot' : 'wallet', coveredAccountClasses: [kind === 'csv' ? 'spot' : 'wallet'],
      asOf: 1, capturedAt: 1, sourceIdentityId: sourceId, endpointProof: {
        authorityKind: kind === 'csv' ? 'csv' : 'rpc', provider: kind, operation: 'snapshot', parametersClass: 'test',
        requestedAccountClasses: [kind === 'csv' ? 'spot' : 'wallet'],
        provenAccountClasses: [kind === 'csv' ? 'spot' : 'wallet'], exhaustiveBalances: true
      }, status: 'complete'
    });
    await db.authorityAssets.put({
      id: 'owned-asset', snapshotId: 'owned-snapshot', generation: 1, scopeId,
      accountClass: kind === 'csv' ? 'spot' : 'wallet', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    });
    await db.sourceCoverage.put({
      id: 'owned-coverage', generation: 1, scopeId, sourceIdentityId: sourceId, evidenceId: 'operation',
      kind: kind === 'csv' ? 'csv' : 'rpc', accountClasses: [kind === 'csv' ? 'spot' : 'wallet'], endpoints: ['history'],
      startedAt: 1, status: 'failed', endpointOutcomes: []
    });
    await db.openingBalances.put({
      id: 'owned-opening', logicalKey: 'owned-logical', scopeId,
      accountClass: kind === 'csv' ? 'spot' : 'wallet', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: 1, provenance: 'source_snapshot', createdAt: 1, updatedAt: 1
    });
    await db.lots.put({
      id: 'owned-lot', asset: 'BTC', acquiredAt: 1, amountRemaining: 1, amountOriginal: 1,
      costBasisPerUnit: 1, costBasisTotal: 1, sourceTxId: 'owned-tx', acquisitionType: 'buy'
    });
    await db.disposals.put({
      id: 'owned-disposal', asset: 'BTC', disposedAt: 2, amount: 1, proceeds: 2,
      costBasis: 1, gain: 1, holdingPeriodDays: 0,
      lotConsumption: [{ lotId: 'owned-lot', amount: 1, costBasis: 1 }],
      sourceTxId: 'owned-tx', method: 'FIFO'
    });
    await db.disposals.put({
      id: 'dependent-disposal', asset: 'BTC', disposedAt: 3, amount: 1, proceeds: 3,
      costBasis: 1, gain: 2, holdingPeriodDays: 0,
      lotConsumption: [{ lotId: 'owned-lot', amount: 1, costBasis: 1 }],
      sourceTxId: 'surviving-tx', method: 'FIFO'
    });
    await db.specIdHints.put({ txId: 'surviving-tx', preferredLotIds: ['owned-lot', 'other-lot'] });

    const deleted = kind === 'csv'
      ? await deleteCsvImportAndTransactions(sourceId)
      : await deleteLookupAddressAndTransactions(sourceId);
    expect(deleted).toBe(1);
    expect(await Promise.all([
      db.transactions.count(), db.authoritySnapshots.count(), db.authorityAssets.count(),
      db.sourceCoverage.count(), db.openingBalances.count(), db.lots.count(), db.disposals.count()
    ])).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await db.specIdHints.get('surviving-tx')).toEqual({
      txId: 'surviving-tx', preferredLotIds: ['other-lot']
    });
  });

  it('atomically removes a large CSV import without oversized IndexedDB key queries', async () => {
    const sourceId = 'large-csv';
    // fake-indexeddb is orders of magnitude slower than Chromium IndexedDB;
    // this still crosses multiple 500-key cleanup batches deterministically.
    const transactions: Transaction[] = Array.from({ length: 2_800 }, (_, index) => ({
      id: `large-${index}`,
      timestamp: index + 1,
      type: 'transfer_in',
      asset: 'USDT',
      amount: 1,
      fiatCurrency: 'USD',
      source: 'binance',
      importBatchId: sourceId,
      flags: [],
      isInternalTransfer: false
    }));
    await db.csvImports.put({
      id: sourceId,
      fileName: 'large-history.csv',
      importedAt: 1,
      txCount: transactions.length,
      parserId: 'binance'
    });
    await db.transactions.bulkAdd(transactions);

    expect(await deleteCsvImportAndTransactions(sourceId)).toBe(transactions.length);
    expect(await db.transactions.where('importBatchId').equals(sourceId).count()).toBe(0);
    expect(await db.csvImports.get(sourceId)).toBeUndefined();
  }, 45_000);
});
