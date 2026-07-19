import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHAINS } from '@/lib/rpc/providers';
import {
  MORALIS_SLUG_TO_CHAIN,
  chainIdFromMoralisSlug,
  fetchWalletActiveChains,
  getMoralisChain
} from './moralis';

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
  const ADDRESS = '0x1111111111111111111111111111111111111111';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(body: unknown, ok = true, status = 200) {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      json: async () => body
    });
  }

  it('returns only chains with real activity, in CHAINS registry order', async () => {
    mockResponse({
      active_chains: [
        // Inactive: empty-string first/last transaction.
        { chain: 'bsc', chain_id: '0x38', first_transaction: '', last_transaction: '' },
        {
          chain: 'polygon',
          chain_id: '0x89',
          first_transaction: { block_timestamp: '2023-01-01T00:00:00.000Z' },
          last_transaction: { block_timestamp: '2024-01-01T00:00:00.000Z' }
        },
        {
          chain: 'eth',
          chain_id: '0x1',
          first_transaction: { block_timestamp: '2022-06-01T00:00:00.000Z' },
          last_transaction: { block_timestamp: '2024-06-01T00:00:00.000Z' }
        },
        // Moralis-only chain the app cannot import — filtered out.
        {
          chain: 'aurora',
          chain_id: '0x4e454152',
          first_transaction: { block_timestamp: '2023-01-01T00:00:00.000Z' },
          last_transaction: { block_timestamp: '2024-01-01T00:00:00.000Z' }
        }
      ]
    });

    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.chains).toEqual(['ethereum', 'polygon']); // registry order, not response order
    expect(result.activeSlugs).toEqual(['polygon', 'eth', 'aurora']);
  });

  it('calls Moralis directly with the user key outside hosted mode', async () => {
    mockResponse({ active_chains: [] });
    await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://deep-index.moralis.io/api/v2.2/wallets/${ADDRESS}/chains`);
    expect(init.headers['X-API-Key']).toBe('moralis-key');
  });

  it('returns an empty list when the wallet has no activity anywhere', async () => {
    mockResponse({
      active_chains: [
        { chain: 'eth', chain_id: '0x1', first_transaction: '', last_transaction: '' },
        { chain: 'polygon', chain_id: '0x89', first_transaction: '', last_transaction: '' }
      ]
    });
    const result = await fetchWalletActiveChains(ADDRESS, 'moralis-key');
    expect(result.chains).toEqual([]);
    expect(result.activeSlugs).toEqual([]);
  });

  it('throws on HTTP errors so the caller can fall back to manual selection', async () => {
    mockResponse({}, false, 401);
    await expect(fetchWalletActiveChains(ADDRESS, 'bad-key')).rejects.toThrow(/401/);
  });
});
