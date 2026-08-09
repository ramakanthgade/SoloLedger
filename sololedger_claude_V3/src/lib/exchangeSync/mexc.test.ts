import { describe, expect, it } from 'vitest';
import type { ExchangeClient, UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import {
  assertValidMexcCheckpoint,
  createMexcCheckpoint,
  fetchMexcHistory,
  mapMexcOfflineUniverse,
  mexcDepositSourceRef
} from './mexc';

const NOW = 1_786_233_600_000;
const markets: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'OLD/USDT': { id: 'OLDUSDT', symbol: 'OLD/USDT', base: 'OLD', quote: 'USDT', spot: true, active: false }
};

function trade(id: string, symbol: string, timestamp: number): UnifiedTrade {
  return {
    id, symbol, timestamp, side: 'buy', amount: 1, price: 2, cost: 2,
    fee: { cost: 0.01, currency: 'USDT' }, info: { id, time: timestamp }
  };
}

function deposit(id: string, timestamp: number, status = '5'): UnifiedTransfer {
  return {
    type: 'deposit', timestamp, currency: 'USDT', amount: 10, status: status === '5' ? 'ok' : 'pending',
    txid: id, address: 'T-address', network: 'TRX',
    info: { status, txId: id, transHash: id, network: 'TRX', coin: 'USDT-TRX', insertTime: String(timestamp), amount: '10', address: 'T-address', memo: '', index: '0' }
  };
}

function client(fetchTrade: ExchangeClient['fetchMyTrades']): ExchangeClient {
  const target = {
    id: 'mexc', markets, last_json_response: undefined,
    loadMarkets: async () => markets,
    fetchBalance: async () => ({ total: {} }),
    fetchMyTrades: fetchTrade,
    fetchDeposits: async () => { target.last_json_response = []; return []; },
    fetchWithdrawals: async () => { target.last_json_response = []; return []; },
    handleRestResponse: () => undefined,
    fetch: async () => undefined
  } as ExchangeClient;
  return target;
}

const offline = { code: 0, data: [{ symbol: 'OLDUSDT', offlineTime: NOW - 1_000 }] };

describe('MEXC symbol universe and state validation', () => {
  it('keeps inactive spot and mapped recent offline markets, while failing closed for unmapped IDs', () => {
    expect(mapMexcOfflineUniverse({ code: 0, data: [
      { symbol: 'OLDUSDT', offlineTime: NOW - 1_000 },
      { symbol: 'UNKNOWNUSDT', offlineTime: NOW - 1_000 }
    ] }, markets, NOW - 30 * 86_400_000)).toEqual({
      symbols: ['OLD/USDT'], unqueryableRecent: ['UNKNOWNUSDT']
    });
  });

  it('fails closed instead of treating a malformed offline-symbol envelope as an empty universe', async () => {
    const c = client(async () => { c.last_json_response = []; return []; });
    const result = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: {}, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 0
    });
    expect(result.partial.trades).toBe(true);
    expect(result.checkpoint?.trade.unsafeEvidence[0]?.reason).toBe('malformed_offline_symbol_response');
    expect(result.warnings.join(' ')).toMatch(/coverage is partial|traversal is incomplete/i);
    expect(result.warnings.join(' ')).not.toMatch(/exhausted.*every queryable/i);
  });

  it('rebuilds discovery evidence so a valid response clears a prior malformed-response failure', async () => {
    const c = client(async () => { c.last_json_response = []; return []; });
    const first = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: {}, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 2
    });
    expect(first.checkpoint?.trade.unsafeEvidence.some((item) => item.reason === 'malformed_offline_symbol_response')).toBe(true);

    const recovered = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, prior: first.checkpoint,
      knownSymbols: [], offlineResponse: { code: 0, data: [] }, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 2
    });
    expect(recovered.partial.trades).toBe(false);
    expect(recovered.checkpoint).toBeUndefined();
  });

  it('clears prior unqueryable discovery evidence when the symbol becomes mappable or ages out', async () => {
    const c = client(async () => { c.last_json_response = []; return []; });
    const recentUnknown = { code: 0, data: [{ symbol: 'UNKNOWNUSDT', offlineTime: NOW - 1 }] };
    const first = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: recentUnknown, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 2
    });
    expect(first.checkpoint?.trade.unsafeEvidence.some((item) => item.reason === 'unqueryable_recent_offline_symbol')).toBe(true);

    const mappedMarket: UnifiedMarket = {
      id: 'UNKNOWNUSDT', symbol: 'UNKNOWN/USDT', base: 'UNKNOWN', quote: 'USDT', spot: true, active: false
    };
    const mapped = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']!, 'UNKNOWN/USDT': mappedMarket }, prior: first.checkpoint,
      knownSymbols: [], offlineResponse: recentUnknown, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 2
    });
    expect(mapped.partial.trades).toBe(false);
    expect(mapped.checkpoint).toBeUndefined();

    const aged = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, prior: first.checkpoint,
      knownSymbols: [], offlineResponse: recentUnknown, now: NOW + 31 * 86_400_000,
      tradeStart: NOW + 86_400_000, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 2
    });
    expect(aged.checkpoint?.trade.unsafeEvidence.some((item) => item.reason === 'unqueryable_recent_offline_symbol')).not.toBe(true);
  });

  it('rejects malformed exact-key/window state before it can be used', () => {
    const checkpoint = createMexcCheckpoint(NOW - 10, NOW - 20, NOW, ['BTC/USDT']);
    expect(() => assertValidMexcCheckpoint(checkpoint)).not.toThrow();
    expect(() => assertValidMexcCheckpoint({ ...checkpoint, secret: 'must-not-exist' })).toThrow(/malformed/);
    expect(() => assertValidMexcCheckpoint({
      ...checkpoint, trade: { ...checkpoint.trade, pendingWindows: [{ symbol: 'BTC/USDT', start: NOW - 10, end: NOW + 1 }] }
    })).toThrow(/malformed/);
  });
});

describe('MEXC recursive closed-window history', () => {
  it('uses one window per symbol per fair round and retains inactive symbols', async () => {
    const calls: string[] = [];
    const c = client(async (symbol, since) => {
      calls.push(symbol!);
      const rows = [trade(`${symbol}-1`, symbol!, since!)];
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    });
    const result = await fetchMexcHistory({
      client: c, markets, knownSymbols: [], offlineResponse: offline, now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 2, transferBudget: 0
    });
    expect(calls).toEqual(['BTC/USDT', 'OLD/USDT']);
    expect(result.transactions.filter((row) => row.raw?.exchangeSyncKind === 'trade')).toHaveLength(2);
    expect(result.checkpoint?.trade.completedSymbols).toEqual(['BTC/USDT', 'OLD/USDT']);
  });

  it('binary-splits a full 100-row trade page and resumes the exact children', async () => {
    const limits: number[] = [];
    const c = client(async (symbol, since, limit) => {
      limits.push(limit!);
      const rows = Array.from({ length: 100 }, (_, index) => trade(String(index), symbol!, since! + index));
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    });
    const result = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 1_000, transferStart: NOW - 2_000, tradeBudget: 1, transferBudget: 0
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.checkpoint?.trade.pendingWindows).toEqual([
      { symbol: 'BTC/USDT', start: NOW - 1_000, end: NOW - 500 },
      { symbol: 'BTC/USDT', start: NOW - 499, end: NOW }
    ]);
    expect(limits).toEqual([100]);
  });

  it('uses native bounded transfer params and endpoint-specific limits', async () => {
    const tradeRequests: Array<{ limit: number | undefined; params: Record<string, unknown> | undefined }> = [];
    const transferRequests: Array<{ kind: string; since: number | undefined; limit: number | undefined; params: Record<string, unknown> | undefined }> = [];
    const c = client(async (_symbol, _since, limit, params) => {
      tradeRequests.push({ limit, params });
      c.last_json_response = [];
      return [];
    });
    c.fetchDeposits = async (_code, since, limit, params) => {
      transferRequests.push({ kind: 'deposit', since, limit, params });
      c.last_json_response = [];
      return [];
    };
    c.fetchWithdrawals = async (_code, since, limit, params) => {
      transferRequests.push({ kind: 'withdrawal', since, limit, params });
      c.last_json_response = [];
      return [];
    };
    await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 1, transferBudget: 1
    });
    expect(tradeRequests).toEqual([{ limit: 100, params: { until: NOW } }]);
    expect(transferRequests).toEqual([
      { kind: 'deposit', since: NOW - 20, limit: 1000, params: { endTime: NOW } },
      { kind: 'withdrawal', since: NOW - 20, limit: 1000, params: { endTime: NOW } }
    ]);
    expect(transferRequests.every(({ params }) => !Object.prototype.hasOwnProperty.call(params ?? {}, 'until'))).toBe(true);
  });

  it('reports the prior scanned frontier when newly frozen extension windows were not queried', async () => {
    const prior = createMexcCheckpoint(NOW - 20, NOW - 30, NOW, ['BTC/USDT']);
    prior.trade.pendingWindows = [];
    prior.trade.completedSymbols = ['BTC/USDT'];
    prior.deposits.pendingWindows = [];
    prior.withdrawals.pendingWindows = [];
    const later = NOW + 1_000;
    const result = await fetchMexcHistory({
      client: client(async () => []), markets: { 'BTC/USDT': markets['BTC/USDT']! }, prior,
      knownSymbols: [], offlineResponse: [], now: later,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 0, transferBudget: 0
    });
    expect(result.checkpoint?.trade.requestedEnd).toBe(later);
    expect(result.checkpoint?.deposits.requestedEnd).toBe(later);
    expect(result.scannedRanges).toEqual({
      trades: { start: NOW - 20, end: NOW },
      deposits: { start: NOW - 30, end: NOW },
      withdrawals: { start: NOW - 30, end: NOW }
    });
  });

  it('fails closed on a saturated 1ms window and preserves unsafe evidence', async () => {
    const c = client(async (symbol, since) => {
      const rows = Array.from({ length: 100 }, (_, index) => trade(String(index), symbol!, since!));
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    });
    const result = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW, transferStart: NOW, tradeBudget: 1, transferBudget: 0
    });
    expect(result.checkpoint?.trade.pendingWindows).toEqual([{ symbol: 'BTC/USDT', start: NOW, end: NOW }]);
    expect(result.checkpoint?.trade.unsafeEvidence[0]?.reason).toBe('saturated_1ms_window');
    expect(result.cursors.trades).toBeUndefined();
  });

  it('counts retry attempts against the trade budget without misclassifying a network error as an unqueryable symbol', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const c = client(async (symbol, since) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary transport failure');
        error.name = 'NetworkError';
        throw error;
      }
      const rows = [trade('retry-ok', symbol!, since!)];
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    });
    const result = await fetchMexcHistory({
      client: c, markets: { 'BTC/USDT': markets['BTC/USDT']! }, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 20, tradeBudget: 2, transferBudget: 0,
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(result.partial.trades).toBe(false);
  });

  it('binary-splits a full 1000-row transfer page and fails closed when the 1ms child is saturated', async () => {
    const c = client(async () => []);
    c.fetchDeposits = async (_code, since) => {
      const rows = Array.from({ length: 1000 }, (_, index) => deposit(String(index), since!));
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    };
    const splitResult = await fetchMexcHistory({
      client: c, markets: {}, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 2, tradeBudget: 0, transferBudget: 1
    });
    expect(splitResult.checkpoint?.deposits.pendingWindows).toEqual([
      { start: NOW - 2, end: NOW - 1 }, { start: NOW, end: NOW }
    ]);

    const saturated = await fetchMexcHistory({
      client: c, markets: {}, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW, transferStart: NOW, tradeBudget: 0, transferBudget: 1
    });
    expect(saturated.checkpoint?.deposits.pendingWindows).toEqual([{ start: NOW, end: NOW }]);
    expect(saturated.checkpoint?.deposits.unsafeEvidence[0]?.reason).toBe('saturated_1ms_window');
  });

  it('keeps unresolved deposit evidence for exact replay and clears it when the provider reports a terminal status', async () => {
    let status = '2';
    const c = client(async () => []);
    c.fetchDeposits = async () => {
      const rows = [deposit('pending-1', NOW - 1, status)];
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    };
    const first = await fetchMexcHistory({
      client: c, markets: {}, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 10, tradeBudget: 0, transferBudget: 1
    });
    expect(first.checkpoint?.deposits.pendingWindows).toEqual([{ start: NOW - 1, end: NOW - 1 }]);
    expect(first.checkpoint?.deposits.unsafeEvidence[0]?.reason).toBe('unresolved_transfer_status');

    status = '7';
    const second = await fetchMexcHistory({
      client: c, markets: {}, prior: first.checkpoint, knownSymbols: [], offlineResponse: [], now: NOW,
      tradeStart: NOW - 10, transferStart: NOW - 10, tradeBudget: 0, transferBudget: 1
    });
    expect(second.partial.deposits).toBe(false);
    expect(second.counts.terminal).toBe(1);
  });

  it('preserves exact unresolved replay when an overlapping extension repeats it alongside a newer deposit', async () => {
    const pendingAt = NOW - 1_000;
    const prior = createMexcCheckpoint(NOW - 10_000, NOW - 10_000, NOW, []);
    const pending = deposit('pending-overlap', pendingAt, '2');
    const pendingId = mexcDepositSourceRef(pending);
    prior.trade.pendingWindows = [];
    prior.deposits.pendingWindows = [{ start: pendingAt, end: pendingAt }];
    prior.deposits.unsafeEvidence = [{
      id: pendingId, start: pendingAt, end: pendingAt, reason: 'unresolved_transfer_status'
    }];
    prior.withdrawals.pendingWindows = [];
    const later = NOW + 86_400_000;
    const newer = deposit('new-settled', later - 1_000);
    const calls: Array<{ start: number | undefined; end: unknown }> = [];
    const c = client(async () => []);
    c.fetchDeposits = async (_code, since, _limit, params) => {
      calls.push({ start: since, end: params?.endTime });
      const rows = since === pendingAt && params?.endTime === pendingAt ? [pending] : [pending, newer];
      c.last_json_response = rows.map((row) => row.info!);
      return rows;
    };

    const result = await fetchMexcHistory({
      client: c, markets: {}, prior, knownSymbols: [], offlineResponse: [], now: later,
      tradeStart: NOW - 5 * 60_000, transferStart: NOW - 7 * 86_400_000,
      depositStart: NOW - 7 * 86_400_000, withdrawalStart: NOW - 7 * 86_400_000,
      tradeBudget: 0, transferBudget: 2
    });

    expect(calls).toEqual([
      { start: pendingAt, end: pendingAt },
      { start: NOW - 7 * 86_400_000, end: later }
    ]);
    expect(result.transactions).toHaveLength(1);
    expect(result.partial.deposits).toBe(true);
    expect(result.cursors.deposits).toBeUndefined();
    expect(result.checkpoint?.deposits.pendingWindows).toContainEqual({ start: pendingAt, end: pendingAt });
    expect(result.checkpoint?.deposits.unsafeEvidence).toContainEqual({
      id: pendingId, start: pendingAt, end: pendingAt, reason: 'unresolved_transfer_status'
    });
  });

  it('fails closed when overlapping transfer windows return conflicting rows for one identity', async () => {
    const pendingAt = NOW - 1_000;
    const prior = createMexcCheckpoint(NOW - 10_000, NOW - 10_000, NOW, []);
    const pending = deposit('conflicting-overlap', pendingAt, '2');
    prior.trade.pendingWindows = [];
    prior.deposits.pendingWindows = [{ start: pendingAt, end: pendingAt }];
    prior.deposits.unsafeEvidence = [{
      id: mexcDepositSourceRef(pending), start: pendingAt, end: pendingAt, reason: 'unresolved_transfer_status'
    }];
    prior.withdrawals.pendingWindows = [];
    const c = client(async () => []);
    let request = 0;
    c.fetchDeposits = async () => {
      request += 1;
      const row = request === 1 ? pending : { ...pending, info: { ...pending.info, status: '3' } };
      c.last_json_response = [row.info!];
      return [row];
    };
    const result = await fetchMexcHistory({
      client: c, markets: {}, prior, knownSymbols: [], offlineResponse: [], now: NOW + 1,
      tradeStart: NOW - 5 * 60_000, transferStart: NOW - 7 * 86_400_000,
      tradeBudget: 0, transferBudget: 2
    });
    expect(result.partial.deposits).toBe(true);
    expect(result.checkpoint?.deposits.unsafeEvidence.some((item) =>
      item.reason === 'conflicting_duplicate_transfer_id')).toBe(true);
  });

  it('prefers the raw native deposit txId over CCXT fallbacks', () => {
    const base = {
      type: 'deposit', timestamp: NOW, currency: 'USDT', amount: 10, status: 'ok',
      id: 'id-fallback', txid: 'unified-fallback',
      info: { status: '5', txId: 'native:0', transHash: 'hash', network: 'TRX', coin: 'USDT-TRX', insertTime: String(NOW), amount: '10', address: 'a', memo: '' }
    };
    expect(mexcDepositSourceRef(base)).toBe('native:0');
    expect(mexcDepositSourceRef({ ...base, info: { ...base.info, txId: '' } })).toBe('unified-fallback');
  });
});
