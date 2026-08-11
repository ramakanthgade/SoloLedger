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
    expect(outcome).toMatchObject({ partial: true, termination: 'exhausted' });
    expect(outcome.rows.map((row) => row.id)).toEqual(['BTC-1', 'ETH-1']);
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
    expect(outcome).toMatchObject({ partial: true, termination: 'exhausted' });
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
    expect(outcome).toMatchObject({ partial: true, termination: 'exhausted' });
  });

  it('LBank trades split history into windows below the documented two-day cap', async () => {
    const windows: Array<[number | undefined, string | undefined]> = [];
    const client = baseClient({
      fetchMyTrades: vi.fn(async (_symbol, since, _limit, params) => {
        windows.push([since, params?.end_date as string]);
        return [] as UnifiedTrade[];
      })
    });
    const start = Date.UTC(2024, 0, 1);
    const outcome = await fetchTradesForSymbol(client, 'lbank', 'BTC/USDT', start, start + 4 * 86_400_000);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.every((_, index) => index === 0 || windows[index][0]! > windows[index - 1][0]!)).toBe(true);
    expect(outcome).toMatchObject({ partial: true, termination: 'exhausted' });
  });

  it('Phemex transfer history rejects rows without immutable ids', async () => {
    const client = baseClient({
      fetchWithdrawals: vi.fn(async () => [{ timestamp: 10, currency: 'BTC', amount: 1 }] as UnifiedTransfer[])
    });
    const outcome = await fetchTransferKind(client, 'phemex', 'withdrawals', 1, 20, [], [], NO_SLEEP);
    expect(outcome).toMatchObject({ rows: [], partial: true, termination: 'nonadvancing' });
  });
});
