import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCoinGeckoRewardCache,
  deriveRewardSignal,
  syncCoinGeckoRewardRegistry
} from './coingeckoRewardRegistry';

describe('CoinGecko reward registry', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCoinGeckoRewardCache();
    vi.restoreAllMocks();
  });

  it('does not infer income from a broad DeFi category', () => {
    expect(deriveRewardSignal(['DeFi'], 'A decentralized trading protocol')).toBeNull();
    expect(deriveRewardSignal(['yield-farming'])).toEqual({ kind: 'defi_reward', confidence: 'high' });
  });

  it('uses a seven-day cache and manual force bypasses it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => []
    } as Response);

    const first = await syncCoinGeckoRewardRegistry();
    expect(first.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const cached = await syncCoinGeckoRewardRegistry();
    expect(cached.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    await syncCoinGeckoRewardRegistry(undefined, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('deduplicates concurrent background syncs', async () => {
    let resolveResponse!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
    const one = syncCoinGeckoRewardRegistry();
    const two = syncCoinGeckoRewardRegistry();
    resolveResponse({ ok: true, json: async () => [] } as Response);
    await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
