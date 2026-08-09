import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BITVAVO_NATIVE_TRADE_CURSOR_CONTRACT,
  bitvavoUncoveredTaskRanges,
  bitvavoTransferDisposition,
  bitvavoTransferIdentityEvidence,
  mergeBitvavoPendingTransferEvidence,
  paginateBitvavoAccountHistory,
  paginateBitvavoTrades,
  paginateBitvavoTransfers,
  validBitvavoPersistedState
} from './bitvavo';
import { loadCcxt, type ExchangeClient, type UnifiedTrade, type UnifiedTransfer } from './ccxtLoader';
import { DEFAULT_SETTINGS, transactionExchangeKey } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import {
  normalizeBitvavoAccountTrade,
  normalizeTrade,
  normalizeTransfer,
  reconcileBitvavoAccountTrades
} from './normalize';

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Bitvavo pinned CCXT signing and parser', () => {
  it('does not recreate a parent range already represented by adaptive descendants', () => {
    const tasks = [
      { symbol: 'BTC/EUR', start: 0, end: 4, tradeIdTo: UUID(1) },
      { symbol: 'BTC/EUR', start: 5, end: 10 },
      { symbol: 'ETH/EUR', start: 0, end: 10 }
    ];
    expect(bitvavoUncoveredTaskRanges('BTC/EUR', 0, 10, tasks)).toEqual([]);
    expect(bitvavoUncoveredTaskRanges('BTC/EUR', 0, 12, tasks)).toEqual([{ start: 11, end: 12 }]);
    expect(bitvavoUncoveredTaskRanges('ETH/BTC', 0, 2, tasks)).toEqual([{ start: 0, end: 2 }]);
    expect(tasks[0].tradeIdTo).toBe(UUID(1));
  });

  it('accepts stale parent association evidence when resumed bisection children overlap the candidate', () => {
    expect(validBitvavoPersistedState({
      bitvavoProgress: { trades: { requestedEnd: 10, tasks: [
        { symbol: 'BTC/EUR', start: 0, end: 4 },
        { symbol: 'BTC/EUR', start: 5, end: 10 }
      ] } },
      bitvavoPendingAccountCandidates: [{
        transactionId: 'account-parent', timestamp: 5, association: 'resolved_market', symbol: 'BTC/EUR',
        intervalStart: 0, intervalEnd: 10, taskIdentities: ['BTC/EUR|0|10'], economics: {
          transactionId: 'account-parent', executedAt: new Date(5).toISOString(), type: 'buy',
          sentCurrency: 'EUR', sentAmount: 10, receivedCurrency: 'BTC', receivedAmount: 0.001, feesAmount: 0
        }
      }]
    })).toBe(true);
  });

  it.each([
    ['no trade progress', undefined],
    ['non-overlapping same-symbol progress', { requestedEnd: 10, tasks: [{ symbol: 'BTC/EUR', start: 6, end: 9 }] }],
    ['overlapping other-symbol progress', { requestedEnd: 10, tasks: [{ symbol: 'ETH/EUR', start: 1, end: 5 }] }]
  ])('rejects a resolved candidate with %s despite valid stale parent evidence', (_label, trades) => {
    expect(validBitvavoPersistedState({
      bitvavoProgress: trades ? { trades } : undefined,
      bitvavoPendingAccountCandidates: [{
        transactionId: 'account-parent', timestamp: 3, association: 'resolved_market', symbol: 'BTC/EUR',
        intervalStart: 1, intervalEnd: 5, taskIdentities: ['BTC/EUR|1|5'], economics: {
          transactionId: 'account-parent', executedAt: new Date(3).toISOString(), type: 'buy',
          sentCurrency: 'EUR', sentAmount: 10, receivedCurrency: 'BTC', receivedAmount: 0.001, feesAmount: 0
        }
      }]
    })).toBe(false);
  });

  it('signs the exact GET path/query bytes with all four headers and no passphrase', async () => {
    const ccxt = await loadCcxt() as unknown as { bitvavo: new (config: Record<string, unknown>) => {
      milliseconds: () => number;
      sign: (path: string, api: string, method: string, params: Record<string, unknown>) => {
        url: string; method: string; body?: string; headers: Record<string, string>;
      };
      requiredCredentials: Record<string, boolean>;
    } };
    const exchange = new ccxt.bitvavo({ apiKey: 'A'.repeat(64), secret: 'B'.repeat(64), options: { fetchCurrencies: false }, has: { fetchCurrencies: false } });
    exchange.milliseconds = () => 1_786_235_200_000;
    const signed = exchange.sign('account/history', 'private', 'GET', {
      fromDate: 1, toDate: 2, page: 1, maxItems: 100
    });
    const path = '/v2/account/history?fromDate=1&toDate=2&page=1&maxItems=100';
    const expected = createHmac('sha256', 'B'.repeat(64)).update(`1786235200000GET${path}`).digest('hex');
    expect(signed).toEqual({
      url: `https://api.bitvavo.com${path}`,
      method: 'GET', body: undefined,
      headers: {
        'BITVAVO-ACCESS-KEY': 'A'.repeat(64),
        'BITVAVO-ACCESS-SIGNATURE': expected,
        'BITVAVO-ACCESS-TIMESTAMP': '1786235200000',
        'BITVAVO-ACCESS-WINDOW': '10000'
      }
    });
    expect(exchange.requiredCredentials.password).toBe(false);
  });

  it('parses native fill/transfer shapes through the real pinned CCXT class', async () => {
    const ccxt = await loadCcxt() as unknown as { bitvavo: new () => {
      parseTrade: (row: Record<string, unknown>, market: Record<string, unknown>) => UnifiedTrade;
      parseTransaction: (row: Record<string, unknown>) => UnifiedTransfer;
    } };
    const exchange = new ccxt.bitvavo();
    const market = { id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', baseId: 'BTC', quoteId: 'EUR' };
    const trade = exchange.parseTrade({
      id: UUID(1), orderId: UUID(2), timestamp: 1000, market: 'BTC-EUR', side: 'buy',
      amount: '0.1', price: '50000', fee: '1', feeCurrency: 'EUR', settled: true
    }, market);
    expect(trade).toMatchObject({ id: UUID(1), order: UUID(2), timestamp: 1000, symbol: 'BTC/EUR', side: 'buy', amount: 0.1, cost: 5000 });
    const transfer = exchange.parseTransaction({ timestamp: 2000, symbol: 'BTC', amount: '0.2', fee: '0.001', status: 'completed', txId: 'provider-ref' });
    expect(transfer).toMatchObject({ id: undefined, timestamp: 2000, currency: 'BTC', amount: 0.2, status: 'ok', type: 'deposit', txid: 'provider-ref' });
  });
});

describe('Bitvavo native paging safety', () => {
  it('pins the empirically recorded native cursor direction and exclusivity', () => {
    const recorded = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/bitvavo/cursor-contract.recorded.json'), 'utf8'));
    expect(recorded._recorded).toBe(true);
    expect(recorded.tradeIdToOldestExclusiveReturned).not.toContain(recorded.initialNewestFirst[2]);
    expect(recorded.tradeIdFromOldestExclusiveReturned).not.toContain(recorded.initialNewestFirst[2]);
    expect(recorded.conclusion).toEqual(BITVAVO_NATIVE_TRADE_CURSOR_CONTRACT);
    expect(BITVAVO_NATIVE_TRADE_CURSOR_CONTRACT).toEqual({
      order: 'newest_first', tradeIdTo: 'exclusive_older', tradeIdFrom: 'exclusive_newer'
    });
  });

  it('continues a saturated newest-first page with exclusive tradeIdTo and handles equal timestamps', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      last_json_response: undefined,
      fetchMyTrades: vi.fn(async (_symbol, _since, _limit, params) => {
        calls.push(params ?? {});
        const full = Array.from({ length: 1000 }, (_, index) => ({ id: UUID(2000 - index), timestamp: 5000 }));
        const raw = params?.tradeIdTo ? [{ id: UUID(999), timestamp: 4999 }] : full;
        client.last_json_response = raw;
        return raw.map((row) => ({ ...row, symbol: 'BTC/EUR', side: 'buy', amount: 1, cost: 10 }));
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTrades({ client, symbol: 'BTC/EUR', start: 0, end: 10_000, budget: { used: 0, max: 3 } });
    expect(outcome).toMatchObject({ partial: false, frontier: 10_000, termination: 'exhausted' });
    expect(calls[1]).toMatchObject({ end: 10_000, tradeIdTo: UUID(1001) });
    expect(outcome.rows).toHaveLength(1001);
  });

  it('persists and resumes the exclusive native cursor chain across runs', async () => {
    const cursors: Array<string | undefined> = [];
    const client = {
      last_json_response: undefined,
      fetchMyTrades: vi.fn(async (_symbol, _since, _limit, params) => {
        cursors.push(params?.tradeIdTo as string | undefined);
        const raw = params?.tradeIdTo
          ? [{ id: UUID(1), timestamp: 4 }]
          : Array.from({ length: 1000 }, (_, index) => ({ id: UUID(2000 - index), timestamp: 5 }));
        client.last_json_response = raw;
        return raw.map((row) => ({ ...row, side: 'buy', amount: 1, cost: 10 }));
      })
    } as unknown as ExchangeClient;
    const first = await paginateBitvavoTrades({ client, symbol: 'BTC/EUR', start: 0, end: 9, budget: { used: 0, max: 1 } });
    expect(first).toMatchObject({ partial: true, termination: 'page_budget' });
    expect(first.progress?.tasks[0].tradeIdTo).toBe(UUID(1001));
    const second = await paginateBitvavoTrades({
      client, symbol: 'BTC/EUR', start: 0, end: 9, budget: { used: 0, max: 1 }, progress: first.progress
    });
    expect(second).toMatchObject({ partial: false, termination: 'exhausted' });
    expect(cursors).toEqual([undefined, UUID(1001)]);
  });

  it('persists adaptive bisection work and monotonically exhausts it across runs', async () => {
    const client = {
      last_json_response: undefined,
      fetchMyTrades: vi.fn(async (_symbol, since, _limit, params) => {
        const root = since === 0 && params?.end === 9;
        const raw = root ? Array.from({ length: 1000 }, (_, index) => ({
          id: index === 999 ? undefined : UUID(2000 - index), timestamp: 5
        })) : [];
        client.last_json_response = raw;
        return raw.map((row) => ({ ...row, side: 'buy', amount: 1, cost: 10 }));
      })
    } as unknown as ExchangeClient;
    let progress;
    for (let run = 0; run < 3; run += 1) {
      const outcome = await paginateBitvavoTrades({
        client, symbol: 'BTC/EUR', start: 0, end: 9, budget: { used: 0, max: 1 }, progress
      });
      progress = outcome.progress;
    }
    expect(progress).toBeUndefined();
  });

  it.each(['missing', 'repeated'] as const)('falls back to adaptive time bisection for %s cursor evidence', async (mode) => {
    const ranges: string[] = [];
    const client = {
      last_json_response: undefined,
      fetchMyTrades: vi.fn(async (_symbol, since, _limit, params) => {
        ranges.push(`${since}-${params?.end}`);
        const isRoot = since === 0 && params?.end === 9;
        const raw = isRoot ? Array.from({ length: 1000 }, (_, i) => ({
          id: mode === 'missing' && i === 999 ? undefined : UUID(2000 - i), timestamp: 5
        })) : [];
        client.last_json_response = raw;
        return raw.map((row) => ({ ...row, symbol: 'BTC/EUR', side: 'buy', amount: 1, cost: 10 }));
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTrades({ client, symbol: 'BTC/EUR', start: 0, end: 9, budget: { used: 0, max: 10 } });
    expect(outcome.partial).toBe(false);
    expect(ranges).toContain('5-9');
    expect(ranges).toContain('0-4');
  });

  it('counts retries in the same budget and never advances a saturated single millisecond', async () => {
    let calls = 0;
    const client = {
      last_json_response: undefined,
      fetchMyTrades: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('timeout'), { name: 'NetworkError' });
        const raw = Array.from({ length: 1000 }, (_, i) => ({ id: UUID(i), timestamp: 1 }));
        client.last_json_response = raw;
        return raw.map((row) => ({ ...row, side: 'buy', amount: 1, cost: 10 }));
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTrades({ client, symbol: 'BTC/EUR', start: 1, end: 1, budget: { used: 0, max: 2 }, sleep: async () => {} });
    expect(outcome).toMatchObject({ partial: true, frontier: 1, termination: 'page_budget' });
    expect(calls).toBe(2);
  });

  it('partitions full transfer ranges and fails closed on indistinguishable multiplicity', async () => {
    const duplicate = { timestamp: 5, currency: 'BTC', amount: 1, status: 'ok', type: 'deposit', info: { txId: 'same', status: 'completed' } };
    const client = {
      last_json_response: undefined,
      fetchDeposits: vi.fn(async () => {
        const raw = Array.from({ length: 1000 }, () => ({ ...duplicate.info, timestamp: 5, symbol: 'BTC', amount: '1', fee: '0' }));
        client.last_json_response = raw;
        return [duplicate, duplicate];
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTransfers({ client, kind: 'deposits', start: 0, end: 10, budget: { used: 0, max: 2 } });
    expect(outcome).toMatchObject({ partial: true, frontier: 0, termination: 'malformed' });
  });

  it('rejects raw/parsed transfer count mismatches without advancing', async () => {
    const client = {
      last_json_response: undefined,
      fetchDeposits: vi.fn(async () => {
        client.last_json_response = [{ timestamp: 5 }, { timestamp: 6 }];
        return [{ timestamp: 5, currency: 'BTC', amount: 1, status: 'ok', info: { txId: 'one' } }];
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTransfers({ client, kind: 'deposits', start: 0, end: 10, budget: { used: 0, max: 1 } });
    expect(outcome).toMatchObject({ partial: true, frontier: 0, termination: 'malformed', rows: [] });
  });

  it('accepts an order-independent raw/parsed transfer bijection', async () => {
    const raw = [
      { timestamp: 6, symbol: 'BTC', amount: '2', fee: '0.2', txId: 'new' },
      { timestamp: 5, symbol: 'BTC', amount: '1', fee: '0.1', txId: 'old' }
    ];
    const client = {
      last_json_response: undefined,
      fetchDeposits: vi.fn(async () => {
        client.last_json_response = raw;
        return [...raw].reverse().map((info) => ({
          timestamp: info.timestamp, currency: info.symbol, amount: Number(info.amount), fee: { cost: Number(info.fee), currency: info.symbol },
          status: 'ok', type: 'deposit', txid: info.txId, info
        }));
      })
    } as unknown as ExchangeClient;
    await expect(paginateBitvavoTransfers({ client, kind: 'deposits', start: 0, end: 10, budget: { used: 0, max: 1 } }))
      .resolves.toMatchObject({ partial: false, rows: [{ timestamp: 5 }, { timestamp: 6 }] });
  });

  it.each(['missing', 'extra', 'ambiguous'] as const)('rejects %s transfer correspondence evidence', async (mode) => {
    const first = { timestamp: 5, symbol: 'BTC', amount: '1', fee: '0', txId: 'one' };
    const raw = mode === 'ambiguous' ? [first, { ...first }] : [first];
    const parsedRaw = mode === 'missing'
      ? [{ ...first, txId: 'other' }]
      : mode === 'extra' ? [first, { ...first, txId: 'two' }] : raw;
    const client = {
      last_json_response: undefined,
      fetchDeposits: vi.fn(async () => {
        client.last_json_response = raw;
        return parsedRaw.map((info) => ({ timestamp: info.timestamp, currency: info.symbol, amount: 1, fee: { cost: 0 }, status: 'ok', type: 'deposit', info }));
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoTransfers({ client, kind: 'deposits', start: 0, end: 10, budget: { used: 0, max: 1 } });
    expect(outcome).toMatchObject({ partial: true, termination: 'malformed', rows: [] });
  });

  it('resumes dense transfer partitions across runs without rescanning completed work', async () => {
    const calls: string[] = [];
    const client = {
      last_json_response: undefined,
      fetchDeposits: vi.fn(async (_code, since, _limit, params) => {
        const end = Number(params?.end); calls.push(`${since}-${end}`);
        const dense = end - Number(since) > 2;
        const raw = dense ? Array.from({ length: 1000 }, (_, index) => ({
          timestamp: Number(since), symbol: 'BTC', amount: String(index + 1), fee: '0', txId: `tx-${since}-${end}-${index}`
        })) : [];
        client.last_json_response = raw;
        return raw.map((row) => ({
          timestamp: row.timestamp, currency: 'BTC', amount: Number(row.amount), fee: { cost: 0 }, txid: row.txId,
          status: 'ok', type: 'deposit', info: row
        }));
      })
    } as unknown as ExchangeClient;
    let progress;
    for (let run = 0; run < 10 && (run === 0 || progress); run += 1) {
      const outcome = await paginateBitvavoTransfers({
        client, kind: 'deposits', start: 0, end: 9, budget: { used: 0, max: 2 }, progress
      });
      progress = outcome.progress;
    }
    expect(progress).toBeUndefined();
    expect(calls.filter((range) => range === '0-9')).toHaveLength(1);
  });

  it('matches pending lifecycle by immutable core while txId, status and fee change', () => {
    const pending: UnifiedTransfer = {
      timestamp: 5, currency: 'BTC', amount: 1, status: 'pending', type: 'withdrawal',
      fee: { cost: 0.1, currency: 'BTC' }, address: 'address', info: { txId: '', address: 'address', paymentId: 'memo' }
    };
    const evidence = bitvavoTransferIdentityEvidence(pending)!;
    const prior = [{ evidence, timestamp: 5, occurrence: 0 }];
    expect(mergeBitvavoPendingTransferEvidence(prior, [{ ...pending, status: 'ok', fee: { cost: 0.2 }, info: { txId: 'completed-id', address: 'address', paymentId: 'memo' } }])).toEqual([]);
    expect(mergeBitvavoPendingTransferEvidence(prior, [{ ...pending, status: 'canceled', fee: undefined, info: { txId: 'cancel-id', address: 'address', paymentId: 'memo' } }])).toEqual([]);
    const duplicateCore = [{ ...pending, status: 'ok' as const }, { ...pending, status: 'canceled' as const }];
    expect(mergeBitvavoPendingTransferEvidence(prior, duplicateCore)).toEqual(prior);
  });

  it('preserves same-core pending multiplicity until terminal evidence is bijective', () => {
    const pending: UnifiedTransfer = {
      timestamp: 5, currency: 'BTC', amount: 1, status: 'pending', type: 'withdrawal',
      address: 'same', info: { address: 'same', paymentId: 'memo' }
    };
    const first = mergeBitvavoPendingTransferEvidence([], [pending, { ...pending }]);
    expect(first).toEqual([
      expect.objectContaining({ occurrence: 0 }), expect.objectContaining({ occurrence: 1 })
    ]);
    expect(mergeBitvavoPendingTransferEvidence(first, [{ ...pending, status: 'ok' }])).toEqual(first);
    expect(mergeBitvavoPendingTransferEvidence(first, [
      { ...pending, status: 'ok' }, { ...pending, status: 'canceled' }
    ])).toEqual([]);
  });
});

describe('Bitvavo account-history and tax-safe normalization', () => {
  it('validates stable envelope metadata and refetches page one without order assumptions', async () => {
    const calls: number[] = [];
    const pages = [[{ transactionId: UUID(1), type: 'deposit' }], [{ transactionId: UUID(2), type: 'withdrawal' }]];
    const client = {
      privateGetAccountHistory: vi.fn(async (params) => {
        const page = Number(params?.page); calls.push(page);
        return { items: pages[page - 1], currentPage: page, totalPages: 2, maxItems: 100 };
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({ client, start: 0, end: 10, budget: { used: 0, max: 5 } });
    expect(outcome).toMatchObject({ partial: false, frontier: 10 });
    expect(calls).toEqual([1, 2, 1, 2]);
    expect(new Set(outcome.rows.map((row) => row.transactionId))).toEqual(new Set([UUID(1), UUID(2)]));
  });

  it('date-partitions an account-history range before a declared page count can exceed the budget', async () => {
    const ranges: string[] = [];
    const client = {
      privateGetAccountHistory: vi.fn(async (params) => {
        const start = Number(params?.fromDate); const end = Number(params?.toDate);
        ranges.push(`${start}-${end}`);
        const wide = end - start > 4;
        return {
          items: wide ? [{ transactionId: UUID(90) }] : [], currentPage: 1,
          totalPages: wide ? 50 : 1, maxItems: 100
        };
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({ client, start: 0, end: 9, budget: { used: 0, max: 10 } });
    expect(outcome.partial).toBe(false);
    expect(ranges).toContain('0-4');
    expect(ranges).toContain('5-9');
  });

  it('fails closed after bounded restarts when fixed-range metadata is unstable', async () => {
    let call = 0;
    const client = {
      privateGetAccountHistory: vi.fn(async (params) => {
        call += 1;
        return {
          items: [{ transactionId: UUID(call) }], currentPage: Number(params?.page),
          totalPages: call % 2 ? 1 : 2, maxItems: 100
        };
      })
    } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({
      client, start: 0, end: 0, budget: { used: 0, max: 10 }, maxRestarts: 2
    });
    expect(outcome).toMatchObject({ partial: true, frontier: 0, termination: 'nonadvancing' });
  });

  it('rejects duplicate transactionId values across accepted pages', async () => {
    const client = { privateGetAccountHistory: vi.fn(async (params) => ({
      items: [{ transactionId: UUID(1), executedAt: '1970-01-01T00:00:00.005Z', type: Number(params?.page) === 1 ? 'buy' : 'sell' }],
      currentPage: Number(params?.page), totalPages: 2, maxItems: 100
    })) } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({ client, start: 0, end: 10, budget: { used: 0, max: 10 } });
    expect(outcome.termination).toBe('malformed');
  });

  it.each(['page-one content', 'later-page content'] as const)('rejects changed canonical %s during full manifest replay', async (mode) => {
    const counts = new Map<number, number>();
    const client = { privateGetAccountHistory: vi.fn(async (params) => {
      const page = Number(params?.page);
      const count = (counts.get(page) ?? 0) + 1; counts.set(page, count);
      const changed = count > 1 && ((mode === 'page-one content' && page === 1) || (mode === 'later-page content' && page === 2));
      return {
        items: [{ transactionId: UUID(page), executedAt: '1970-01-01T00:00:00.005Z', type: changed ? 'sell' : 'buy' }],
        currentPage: page, totalPages: 2, maxItems: 100
      };
    }) } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({
      client, start: 0, end: 10, budget: { used: 0, max: 10 }, maxRestarts: 0
    });
    expect(outcome.termination).toBe('nonadvancing');
  });

  it('rejects dated history outside its fixed requested range', async () => {
    const client = { privateGetAccountHistory: vi.fn(async () => ({
      items: [{ transactionId: UUID(1), executedAt: '1970-01-01T00:00:00.011Z', type: 'deposit' }],
      currentPage: 1, totalPages: 1, maxItems: 100
    })) } as unknown as ExchangeClient;
    const outcome = await paginateBitvavoAccountHistory({ client, start: 0, end: 10, budget: { used: 0, max: 3 } });
    expect(outcome.termination).toBe('malformed');
  });

  it('durably completes date partitions over multiple bounded runs', async () => {
    const client = { privateGetAccountHistory: vi.fn(async (params) => {
      const start = Number(params?.fromDate); const end = Number(params?.toDate);
      const wide = end - start > 2;
      return {
        items: wide ? [{ transactionId: UUID(99) }] : [], currentPage: Number(params?.page),
        totalPages: wide ? 20 : 1, maxItems: 100
      };
    }) } as unknown as ExchangeClient;
    let progress;
    const remaining: number[] = [];
    for (let run = 0; run < 10 && (run === 0 || progress); run += 1) {
      const outcome = await paginateBitvavoAccountHistory({
        client, start: 0, end: 9, budget: { used: 0, max: 3 }, progress
      });
      progress = outcome.progress;
      remaining.push(progress?.tasks.length ?? 0);
    }
    expect(progress).toBeUndefined();
    expect(remaining[remaining.length - 1]).toBe(0);
  });

  it('normalizes unmatched account economics and suppresses only an unambiguous many-fill aggregate', () => {
    const history = normalizeBitvavoAccountTrade({
      transactionId: UUID(1), executedAt: '2026-08-08T12:00:00.000Z', type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01',
      feesCurrency: 'EUR', feesAmount: '1.25'
    })!;
    const market = { id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true };
    const fills = [
      normalizeTrade('bitvavo', { id: UUID(2), order: UUID(9), timestamp: history.timestamp, side: 'buy', amount: 0.006, cost: 300, fee: { cost: 0.75, currency: 'EUR' } }, market)!,
      normalizeTrade('bitvavo', { id: UUID(3), order: UUID(9), timestamp: history.timestamp + 1, side: 'buy', amount: 0.004, cost: 200, fee: { cost: 0.5, currency: 'EUR' } }, market)!
    ];
    expect(reconcileBitvavoAccountTrades([history], fills)).toMatchObject({ retained: [], matched: 1, ambiguous: 0 });
    expect(history).toMatchObject({ type: 'buy', asset: 'BTC', amount: 0.01, counterAsset: 'EUR', counterAmount: 500, fiatValue: 500, sourceRef: UUID(1) });
  });

  it('fails reconciliation closed for fee mismatch, missing positive-fee currency, and multiple matching orders', () => {
    const item = {
      transactionId: UUID(30), executedAt: '2026-08-08T12:00:00.000Z', type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01',
      feesCurrency: 'EUR', feesAmount: '1.25'
    };
    const history = normalizeBitvavoAccountTrade(item)!;
    expect(normalizeBitvavoAccountTrade({ ...item, feesCurrency: '', feesAmount: '1' })).toBeNull();
    const market = { id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true };
    const fill = (id: number, order: number, fee = 1.25) => normalizeTrade('bitvavo', {
      id: UUID(id), order: UUID(order), timestamp: history.timestamp, side: 'buy', amount: 0.01, cost: 500,
      fee: { cost: fee, currency: 'EUR' }
    }, market)!;
    expect(reconcileBitvavoAccountTrades([history], [fill(31, 40, 1)])).toMatchObject({ matched: 0, retained: [history] });
    expect(reconcileBitvavoAccountTrades([history], [fill(31, 40), fill(32, 41)])).toMatchObject({ matched: 0, ambiguous: 1, retained: [history] });
  });

  it('uses exact one-fill fallback only when orderId is absent', () => {
    const history = normalizeBitvavoAccountTrade({
      transactionId: UUID(50), executedAt: '2026-08-08T12:00:00.000Z', type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01', feesAmount: '0'
    })!;
    const market = { id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true };
    const fills = [0.006, 0.004].map((amount, index) => normalizeTrade('bitvavo', {
      id: UUID(51 + index), timestamp: history.timestamp + index, side: 'buy', amount, cost: amount * 50_000
    }, market)!);
    expect(reconcileBitvavoAccountTrades([history], fills)).toMatchObject({ matched: 0, retained: [history] });
    expect(reconcileBitvavoAccountTrades([history], [normalizeTrade('bitvavo', {
      id: UUID(60), timestamp: history.timestamp, side: 'buy', amount: 0.01, cost: 500
    }, market)!])).toMatchObject({ matched: 1, retained: [] });
  });

  it('uses connection/kind-safe transfer refs, durable status semantics and raw kind', () => {
    const base: UnifiedTransfer = {
      timestamp: 1000, currency: 'BTC', amount: 1, status: 'ok', type: 'deposit', txid: 'provider-ref',
      address: 'address', fee: { cost: 0.01, currency: 'BTC' }, info: { txId: 'provider-ref', paymentId: 'memo', status: 'completed' }
    };
    const deposit = normalizeTransfer('bitvavo', base)!;
    const withdrawal = normalizeTransfer('bitvavo', { ...base, type: 'withdrawal' })!;
    expect(deposit.sourceRef).not.toBe(withdrawal.sourceRef);
    expect(deposit.raw?.exchangeSyncKind).toBe('deposit');
    expect(withdrawal.raw?.exchangeSyncKind).toBe('withdrawal');
    expect(bitvavoTransferDisposition({ ...base, status: 'pending' })).toBe('pending');
    expect(bitvavoTransferDisposition({ ...base, status: 'canceled' })).toBe('terminal');
    expect(bitvavoTransferDisposition({ ...base, status: 'new_status' })).toBe('unknown');
    expect(transactionExchangeKey({ ...deposit, importBatchId: 'connection-a' }))
      .not.toBe(transactionExchangeKey({ ...deposit, importBatchId: 'connection-b' }));
    expect(transactionExchangeKey({ ...deposit, importBatchId: 'connection-a' }))
      .not.toBe(transactionExchangeKey({ ...withdrawal, importBatchId: 'connection-a' }));
  });

  it('keeps existing tax policy and derived posting signs without cost-basis math changes', () => {
    const buy = normalizeBitvavoAccountTrade({
      transactionId: UUID(20), executedAt: '2026-08-08T12:00:00.000Z', type: 'buy',
      sentCurrency: 'EUR', sentAmount: '500', receivedCurrency: 'BTC', receivedAmount: '0.01',
      feesCurrency: 'EUR', feesAmount: '1.25'
    })!;
    const sell = normalizeBitvavoAccountTrade({
      transactionId: UUID(21), executedAt: '2026-08-08T13:00:00.000Z', type: 'sell',
      sentCurrency: 'BTC', sentAmount: '0.004', receivedCurrency: 'EUR', receivedAmount: '220',
      feesCurrency: 'EUR', feesAmount: '0.55'
    })!;
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: buy, settings: DEFAULT_SETTINGS }).treatment).not.toBe('requires_review');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: sell, settings: DEFAULT_SETTINGS }).treatment).not.toBe('requires_review');
    const postings = derivePostings([
      { ...buy, importBatchId: 'bitvavo-account' }, { ...sell, importBatchId: 'bitvavo-account' }
    ], { exchangeConnections: [{ id: 'bitvavo-account', exchange: 'bitvavo' }] });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.01, -0.004]));
  });
});
