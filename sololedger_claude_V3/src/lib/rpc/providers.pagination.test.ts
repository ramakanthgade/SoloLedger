import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAlchemyEvmInner,
  fetchAlchemySolana,
  fetchBitcoin,
  fetchBlockscoutEthereum,
  fetchEtherscanCompatible
} from './providers';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider history pagination', () => {
  it('paginates realistic Esplora pages by 25 confirmed rows despite initial mempool rows', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      calls.push(String(rawUrl));
      const page = calls.length;
      const confirmedCount = page <= 10 ? 25 : 1;
      const confirmed = Array.from({ length: confirmedCount }, (_, index) => ({
        txid: `tx-${page}-${index}`, status: { confirmed: true, block_time: 1 },
        vin: [], vout: [{ scriptpubkey_address: 'bc1wallet', value: 1 }]
      }));
      return response(page === 1 ? [
        { txid: 'mempool-a', status: { confirmed: false }, vin: [], vout: [] },
        { txid: 'mempool-b', status: { confirmed: false }, vin: [], vout: [] },
        ...confirmed
      ] : confirmed);
    }));

    const result = await fetchBitcoin('bc1wallet', 'https://bitcoin.test/api', 'BTC');

    expect(calls).toHaveLength(11);
    expect(calls[1]).toContain('/txs/chain/tx-1-24');
    expect(calls[10]).toContain('/txs/chain/tx-10-24');
    expect(result.transactions).toHaveLength(253);
    expect(result.streamOutcomes).toEqual([
      expect.objectContaining({ status: 'complete', pages: 11, paginationExhausted: true })
    ]);
  });

  it('paginates all Alchemy Solana signatures and retains a partial later signature page', async () => {
    let signaturePages = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'getSignaturesForAddress') {
        signaturePages++;
        if (signaturePages === 2) return response({ error: { code: 503, message: 'later page failed' } });
        return response({ result: Array.from({ length: 1000 }, (_, index) => ({
          signature: `sig-${index}`, blockTime: 1
        })) });
      }
      return response({ result: {
        transaction: { message: { accountKeys: [] } },
        meta: { preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [] }
      } });
    }));

    const result = await fetchAlchemySolana('sol-wallet', 'key');

    expect(signaturePages).toBe(2);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: 'alchemy:getSignaturesForAddress', status: 'partial', pages: 1,
        termination: 'partial_error'
      })
    ]));
  });

  it('pages both Alchemy directions by pageKey and deduplicates provider event identity', async () => {
    const calls: Array<{ direction: 'from' | 'to'; pageKey?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const params = request.params[0];
      const direction = params.fromAddress ? 'from' : 'to';
      calls.push({ direction, pageKey: params.pageKey });
      if (direction === 'from' && !params.pageKey) {
        return response({ result: { transfers: [{
          uniqueId: 'event-a', hash: '0xa', category: 'external', from: WALLET,
          to: OTHER, value: 1, asset: 'ETH'
        }], pageKey: 'out-2' } });
      }
      if (direction === 'from') {
        return response({ result: { transfers: [{
          uniqueId: 'event-b', hash: '0xb', category: 'external', from: WALLET,
          to: OTHER, value: 2, asset: 'ETH'
        }] } });
      }
      return response({ result: { transfers: [
        {
          uniqueId: 'event-a', hash: '0xa', category: 'external', from: WALLET,
          to: OTHER, value: 1, asset: 'ETH'
        },
        {
          uniqueId: 'event-c', hash: '0xc', category: 'erc721', from: OTHER,
          to: WALLET, value: 1, asset: 'NFT', rawContract: { address: '0xnft' }
        },
        {
          uniqueId: 'event-d', hash: '0xc', category: 'erc721', from: OTHER,
          to: WALLET, value: 1, asset: 'NFT', rawContract: { address: '0xnft' }
        }
      ] } });
    }));

    const result = await fetchAlchemyEvmInner(WALLET, 'eth-mainnet', 'key', 'ETH', 'ethereum');

    expect(calls).toEqual(expect.arrayContaining([
      { direction: 'from', pageKey: undefined },
      { direction: 'from', pageKey: 'out-2' },
      { direction: 'to', pageKey: undefined }
    ]));
    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual([
      '0xa', '0xb', 'alchemy:event:event-c', 'alchemy:event:event-d'
    ]);
    expect(result.transactions.map((tx) => tx.txHash)).toEqual(['0xa', '0xb', '0xc', '0xc']);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: 'alchemy_getAssetTransfers:outgoing', pages: 2,
        status: 'complete', paginationExhausted: true
      }),
      expect.objectContaining({
        endpoint: 'alchemy_getAssetTransfers:incoming', pages: 1,
        status: 'complete', paginationExhausted: true
      })
    ]));
  });

  it('omits Alchemy self-transfers instead of projecting a one-sided outgoing principal', async () => {
    const selfTransfer = {
      uniqueId: 'self-event', hash: '0xself', category: 'erc20', from: WALLET, to: WALLET,
      value: 5, asset: 'TOK', rawContract: { address: '0xcontract' }
    };
    vi.stubGlobal('fetch', vi.fn(async () => response({ result: { transfers: [selfTransfer] } })));

    const result = await fetchAlchemyEvmInner(WALLET, 'eth-mainnet', 'key', 'ETH', 'ethereum');

    expect(result.transactions).toEqual([]);
    expect(result.streamOutcomes?.every((outcome) => outcome.status === 'complete')).toBe(true);
  });

  it('follows Blockscout next_page_params for transactions and token transfers', async () => {
    const urls: string[] = [];
    const native = (hash: string) => ({
      hash, from: { hash: OTHER }, to: { hash: WALLET }, value: '1000000000000000000',
      timestamp: '2026-01-01T00:00:00.000Z'
    });
    const token = {
      transaction_hash: '0xtoken', log_index: 1, from: { hash: OTHER }, to: { hash: WALLET },
      total: { value: '1000000' }, token: { symbol: 'USDC', decimals: '6', address_hash: '0xcontract' },
      timestamp: '2026-01-01T00:00:00.000Z'
    };
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      urls.push(url);
      const later = url.includes('block_number=10');
      if (url.includes('/token-transfers')) {
        return response(later ? { items: [token], next_page_params: null } : {
          items: [token], next_page_params: { block_number: 10 }
        });
      }
      return response(later ? { items: [native('0xnative1'), native('0xnative2')] } : {
        items: [native('0xnative1')], next_page_params: { block_number: 10 }
      });
    }));

    const result = await fetchBlockscoutEthereum(WALLET);

    expect(urls.filter((url) => url.includes('block_number=10'))).toHaveLength(2);
    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual([
      '0xnative1', '0xnative2', 'blockscout:event:0xtoken:log:1'
    ]);
    expect(result.transactions.map((tx) => tx.txHash)).toEqual(['0xnative1', '0xnative2', '0xtoken']);
    expect(result.streamOutcomes?.every((outcome) =>
      outcome.pages === 2 && outcome.paginationExhausted)).toBe(true);
  });

  it('throws when either required Blockscout stream fails on its first page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) =>
      String(rawUrl).includes('/token-transfers')
        ? response({}, 503)
        : response({ items: [] })));

    await expect(fetchBlockscoutEthereum(WALLET))
      .rejects.toThrow('Blockscout returned 503 for /addresses/');
  });

  it('retains Blockscout rows and partial evidence after a later-page failure', async () => {
    const native = {
      hash: '0xretained', from: { hash: OTHER }, to: { hash: WALLET },
      value: '1000000000000000000', timestamp: '2026-01-01T00:00:00.000Z'
    };
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('/token-transfers')) return response({ items: [] });
      if (url.includes('block_number=10')) return response({}, 503);
      return response({ items: [native], next_page_params: { block_number: 10 } });
    }));

    const result = await fetchBlockscoutEthereum(WALLET);

    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual(['0xretained']);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: 'blockscout:transactions', status: 'partial', pages: 1,
        termination: 'partial_error'
      })
    ]));
  });

  it('increments Etherscan-compatible page numbers until a short page', async () => {
    const pages: string[] = [];
    const row = (hash: string) => ({
      hash, blockNumber: '100', from: OTHER, to: WALLET,
      value: '1000000000000000000', timeStamp: '1700000000'
    });
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const action = url.searchParams.get('action');
      const page = url.searchParams.get('page') ?? '';
      pages.push(`${action}:${page}`);
      if (action === 'tokentx') return response({ status: '1', result: [] });
      return response({
        status: '1',
        result: page === '1' ? Array.from({ length: 1000 }, () => row('0xfirst')) : [row('0xsecond')]
      });
    }));

    const result = await fetchEtherscanCompatible(
      WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum'
    );

    expect(pages).toEqual(['txlist:1', 'txlist:2', 'tokentx:1']);
    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual(['0xfirst', '0xsecond']);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: 'etherscan:txlist', pages: 2, paginationExhausted: true }),
      expect.objectContaining({ endpoint: 'etherscan:tokentx', pages: 1, paginationExhausted: true })
    ]));
  });

  it('retains earlier Etherscan pages when a later page returns malformed JSON', async () => {
    const row = (hash: string) => ({
      hash, blockNumber: '100', from: OTHER, to: WALLET,
      value: '1', timeStamp: '1700000000'
    });
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      if (url.searchParams.get('action') === 'tokentx') return response({ status: '1', result: [] });
      if (url.searchParams.get('page') === '2') {
        return new Response('{malformed', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return response({ status: '1', result: Array.from({ length: 1000 }, (_, index) => row(`0x${index}`)) });
    }));

    const result = await fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum');

    expect(result.transactions).toHaveLength(1000);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: 'etherscan:txlist', status: 'partial', pages: 1 })
    ]));
  });

  it('fails an Etherscan stream whose first page returns malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{malformed', { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum'))
      .rejects.toThrow();
  });

  it('splits a saturated Etherscan range into inclusive non-overlapping children without skipping the boundary', async () => {
    const windows: string[] = [];
    const row = (hash: string, blockNumber: string) => ({
      hash, blockNumber, from: OTHER, to: WALLET,
      value: '1000000000000000000', timeStamp: '1700000000'
    });
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      const action = url.searchParams.get('action');
      if (action === 'tokentx') return response({ status: '1', result: [] });
      const page = url.searchParams.get('page')!;
      const startBlock = url.searchParams.get('startblock')!;
      const endBlock = url.searchParams.get('endblock')!;
      windows.push(`${startBlock}-${endBlock}:${page}`);
      if (startBlock !== '0' || endBlock !== '99999999') {
        return response({ status: '1', result: [
          startBlock === '50000000' ? row('0xupper-boundary', '50000000') : row('0xlower-boundary', '49999999')
        ] });
      }
      return response({
        status: '1', result: Array.from({ length: 1000 }, (_, index) =>
          row(`0xprobe-${page}-${index}`, index % 2 ? '49999999' : '50000000'))
      });
    }));

    const result = await fetchEtherscanCompatible(
      WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum'
    );

    expect(windows).toContain('0-99999999:10');
    expect(windows).toContain('50000000-99999999:1');
    expect(windows).toContain('0-49999999:1');
    expect(windows).not.toContain('0-99999999:11');
    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual([
      '0xupper-boundary', '0xlower-boundary'
    ]);
  });

  it('marks a stream partial when one block alone exceeds the 10,000-result cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      if (url.searchParams.get('action') === 'tokentx') return response({ status: '1', result: [] });
      const start = url.searchParams.get('startblock')!;
      const end = url.searchParams.get('endblock')!;
      const page = url.searchParams.get('page')!;
      if (start === '101') return response({ status: '1', result: [] });
      if (Number(end) < 100) return response({ status: '1', result: [] });
      return response({ status: '1', result: Array.from({ length: 1000 }, (_, index) => ({
        hash: `0x${page}-${index}`, blockNumber: '100', from: OTHER, to: WALLET,
        value: '1', timeStamp: '1700000000'
      })) });
    }));

    const result = await fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum');

    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpoint: 'etherscan:txlist', status: 'partial', paginationExhausted: false,
        warning: expect.stringContaining('Block 100 alone exceeds')
      })
    ]));
    // Parent and exact-block probes overlap; validated rows survive once.
    expect(result.transactions).toHaveLength(10_000);
  });

  it('preserves identical same-contract tokentx occurrences without logIndex using stable source refs', async () => {
    const tokenRow = {
      hash: '0xsame', blockNumber: '42', transactionIndex: '3', contractAddress: '0xcontract',
      from: OTHER, to: WALLET, value: '100', tokenDecimal: '2', tokenSymbol: 'TOK', timeStamp: '1700000000'
    };
    const indexedRow = { ...tokenRow, hash: '0xindexed', logIndex: '7' };
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const action = new URL(String(rawUrl)).searchParams.get('action');
      return response({
        status: '1',
        result: action === 'tokentx' ? [tokenRow, tokenRow, indexedRow, indexedRow] : []
      });
    }));

    const first = await fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum');
    const second = await fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum');
    const firstRefs = first.transactions.map((tx) => tx.sourceRef);

    expect(first.transactions).toHaveLength(3);
    expect(new Set(firstRefs).size).toBe(3);
    expect(second.transactions.map((tx) => tx.sourceRef)).toEqual(firstRefs);
    expect(first.transactions.map((tx) => tx.txHash)).toEqual(['0xsame', '0xsame', '0xindexed']);
  });

  it('retains a lower Etherscan child after a recursive upper child becomes partial', async () => {
    const row = (hash: string, blockNumber: string) => ({
      hash, blockNumber, from: OTHER, to: WALLET, value: '1', timeStamp: '1700000000'
    });
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      if (url.searchParams.get('action') === 'tokentx') return response({ status: '1', result: [] });
      const start = url.searchParams.get('startblock')!;
      const end = url.searchParams.get('endblock')!;
      if (start === '50000000') return response({ message: 'upper child failed' }, 503);
      if (start === '0' && end === '49999999') {
        return response({ status: '1', result: [row('0xretained-lower', '42')] });
      }
      return response({
        status: '1', result: Array.from({ length: 1000 }, (_, index) =>
          row(`0xprobe-${url.searchParams.get('page')}-${index}`, index % 2 ? '49999999' : '50000000'))
      });
    }));

    const result = await fetchEtherscanCompatible(WALLET, 'https://example.test/api', 'key', 'ETH', 'ethereum');

    expect(result.transactions.map((tx) => tx.sourceRef)).toContain('0xretained-lower');
    expect(result.transactions.map((tx) => tx.sourceRef)).toContain('0xprobe-1-0');
    expect(new Set(result.transactions.map((tx) => tx.sourceRef)).size).toBe(result.transactions.length);
    expect(result.streamOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: 'etherscan:txlist', status: 'partial' })
    ]));
  });
});
