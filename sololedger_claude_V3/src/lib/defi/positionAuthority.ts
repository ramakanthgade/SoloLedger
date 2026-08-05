import { db } from '@/lib/storage/db';
import { isSaasMode } from '@/lib/saas/config';
import { createEthereumRpcCall, fetchAaveCompatibleRpcPositions, type EthereumRpcCall } from './aaveRpc';
import { fetchMoralisPositions } from './moralisPositions';
import { commitPositionGeneration, reconcilePositionEvidence, unsupportedPositionRequest } from './positionReconcile';
import { PROTOCOL_REGISTRY } from './protocolRegistry';
import type { DefiPositionRequest, DefiPositionResult, ProtocolId } from './types';

export interface PositionRefreshCredentials { alchemyApiKey?: string; moralisApiKey?: string }
export interface PositionAuthorityDependencies {
  rpc?: EthereumRpcCall;
  blockTag?: string;
  fetchMoralis?: typeof fetchMoralisPositions;
  commit?: typeof commitPositionGeneration;
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
  const warnings: string[] = [];
  const rpc = dependencies.rpc ?? createEthereumRpcCall(credentials.alchemyApiKey ?? '');
  const blockTag = dependencies.blockTag ?? await rpc('eth_blockNumber', []);
  if (typeof blockTag !== 'string' || !/^0x[0-9a-fA-F]+$/.test(blockTag)) throw new Error('Malformed block number.');
  for (const protocolId of Object.keys(PROTOCOL_REGISTRY) as ProtocolId[]) {
    const result = await fetchPositionAuthority({ chainId: 1, protocolId, address }, credentials, { ...dependencies, rpc, blockTag });
    results.push(result);
    if (result.status !== 'unsupported') {
      const commit = dependencies.commit ?? commitPositionGeneration;
      await commit({ defiPositionSnapshots: db.defiPositionSnapshots, defiPositionRows: db.defiPositionRows }, address, result);
      warnings.push(...result.warnings.map((warning) => `${PROTOCOL_REGISTRY[protocolId].protocol} ${PROTOCOL_REGISTRY[protocolId].version}: ${warning}`));
    }
  }
  return { results, warnings };
}
