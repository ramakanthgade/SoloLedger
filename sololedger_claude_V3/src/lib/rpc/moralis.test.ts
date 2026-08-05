import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMode } from '@/lib/saas/mode';
import { fetchMoralisEvm, moralisTxToRows, type MoralisTransaction } from './moralis';

const wallet = '0x1111111111111111111111111111111111111111';
const txBase: MoralisTransaction = {
  hash: '0xhash',
  block_timestamp: '2026-01-01T00:00:00.000Z',
  from_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  to_address: wallet,
  value: '0',
  receipt_status: '1',
  category: 'receive',
  summary: 'Received native assets',
  possible_spam: false,
  erc20_transfers: [],
  native_transfers: [],
  nft_transfers: []
};

describe('Moralis native transfer mapping', () => {
  it('uses each native transfer leg addresses rather than transaction-level parties', () => {
    const legSender = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const [row] = moralisTxToRows({
      ...txBase,
      native_transfers: [{
        from_address: legSender,
        to_address: wallet,
        direction: 'receive',
        value_formatted: '1.25',
        token_symbol: 'ETH'
      }]
    }, wallet, 'ETH', 'ethereum');
    expect(row).toMatchObject({ type: 'transfer_in', counterpartyAddress: legSender, amount: 1.25 });
  });

  it('falls back to transaction-level parties only when a native leg omits them', () => {
    const [row] = moralisTxToRows({
      ...txBase,
      native_transfers: [{
        direction: 'receive',
        value_formatted: '0.5',
        token_symbol: 'ETH'
      }]
    }, wallet, 'ETH', 'ethereum');
    expect(row.counterpartyAddress).toBe(txBase.from_address);
  });

  it('separates ERC-20 event identity from the shared transaction hash', () => {
    const transfer = {
      token_name: 'Token', token_symbol: 'TOK', from_address: txBase.from_address,
      to_address: wallet, address: '0x2222222222222222222222222222222222222222',
      value_formatted: '1', possible_spam: false
    };
    const rows = moralisTxToRows({
      ...txBase, erc20_transfers: [transfer, transfer]
    }, wallet, 'ETH', 'ethereum');

    expect(rows.map((row) => row.sourceRef)).toEqual([
      'moralis:event:0xhash:erc20:0', 'moralis:event:0xhash:erc20:1'
    ]);
    expect(rows.map((row) => row.txHash)).toEqual(['0xhash', '0xhash']);
  });
});

describe('fetchMoralisEvm pagination', () => {
  function response(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    } as Response;
  }

  function historyTx(hash: string, amount: string): MoralisTransaction {
    return {
      ...txBase,
      hash,
      native_transfers: [{
        from_address: txBase.from_address,
        to_address: wallet,
        direction: 'receive',
        value_formatted: amount,
        token_symbol: 'ETH'
      }]
    };
  }

  beforeEach(() => {
    setMode('local');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('follows cursors through exhaustion even when a page contains fewer than the limit', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ result: [historyTx('0xfirst', '1')], cursor: 'next cursor' }))
      .mockResolvedValueOnce(response({ result: [historyTx('0xsecond', '2')], cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.transactions.map((tx) => tx.sourceRef)).toEqual([
      'moralis:event:0xfirst:native:0', 'moralis:event:0xsecond:native:0'
    ]);
    expect(result.transactions.map((tx) => tx.txHash)).toEqual(['0xfirst', '0xsecond']);
    expect(result.warnings).toEqual([]);
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=next%20cursor');
  });

  it('returns accumulated rows with a partial warning when a cursor repeats', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ result: [historyTx('0xfirst', '1')], cursor: 'same' }))
      .mockResolvedValueOnce(response({ result: [historyTx('0xsecond', '2')], cursor: 'same' })));

    const resultPromise = fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.transactions).toHaveLength(2);
    expect(result.warnings).toEqual([
      'Moralis: wallet history is partial because the pagination cursor repeated.'
    ]);
  });

  it('reports a finite page budget as partial rather than silently truncating', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ result: [historyTx('0xfirst', '1')], cursor: 'more' })
    ));

    const result = await fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key', 1);

    expect(result.transactions).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Moralis: wallet history is partial because the 1-page pagination budget was reached.'
    ]);
  });

  it('preserves prior pages and reports a later fetch failure as partial', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ result: [historyTx('0xfirst', '1')], cursor: 'next' }))
      .mockRejectedValueOnce(new Error('network unavailable')));

    const resultPromise = fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.transactions).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Moralis: wallet history is partial because page 2 could not be fetched.'
    ]);
  });

  it('deduplicates a transaction repeated at a cursor boundary before expanding its events', async () => {
    vi.useFakeTimers();
    const boundary = {
      ...txBase,
      hash: '0xboundary',
      erc20_transfers: [
        {
          token_name: 'One', token_symbol: 'ONE', from_address: txBase.from_address,
          to_address: wallet, address: '0x1111111111111111111111111111111111111111',
          value_formatted: '1', possible_spam: false
        },
        {
          token_name: 'Two', token_symbol: 'TWO', from_address: txBase.from_address,
          to_address: wallet, address: '0x2222222222222222222222222222222222222222',
          value_formatted: '2', possible_spam: false
        }
      ]
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ result: [boundary], cursor: 'next' }))
      .mockResolvedValueOnce(response({ result: [boundary, historyTx('0xdistinct', '3')], cursor: null })));

    const resultPromise = fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.transactions.filter((tx) => tx.txHash === '0xboundary')).toHaveLength(2);
    expect(result.transactions.filter((tx) => tx.txHash === '0xdistinct')).toHaveLength(1);
  });

  it('throws a first-page failure so the caller can activate fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, 503)));

    await expect(fetchMoralisEvm(wallet, 'ethereum', 'ETH', 'key'))
      .rejects.toThrow('Moralis: wallet history is partial; returned 503.');
  });
});
