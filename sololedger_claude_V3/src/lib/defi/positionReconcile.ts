import type { Table } from 'dexie';
import { resolveProtocol } from './protocolRegistry';
import { accountIdentityScope, type DefiPositionRequest, type DefiPositionResult, type DefiPositionRow, type DefiPositionSnapshot, type ProtocolId } from './types';

function rowKey(row: DefiPositionRow): string {
  return `${row.reserveKey}:${row.role}:${row.role === 'debt' ? row.debtRateMode : 'supply'}`;
}
function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left), Math.abs(right)) * 1e-6;
}

export function unsupportedPositionRequest(request: DefiPositionRequest): DefiPositionResult | undefined {
  if (resolveProtocol(request.chainId, request.protocolId)) return undefined;
  return { status: 'unsupported', chainId: request.chainId, protocolId: request.protocolId, rows: [], warnings: ['Protocol look-through is supported only for Aave v2/v3 and Spark v1 on Ethereum mainnet. Raw custody assets were retained.'] };
}

/** RPC is exhaustive fallback. If both providers have rows, disagreement is fail-closed partial. */
export function reconcilePositionEvidence(moralis: DefiPositionResult | undefined, rpc: DefiPositionResult): DefiPositionResult {
  if (rpc.status === 'unsupported') return rpc;
  const protocolId = rpc.protocolId;
  if (rpc.status !== 'complete') {
    const debtRows = [...(moralis?.status === 'unsupported' ? [] : moralis?.rows ?? []), ...rpc.rows].filter((row) => row.role === 'debt');
    return { status: 'partial', chainId: 1, protocolId, blockNumber: rpc.blockNumber, rows: debtRows, evidence: [...(moralis?.status === 'unsupported' ? [] : moralis?.evidence ?? []), ...rpc.evidence], warnings: [...(moralis?.warnings ?? []), ...rpc.warnings, 'Incomplete position evidence cannot replace complete authority; partial debt is retained conservatively.'] };
  }
  if (!moralis || moralis.status === 'unsupported' || moralis.evidence.every((item) => item.status === 'unavailable') || moralis.rows.length === 0) return rpc;
  const rpcRows = new Map(rpc.rows.map((row) => [rowKey(row), row]));
  const moralisRows = new Map(moralis.rows.map((row) => [rowKey(row), row]));
  const disagreements = moralis.rows.filter((row) => {
    const direct = rpcRows.get(rowKey(row));
    return !direct || direct.underlying.contractAddress !== row.underlying.contractAddress || !close(direct.quantity, row.quantity);
  });
  if (moralis.status === 'complete') disagreements.push(...rpc.rows.filter((row) => !moralisRows.has(rowKey(row))));
  if (disagreements.length > 0) {
    const conservativeDebt = rpc.rows.filter((row) => row.role === 'debt');
    return { status: 'partial', chainId: 1, protocolId, blockNumber: rpc.blockNumber, rows: conservativeDebt, evidence: [...moralis.evidence, ...rpc.evidence], warnings: [...moralis.warnings, ...rpc.warnings, 'Moralis and same-block RPC position evidence disagreed; the prior complete authority remains selected.'] };
  }
  const rows = rpc.rows.map((direct) => {
    const corroborating = moralisRows.get(rowKey(direct));
    return corroborating?.valueEvidence
      ? { ...direct, valueEvidence: corroborating.valueEvidence }
      : direct;
  });
  return { ...rpc, rows, evidence: [...moralis.evidence, ...rpc.evidence] };
}

export interface PositionTables {
  defiPositionSnapshots: Table<DefiPositionSnapshot, string>;
  defiPositionRows: Table<DefiPositionRow, string>;
}

/** Immutable rows and their generation header are committed atomically. */
export async function commitPositionGeneration(tables: PositionTables, address: string, result: Exclude<DefiPositionResult, { status: 'unsupported' }>, capturedAt = Date.now()): Promise<DefiPositionSnapshot> {
  if (result.status === 'complete' && (!Number.isSafeInteger(result.blockNumber) ||
    !result.evidence.some((item) => item.provider === 'ethereum-rpc' && item.status === 'complete' && item.blockNumber === result.blockNumber))) {
    throw new Error('A complete position generation requires exhaustive same-block Ethereum RPC evidence.');
  }
  const logicalRows = new Set<string>();
  for (const row of result.rows) {
    const key = rowKey(row);
    if (logicalRows.has(key) || row.quantity <= 0 || !Number.isFinite(row.quantity)) throw new Error('Duplicate or invalid protocol position row.');
    logicalRows.add(key);
  }
  const scope = accountIdentityScope(address);
  const existing = await tables.defiPositionSnapshots.where('[accountIdentityScope+protocolId]').equals([scope, result.protocolId]).toArray();
  const generation = Math.max(0, ...existing.map((row) => row.generation)) + 1;
  const priorComplete = existing.filter((row) => row.status === 'complete').sort((a, b) => b.generation - a.generation)[0];
  const snapshotId = `${scope}:${result.protocolId}:${generation}`;
  const snapshot: DefiPositionSnapshot = {
    snapshotId, generation, accountIdentityScope: scope, protocolId: result.protocolId,
    chainId: 1, status: result.status, capturedAt, blockNumber: result.blockNumber,
    evidence: result.evidence, warnings: result.warnings,
    supersedesSnapshotId: result.status === 'complete' ? priorComplete?.snapshotId : undefined
  };
  const rows = result.rows.map((row) => ({ ...row, id: `${snapshotId}:${rowKey(row)}`, snapshotId }));
  await tables.defiPositionSnapshots.db.transaction('rw', [tables.defiPositionSnapshots, tables.defiPositionRows], async () => {
    await tables.defiPositionSnapshots.add(snapshot);
    if (rows.length) await tables.defiPositionRows.bulkAdd(rows);
  });
  return snapshot;
}

export interface SelectedPositionAuthority {
  latest?: DefiPositionSnapshot;
  selected?: DefiPositionSnapshot;
  rows: DefiPositionRow[];
  status: 'complete' | 'stale' | 'partial' | 'unsupported' | 'missing';
}

export function selectPositionAuthority(snapshots: readonly DefiPositionSnapshot[], rows: readonly DefiPositionRow[], scope: string, protocolId: ProtocolId): SelectedPositionAuthority {
  const candidates = snapshots.filter((row) => row.accountIdentityScope === scope && row.protocolId === protocolId).sort((a, b) => b.generation - a.generation);
  const latest = candidates[0];
  if (!latest) return { rows: [], status: 'missing' };
  const complete = candidates.find((row) => row.status === 'complete');
  if (!complete) return { latest, selected: latest, rows: rows.filter((row) => row.snapshotId === latest.snapshotId), status: latest.status };
  const stale = latest.snapshotId !== complete.snapshotId || complete.restoredAt != null;
  return { latest, selected: complete, rows: rows.filter((row) => row.snapshotId === complete.snapshotId), status: stale ? 'stale' : 'complete' };
}
