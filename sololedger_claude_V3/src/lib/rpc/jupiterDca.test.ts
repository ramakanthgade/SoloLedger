import { describe, it, expect, vi, beforeEach } from 'vitest';

// jupiterDca calls recordNetworkActivity → keep it inert.
vi.mock('@/lib/networkActivity', () => ({
  recordNetworkActivity: vi.fn(),
  resolveMode: vi.fn(() => 'direct')
}));

import { fetchJupiterRecurringHistory } from '@/lib/rpc/jupiterDca';

const WALLET = 'CgSF2tG4uD2EuSuoYBxwySqdaPKqgcbzSGLbRdfBtgfp';

function mockFetch(payload: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchJupiterRecurringHistory — 2026 API contract', () => {
  it('sends the required includeFailedTx param (400 without it)', async () => {
    mockFetch({ user: WALLET, orderStatus: 'history', time: [], totalPages: 0, totalItems: 0, page: 1 });
    await fetchJupiterRecurringHistory(WALLET);
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2); // history + active buckets
    for (const [url] of calls) {
      expect(String(url)).toContain('includeFailedTx=false');
      expect(String(url)).toContain(`user=${WALLET}`);
    }
  });

  it('parses orders from the current top-level `time` key', async () => {
    const order = {
      orderKey: 'DCAvault111',
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      inDeposited: '1000000',
      inLeft: '0',
      fills: [
        {
          txId: 'sig-1',
          rawInputAmount: '500000',
          rawOutputAmount: '600000',
          inputAmount: 0.5,
          outputAmount: 0.6,
          confirmedAt: '2026-01-01T00:00:00Z',
          action: 'filled'
        }
      ]
    };
    mockFetch({ user: WALLET, orderStatus: 'history', time: [order], totalPages: 1, totalItems: 1, page: 1 });
    const r = await fetchJupiterRecurringHistory(WALLET);
    expect(r.reachable).toBe(true);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0].orderKey).toBe('DCAvault111');
    expect(r.fillsByTxId.get('sig-1')?.fill.inputAmount).toBe(0.5);
  });

  it('empty `time` list with HTTP 200 = confirmed no orders (reachable)', async () => {
    mockFetch({ user: WALLET, orderStatus: 'history', time: [], totalPages: 0, totalItems: 0, page: 1 });
    const r = await fetchJupiterRecurringHistory(WALLET);
    expect(r.reachable).toBe(true);
    expect(r.orders).toHaveLength(0);
  });

  it('HTTP 400 (missing param regression) = unreachable, callers fail open', async () => {
    mockFetch({ error: 'missing field includeFailedTx' }, false);
    const r = await fetchJupiterRecurringHistory(WALLET);
    expect(r.reachable).toBe(false);
    expect(r.orders).toHaveLength(0);
  });
});
