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
const fixture = <T,>(file: string): T => JSON.parse(readFileSync(join(HERE, '__fixtures__', 'mexc', file), 'utf8')) as T;
const market: UnifiedMarket = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };
type CcxtMexc = {
  parseTrade(row: unknown, market: UnifiedMarket): UnifiedTrade;
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};
let mexc: CcxtMexc;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { mexc: new (config: object) => CcxtMexc };
  mexc = new ccxt.mexc({ options: { defaultType: 'spot', fetchCurrencies: false } });
});
beforeEach(async () => clearAllData());

function apiRows(): Transaction[] {
  const trades = fixture<unknown[]>('trades.json').map((raw) => mexc.parseTrade(raw, market));
  const deposits = mexc.parseTransactions(fixture<unknown[]>('deposits.json'));
  const withdrawals = mexc.parseTransactions(fixture<unknown[]>('withdrawals.json'));
  return [
    ...trades.map((trade) => normalizeTrade('mexc', trade, market)),
    ...deposits.map((transfer) => normalizeTransfer('mexc', transfer)),
    ...withdrawals.map((transfer) => normalizeTransfer('mexc', transfer))
  ].filter((row): row is Transaction => row != null);
}

describe('MEXC pinned parser, tax semantics and identity', () => {
  it('normalizes stable-quoted spot fills and only verified settled transfer statuses', () => {
    const rows = apiRows();
    expect(rows.map((row) => row.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_in', 'transfer_out']);
    expect(rows[0]).toMatchObject({ source: 'mexc_api', sourceRef: '90001', fiatCurrency: 'USD', fiatValue: 600, raw: { exchangeSyncKind: 'trade' } });
    expect(rows.filter((row) => row.type === 'transfer_in').every((row) => row.sourceRef?.startsWith('mexc-deposit:'))).toBe(true);
    expect(rows.find((row) => row.type === 'transfer_out')).toMatchObject({ sourceRef: 'w-1', amount: 10, feeAmount: 1, raw: { exchangeSyncKind: 'withdrawal' } });
  });

  it('keeps canonical tax policy and derived posting signs unchanged', () => {
    const rows = apiRows().map((row) => ({ ...row, importBatchId: 'mexc-account' }));
    for (const row of rows.filter((item) => item.type === 'buy' || item.type === 'sell')) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: row, settings: DEFAULT_SETTINGS }).treatment)
        .not.toBe('requires_review');
    }
    const postings = derivePostings(rows, { exchangeConnections: [{ id: 'mexc-account', exchange: 'mexc' }] });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.01, -0.01]));
    expect(postings.filter((posting) => posting.asset === 'USDT').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([10, 2, -10]));
  });

  it('scopes replay identity by connection and immutable endpoint kind', async () => {
    const trade = apiRows()[0]!;
    const same = { ...trade, id: 'deposit', sourceRef: trade.sourceRef, type: 'transfer_in' as const,
      raw: { ...trade.raw, exchangeSyncKind: 'deposit' }, importBatchId: 'account-a' };
    const a = { ...trade, id: 'a', importBatchId: 'account-a' };
    const replay = { ...trade, id: 'replay', importBatchId: 'account-a' };
    const other = { ...trade, id: 'other', importBatchId: 'account-b' };
    expect(transactionExchangeKey(a)).toBe('ex-api:account-a:mexc:trade:90001');
    expect(transactionExchangeKey(same)).toBe('ex-api:account-a:mexc:deposit:90001');
    expect(transactionExchangeKey(other)).not.toBe(transactionExchangeKey(a));
    await db.transactions.bulkPut([a, replay, same, other]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(3);
  });
});
