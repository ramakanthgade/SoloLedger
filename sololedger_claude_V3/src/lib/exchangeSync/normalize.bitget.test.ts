import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearAllData, db, deduplicateTransactions, transactionExchangeKey, DEFAULT_SETTINGS } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bitget', file), 'utf8')) as { response: T }).response;
const market: UnifiedMarket = {
  id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true
};
type CcxtBitget = {
  parseTrade(row: unknown, market: UnifiedMarket): UnifiedTrade;
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};
let bitget: CcxtBitget;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { bitget: new (config: object) => CcxtBitget };
  bitget = new ccxt.bitget({ options: { uta: false } });
});
beforeEach(async () => clearAllData());

function apiRows(): Transaction[] {
  const trades = fixture<unknown[]>('trades.json').map((row) => bitget.parseTrade(row, market));
  const transfers = bitget.parseTransactions([
    ...fixture<unknown[]>('deposits.json'), ...fixture<unknown[]>('withdrawals.json')
  ]);
  return [
    ...trades.map((trade) => normalizeTrade('bitget', trade, market)),
    ...transfers.map((transfer) => normalizeTransfer('bitget', transfer))
  ].filter((row): row is Transaction => row != null);
}

describe('Bitget schema-faithful parser, tax/posting semantics and scoped replay identity', () => {
  it('parses native tradeId/orderId shapes and imports settled spot economics only', () => {
    const rows = apiRows();
    expect(rows.map((row) => row.type)).toEqual(['sell', 'buy', 'transfer_out', 'transfer_in']);
    expect(rows[0]).toMatchObject({
      source: 'bitget_api', sourceRef: '1098394344974925824', asset: 'BTC', amount: 0.0002,
      counterAsset: 'USDT', counterAmount: 5.693536, feeAsset: 'USDT', feeAmount: 0.005693536,
      raw: { exchangeSyncKind: 'trade' }
    });
    expect(rows.find((row) => row.type === 'transfer_out')).toMatchObject({
      sourceRef: '1083832260799930268', amount: 0.0099, feeAmount: 0.0001,
      raw: { exchangeSyncKind: 'withdrawal' }
    });
    expect(rows.some((row) => row.sourceRef === '1083832260799930300')).toBe(false);
  });

  it('keeps ordinary spot tax treatment and derived posting signs without cost-basis changes', () => {
    const rows = apiRows().map((row) => ({ ...row, importBatchId: 'bitget-account' }));
    const buy = rows.find((row) => row.type === 'buy')!;
    const sell = rows.find((row) => row.type === 'sell')!;
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: buy, settings: DEFAULT_SETTINGS }).treatment)
      .not.toBe('requires_review');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: sell, settings: DEFAULT_SETTINGS }).treatment)
      .not.toBe('requires_review');
    const postings = derivePostings(rows, {
      exchangeConnections: [{ id: 'bitget-account', exchange: 'bitget' }]
    });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([-0.0002, 0.001, 0.0003, -0.0099]));
  });

  it('deduplicates replay only inside one connection and immutable endpoint kind', async () => {
    const trade = apiRows()[0]!;
    const a = { ...trade, id: 'a', importBatchId: 'account-a' };
    const replay = { ...trade, id: 'replay', importBatchId: 'account-a' };
    const other = { ...trade, id: 'other', importBatchId: 'account-b' };
    const depositKind = { ...trade, id: 'deposit-kind', importBatchId: 'account-a', raw: { exchangeSyncKind: 'deposit' } };
    expect(transactionExchangeKey(a)).toBe('ex-api:account-a:bitget:trade:1098394344974925824');
    expect(transactionExchangeKey(other)).not.toBe(transactionExchangeKey(a));
    expect(transactionExchangeKey(depositKind)).not.toBe(transactionExchangeKey(a));
    await db.transactions.bulkPut([a, replay, other, depositKind]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(3);
  });
});
