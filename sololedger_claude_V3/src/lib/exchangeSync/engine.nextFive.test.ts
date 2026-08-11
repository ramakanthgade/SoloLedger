import { describe, expect, it, vi } from 'vitest';
import type { ExchangeClient, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { fetchTradesForSymbol, fetchTransferKind } from './engine';

const NO_SLEEP = async () => {};

function baseClient(overrides: Partial<ExchangeClient>): ExchangeClient {
  return {
    id: 'fake', markets: {}, last_json_response: undefined,
    fetchBalance: vi.fn(), loadMarkets: vi.fn(), fetchMyTrades: vi.fn(),
    fetchDeposits: vi.fn(), fetchWithdrawals: vi.fn(), fetch: vi.fn(), handleRestResponse: vi.fn(),
    ...overrides
  } as ExchangeClient;
}

describe('next-five engine plans', () => {
  it('Bitrue transfers scan each discovered asset with endpoint-specific 1000-row offsets', async () => {
    const calls: Array<[string | undefined, number | undefined]> = [];
    const client = baseClient({
      fetchDeposits: vi.fn(async (code, _since, _limit, params) => {
        calls.push([code, params?.offset as number | undefined]);
        return [{ id: `${code}-1`, timestamp: 10, currency: code, amount: 1, status: 'ok' }];
      })
    });
    const outcome = await fetchTransferKind(client, 'bitrue', 'deposits', 1, 20, ['BTC', 'ETH'], [], NO_SLEEP);
    expect(calls).toEqual([['BTC', 0], ['ETH', 0]]);
    expect(outcome).toMatchObject({ partial: true, termination: 'retention_unverified' });
    expect(outcome.rows.map((row) => row.id)).toEqual(['BTC-1', 'ETH-1']);
  });

  it('Bitrue freezes currency/offset continuation and resumes it', async () => {
    const calls: number[] = [];
    const client = baseClient({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0); calls.push(offset);
      return offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: String(i), timestamp: 10 })) : [];
    }) });
    const first = await fetchTransferKind(client, 'bitrue', 'deposits', 1, 20, ['BTC'], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    expect(first.nextFiveCheckpoint).toMatchObject({ start: 1, end: 20, items: ['BTC'], itemIndex: 0, offset: 1000 });
    const resumed = await fetchTransferKind(client, 'bitrue', 'deposits', 1, 30, ['BTC'], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, first.nextFiveCheckpoint, 1);
    expect(calls).toEqual([0, 1000]);
    expect(resumed.termination).toBe('retention_unverified');
    expect(resumed.nextFiveCheckpoint).toBeUndefined();
  });

  it('Bitrue emits valid continuation at a currency boundary and retains only valid state on failure', async () => {
    const client = baseClient({ fetchDeposits: vi.fn(async () => []) });
    const boundary = await fetchTransferKind(client, 'bitrue', 'deposits', 1, 20, ['BTC', 'ETH'], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    expect(boundary.nextFiveCheckpoint).toMatchObject({ items: ['BTC', 'ETH'], itemIndex: 1, offset: 0 });
    expect(boundary.nextFiveCheckpoint?.lastId).toBeUndefined();
    client.fetchDeposits = vi.fn(async () => [{ timestamp: 10 }]) as ExchangeClient['fetchDeposits'];
    const failed = await fetchTransferKind(client, 'bitrue', 'deposits', 1, 20, ['BTC'], [], NO_SLEEP);
    expect(failed.nextFiveCheckpoint).toBeUndefined();
  });

  it('CoinSpot uses only the read-only raw deposit adapter and filters the requested time range', async () => {
    const client = baseClient({
      fetchCoinspotDeposits: vi.fn(async () => ({ status: 'ok', deposits: [
        { id: 'old', coin: 'btc', amount: 1, timestamp: 5 },
        { id: 'kept', coin: 'btc', amount: 2, timestamp: 15 }
      ] })),
      fetchCoinspotWithdrawals: vi.fn()
    });
    const outcome = await fetchTransferKind(client, 'coinspot', 'deposits', 10_000, 20_000, [], [], NO_SLEEP);
    expect(outcome.rows.map((row) => row.id)).toEqual(['kept']);
    expect(outcome).toMatchObject({ partial: true, termination: 'retention_unverified' });
    expect(client.fetchCoinspotWithdrawals).not.toHaveBeenCalled();
  });

  it('XT.COM keeps retention partial even when native pagination is exhausted', async () => {
    const client = baseClient({
      fetchDeposits: vi.fn(async () => {
        client.last_json_response = { result: { hasNext: false, items: [] } };
        return [];
      })
    });
    const outcome = await fetchTransferKind(client, 'xt', 'deposits', 1, 20, [], [], NO_SLEEP);
    expect(outcome).toMatchObject({ partial: true, termination: 'retention_unverified' });
  });

  it('XT.COM persists and resumes its immutable native cursor', async () => {
    const cursors: Array<string | undefined> = [];
    const client = baseClient({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const cursor = params?.id as string | undefined; cursors.push(cursor);
      const rows = cursor ? [{ id: '2', timestamp: 2 }] : [{ id: '1', timestamp: 1 }];
      client.last_json_response = { result: { hasNext: !cursor, items: rows } };
      return rows;
    }) });
    const first = await fetchTransferKind(client, 'xt', 'deposits', 1, 20, [], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    expect(first.nextFiveCheckpoint).toMatchObject({ nativeCursor: '1', start: 1, end: 20 });
    const second = await fetchTransferKind(client, 'xt', 'deposits', 1, 30, [], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, first.nextFiveCheckpoint, 1);
    expect(cursors).toEqual([undefined, '1']);
    expect(second.termination).toBe('retention_unverified');
  });

  it('LBank trades split history into windows below the documented two-day cap', async () => {
    const windows: Array<[number | undefined, string | undefined, number | undefined]> = [];
    const client = baseClient({
      fetchMyTrades: vi.fn(async (_symbol, since, _limit, params) => {
        windows.push([since, params?.end_date as string, params?.from as number]);
        client.last_json_response = { data: [] };
        return [] as UnifiedTrade[];
      })
    });
    const start = Date.UTC(2024, 0, 1);
    const outcome = await fetchTradesForSymbol(client, 'lbank', 'BTC/USDT', start, start + 4 * 86_400_000);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.every(([dayStart, endDate]) => new Date(dayStart!).toISOString().slice(0, 10) === endDate)).toBe(true);
    expect(windows.map(([dayStart]) => dayStart)).toEqual([...new Set(windows.map(([dayStart]) => dayStart))]);
    expect(outcome).toMatchObject({ partial: true, termination: 'retention_unverified' });
  });

  it('Phemex transfer history rejects rows without immutable ids', async () => {
    const client = baseClient({
      fetchWithdrawals: vi.fn(async () => {
        client.last_json_response = { data: [{ txHash: 'raw-1' }] };
        return [{ timestamp: 10, currency: 'BTC', amount: 1 }] as UnifiedTransfer[];
      })
    });
    const outcome = await fetchTransferKind(client, 'phemex', 'withdrawals', 1, 20, [], [], NO_SLEEP);
    expect(outcome).toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });

  it.each([
    ['future', { id: '1', timestamp: 21, currency: 'BTC', amount: 1 }],
    ['before frozen range', { id: '1', timestamp: 0, currency: 'BTC', amount: 1 }]
  ])('Phemex transfers ignore legitimate rows %s', async (_label, row) => {
    const client = baseClient({ fetchDeposits: vi.fn(async () => {
      client.last_json_response = { data: [{ id: '1' }] };
      return [row] as UnifiedTransfer[];
    }) });
    expect(await fetchTransferKind(client, 'phemex', 'deposits', 1, 20, [], [], NO_SLEEP))
      .toMatchObject({ rows: [], partial: true, termination: 'retention_unverified' });
  });

  it('Phemex transfers fail closed on malformed timestamps', async () => {
    const client = baseClient({ fetchDeposits: vi.fn(async () => {
      client.last_json_response = { data: [{ id: '1' }] };
      return [{ id: '1', timestamp: 1.5 }] as UnifiedTransfer[];
    }) });
    expect(await fetchTransferKind(client, 'phemex', 'deposits', 1, 20, [], [], NO_SLEEP))
      .toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });

  it('Phemex puts the page limit in signed params and checkpoints an immutable raw id', async () => {
    const client = baseClient({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      expect(params).toMatchObject({ limit: 200, offset: 0 });
      client.last_json_response = { data: Array.from({ length: 200 }, (_, i) => ({ id: String(i) })) };
      return [{ id: '0', timestamp: 10 }] as UnifiedTransfer[];
    }) });
    const outcome = await fetchTransferKind(client, 'phemex', 'deposits', 1, 20, [], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    expect(outcome).toMatchObject({ termination: 'page_budget', nextFiveCheckpoint: { lastId: '199' } });
    expect(outcome.nextFiveCheckpoint).not.toHaveProperty('offset');
  });

  it('Phemex replays from zero to an immutable anchor and retains late in-range rows', async () => {
    const offsets: number[] = [];
    const client = baseClient({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0);
      offsets.push(offset);
      const ids = offset === 0
        ? Array.from({ length: 200 }, (_, i) => `new-${i}`)
        : ['anchor', ...Array.from({ length: 199 }, (_, i) => `continued-${i}`)];
      client.last_json_response = { data: ids.map((id) => ({ id })) };
      return ids.map((id) => ({ id, timestamp: 10 })) as UnifiedTransfer[];
    }) });
    const outcome = await fetchTransferKind(client, 'phemex', 'deposits', 1, 20, [], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { start: 1, end: 20, lastId: 'anchor' }, 1);
    expect(offsets).toEqual([0, 200]);
    expect(outcome.rows.map((row) => row.id)).toEqual([
      ...Array.from({ length: 200 }, (_, i) => `new-${i}`),
      'anchor', ...Array.from({ length: 199 }, (_, i) => `continued-${i}`)
    ]);
    expect(outcome.nextFiveCheckpoint?.lastId).toBe('continued-198');
  });

  it('Phemex retains the immutable checkpoint when the anchor disappears', async () => {
    const client = baseClient({ fetchDeposits: vi.fn(async (_code, _since, _limit, params) => {
      const offset = Number(params?.offset ?? 0);
      const ids = offset === 0 ? Array.from({ length: 200 }, (_, i) => `other-${i}`) : [];
      client.last_json_response = { data: ids.map((id) => ({ id })) };
      return ids.map((id) => ({ id, timestamp: 10 })) as UnifiedTransfer[];
    }) });
    const checkpoint = { start: 1, end: 20, lastId: 'missing-anchor' };
    const outcome = await fetchTransferKind(client, 'phemex', 'deposits', 1, 20, [], [], NO_SLEEP,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      checkpoint, 1);
    expect(outcome).toMatchObject({ termination: 'nonadvancing', nextFiveCheckpoint: checkpoint });
    expect(outcome.rows).toHaveLength(200);
  });
});
