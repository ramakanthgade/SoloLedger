import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ direct: vi.fn() }));
vi.mock('./aaveRpc', async (importActual) => {
  const actual = await importActual<typeof import('./aaveRpc')>();
  return { ...actual, fetchAaveCompatibleRpcPositions: mocks.direct };
});

import { commitWalletBalanceOperation, db, reserveWalletBalanceOperation } from '@/lib/storage/db';
import { commitWalletDefiRefreshManifest, refreshEthereumPositionAuthority } from './positionAuthority';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';

const ADDRESS = `0x${'a'.repeat(40)}`;
const CUSTODY_ID = `ethereum:${ADDRESS}:rpc:1`;
const BLOCK = 0x1234;
const NOW = 1_000_000;

function custody(snapshotId = CUSTODY_ID, generation = 1, scopeId = `wallet:evm:1:${ADDRESS}`): AuthoritySnapshotRow {
  return {
    snapshotId, generation, scopeId, authorityKind: 'rpc', authorityClass: 'wallet_balance',
    accountClass: 'wallet', coveredAccountClasses: ['wallet'], asOf: NOW, capturedAt: NOW,
    sourceIdentityId: `ethereum:${ADDRESS}`,
    endpointProof: {
      authorityKind: 'rpc', provider: 'alchemy', operation: 'wallet balances', parametersClass: 'fixture',
      requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
    },
    status: 'complete'
  };
}

describe('wallet DeFi refresh manifest persistence', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.direct.mockReset();
    await db.transaction('rw', [
      db.lookupAddresses, db.walletBalances, db.authoritySnapshots, db.authorityAssets, db.sourceCoverage,
      db.defiPositionSnapshots, db.defiPositionRows, db.walletDefiRefreshManifests
    ], async () => {
      await db.lookupAddresses.clear();
      await db.walletBalances.clear();
      await db.authoritySnapshots.clear();
      await db.authorityAssets.clear();
      await db.sourceCoverage.clear();
      await db.defiPositionSnapshots.clear();
      await db.defiPositionRows.clear();
      await db.walletDefiRefreshManifests.clear();
    });
    await db.lookupAddresses.put({
      id: `ethereum:${ADDRESS}`, chain: 'ethereum', address: ADDRESS, lastSyncedAt: 1, txCount: 0,
      authorityGeneration: 0, revision: 0
    });
    const operation = await reserveWalletBalanceOperation('ethereum', ADDRESS, NOW);
    await commitWalletBalanceOperation({
      operation, rows: [], provider: 'alchemy', operationName: 'wallet balances',
      endpointOutcomes: [{ endpoint: 'ethereum:wallet-balances', accountClass: 'wallet', required: true, status: 'complete' }],
      status: 'complete', asOf: NOW, capturedAt: NOW
    });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mocks.direct.mockImplementation(async (_address, protocolId, _rpc, blockTag) => ({
      status: 'complete', chainId: 1, protocolId, blockNumber: Number(BigInt(blockTag)), rows: [], warnings: [],
      evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: Number(BigInt(blockTag)), detail: 'empty exhaustive fixture' }]
    }));
  });

  it('publishes one exact batch after real commits for all three families, including empty generations', async () => {
    const outcome = await refreshEthereumPositionAuthority(ADDRESS, {}, {
      rpc: vi.fn(async (method: string) => method === 'eth_blockNumber' ? `0x${BLOCK.toString(16)}` : undefined),
      custodySnapshotId: CUSTODY_ID
    });

    expect(outcome.results).toHaveLength(3);
    expect(await db.defiPositionRows.count()).toBe(0);
    const snapshots = await db.defiPositionSnapshots.toArray();
    expect(snapshots.map((row) => row.protocolId).sort()).toEqual([
      'aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'
    ]);
    expect(await db.walletDefiRefreshManifests.toArray()).toEqual([expect.objectContaining({
      accountIdentityScope: `wallet:evm:${ADDRESS}`,
      custodySnapshotId: CUSTODY_ID,
      custodyGeneration: 1,
      custodyAsOf: NOW,
      blockNumber: BLOCK,
      protocolSnapshotIds: Object.fromEntries(snapshots.map((row) => [row.protocolId, row.snapshotId]))
    })]);
  });

  it('publishes no manifest when a required family fails after an earlier family committed', async () => {
    mocks.direct.mockImplementation(async (_address, protocolId, _rpc, blockTag) => {
      if (protocolId === 'aave-v3-ethereum') throw new Error('provider failed');
      return {
        status: 'complete', chainId: 1, protocolId, blockNumber: Number(BigInt(blockTag)), rows: [], warnings: [],
        evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: Number(BigInt(blockTag)), detail: 'fixture' }]
      };
    });
    await expect(refreshEthereumPositionAuthority(ADDRESS, {}, {
      rpc: vi.fn(async () => `0x${BLOCK.toString(16)}`), custodySnapshotId: CUSTODY_ID
    })).rejects.toThrow('provider failed');
    expect(await db.defiPositionSnapshots.count()).toBe(1);
    expect(await db.walletDefiRefreshManifests.count()).toBe(0);
  });

  it('rejects stale publication when custody advanced after the batch began', async () => {
    const outcome = await refreshEthereumPositionAuthority(ADDRESS, {}, {
      rpc: vi.fn(async () => `0x${BLOCK.toString(16)}`), custodySnapshotId: CUSTODY_ID
    });
    const original = await db.walletDefiRefreshManifests.get(`wallet:evm:${ADDRESS}`);
    await db.authoritySnapshots.put(custody(`ethereum:${ADDRESS}:rpc:2`, 2));

    await expect(commitWalletDefiRefreshManifest(
      ADDRESS, CUSTODY_ID,
      await db.defiPositionSnapshots.toArray(), BLOCK
    )).resolves.toBe(false);
    expect(await db.walletDefiRefreshManifests.get(`wallet:evm:${ADDRESS}`)).toEqual(original);
    expect(outcome.results).toHaveLength(3);
  });

  it('rejects a batch whose custody and protocol capture times are not coherent', async () => {
    await db.authoritySnapshots.put({ ...custody(), asOf: 1, capturedAt: 1 });
    await refreshEthereumPositionAuthority(ADDRESS, {}, {
      rpc: vi.fn(async () => `0x${BLOCK.toString(16)}`), custodySnapshotId: CUSTODY_ID
    });
    expect(await db.walletDefiRefreshManifests.count()).toBe(0);
  });
});
