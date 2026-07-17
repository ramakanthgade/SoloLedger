import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFILLAMA_HINTS_CACHE_KEY,
  EXCLUDED_REWARD_MINTS,
  MAX_HINT_POOL_SYMBOLS,
  MAX_HINT_PROJECTS,
  clearDefiLlamaHintCache,
  fetchSolanaRewardHints,
  parseSolanaRewardHints
} from '@/lib/assets/defiLlamaRewards';

const MINT_A = 'A'.repeat(44);
const MINT_B = 'B'.repeat(44);
const MINT_C = 'C'.repeat(44);
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function poolsPayload(pools: unknown[]) {
  return { status: 'success', data: pools };
}

describe('parseSolanaRewardHints', () => {
  it('collects Solana reward mints with project/pool context', () => {
    const hints = parseSolanaRewardHints(
      poolsPayload([
        { chain: 'Solana', rewardTokens: [MINT_A], project: 'orca-dex', symbol: 'SOL-BSOL' },
        { chain: 'Solana', rewardTokens: [MINT_A, MINT_B], project: 'raydium-amm', symbol: 'WSOL-USDC' }
      ])
    );
    expect(hints.size).toBe(2);
    const a = hints.get(MINT_A)!;
    expect(a.poolCount).toBe(2);
    expect(a.projects).toEqual(['orca-dex', 'raydium-amm']); // sorted
    expect(a.poolSymbols).toEqual(['SOL-BSOL', 'WSOL-USDC']);
    expect(hints.get(MINT_B)!.poolCount).toBe(1);
  });

  it('skips non-Solana pools and pools without rewardTokens', () => {
    const hints = parseSolanaRewardHints(
      poolsPayload([
        { chain: 'Ethereum', rewardTokens: [MINT_A], project: 'aave', symbol: 'USDC' },
        { chain: 'Solana', project: 'no-rewards', symbol: 'SOL' },
        { chain: 'Solana', rewardTokens: [], project: 'empty', symbol: 'X' }
      ])
    );
    expect(hints.size).toBe(0);
  });

  it('excludes wrapped SOL and major stablecoins', () => {
    const hints = parseSolanaRewardHints(
      poolsPayload([
        { chain: 'Solana', rewardTokens: [WSOL, USDC, MINT_C], project: 'jupiter-lend', symbol: 'USDC' }
      ])
    );
    expect(hints.has(WSOL)).toBe(false);
    expect(hints.has(USDC)).toBe(false);
    expect(hints.has(MINT_C)).toBe(true);
    // Sanity: the exclusion set really does cover the blue chips we named.
    expect(EXCLUDED_REWARD_MINTS.has(WSOL)).toBe(true);
    expect(EXCLUDED_REWARD_MINTS.has(USDC)).toBe(true);
  });

  it('is defensive against malformed payloads', () => {
    expect(parseSolanaRewardHints(null).size).toBe(0);
    expect(parseSolanaRewardHints(undefined).size).toBe(0);
    expect(parseSolanaRewardHints({}).size).toBe(0);
    expect(parseSolanaRewardHints({ data: 'nope' }).size).toBe(0);
    expect(
      parseSolanaRewardHints(
        poolsPayload([
          null,
          'garbage',
          { chain: 'Solana', rewardTokens: ['short', 123, null, MINT_A], project: 'x', symbol: 'Y' }
        ])
      ).size
    ).toBe(1);
  });

  it('caps projects and pool symbols for readable notes', () => {
    const pools = Array.from({ length: 8 }, (_, i) => ({
      chain: 'Solana',
      rewardTokens: [MINT_A],
      project: `proj-${i}`,
      symbol: `SYM-${i}`
    }));
    const hint = parseSolanaRewardHints(poolsPayload(pools)).get(MINT_A)!;
    expect(hint.poolCount).toBe(8);
    expect(hint.projects.length).toBe(MAX_HINT_PROJECTS);
    expect(hint.poolSymbols.length).toBe(MAX_HINT_POOL_SYMBOLS);
  });
});

describe('fetchSolanaRewardHints (caching)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearDefiLlamaHintCache();
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(payload: unknown) {
    return { ok: true, json: async () => payload } as Response;
  }

  it('fetches once, then serves the memory cache within the TTL', async () => {
    fetchMock.mockResolvedValue(okResponse(poolsPayload([
      { chain: 'Solana', rewardTokens: [MINT_A], project: 'orca-dex', symbol: 'SOL-BSOL' }
    ])));

    const first = await fetchSolanaRewardHints();
    expect(first.fromCache).toBe(false);
    expect(first.hints.has(MINT_A)).toBe(true);

    const second = await fetchSolanaRewardHints();
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a warm localStorage cache on a fresh module state', async () => {
    // Seed localStorage directly (simulates a previous session).
    localStorage.setItem(
      DEFILLAMA_HINTS_CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        hints: [{ mint: MINT_B, projects: ['p'], poolSymbols: ['s'], poolCount: 1 }]
      })
    );
    clearDefiLlamaHintCache(); // clears memory but ALSO storage — re-seed after.
    localStorage.setItem(
      DEFILLAMA_HINTS_CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        hints: [{ mint: MINT_B, projects: ['p'], poolSymbols: ['s'], poolCount: 1 }]
      })
    );

    const res = await fetchSolanaRewardHints();
    expect(res.fromCache).toBe(true);
    expect(res.hints.has(MINT_B)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-applies the exclusion list when restoring from cache', async () => {
    localStorage.setItem(
      DEFILLAMA_HINTS_CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        hints: [
          { mint: WSOL, projects: ['p'], poolSymbols: ['s'], poolCount: 5 },
          { mint: MINT_A, projects: ['p'], poolSymbols: ['s'], poolCount: 1 }
        ]
      })
    );
    const res = await fetchSolanaRewardHints();
    expect(res.hints.has(WSOL)).toBe(false);
    expect(res.hints.has(MINT_A)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forceRefresh bypasses caches', async () => {
    fetchMock.mockResolvedValue(okResponse(poolsPayload([
      { chain: 'Solana', rewardTokens: [MINT_A], project: 'p', symbol: 's' }
    ])));
    await fetchSolanaRewardHints();
    const res = await fetchSolanaRewardHints({ forceRefresh: true });
    expect(res.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a STALE cache when the network fails', async () => {
    localStorage.setItem(
      DEFILLAMA_HINTS_CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now() - 48 * 60 * 60 * 1000, // 48 h ago → stale
        hints: [{ mint: MINT_A, projects: ['p'], poolSymbols: ['s'], poolCount: 2 }]
      })
    );
    fetchMock.mockRejectedValue(new Error('network down'));

    const res = await fetchSolanaRewardHints();
    expect(res.fromCache).toBe(true);
    expect(res.hints.has(MINT_A)).toBe(true);
  });

  it('throws when the network fails and there is nothing cached', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchSolanaRewardHints()).rejects.toThrow('network down');
  });

  it('dedupes concurrent fetches and shares the stale fallback', async () => {
    let resolveFetch: (v: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = res;
        })
    );
    const p1 = fetchSolanaRewardHints();
    const p2 = fetchSolanaRewardHints();
    resolveFetch!(okResponse(poolsPayload([
      { chain: 'Solana', rewardTokens: [MINT_A], project: 'p', symbol: 's' }
    ])));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.hints.has(MINT_A)).toBe(true);
    expect(r2.hints.has(MINT_A)).toBe(true);

    // And a concurrent pair that fails: both must fall back to the cache written above.
    clearDefiLlamaHintCache();
    // re-seed stale storage (clearDefiLlamaHintCache wiped it)
    localStorage.setItem(
      DEFILLAMA_HINTS_CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
        hints: [{ mint: MINT_A, projects: ['p'], poolSymbols: ['s'], poolCount: 1 }]
      })
    );
    fetchMock.mockRejectedValue(new Error('down again'));
    const [s1, s2] = await Promise.all([fetchSolanaRewardHints(), fetchSolanaRewardHints()]);
    expect(s1.hints.has(MINT_A)).toBe(true);
    expect(s2.hints.has(MINT_A)).toBe(true);
  });
});
