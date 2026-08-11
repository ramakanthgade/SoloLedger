import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import { exchangeSourceRef } from '@/lib/parsers/types';
import { normalizeTrade } from './normalize';

const market = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true };
const fill = { id: '7', timestamp: 1_700_000_000_123, symbol: 'BTC/USDT', side: 'buy', amount: 0.5, cost: 10_000, info: {} };

describe('next-five dedup contract', () => {
  beforeEach(async () => db.transactions.clear());

  it.each(['bitrue', 'xt', 'phemex', 'lbank'] as const)(
    '%s native-id replay is idempotent through the real database deduper',
    async (exchange) => {
      const first = normalizeTrade(exchange, fill, market)!;
      const replay = normalizeTrade(exchange, { ...fill }, market)!;
      await db.transactions.bulkPut([first, replay]);
      expect(await deduplicateTransactions()).toBe(1);
      const remaining = await db.transactions.toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sourceRef).toBe(first.sourceRef);
    }
  );

  it('does not fabricate CoinSpot CSV/API collisions without deterministic native twins', () => {
    const api = normalizeTrade('coinspot', { ...fill, id: undefined }, market)!;
    const csv = {
      ...api,
      source: 'coinspot',
      sourceRef: exchangeSourceRef('coinspot', api.timestamp, api.type, api.asset, api.amount)
    };
    expect(transactionExchangeKey(api)).not.toBe(transactionExchangeKey(csv));
  });
});
