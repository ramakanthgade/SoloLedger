import { db } from '@/lib/storage/db';
import { isSaasMode } from '@/lib/saas/config';
import { createEthereumRpcCall, fetchAaveCompatibleRpcPositions, type EthereumRpcCall } from './aaveRpc';
import { fetchMoralisPositions } from './moralisPositions';
import { commitPositionGeneration, reconcilePositionEvidence, unsupportedPositionRequest } from './positionReconcile';
import { PROTOCOL_REGISTRY } from './protocolRegistry';
import { accountIdentityScope, type DefiPositionRequest, type DefiPositionResult, type DefiPositionSnapshot, type ProtocolId, type WalletDefiRefreshManifest } from './types';

const REQUIRED_PROTOCOLS = Object.keys(PROTOCOL_REGISTRY) as ProtocolId[];
const MAX_REFRESH_SKEW_MS = 5 * 60_000;

export interface PositionRefreshCredentials { alchemyApiKey?: string; moralisApiKey?: string }
export interface PositionAuthorityDependencies {
  rpc?: EthereumRpcCall;
  blockTag?: string;
  fetchMoralis?: typeof fetchMoralisPositions;
  commit?: typeof commitPositionGeneration;
  custodySnapshotId?: string;
}

/**
 * Publish the batch pointer only while every referenced generation is still
 * current. Position and custody rows remain immutable; this single record is
 * the atomic signal that they belong to one completed refresh.
 */
export async function commitWalletDefiRefreshManifest(
  address: string,
  custodySnapshotId: string,
  committedSnapshots: readonly DefiPositionSnapshot[],
  blockNumber: number
): Promise<boolean> {
  if (!Number.isSafeInteger(blockNumber)) return false;
  const scope = accountIdentityScope(address);
  const normalizedAddress = scope.slice('wallet:evm:'.length);
  const byProtocol = new Map(committedSnapshots.map((row) => [row.protocolId, row]));
  if (committedSnapshots.length !== REQUIRED_PROTOCOLS.length ||
    !REQUIRED_PROTOCOLS.every((protocolId) => byProtocol.has(protocolId))) return false;

  return db.transaction('rw', [db.authoritySnapshots, db.defiPositionSnapshots, db.walletDefiRefreshManifests], async () => {
    const custody = await db.authoritySnapshots.get(custodySnapshotId);
    if (!custody || custody.status !== 'complete' || custody.restoredAt != null || custody.asOf == null ||
      custody.accountClass !== 'wallet' || custody.authorityClass !== 'wallet_balance' ||
      custody.endpointProof.exhaustiveBalances !== true ||
      custody.scopeId.toLowerCase() !== `wallet:evm:1:${normalizedAddress}`) return false;

    const custodyCandidates = (await db.authoritySnapshots.where('scopeId').equals(custody.scopeId).toArray())
      .filter((row) => row.accountClass === 'wallet');
    const latestCustody = custodyCandidates.sort((a, b) => b.generation - a.generation)[0];
    if (latestCustody?.snapshotId !== custody.snapshotId) return false;

    const currentSnapshots: DefiPositionSnapshot[] = [];
    for (const protocolId of REQUIRED_PROTOCOLS) {
      const expected = byProtocol.get(protocolId)!;
      const candidates = await db.defiPositionSnapshots
        .where('[accountIdentityScope+protocolId]').equals([scope, protocolId]).toArray();
      const latest = candidates.sort((a, b) => b.generation - a.generation)[0];
      if (!latest || latest.snapshotId !== expected.snapshotId || latest.status !== 'complete' ||
        latest.restoredAt != null || latest.blockNumber !== blockNumber || latest.evidence.length === 0 ||
        !latest.evidence.every((item) => item.status === 'complete' &&
          (item.provider !== 'ethereum-rpc' || item.blockNumber === blockNumber))) return false;
      currentSnapshots.push(latest);
    }

    const observedAt = [custody.asOf, custody.capturedAt, ...currentSnapshots.map((row) => row.capturedAt)];
    if (observedAt.some((value) => !Number.isFinite(value)) ||
      Math.max(...observedAt) - Math.min(...observedAt) > MAX_REFRESH_SKEW_MS) return false;
    const capturedAt = Math.max(...currentSnapshots.map((row) => row.capturedAt));
    const manifest: WalletDefiRefreshManifest = {
      accountIdentityScope: scope,
      custodyScopeId: custody.scopeId,
      custodySnapshotId: custody.snapshotId,
      custodyGeneration: custody.generation,
      custodyAsOf: custody.asOf,
      blockNumber,
      capturedAt,
      protocolSnapshotIds: Object.fromEntries(REQUIRED_PROTOCOLS.map((protocolId) => [
        protocolId, byProtocol.get(protocolId)!.snapshotId
      ])) as Record<ProtocolId, string>
    };
    await db.walletDefiRefreshManifests.put(manifest);
    return true;
  });
}

export async function fetchPositionAuthority(request: DefiPositionRequest, credentials: PositionRefreshCredentials, dependencies: PositionAuthorityDependencies = {}): Promise<DefiPositionResult> {
  const unsupported = unsupportedPositionRequest(request);
  if (unsupported) return unsupported; // Guard precedes every provider/RPC construction.
  const protocolId = request.protocolId as ProtocolId;
  const rpc = dependencies.rpc ?? createEthereumRpcCall(credentials.alchemyApiKey ?? '');
  const fetchMoralis = dependencies.fetchMoralis ?? fetchMoralisPositions;
  const [moralis, direct] = await Promise.all([
    credentials.moralisApiKey || isSaasMode()
      ? fetchMoralis(request.address, protocolId, credentials.moralisApiKey ?? '')
      : Promise.resolve(undefined),
    fetchAaveCompatibleRpcPositions(request.address, protocolId, rpc, dependencies.blockTag)
  ]);
  return reconcilePositionEvidence(moralis, direct);
}

export async function refreshEthereumPositionAuthority(address: string, credentials: PositionRefreshCredentials, dependencies: PositionAuthorityDependencies = {}): Promise<{ results: DefiPositionResult[]; warnings: string[] }> {
  const results: DefiPositionResult[] = [];
  const committedSnapshots: DefiPositionSnapshot[] = [];
  const warnings: string[] = [];
  const rpc = dependencies.rpc ?? createEthereumRpcCall(credentials.alchemyApiKey ?? '');
  const blockTag = dependencies.blockTag ?? await rpc('eth_blockNumber', []);
  if (typeof blockTag !== 'string' || !/^0x[0-9a-fA-F]+$/.test(blockTag)) throw new Error('Malformed block number.');
  const blockNumber = Number(BigInt(blockTag));
  if (!Number.isSafeInteger(blockNumber)) throw new Error('Malformed block number.');
  for (const protocolId of REQUIRED_PROTOCOLS) {
    const result = await fetchPositionAuthority({ chainId: 1, protocolId, address }, credentials, { ...dependencies, rpc, blockTag });
    results.push(result);
    if (result.status !== 'unsupported') {
      const commit = dependencies.commit ?? commitPositionGeneration;
      committedSnapshots.push(await commit({ defiPositionSnapshots: db.defiPositionSnapshots, defiPositionRows: db.defiPositionRows }, address, result));
      warnings.push(...result.warnings.map((warning) => `${PROTOCOL_REGISTRY[protocolId].protocol} ${PROTOCOL_REGISTRY[protocolId].version}: ${warning}`));
    }
  }
  if (dependencies.custodySnapshotId && committedSnapshots.every((row) => row.status === 'complete')) {
    await commitWalletDefiRefreshManifest(address, dependencies.custodySnapshotId, committedSnapshots, blockNumber);
  }
  return { results, warnings };
}
