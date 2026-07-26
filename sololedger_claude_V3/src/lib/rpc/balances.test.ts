import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, getWalletBalances } from '@/lib/storage/db';
import { CHAINS } from '@/lib/rpc/providers';
import {
  fetchAddressBalances,
  refreshWalletBalances,
  refreshWalletBalancesForAddresses
} from '@/lib/rpc/balances';
import type { TaxSettings } from '@/types/transaction';
import type { Transaction } from '@/types/transaction';

const SETTINGS = {
  jurisdiction: 'IN',
  reportingCurrency: 'INR',
  defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false,
  rpcLookupEnabled: true,
  alchemyApiKey: 'test-alchemy-key'
} as TaxSettings;

const BTC_ADDR = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';
const ETH_ADDR = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const WBTC_CONTRACT = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? `t-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.UTC(2026, 0, 15, 12),
    type: 'transfer_in',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    source: 'rpc:bitcoin',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

/** Route stubbed fetch calls by URL + JSON-RPC method. */
function stubFetch(handler: (url: string, method?: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let method: string | undefined;
    if (init?.body) {
      try {
        method = JSON.parse(String(init.body)).method;
      } catch { /* not json */ }
    }
    const result = handler(url, method);
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => result } as Response;
  }));
}

beforeEach(async () => {
  await db.walletBalances.clear();
  await db.transactions.clear();
  await db.lookupAddresses.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchAddressBalances — bitcoin', () => {
  it('computes funded − spent across chain + mempool stats (zero included)', async () => {
    stubFetch((url) => {
      expect(url).toBe(`https://blockstream.info/api/address/${BTC_ADDR}`);
      return {
        chain_stats: { funded_txo_sum: 3_265_574_623, spent_txo_sum: 3_265_574_623, tx_count: 22 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }
      };
    });
    const rows = await fetchAddressBalances(CHAINS.find((c) => c.id === 'bitcoin')!, BTC_ADDR, SETTINGS);
    expect(rows).toEqual([{ asset: 'BTC', amount: 0 }]);
  });

  it('reports a live balance when funds remain', async () => {
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 500_000_000, spent_txo_sum: 100_000_000 },
      mempool_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 0 }
    }));
    const rows = await fetchAddressBalances(CHAINS.find((c) => c.id === 'bitcoin')!, BTC_ADDR, SETTINGS);
    expect(rows[0].amount).toBeCloseTo(4.5, 8);
  });
});

describe('fetchAddressBalances — EVM (alchemy)', () => {
  it('fetches native + token balances with metadata decimals', async () => {
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0xde0b6b3a7640000' }; // 1 ETH
      if (method === 'alchemy_getTokenBalances') {
        return {
          result: {
            tokenBalances: [
              { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' }, // 1e8 raw
              { contractAddress: '0xdead000000000000000000000000000000000000', tokenBalance: '0x0' }
            ]
          }
        };
      }
      if (method === 'alchemy_getTokenMetadata') return { result: { symbol: 'WBTC', decimals: 8 } };
      throw new Error(`unexpected method ${method}`);
    });
    const rows = await fetchAddressBalances(CHAINS.find((c) => c.id === 'ethereum')!, ETH_ADDR, SETTINGS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ asset: 'ETH', amount: 1 });
    expect(rows[1]).toEqual({ asset: 'WBTC', contractAddress: WBTC_CONTRACT, amount: 1 });
  });

  it('throws without an alchemy key (local mode)', async () => {
    await expect(
      fetchAddressBalances(CHAINS.find((c) => c.id === 'ethereum')!, ETH_ADDR, {
        ...SETTINGS,
        alchemyApiKey: undefined
      })
    ).rejects.toThrow(/Alchemy API key/);
  });
});

describe('refreshWalletBalancesForAddresses — storage + zero-fill', () => {
  it('stores fetched rows and zero-fills tx-history assets the chain did not return', async () => {
    // Tx history says the address once held ETH + WBTC (+ an NFT).
    await db.transactions.bulkPut([
      tx({ id: 'h1', asset: 'ETH', chain: 'ethereum', walletAddress: ETH_ADDR, source: 'rpc:alchemy' }),
      tx({
        id: 'h2', asset: 'WBTC', chain: 'ethereum', walletAddress: ETH_ADDR,
        source: 'rpc:alchemy', contractAddress: WBTC_CONTRACT
      }),
      tx({
        id: 'h3', asset: 'NFT 0xabc1', chain: 'ethereum', walletAddress: ETH_ADDR,
        source: 'rpc:alchemy', contractAddress: '0xabc1000000000000000000000000000000000000',
        category: 'nft'
      })
    ]);
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' }; // drained native
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [] } }; // no tokens held
      throw new Error(`unexpected method ${method}`);
    });

    const outcome = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((c) => c.id === 'ethereum')!, address: ETH_ADDR }],
      SETTINGS
    );
    expect(outcome.failed).toEqual([]);
    expect(outcome.updated).toBe(1);

    const rows = await getWalletBalances();
    const byAsset = new Map(rows.map((r) => [r.asset, r]));
    expect(byAsset.get('ETH')?.amount).toBe(0); // confirmed zero, not absent
    expect(byAsset.get('WBTC')?.amount).toBe(0); // phantom-killer zero row
    expect(byAsset.has('NFT 0xabc1')).toBe(false); // NFTs never zero-filled
    expect(rows.every((r) => r.source === 'rpc' && r.asOf > 0)).toBe(true);
  });

  it('zeroes previously stored assets that vanish from a later fetch', async () => {
    await db.walletBalances.put({
      id: `bitcoin:${BTC_ADDR}:BTC`, chain: 'bitcoin', address: BTC_ADDR,
      asset: 'BTC', amount: 32.65574623, asOf: 1, source: 'rpc'
    });
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 1000 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    const outcome = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((c) => c.id === 'bitcoin')!, address: BTC_ADDR }],
      SETTINGS
    );
    expect(outcome.updated).toBe(1);
    const rows = await getWalletBalances();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(0);
  });

  it('a failed fetch keeps prior balances and reports the failure', async () => {
    await db.walletBalances.put({
      id: `bitcoin:${BTC_ADDR}:BTC`, chain: 'bitcoin', address: BTC_ADDR,
      asset: 'BTC', amount: 1.25, asOf: 1, source: 'rpc'
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 }) as Response));
    const outcome = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((c) => c.id === 'bitcoin')!, address: BTC_ADDR }],
      SETTINGS
    );
    expect(outcome.updated).toBe(0);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].message).toMatch(/502/);
    const rows = await getWalletBalances();
    expect(rows[0].amount).toBe(1.25); // untouched
  });
});

describe('refreshWalletBalances — all watched addresses', () => {
  it('refreshes every lookupAddresses row and skips unsupported chains', async () => {
    await db.lookupAddresses.bulkPut([
      { id: `bitcoin:${BTC_ADDR}`, chain: 'bitcoin', address: BTC_ADDR, lastSyncedAt: 1, txCount: 5 },
      { id: 'starknet:0xabc', chain: 'starknet', address: '0xabc', lastSyncedAt: 1, txCount: 1 }
    ]);
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 200_000_000, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    const outcome = await refreshWalletBalances(SETTINGS);
    expect(outcome.updated).toBe(1);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].chain).toBe('starknet');
    const rows = await getWalletBalances();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBeCloseTo(2, 8);
  });
});
