import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import { exchangeSourceRef } from '@/lib/parsers/types';
import { normalizeTrade, normalizeTransfer } from './normalize';
import { assignCoinspotTradeIds } from './nextFiveExchanges';
import { loadCcxt } from './ccxtLoader';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    const api = normalizeTrade('coinspot', assignCoinspotTradeIds([{ ...fill, id: undefined }])[0], market)!;
    const csv = {
      ...api,
      source: 'coinspot',
      sourceRef: exchangeSourceRef('coinspot', api.timestamp, api.type, api.asset, api.amount)
    };
    expect(transactionExchangeKey(api)).not.toBe(transactionExchangeKey(csv));
  });

  it('persists two identical CoinSpot API fills across replay without collapsing multiplicity', async () => {
    const parsed = assignCoinspotTradeIds([0, 1].map(() => ({ ...fill, id: undefined })));
    const first = parsed.map((row) => normalizeTrade('coinspot', row, market)!);
    await db.transactions.bulkPut(first);
    expect(await deduplicateTransactions()).toBe(0);
    expect(await db.transactions.count()).toBe(2);
    const replay = assignCoinspotTradeIds([0, 1].map(() => ({ ...fill, id: undefined })))
      .map((row) => normalizeTrade('coinspot', row, market)!);
    expect(replay.map((row) => row.sourceRef)).toEqual(first.map((row) => row.sourceRef));
  });

  it('parses raw LBank fixture transfers through pinned CCXT and persists direction-stable refs', async () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/exchangeSync/__fixtures__/lbank/replay.json'), 'utf8'));
    const ccxt = await loadCcxt();
    const LBank = ccxt.lbank as new (config: Record<string, unknown>) => {
      parseTransaction(row: Record<string, unknown>): Parameters<typeof normalizeTransfer>[1];
    };
    const client = new LBank({ apiKey: 'key', secret: 'secret' });
    const deposit = normalizeTransfer('lbank', client.parseTransaction(fixture.deposits.data.depositOrders[0]), 'deposit')!;
    const withdrawal = normalizeTransfer('lbank', client.parseTransaction(fixture.withdrawals.data.withdraws[0]), 'withdrawal')!;
    expect(deposit.sourceRef).toBe('deposit:deposit-hash');
    expect(withdrawal.sourceRef).toBe('52');
    await db.transactions.bulkPut([deposit, withdrawal]);
    expect(await deduplicateTransactions()).toBe(0);
    expect(await db.transactions.count()).toBe(2);
  });
});
