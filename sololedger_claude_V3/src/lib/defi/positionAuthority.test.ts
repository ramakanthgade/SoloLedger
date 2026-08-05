import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ direct: vi.fn() }));
vi.mock('./aaveRpc', async (importActual) => {
  const actual = await importActual<typeof import('./aaveRpc')>();
  return { ...actual, fetchAaveCompatibleRpcPositions: mocks.direct };
});

import { fetchPositionAuthority, refreshEthereumPositionAuthority } from './positionAuthority';

describe('position authority network guard', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([137, 42161, 8453])('returns unsupported for chain %s before any network request', async (chainId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPositionAuthority({ chainId, protocolId: 'aave-v3-ethereum', address: `0x${'1'.repeat(40)}` }, {})).resolves.toMatchObject({ status: 'unsupported', rows: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('captures one Ethereum block tag for every protocol in a wallet refresh', async () => {
    const rpc = vi.fn(async (method: string) => method === 'eth_blockNumber' ? '0x1234' : undefined);
    mocks.direct.mockImplementation(async (_address, protocolId, _rpc, blockTag) => ({
      status: 'complete', chainId: 1, protocolId, blockNumber: Number(BigInt(blockTag)), rows: [], warnings: [],
      evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: Number(BigInt(blockTag)), detail: 'fixture' }]
    }));
    const commit = vi.fn(async () => ({ snapshotId: 'fixture' }));
    const result = await refreshEthereumPositionAuthority(`0x${'1'.repeat(40)}`, {}, { rpc, commit: commit as never });
    expect(result.results).toHaveLength(3);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocks.direct.mock.calls.map((call) => call[3])).toEqual(['0x1234', '0x1234', '0x1234']);
  });
});
