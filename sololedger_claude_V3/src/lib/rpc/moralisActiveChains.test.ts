import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHAINS } from '@/lib/rpc/providers';
import { setMode } from '@/lib/saas/mode';
import {
  CHAINS_ENDPOINT_SLUGS,
  MORALIS_SLUG_TO_CHAIN,
  chainIdFromMoralisSlug,
  fetchWalletActiveChains,
  getMoralisChain
} from './moralis';

const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn() }));

vi.mock('@/lib/saas/api', () => ({ saasProxyFetch: mocks.proxyFetch }));

describe('MORALIS_SLUG_TO_CHAIN — inverse map', () => {
  it('is the exact inverse of the MORALIS_CHAIN forward map', () => {
    const forwardEntries: [string, string][] = [];
    for (const chain of CHAINS) {
      const slug = getMoralisChain(chain.id);
      if (slug) forwardEntries.push([chain.id, slug]);
    }
    expect(Object.keys(MORALIS_SLUG_TO_CHAIN)).toHaveLength(forwardEntries.length);
    for (const [chainId, slug] of forwardEntries) {
      expect(MORALIS_SLUG_TO_CHAIN[slug]).toBe(chainId);
    }
  });

  it('maps known slugs case-insensitively', () => {
    expect(chainIdFromMoralisSlug('eth')).toBe('ethereum');
    expect(chainIdFromMoralisSlug(' ETH ')).toBe('ethereum');
    expect(chainIdFromMoralisSlug('polygon')).toBe('polygon');
    expect(chainIdFromMoralisSlug('bsc')).toBe('bsc');
  });
});

describe('chainIdFromMoralisSlug — importable-chain intersection', () => {
  it('returns null for unknown slugs', () => {
    expect(chainIdFromMoralisSlug('solana')).toBeNull();
    expect(chainIdFromMoralisSlug('bitcoin')).toBeNull();
    expect(chainIdFromMoralisSlug('notachain')).toBeNull();
  });

  it('excludes chains the app cannot import (starknet / custom_evm)', () => {
    // starknet is not EVM (provider unsupported) and custom_evm is the manual
    // explorer path — neither may surface from auto-detection.
    expect(chainIdFromMoralisSlug('starknet')).toBeNull();
    expect(chainIdFromMoralisSlug('custom_evm')).toBeNull();
  });

  it('excludes etherscan-only chains reachable via the manual dropdown (aurora/moonriver)', () => {
    expect(chainIdFromMoralisSlug('aurora')).toBeNull();
    expect(chainIdFromMoralisSlug('moonriver')).toBeNull();
  });

  it('includes every alchemy_evm chain Moralis knows', () => {
    // Sanity anchor: the seven chains the picker has always offered resolve.
    for (const id of ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc', 'optimism', 'avalanche']) {
      const slug = getMoralisChain(id as (typeof CHAINS)[number]['id'])!;
      expect(chainIdFromMoralisSlug(slug)).toBe(id);
    }
  });
});

describe('fetchWalletActiveChains', () => {
  const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  interface HistoryPage {
    txs: { from_address?: string }[];
    cursor?: string | null;
  }

  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body } as Response;
  }

  const activeEntry = (slug: string) => ({
    chain: slug,
    chain_id: `0x${slug}`,
    first_transaction: { block_timestamp: '2023-01-01T00:00:00.000Z' },
    last_transaction: { block_timestamp: '2024-01-01T00:00:00.000Z' }
  });

  const inactiveEntry = (slug: string) => ({
    chain: slug,
    chain_id: `0x${slug}`,
    first_transaction: '',
    last_transaction: ''
  });

  const incomingPage = (count: number, cursor: string | null = null): HistoryPage => ({
    txs: Array.from({ length: count }, () => ({ from_address: OTHER })),
    cursor
  });

  /**
   * Route the fetch mock by URL: /chains returns `chainsBody`; /history serves
   * `history[slug]` pages in call order ('error' → HTTP 500). An unconfigured
   * slug rejects, so a test proves exactly which chains reached verification.
   */
  function mockMoralis(opts: {
    chainsBody?: unknown;
    chainsOk?: boolean;
    chainsStatus?: number;
    history?: Record<string, HistoryPage[] | 'error'>;
  } = {}) {
    const { chainsBody = { active_chains: [] }, chainsOk = true, chainsStatus = 200, history = {} } = opts;
    const served: Record<string, number> = {};
    fetchMock().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/chains')) return jsonResponse(chainsBody, chainsOk, chainsStatus);
      if (u.pathname.endsWith('/history')) {
        const slug = u.searchParams.get('chain') ?? '';
        const cfg = history[slug];
        if (!cfg) throw new Error(`unexpected history call for ${slug}`);
        if (cfg === 'error') return jsonResponse({}, false, 500);
        const n = (served[slug] = (served[slug] ?? 0) + 1);
        const page = cfg[Math.min(n - 1, cfg.length - 1)];
        return jsonResponse({ cursor: page.cursor ?? null, page: n - 1, page_size: 100, result: page.txs });
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  /** URLs the fetch mock saw, filtered to one endpoint fragment. */
  const callsTo = (fragment: string) =>
    fetchMock()
      .mock.calls.map(([u]) => String(u))
      .filter((u) => u.includes(fragment));

  const expectedChainsParams = CHAINS_ENDPOINT_SLUGS.map((s) => `chains=${s}`).join('&');

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mocks.proxyFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMode('local');
  });

  it('pins the endpoint-verified slugs, in order', () => {
    // Live-verified 2026-07: the /chains endpoint HTTP-400s on every other
    // MORALIS_CHAIN slug and under-reports when called with no param at all.
    expect([...CHAINS_ENDPOINT_SLUGS]).toEqual([
      'eth',
      'polygon',
      'arbitrum',
      'base',
      'bsc',
      'optimism',
      'avalanche',
      'linea',
      'cronos',
      'gnosis',
      'moonbeam'
    ]);
  });

  it('sends the verified chains as repeated chains= params on the direct URL', async () => {
    mockMoralis();
    await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe(`https://deep-index.moralis.io/api/v2.2/wallets/${ADDRESS}/chains?${expectedChainsParams}`);
    expect(init.headers['X-API-Key']).toBe('moralis-key');
    for (const rejected of ['fantom', 'celo', 'zksync', 'scroll', 'blast', 'mantle', 'aurora', 'moonriver', 'metis', 'opbnb']) {
      expect(url).not.toContain(`chains=${rejected}`);
    }
  });

  it('sends the same chains= params on the hosted SaaS-proxy URL', async () => {
    setMode('hosted');
    mocks.proxyFetch.mockResolvedValue(jsonResponse({ active_chains: [] }));
    await fetchWalletActiveChains(ADDRESS, '');
    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      `/api/proxy/moralis/api/v2.2/wallets/${ADDRESS}/chains?${expectedChainsParams}`
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('returns outgoing-verified chains in CHAINS registry order, skipping non-candidates', async () => {
    mockMoralis({
      chainsBody: {
        active_chains: [
          inactiveEntry('bsc'), // no activity — filtered before verification
          activeEntry('polygon'),
          activeEntry('eth'),
          activeEntry('aurora'), // not importable (etherscan-only) — never verified
          activeEntry('fantom') // rejected by the /chains endpoint — never verified
        ]
      },
      history: {
        // Checksummed sender vs. lowercase query address — match is case-insensitive.
        eth: [{ txs: [{ from_address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] }],
        polygon: [{ txs: [{ from_address: ADDRESS }] }]
      }
    });

    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.active).toEqual(['ethereum', 'polygon']); // registry order, not response order
    expect(result.incomingOnly).toEqual([]);

    // Only the importable + endpoint-supported candidates were verified.
    expect(callsTo('/history')).toHaveLength(2);
    expect(callsTo('chain=aurora')).toHaveLength(0);
    expect(callsTo('chain=fantom')).toHaveLength(0);
    expect(callsTo('chain=bsc')).toHaveLength(0);
  });

  it('treats a partially-populated entry as active (first OR last is enough)', async () => {
    mockMoralis({
      chainsBody: {
        active_chains: [
          {
            chain: 'eth',
            chain_id: '0x1',
            first_transaction: { block_timestamp: '2022-06-01T00:00:00.000Z' },
            last_transaction: ''
          }
        ]
      },
      history: { eth: [{ txs: [{ from_address: ADDRESS }] }] }
    });
    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.active).toEqual(['ethereum']);
  });

  it('returns empty lists — and skips history calls — when the wallet has no activity anywhere', async () => {
    mockMoralis({
      chainsBody: { active_chains: [inactiveEntry('eth'), inactiveEntry('polygon')] }
    });
    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result).toEqual({ active: [], incomingOnly: [] });
    expect(callsTo('/history')).toHaveLength(0);
  });

  it('splits outgoing vs incoming-only, and keeps a chain whose history check failed', async () => {
    mockMoralis({
      chainsBody: { active_chains: [activeEntry('eth'), activeEntry('polygon'), activeEntry('avalanche')] },
      history: {
        eth: [{ txs: [{ from_address: ADDRESS }] }], // outgoing → active
        polygon: [incomingPage(100, 'cursor-2'), incomingPage(3)], // paged, still incoming-only
        avalanche: 'error' // transient failure → stays listed
      }
    });

    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.active).toEqual(['ethereum', 'avalanche']);
    expect(result.incomingOnly).toEqual(['polygon']);

    // The incoming-only verdict paged through the cursor before concluding.
    const polygonCalls = callsTo('chain=polygon');
    expect(polygonCalls).toHaveLength(2);
    expect(polygonCalls[1]).toContain('cursor=cursor-2');
  });

  it('caps the outgoing check at 3 history pages per chain', async () => {
    mockMoralis({
      chainsBody: { active_chains: [activeEntry('eth')] },
      history: {
        eth: [incomingPage(100, 'c1'), incomingPage(100, 'c2'), incomingPage(100, 'c3')]
      }
    });
    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.active).toEqual([]);
    expect(result.incomingOnly).toEqual(['ethereum']);
    // Page 3 still returned a cursor, but the cap stopped the scan.
    expect(callsTo('chain=eth')).toHaveLength(3);
  });

  it('throws on HTTP errors of the chains call so the caller can fall back to manual selection', async () => {
    mockMoralis({ chainsOk: false, chainsStatus: 401 });
    await expect(fetchWalletActiveChains(ADDRESS, 'bad-key')).rejects.toThrow(/401/);
  });
});
