import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  db,
  getAuthorityAssetsForSnapshot,
  getWalletBalances,
  upsertLookupAddress
} from '@/lib/storage/db';
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
const SOL_ADDR = 'AbCdEfGhijkLmnoPqrstUvWxYz123456789ABCDE';
const SOL_MINT = 'MintCaseSensitive1111111111111111111111111';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

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
function stubFetch(handler: (url: string, method?: string, params?: unknown[]) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let method: string | undefined;
    let params: unknown[] | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(String(init.body));
        method = body.method;
        params = body.params;
      } catch { /* not json */ }
    }
    const result = handler(url, method, params);
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => result } as Response;
  }));
}

async function watch(chain: string, address: string) {
  await db.lookupAddresses.put({
    id: `${chain}:${address}`, chain, address, lastSyncedAt: 1, txCount: 0
  });
}

beforeEach(async () => {
  await db.walletBalances.clear();
  await db.transactions.clear();
  await db.lots.clear();
  await db.disposals.clear();
  await db.lookupAddresses.clear();
  await db.authoritySnapshots.clear();
  await db.authorityAssets.clear();
  await db.sourceCoverage.clear();
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

  it('deduplicates identical Alchemy token rows instead of summing them', async () => {
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' },
        { contractAddress: WBTC_CONTRACT.toUpperCase(), tokenBalance: '0x5F5E100' }
      ] } };
      if (method === 'alchemy_getTokenMetadata') return { result: { symbol: 'WBTC', decimals: 8 } };
      throw new Error(`unexpected method ${method}`);
    });

    const rows = await fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'ethereum')!, ETH_ADDR, SETTINGS
    );
    expect(rows.find((row) => row.contractAddress === WBTC_CONTRACT)?.amount).toBe(1);
  });

  it('marks conflicting duplicate token rows partial and records no authoritative quantity', async () => {
    await watch('ethereum', ETH_ADDR);
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' },
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0xbebc200' }
      ] } };
      throw new Error(`unexpected method ${method}`);
    });

    const result = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot.status).toBe('partial');
    expect(await getAuthorityAssetsForSnapshot(snapshot.snapshotId)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKey: `evm:1:${WBTC_CONTRACT}` })
    ]));
    expect((await db.sourceCoverage.toArray())[0].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: expect.stringContaining('alchemy_getTokenBalances'), required: true,
        status: 'failed', observedContractAddress: WBTC_CONTRACT, quantityResolved: false
      })
    ]));
  });

  it('throws without an alchemy key (local mode)', async () => {
    await expect(
      fetchAddressBalances(CHAINS.find((c) => c.id === 'ethereum')!, ETH_ADDR, {
        ...SETTINGS,
        alchemyApiKey: undefined
      })
    ).rejects.toThrow(/Alchemy API key/);
  });

  it.each([
    ['missing native result', (_method: string) => ({ jsonrpc: '2.0', id: 1 })],
    ['malformed native hex', (_method: string) => ({ result: 'not-hex' })],
    ['malformed token list', (method: string) => method === 'eth_getBalance'
      ? { result: '0x0' } : { result: { tokenBalances: null } }]
  ])('rejects HTTP-200 %s instead of converting it to zero', async (_label, response) => {
    stubFetch((_url, method) => response(method ?? ''));
    await expect(fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'ethereum')!, ETH_ADDR, SETTINGS
    )).rejects.toThrow(/missing result|malformed/i);
  });

  it('follows token pageKey pagination through exhaustion and retains a later-page token', async () => {
    const laterContract = '0x00000000000000000000000000000000000000bb';
    stubFetch((_url, method, params) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') {
        const cursor = (params?.[2] as { pageKey?: string } | undefined)?.pageKey;
        return cursor
          ? { result: { tokenBalances: [{ contractAddress: laterContract, tokenBalance: '0x3b9aca00' }] } }
          : { result: { tokenBalances: [], pageKey: 'page-2' } };
      }
      if (method === 'alchemy_getTokenMetadata') return { result: { symbol: 'LATER', decimals: 9 } };
      throw new Error(`unexpected method ${method}`);
    });
    const rows = await fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'ethereum')!, ETH_ADDR, SETTINGS
    );
    expect(rows).toEqual([
      { asset: 'ETH', amount: 0 },
      { asset: 'LATER', contractAddress: laterContract, amount: 1 }
    ]);

    await watch('ethereum', ETH_ADDR);
    await db.walletBalances.put({
      id: 'prior-later', chain: 'ethereum', address: ETH_ADDR, asset: 'LATER',
      contractAddress: laterContract, amount: 8, asOf: 1, source: 'rpc'
    });
    await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect((await getWalletBalances()).find((row) => row.contractAddress === laterContract)?.amount).toBe(1);
    expect((await db.sourceCoverage.toArray())[0].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: expect.stringContaining('alchemy_getTokenBalances'),
        paginationRequired: true, paginationExhausted: true, pages: 2, status: 'complete'
      })
    ]));
  });

  it('exhausts more than 40 positive token quantities through a bounded metadata queue', async () => {
    const contracts = Array.from({ length: 41 }, (_, index) =>
      `0x${(index + 1).toString(16).padStart(40, '0')}`);
    let activeMetadata = 0;
    let maxActiveMetadata = 0;
    stubFetch(async (_url, method, params) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') {
        return { result: { tokenBalances: contracts.map((contractAddress) => ({
          contractAddress, tokenBalance: '0x64'
        })) } };
      }
      if (method === 'alchemy_getTokenMetadata') {
        activeMetadata++;
        maxActiveMetadata = Math.max(maxActiveMetadata, activeMetadata);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeMetadata--;
        return { result: { symbol: `T${contracts.indexOf(String(params?.[0]))}`, decimals: 2 } };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const rows = await fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'ethereum')!, ETH_ADDR, SETTINGS
    );
    expect(rows).toHaveLength(42);
    expect(rows.slice(1).every((row) => row.amount === 1)).toBe(true);
    expect(maxActiveMetadata).toBeLessThanOrEqual(8);
  });

  it('isolates unresolved decimals while keeping resolved balance authority exhaustive', async () => {
    const unresolved = '0x00000000000000000000000000000000000000cc';
    await watch('ethereum', ETH_ADDR);
    await db.walletBalances.put({
      id: `ethereum:${ETH_ADDR}:UNKNOWN`, chain: 'ethereum', address: ETH_ADDR,
      asset: 'UNKNOWN', contractAddress: unresolved, amount: 7, asOf: 1, source: 'rpc'
    });
    stubFetch((_url, method, params) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' },
        { contractAddress: unresolved, tokenBalance: '0x2a' }
      ] } };
      if (method === 'alchemy_getTokenMetadata') {
        return params?.[0] === unresolved
          ? { result: { symbol: 'UNKNOWN', decimals: null } }
          : { result: { symbol: 'WBTC', decimals: 8 } };
      }
      throw new Error(`unexpected method ${method}`);
    });

    expect(await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    )).toMatchObject({ updated: 1, failed: [] });
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot).toMatchObject({
      status: 'complete', endpointProof: expect.objectContaining({ exhaustiveBalances: true })
    });
    const authority = await getAuthorityAssetsForSnapshot(snapshot.snapshotId);
    expect(authority).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKey: `evm:1:${WBTC_CONTRACT}`, quantity: 1 })
    ]));
    expect(authority).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKey: `evm:1:${unresolved}` })
    ]));
    expect((await getWalletBalances()).find((row) => row.contractAddress === unresolved)?.amount).toBe(7);
    expect((await db.sourceCoverage.toArray())[0].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: expect.stringContaining(unresolved), status: 'failed', required: false,
        observedContractAddress: unresolved, observedRawQuantity: '0x2a', quantityResolved: false
      })
    ]));
  });

  it('retains valid page quantities when a sibling token row is malformed', async () => {
    await watch('ethereum', ETH_ADDR);
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' },
        { contractAddress: 'not-a-contract', tokenBalance: '0x2a' }
      ] } };
      if (method === 'alchemy_getTokenMetadata') return { result: { symbol: 'WBTC', decimals: 8 } };
      throw new Error(`unexpected method ${method}`);
    });

    await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot.status).toBe('partial');
    expect(await getAuthorityAssetsForSnapshot(snapshot.snapshotId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKey: `evm:1:${WBTC_CONTRACT}`, quantity: 1 })
    ]));
    expect((await db.sourceCoverage.toArray())[0].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: expect.stringContaining('alchemy_getTokenBalances'), status: 'failed',
        warning: expect.stringContaining('1 malformed token balance row')
      })
    ]));
  });

  it('uses a stable contract label when optional symbol metadata is malformed', async () => {
    await watch('ethereum', ETH_ADDR);
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [
        { contractAddress: WBTC_CONTRACT, tokenBalance: '0x5f5e100' }
      ] } };
      if (method === 'alchemy_getTokenMetadata') return { result: { symbol: 123, decimals: 8 } };
      throw new Error(`unexpected method ${method}`);
    });

    await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect((await db.authoritySnapshots.toArray())[0]).toMatchObject({
      status: 'complete', endpointProof: expect.objectContaining({ exhaustiveBalances: true })
    });
    expect((await getWalletBalances()).find((row) => row.contractAddress === WBTC_CONTRACT)?.asset)
      .toBe('0x2260…c599');
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      status: 'complete', failedCount: 0,
      endpointOutcomes: expect.arrayContaining([
        expect.objectContaining({ endpoint: expect.stringContaining(':symbol'), required: false, status: 'failed' })
      ])
    });
  });

  it('records partial pagination and preserves prior v10 balances when a later page fails', async () => {
    await watch('ethereum', ETH_ADDR);
    await db.walletBalances.put({
      id: 'prior-token', chain: 'ethereum', address: ETH_ADDR, asset: 'OLD',
      contractAddress: WBTC_CONTRACT, amount: 7, asOf: 1, source: 'rpc'
    });
    stubFetch((_url, method, params) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') {
        return params?.[2]
          ? { error: { code: -32000, message: 'page two failed' } }
          : { result: { tokenBalances: [], pageKey: 'page-2' } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const result = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getWalletBalances())[0]).toMatchObject({ amount: 7, asset: 'OLD' });
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      status: 'partial', endpointOutcomes: expect.arrayContaining([
        expect.objectContaining({
          endpoint: expect.stringContaining('alchemy_getTokenBalances'), status: 'failed',
          paginationRequired: true, paginationExhausted: false, pages: 1
        })
      ])
    });
  });
});

describe('fetchAddressBalances — Solana completeness', () => {
  it('requires both token programs and aggregates exact case-sensitive mint identity', async () => {
    stubFetch((_url, method, params) => {
      if (method === 'getBalance') return { result: { value: 1_000_000_000 } };
      if (method === 'getTokenAccountsByOwner') {
        const program = (params?.[1] as { programId?: string })?.programId;
        return { result: { value: [{ account: { data: { parsed: { info: {
          mint: SOL_MINT, tokenAmount: { uiAmount: program === TOKEN_2022_PROGRAM ? 2 : 1 }
        } } } } }] } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const rows = await fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'solana')!, SOL_ADDR, SETTINGS
    );
    expect(rows).toEqual([
      { asset: 'SOL', amount: 1 },
      expect.objectContaining({ contractAddress: SOL_MINT, amount: 3 })
    ]);
  });

  it('rejects malformed parsed token amounts instead of claiming exhaustive coverage', async () => {
    stubFetch((_url, method) => method === 'getBalance'
      ? { result: { value: 0 } }
      : { result: { value: [{ account: { data: { parsed: { info: {
        mint: SOL_MINT, tokenAmount: { uiAmount: null }
      } } } } }] } });
    await expect(fetchAddressBalances(
      CHAINS.find((chain) => chain.id === 'solana')!, SOL_ADDR, SETTINGS
    )).rejects.toThrow(/malformed/i);
  });
});

describe('refreshWalletBalancesForAddresses — storage + zero-fill', () => {
  it('stores fetched rows and zero-fills tx-history assets the chain did not return', async () => {
    await watch('ethereum', ETH_ADDR);
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
    await db.lots.put({
      id: 'lot-before', asset: 'ETH', acquiredAt: 1, amountRemaining: 1, amountOriginal: 1,
      costBasisPerUnit: 100, costBasisTotal: 100, sourceTxId: 'h1', acquisitionType: 'buy'
    });
    await db.disposals.put({
      id: 'disposal-before', asset: 'ETH', disposedAt: 2, amount: 1, proceeds: 200,
      costBasis: 100, gain: 100, holdingPeriodDays: 1,
      lotConsumption: [{ lotId: 'lot-before', amount: 1, costBasis: 100 }],
      sourceTxId: 'h1', method: 'FIFO'
    });
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
    expect(outcome.completed).toEqual([{
      address: ETH_ADDR,
      chain: 'ethereum',
      custodySnapshotId: `ethereum:${ETH_ADDR}:rpc:1`
    }]);

    const rows = await getWalletBalances();
    const byAsset = new Map(rows.map((r) => [r.asset, r]));
    expect(byAsset.get('ETH')?.amount).toBe(0); // confirmed zero, not absent
    expect(byAsset.get('WBTC')?.amount).toBe(0); // phantom-killer zero row
    expect(byAsset.has('NFT 0xabc1')).toBe(false); // NFTs never zero-filled
    expect(rows.every((r) => r.source === 'rpc' && r.asOf > 0)).toBe(true);
    expect(await db.transactions.count()).toBe(3);
    expect(await db.lots.get('lot-before')).toMatchObject({ amountRemaining: 1, costBasisTotal: 100 });
    expect(await db.disposals.get('disposal-before')).toMatchObject({ gain: 100, sourceTxId: 'h1' });

    const source = await db.lookupAddresses.get(`ethereum:${ETH_ADDR}`);
    expect(source).toMatchObject({ authorityGeneration: 1, revision: 2 });
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot).toMatchObject({
      generation: 1,
      scopeId: `wallet:evm:1:${ETH_ADDR.toLowerCase()}`,
      authorityKind: 'rpc',
      authorityClass: 'wallet_balance',
      accountClass: 'wallet',
      status: 'complete',
      asOf: snapshot.capturedAt,
      endpointProof: expect.objectContaining({
        provider: 'alchemy', exhaustiveBalances: true,
        operation: 'eth_getBalance+alchemy_getTokenBalances+alchemy_getTokenMetadata'
      })
    });
    expect(await getAuthorityAssetsForSnapshot(snapshot.snapshotId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: 'ETH', assetKey: 'evm:1:native', quantity: 0 }),
      expect.objectContaining({ asset: 'WBTC', assetKey: `evm:1:${WBTC_CONTRACT}`, quantity: 0 })
    ]));
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      generation: 1, status: 'complete', authoritySnapshotId: snapshot.snapshotId,
      accountClasses: ['wallet'], failedCount: 0
    });
  });

  it('finishes zero-fill beyond the former safety cap before claiming completeness', async () => {
    await watch('ethereum', ETH_ADDR);
    await db.transactions.bulkPut(Array.from({ length: 101 }, (_, index) => tx({
      id: `history-${index}`, asset: `TOKEN${index}`, chain: 'ethereum', walletAddress: ETH_ADDR,
      source: 'rpc:alchemy', contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`
    })));
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0x0' };
      if (method === 'alchemy_getTokenBalances') return { result: { tokenBalances: [] } };
      throw new Error(`unexpected method ${method}`);
    });

    await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect(await getWalletBalances()).toHaveLength(102);
    expect(await db.authorityAssets.count()).toBe(102);
    expect((await db.authoritySnapshots.toArray())[0]).toMatchObject({
      status: 'complete', endpointProof: expect.objectContaining({ exhaustiveBalances: true })
    });
  });

  it('zeroes previously stored assets that vanish from a later fetch', async () => {
    await watch('bitcoin', BTC_ADDR);
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

  it('keeps exhaustive balance authority while atomically linking partial history coverage', async () => {
    await watch('bitcoin', BTC_ADDR);
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 100_000_000, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    const outcome = await refreshWalletBalancesForAddresses([{
      chain: CHAINS.find((chain) => chain.id === 'bitcoin')!,
      address: BTC_ADDR,
      historyEndpointOutcomes: [{
        endpoint: 'bitcoin:history:blockstream:transactions', accountClass: 'wallet',
        required: true, status: 'partial', paginationRequired: true,
        paginationExhausted: false, pages: 3, warning: 'page four failed'
      }]
    }], SETTINGS);

    expect(outcome).toMatchObject({ updated: 1, failed: [] });
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot).toMatchObject({
      status: 'complete', endpointProof: expect.objectContaining({ exhaustiveBalances: true })
    });
    expect((await getWalletBalances())[0]).toMatchObject({ asset: 'BTC', amount: 1 });
    expect(await db.sourceCoverage.toArray()).toEqual([
      expect.objectContaining({
        authoritySnapshotId: snapshot.snapshotId,
        status: 'partial',
        endpointOutcomes: expect.arrayContaining([
          expect.objectContaining({ endpoint: 'bitcoin:history:blockstream:transactions', status: 'partial' }),
          expect.objectContaining({ status: 'complete' })
        ])
      })
    ]);
  });

  it('a failed fetch keeps prior balances and reports the failure', async () => {
    await watch('bitcoin', BTC_ADDR);
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 125_000_000, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    const entry = [{
      chain: CHAINS.find((chain) => chain.id === 'bitcoin')!, address: BTC_ADDR,
      historyEndpointOutcomes: [{
        endpoint: 'bitcoin:history:blockstream:transactions', accountClass: 'wallet' as const,
        required: true, status: 'complete' as const, paginationRequired: true,
        paginationExhausted: true, pages: 4
      }]
    }];
    expect((await refreshWalletBalancesForAddresses(entry, SETTINGS)).updated).toBe(1);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 }) as Response));
    const outcome = await refreshWalletBalancesForAddresses(entry, SETTINGS);
    expect(outcome.updated).toBe(0);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].message).toMatch(/502/);
    const rows = await getWalletBalances();
    expect(rows[0].amount).toBe(1.25); // untouched
    expect(await db.authoritySnapshots.count()).toBe(1);
    const coverage = await db.sourceCoverage.orderBy('generation').toArray();
    expect(coverage).toHaveLength(2);
    expect(coverage[0]).toMatchObject({ generation: 1, status: 'complete' });
    expect(coverage[1]).toMatchObject({ generation: 2, status: 'failed', failureKind: 'provider' });
    expect(coverage[1].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: 'bitcoin:history:blockstream:transactions', status: 'complete' }),
      expect.objectContaining({ status: 'failed' })
    ]));
    expect(coverage[1]).not.toHaveProperty('authoritySnapshotId');
  });

  it('persists coverage-only history when the balance provider is unsupported', async () => {
    await watch('starknet', '0xabc');
    const result = await refreshWalletBalancesForAddresses([{
      chain: CHAINS.find((chain) => chain.id === 'starknet')!, address: '0xabc',
      historyEndpointOutcomes: [{
        endpoint: 'starknet:history:custom', accountClass: 'wallet', required: true,
        status: 'complete', paginationRequired: true, paginationExhausted: true, pages: 3
      }]
    }], SETTINGS);

    expect(result).toMatchObject({ updated: 0, skipped: [expect.objectContaining({ chain: 'starknet' })] });
    expect(await db.walletBalances.count()).toBe(0);
    expect(await db.authoritySnapshots.count()).toBe(0);
    expect(await db.sourceCoverage.toArray()).toEqual([
      expect.objectContaining({
        status: 'complete',
        endpointOutcomes: [expect.objectContaining({ endpoint: 'starknet:history:custom' })]
      })
    ]);
    expect((await db.sourceCoverage.toArray())[0]).not.toHaveProperty('authoritySnapshotId');
  });

  it('links successive immutable generations and preserves confirmed zeroes', async () => {
    await watch('bitcoin', BTC_ADDR);
    let funded = 200_000_000;
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: funded, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    const entry = [{ chain: CHAINS.find((chain) => chain.id === 'bitcoin')!, address: BTC_ADDR }];
    expect((await refreshWalletBalancesForAddresses(entry, SETTINGS)).updated).toBe(1);
    funded = 0;
    expect((await refreshWalletBalancesForAddresses(entry, SETTINGS)).updated).toBe(1);

    const snapshots = await db.authoritySnapshots.orderBy('generation').toArray();
    expect(snapshots.map((snapshot) => snapshot.generation)).toEqual([1, 2]);
    expect(snapshots[1].supersedesSnapshotId).toBe(snapshots[0].snapshotId);
    expect((await getAuthorityAssetsForSnapshot(snapshots[1].snapshotId))[0]).toMatchObject({
      assetKey: 'bitcoin:native', quantity: 0
    });
    expect(await db.lookupAddresses.get(`bitcoin:${BTC_ADDR}`)).toMatchObject({
      authorityGeneration: 2, revision: 4
    });
  });

  it('records partial per-request coverage and coherent assets without replacing v10 balances', async () => {
    await watch('ethereum', ETH_ADDR);
    await db.walletBalances.put({
      id: `ethereum:${ETH_ADDR}:ETH`, chain: 'ethereum', address: ETH_ADDR,
      asset: 'ETH', amount: 9, asOf: 1, source: 'rpc'
    });
    stubFetch((_url, method) => {
      if (method === 'eth_getBalance') return { result: '0xde0b6b3a7640000' };
      if (method === 'alchemy_getTokenBalances') return { error: { code: -32000, message: 'token outage' } };
      throw new Error(`unexpected method ${method}`);
    });

    const result = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'ethereum')!, address: ETH_ADDR }], SETTINGS
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getWalletBalances())[0].amount).toBe(9);
    const snapshot = (await db.authoritySnapshots.toArray())[0];
    expect(snapshot).toMatchObject({ status: 'partial', endpointProof: expect.objectContaining({ exhaustiveBalances: false }) });
    expect(await getAuthorityAssetsForSnapshot(snapshot.snapshotId)).toEqual([
      expect.objectContaining({ assetKey: 'evm:1:native', quantity: 1 })
    ]);
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      status: 'partial', endpointOutcomes: [
        expect.objectContaining({ status: 'complete' }),
        expect.objectContaining({ status: 'failed', warning: 'token outage' })
      ]
    });
  });

  it('drops an in-flight result after wallet deletion without writing evidence or balances', async () => {
    await watch('bitcoin', BTC_ADDR);
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => pending));
    const refresh = refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'bitcoin')!, address: BTC_ADDR }], SETTINGS
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await db.lookupAddresses.delete(`bitcoin:${BTC_ADDR}`);
    resolveFetch({
      ok: true, status: 200, json: async () => ({
        chain_stats: { funded_txo_sum: 100_000_000, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
      })
    } as Response);

    expect((await refresh).failed[0].message).toMatch(/changed/);
    expect(await db.walletBalances.count()).toBe(0);
    expect(await db.authoritySnapshots.count()).toBe(0);
    expect(await db.sourceCoverage.count()).toBe(0);
  });

  it('rejects an old response after delete/re-add while the new incarnation refresh succeeds', async () => {
    await upsertLookupAddress('bitcoin', BTC_ADDR, 0);
    const firstIncarnation = (await db.lookupAddresses.get(`bitcoin:${BTC_ADDR}`))!.sourceIncarnation;
    let resolveOld!: (response: Response) => void;
    const oldPending = new Promise<Response>((resolve) => { resolveOld = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => oldPending));
    const entry = [{ chain: CHAINS.find((chain) => chain.id === 'bitcoin')!, address: BTC_ADDR }];
    const oldRefresh = refreshWalletBalancesForAddresses(entry, SETTINGS);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await db.lookupAddresses.delete(`bitcoin:${BTC_ADDR}`);
    await upsertLookupAddress('bitcoin', BTC_ADDR, 0);
    const secondIncarnation = (await db.lookupAddresses.get(`bitcoin:${BTC_ADDR}`))!.sourceIncarnation;
    expect(secondIncarnation).not.toBe(firstIncarnation);
    stubFetch(() => ({
      chain_stats: { funded_txo_sum: 200_000_000, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
    }));
    expect((await refreshWalletBalancesForAddresses(entry, SETTINGS)).updated).toBe(1);

    resolveOld({
      ok: true, status: 200, json: async () => ({
        chain_stats: { funded_txo_sum: 900_000_000, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }
      })
    } as Response);
    expect((await oldRefresh).failed[0].message).toMatch(/changed/);
    expect((await getWalletBalances())[0].amount).toBe(2);
    expect(await db.authoritySnapshots.count()).toBe(1);
  });

  it('keeps v10 anchors when Token-2022 is unsupported and records partial coverage', async () => {
    await watch('solana', SOL_ADDR);
    await db.walletBalances.put({
      id: 'solana:prior', chain: 'solana', address: SOL_ADDR, asset: 'SOL', amount: 9, asOf: 1, source: 'rpc'
    });
    stubFetch((_url, method, params) => {
      if (method === 'getBalance') return { result: { value: 1_000_000_000 } };
      const program = (params?.[1] as { programId?: string })?.programId;
      if (program === TOKEN_2022_PROGRAM) return { error: { code: -32602, message: 'unsupported program' } };
      return { result: { value: [] } };
    });
    const result = await refreshWalletBalancesForAddresses(
      [{ chain: CHAINS.find((chain) => chain.id === 'solana')!, address: SOL_ADDR }], SETTINGS
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getWalletBalances())[0].amount).toBe(9);
    expect((await db.authoritySnapshots.toArray())[0]).toMatchObject({
      status: 'partial', endpointProof: expect.objectContaining({ exhaustiveBalances: false })
    });
    expect((await db.sourceCoverage.toArray())[0].endpointOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: expect.stringContaining(TOKEN_2022_PROGRAM), status: 'failed' })
    ]));
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
