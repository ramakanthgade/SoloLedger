import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearAllData, db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'cryptocom', file), 'utf8')) as { response: T }).response;

type CcxtCrypto = {
  markets: Record<string, UnifiedMarket>;
  markets_by_id: Record<string, UnifiedMarket[]>;
  parseTrades(rows: unknown[]): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};
let client: CcxtCrypto;
const spot: UnifiedMarket = { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };
const perp: UnifiedMarket = { id: 'ETHUSD-PERP', symbol: 'ETH/USD:USD', base: 'ETH', quote: 'USD', spot: false, active: true };

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { cryptocom: new (config: object) => CcxtCrypto };
  client = new ccxt.cryptocom({ options: { defaultType: 'spot' } });
  client.markets = { 'BTC/USDT': spot, 'ETH/USD:USD': perp };
  client.markets_by_id = { BTC_USDT: [spot], 'ETHUSD-PERP': [perp] };
});

beforeEach(async () => clearAllData());

describe('Crypto.com Exchange normalization', () => {
  it('uses native trade_id and native wallet ids, with txid retained as evidence', () => {
    const rawTrades = fixture<{ result: { data: unknown[] } }>('trades.json').result.data;
    const trades = client.parseTrades(rawTrades);
    const spotTrade = trades.find((trade) => trade.id === '90001')!;
    expect(normalizeTrade('cryptocom', spotTrade, spot)).toMatchObject({
      source: 'cryptocom_api', sourceRef: '90001', type: 'buy', asset: 'BTC', amount: 0.01,
      raw: expect.objectContaining({ exchangeSyncKind: 'trade' })
    });
    const deposits = client.parseTransactions(fixture<{ result: { deposit_list: unknown[] } }>('deposits.json').result.deposit_list);
    const withdrawals = client.parseTransactions(fixture<{ result: { withdrawal_list: unknown[] } }>('withdrawals.json').result.withdrawal_list);
    expect(normalizeTransfer('cryptocom', deposits[0])).toMatchObject({
      sourceRef: '42', raw: expect.objectContaining({
        txid: 'same-economic-txid/0', exchangeSyncKind: 'deposit', transferType: 'deposit'
      })
    });
    expect(normalizeTransfer('cryptocom', deposits[1])).toBeNull();
    expect(normalizeTransfer('cryptocom', withdrawals[0])).toMatchObject({
      sourceRef: '42', type: 'transfer_out',
      raw: expect.objectContaining({ exchangeSyncKind: 'withdrawal', transferType: 'withdrawal' })
    });
    expect(normalizeTransfer('cryptocom', withdrawals[1])).toBeNull();
  });

  it('scopes API identity by connection and endpoint kind', () => {
    const base = { source: 'cryptocom_api', sourceRef: '42' } as const;
    expect(transactionExchangeKey({ ...base, importBatchId: 'a', type: 'income', raw: { exchangeSyncKind: 'trade' } }))
      .toBe('ex-api:a:cryptocom:trade:42');
    expect(transactionExchangeKey({ ...base, importBatchId: 'a', type: 'gift_received', raw: { exchangeSyncKind: 'deposit' } }))
      .toBe('ex-api:a:cryptocom:deposit:42');
    expect(transactionExchangeKey({ ...base, importBatchId: 'a', type: 'fee', raw: { exchangeSyncKind: 'withdrawal' } }))
      .toBe('ex-api:a:cryptocom:withdrawal:42');
    expect(transactionExchangeKey({ ...base, importBatchId: 'b', type: 'buy', raw: { exchangeSyncKind: 'trade' } })).not.toBe(
      transactionExchangeKey({ ...base, importBatchId: 'a', type: 'buy', raw: { exchangeSyncKind: 'trade' } })
    );
  });

  it('recovers legacy endpoint kind from immutable raw evidence before mutable type', () => {
    const base = { source: 'cryptocom_api', sourceRef: '42', importBatchId: 'a' } as const;
    expect(transactionExchangeKey({ ...base, type: 'transfer_out', raw: { tradeId: '42' } }))
      .toBe('ex-api:a:cryptocom:trade:42');
    expect(transactionExchangeKey({ ...base, type: 'sell', raw: { transferType: 'deposit' } }))
      .toBe('ex-api:a:cryptocom:deposit:42');
    expect(transactionExchangeKey({ ...base, type: 'income', raw: { clientWid: '' } }))
      .toBe('ex-api:a:cryptocom:withdrawal:42');
  });

  it('never auto-dedups Crypto.com App CSV with Exchange API, even for identical txid/economics', async () => {
    const common: Omit<Transaction, 'id' | 'source' | 'sourceRef'> = {
      timestamp: 1_782_950_400_000, type: 'transfer_in', asset: 'BTC', amount: 0.02,
      fiatCurrency: 'USD', flags: ['possible_internal_transfer'],
      isInternalTransfer: false, txHash: 'same-economic-txid'
    };
    await db.transactions.bulkAdd([
      { ...common, id: 'app', source: 'cryptocom', sourceRef: 'same-economic-txid' },
      { ...common, id: 'api', source: 'cryptocom_api', sourceRef: '42', importBatchId: 'exchange-account-a' }
    ]);
    expect(await deduplicateTransactions()).toBe(0);
    expect(await db.transactions.count()).toBe(2);
  });
});
