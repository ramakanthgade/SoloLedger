import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@/lib/storage/db';
import { commitPositionGeneration, selectPositionAuthority } from './positionReconcile';
import type { DefiPositionResult, DefiPositionRow } from './types';

const ADDRESS = `0x${'1'.repeat(40)}`;
const reserve = `0x${'2'.repeat(40)}`;
const row: DefiPositionRow = { id: 'temp', snapshotId: '', protocolId: 'aave-v3-ethereum', reserveKey: reserve, role: 'supply', underlying: { chainId: 1, contractAddress: reserve, symbol: 'USDC', decimals: 6 }, protocolToken: { chainId: 1, contractAddress: `0x${'3'.repeat(40)}`, symbol: 'aUSDC', decimals: 6 }, quantity: 10, rawQuantity: '10000000', isCollateral: true };
const result = (status: 'complete' | 'partial'): Exclude<DefiPositionResult, { status: 'unsupported' }> => ({ status, chainId: 1, protocolId: 'aave-v3-ethereum', blockNumber: 100, rows: status === 'complete' ? [row] : [], evidence: [{ provider: 'ethereum-rpc', status, blockNumber: 100, detail: status }], warnings: [] });

describe('position generation storage', () => {
  const database = createDb(`defi-${crypto.randomUUID()}`);
  beforeEach(() => database.open());
  afterEach(async () => { await database.delete(); });

  it('writes immutable generations and retains the last complete selection', async () => {
    const tables = { defiPositionSnapshots: database.defiPositionSnapshots, defiPositionRows: database.defiPositionRows };
    const first = await commitPositionGeneration(tables, ADDRESS, result('complete'), 1);
    const second = await commitPositionGeneration(tables, ADDRESS, result('partial'), 2);
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(await database.defiPositionSnapshots.count()).toBe(2);
    const selected = selectPositionAuthority(await database.defiPositionSnapshots.toArray(), await database.defiPositionRows.toArray(), `wallet:evm:${ADDRESS}`, 'aave-v3-ethereum');
    expect(selected).toMatchObject({ status: 'stale', selected: { snapshotId: first.snapshotId }, rows: [expect.objectContaining({ isCollateral: true })] });
  });
});
