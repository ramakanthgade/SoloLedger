import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bitfinexParser } from '@/lib/parsers/bitfinex';
import { clearAllData, db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bitfinex', file), 'utf8')) as { response: T }).response;

type CcxtBitfinex = {
  markets: Record<string, UnifiedMarket>;
  markets_by_id: Record<string, UnifiedMarket[]>;
  parseTrades(rows: unknown[]): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};

let client: CcxtBitfinex;
const spot: UnifiedMarket = { id: 'tBTCUSD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true };
const eth: UnifiedMarket = { id: 'tETHUSD', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', spot: true, active: true };
const derivative: UnifiedMarket = {
  id: 'tBTCF0:USTF0', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', spot: false, active: true
};

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { bitfinex: new (config: object) => CcxtBitfinex };
  client = new ccxt.bitfinex({ options: { defaultType: 'spot' } });
  client.markets = { 'BTC/USD': spot, 'ETH/USD': eth, 'BTC/USDT:USDT': derivative };
  client.markets_by_id = { tBTCUSD: [spot], tETHUSD: [eth], 'tBTCF0:USTF0': [derivative] };
});

beforeEach(async () => clearAllData());

describe('Bitfinex normalization and identity', () => {
  it('parses native ids and keeps immutable trade/deposit/withdrawal kinds', () => {
    const rawTrades = fixture<unknown[][]>('trades.json');
    const trades = client.parseTrades(rawTrades.map((result) => ({ result })));
    expect(normalizeTrade('bitfinex', trades[0], spot)).toMatchObject({
      source: 'bitfinex_api', sourceRef: '42', type: 'buy', asset: 'BTC', amount: 0.01,
      raw: expect.objectContaining({ exchangeSyncKind: 'trade', tradeId: '42' })
    });

    const transfers = client.parseTransactions(fixture<unknown[][]>('movements.json'));
    const deposit = transfers.find((row) => row.id === '42' && row.type === 'deposit')!;
    const withdrawal = transfers.find((row) => row.id === '47' && row.type === 'withdrawal')!;
    expect(normalizeTransfer('bitfinex', deposit)).toMatchObject({
      sourceRef: '42', type: 'transfer_in', raw: expect.objectContaining({ exchangeSyncKind: 'deposit' })
    });
    expect(normalizeTransfer('bitfinex', withdrawal)).toMatchObject({
      sourceRef: '47', type: 'transfer_out', raw: expect.objectContaining({ exchangeSyncKind: 'withdrawal' })
    });
    expect(transfers.filter((row) => row.status !== 'ok').every((row) => normalizeTransfer('bitfinex', row) == null)).toBe(true);
  });

  it('scopes API identity by connection and immutable endpoint kind', () => {
    const base = { source: 'bitfinex_api', sourceRef: '42', importBatchId: 'account-a' } as const;
    expect(transactionExchangeKey({ ...base, type: 'income', raw: { exchangeSyncKind: 'trade' } }))
      .toBe('ex-api:account-a:bitfinex:trade:42');
    expect(transactionExchangeKey({ ...base, type: 'sell', raw: { exchangeSyncKind: 'deposit' } }))
      .toBe('ex-api:account-a:bitfinex:deposit:42');
    expect(transactionExchangeKey({ ...base, type: 'buy', raw: { exchangeSyncKind: 'withdrawal' } }))
      .toBe('ex-api:account-a:bitfinex:withdrawal:42');
  });

  it('explicitly does not auto-deduplicate the beta Trades CSV with API rows', async () => {
    const csv = bitfinexParser.parse([{
      '#': '42', Date: '2026-08-01 00:00:01', Pair: 'BTC/USD', Amount: '0.01',
      Price: '64000', Fee: '1.28', 'Fee Currency': 'USD'
    }]).transactions[0];
    const api = {
      ...csv,
      id: 'api-row',
      source: 'bitfinex_api',
      importBatchId: 'account-a',
      raw: { exchangeSyncKind: 'trade', tradeId: '42' }
    };
    await db.transactions.bulkAdd([csv, api]);
    expect(transactionExchangeKey(csv)).toBe('ex:42');
    expect(transactionExchangeKey(api)).toBe('ex-api:account-a:bitfinex:trade:42');
    expect(await deduplicateTransactions()).toBe(0);
    expect(await db.transactions.count()).toBe(2);
  });
});
