import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getNetworkMode,
  hasUsedNetworkThisSession,
  recordNetworkActivity,
  resetNetworkActivity,
  resolveMode
} from './networkActivity';

describe('networkActivity — 3-state store (A1)', () => {
  beforeEach(() => {
    resetNetworkActivity();
  });

  it('defaults to local with no activity (AC-A1)', () => {
    expect(getNetworkMode()).toBe('local');
    expect(hasUsedNetworkThisSession()).toBe(false);
  });

  it('resolveMode maps SaaS-proxy usage to relay, else direct', () => {
    expect(resolveMode(true)).toBe('relay');
    expect(resolveMode(false)).toBe('direct');
  });

  it('records direct and relay activity', () => {
    recordNetworkActivity('direct');
    expect(getNetworkMode()).toBe('direct');
    expect(hasUsedNetworkThisSession()).toBe(true);
  });

  it('escalates local < direct < relay and never downgrades', () => {
    recordNetworkActivity('direct');
    expect(getNetworkMode()).toBe('direct');
    recordNetworkActivity('relay');
    expect(getNetworkMode()).toBe('relay');
    // A later direct call must not downgrade from relay.
    recordNetworkActivity('direct');
    expect(getNetworkMode()).toBe('relay');
  });

  it('relay directly from local stays relay', () => {
    recordNetworkActivity('relay');
    expect(getNetworkMode()).toBe('relay');
  });

  it('resetNetworkActivity() resets to local', () => {
    recordNetworkActivity('relay');
    resetNetworkActivity();
    expect(getNetworkMode()).toBe('local');
    expect(hasUsedNetworkThisSession()).toBe(false);
  });
});

describe('networkActivity — transport instrumentation (A1)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetNetworkActivity();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a direct transport (CoinGecko token symbol) flips the badge to direct', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ symbol: 'wif' })
    }) as unknown as typeof fetch;

    const { fetchCoinGeckoTokenSymbol } = await import('@/lib/assets/tokenSymbols');
    const sym = await fetchCoinGeckoTokenSymbol('solana', 'MINTaddr_direct_1');

    expect(sym).toBe('WIF');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getNetworkMode()).toBe('direct');
  });

  it('a cache-hit path does NOT flip the badge', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ symbol: 'bonk' })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchCoinGeckoTokenSymbol } = await import('@/lib/assets/tokenSymbols');
    // First call populates the module cache and records a real call.
    await fetchCoinGeckoTokenSymbol('solana', 'MINTaddr_cache_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reset to local, then the second (cached) call must not touch the network.
    resetNetworkActivity();
    const cached = await fetchCoinGeckoTokenSymbol('solana', 'MINTaddr_cache_1');
    expect(cached).toBe('BONK');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no new fetch
    expect(getNetworkMode()).toBe('local'); // badge did not flip
  });

  it('a direct transport (Jupiter DCA) flips the badge to direct', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] })
    }) as unknown as typeof fetch;

    const { fetchJupiterRecurringHistory } = await import('@/lib/rpc/jupiterDca');
    await fetchJupiterRecurringHistory('SoLwallet_direct');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getNetworkMode()).toBe('direct');
  });

  it('a relay transport (SaaS apiFetch) flips the badge to relay', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:3001');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    }) as unknown as typeof fetch;

    const { apiFetch } = await import('@/lib/saas/api');
    await apiFetch('/api/config/public');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getNetworkMode()).toBe('relay');
  });
});
