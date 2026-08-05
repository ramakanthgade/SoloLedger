import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htxParser } from '@/lib/parsers/htx';
import { loadFixtureRows } from '@/lib/parsers/__fixtures__/fixtureUtils';
import { db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { mergeHtxOrderTransactions, normalizeHtxTradesByOrder, normalizeTransfer } from './normalize';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'btcusdt', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }
};

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'htx', file), 'utf8')) as { response: T }).response;
}

interface CcxtHtx {
  parseTrades(rows: unknown[]): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
  markets: Record<string, unknown>;
  markets_by_id: Record<string, unknown[]>;
}

let htx: CcxtHtx;
beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { htx: new (config: object) => CcxtHtx };
  htx = new ccxt.htx({ options: {
    defaultType: 'spot',
    networkNamesByChainIds: { __sololedger__: '__sololedger__' },
    networkChainIdsByNames: { __sololedger__: {} }
  } });
  htx.markets = MARKETS;
  htx.markets_by_id = { btcusdt: [MARKETS['BTC/USDT']] };
});

function apiTrades(): Transaction[] {
  const parsed = htx.parseTrades(fixture<{ data: unknown[] }>('myTrades.json').data);
  return normalizeHtxTradesByOrder(parsed, MARKETS).transactions;
}

function csvRows(): Transaction[] {
  return htxParser.parse(loadFixtureRows('../../exchangeSync/__fixtures__/htx/history.csv')).transactions;
}

describe('HTX normalization', () => {
  beforeEach(async () => db.transactions.clear());

  it('uses raw id as durable fill evidence but aggregates by CSV Order ID', () => {
    const parsed = htx.parseTrades(fixture<{ data: unknown[] }>('myTrades.json').data);
    const parsedFill = parsed.find((fill) => fill.id === '600002')!;
    expect(parsedFill.info?.id).toBe(900003);
    const [order] = normalizeHtxTradesByOrder(parsed, MARKETS).transactions;
    expect(order).toMatchObject({
      source: 'htx_api', sourceRef: '700001', type: 'buy', asset: 'BTC', amount: 0.1,
      counterAsset: 'USDT', counterAmount: 5000, feeAmount: 0.0001, feeAsset: 'BTC'
    });
    expect(order.raw?.htxFills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '600002', nativeId: '900003' }),
      expect.objectContaining({ id: '600001', nativeId: '900017' })
    ]));
    expect(order.sourceRef).toBe(csvRows()[0].sourceRef);
  });

  it('maps native deposit/withdraw record ids to fixture-demonstrated CSV refs', () => {
    const deposits = htx.parseTransactions(fixture<{ data: unknown[] }>('deposits.json').data);
    const withdrawals = htx.parseTransactions(fixture<{ data: unknown[] }>('withdrawals.json').data);
    const settledDeposit = deposits.find((item) => item.id === '75115912')!;
    const pendingDeposit = deposits.find((item) => item.id === '75115999')!;
    const settledWithdrawal = withdrawals.find((item) => item.id === '61335312')!;
    const pendingWithdrawal = withdrawals.find((item) => item.id === '61335399')!;
    const normalized = [normalizeTransfer('htx', settledDeposit), normalizeTransfer('htx', settledWithdrawal)];
    expect(normalized).toEqual([
      expect.objectContaining({ source: 'htx_api', sourceRef: '75115912', type: 'transfer_in' }),
      expect.objectContaining({ source: 'htx_api', sourceRef: '61335312', type: 'transfer_out', feeAmount: 0.001 })
    ]);
    expect(normalizeTransfer('htx', pendingDeposit)).toBeNull();
    expect(normalizeTransfer('htx', pendingWithdrawal)).toBeNull();
    expect(normalized.map((row) => row!.sourceRef).sort())
      .toEqual(csvRows().slice(1).map((row) => row.sourceRef).sort());
  });

  it('deduplicates in both CSV/API import orders while retaining API fill evidence', async () => {
    const api = apiTrades().map((row) => ({ ...row, importBatchId: 'htx-connection' }));
    const csv = csvRows().slice(0, 1);
    for (const first of ['csv', 'api'] as const) {
      await db.transactions.clear();
      await db.transactions.bulkPut(first === 'csv' ? csv : api);
      await db.transactions.bulkPut(first === 'csv' ? api : csv);
      await deduplicateTransactions();
      const rows = await db.transactions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'htx', sourceRef: '700001' });
      expect(rows[0].dedupMatchedApiRow?.raw?.htxFills).toHaveLength(2);
    }
  });

  it('reconciles later fills without overwriting user review state', () => {
    const first = apiTrades()[0];
    const existing = {
      ...first, amount: 0.04, counterAmount: 2000, type: 'income' as const,
      notes: 'reviewed', fiatValue: 123, isSpam: true,
      raw: { ...first.raw, htxFills: (first.raw?.htxFills as unknown[]).slice(0, 1) }
    };
    const merged = mergeHtxOrderTransactions(existing, first);
    expect(merged).toMatchObject({
      type: 'income', notes: 'reviewed', fiatValue: 123, isSpam: true,
      amount: 0.1, counterAmount: 5000, feeAmount: 0.0001
    });
    expect(merged.raw?.htxFills).toHaveLength(2);
  });

  it('keeps signed rebates as evidence and posts only a positive net same-currency fee', () => {
    const fills: UnifiedTrade[] = [
      { id: 'fee', order: 'rebate-order', timestamp: 1, symbol: 'BTC/USDT', side: 'buy', amount: 0.1,
        cost: 5000, fee: { cost: 0.0003, currency: 'BTC' }, info: { id: '91' } },
      { id: 'rebate', order: 'rebate-order', timestamp: 2, symbol: 'BTC/USDT', side: 'buy', amount: 0.1,
        cost: 5000, fee: { cost: -0.0001, currency: 'BTC' }, info: { id: '92' } }
    ];
    const normalized = normalizeHtxTradesByOrder(fills, MARKETS);
    expect(normalized.rebateFills).toBe(1);
    expect(normalized.transactions[0].feeAmount).toBeCloseTo(0.0002);
    expect(normalized.transactions[0].raw?.htxFills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rebate', feeAmount: -0.0001 })
    ]));
  });

  it('never converts a pure rebate into an expense across late-fill reconciliation', () => {
    const fill = (id: string, nativeId: string, feeAmount: number): UnifiedTrade => ({
      id, order: 'pure-rebate', timestamp: Number(nativeId), symbol: 'BTC/USDT', side: 'buy',
      amount: 0.01, cost: 500, fee: { cost: feeAmount, currency: 'BTC' }, info: { id: nativeId }
    });
    const first = normalizeHtxTradesByOrder([fill('r1', '101', -0.00001)], MARKETS).transactions[0];
    const later = normalizeHtxTradesByOrder([fill('r2', '102', -0.00002)], MARKETS).transactions[0];
    expect(first.feeAmount).toBeUndefined();
    const merged = mergeHtxOrderTransactions(first, later);
    expect(merged.feeAmount).toBeUndefined();
    expect((merged.raw?.htxFills as Array<{ feeAmount: number }>).map((item) => item.feeAmount))
      .toEqual([-0.00001, -0.00002]);
  });

  it('does not claim rebate evidence was retained when the negative-fee fill cannot normalize', () => {
    const result = normalizeHtxTradesByOrder([{
      id: 'skipped-rebate', order: 'missing-market', timestamp: 1, symbol: 'UNKNOWN/USDT', side: 'buy',
      amount: undefined, cost: undefined, fee: { cost: -0.01, currency: 'UNKNOWN' }, info: { id: '404' }
    }], MARKETS);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.rebateFills).toBe(0);
  });

  it('scopes HTX API identity by connection while a reconnect of the same connection remains idempotent', async () => {
    const base = apiTrades()[0];
    const first = { ...base, id: 'connection-a-first', importBatchId: 'connection-a' };
    const replay = { ...base, id: 'connection-a-replay', importBatchId: 'connection-a' };
    const other = { ...base, id: 'connection-b', importBatchId: 'connection-b' };
    expect(transactionExchangeKey(first)).toBe(transactionExchangeKey(replay));
    expect(transactionExchangeKey(first)).not.toBe(transactionExchangeKey(other));
    await db.transactions.bulkPut([first, replay, other]);
    await deduplicateTransactions();
    const survivors = await db.transactions.toArray();
    expect(survivors).toHaveLength(2);
    expect(new Set(survivors.map((row) => row.importBatchId))).toEqual(new Set(['connection-a', 'connection-b']));
  });

  it('binds an HTX CSV row only to the uniquely economics-matching connection', async () => {
    const base = apiTrades()[0];
    const matching = { ...base, id: 'matching-api', importBatchId: 'connection-a' };
    const different = { ...base, id: 'different-api', importBatchId: 'connection-b', amount: 0.2, counterAmount: 10_000 };
    const csv = { ...csvRows()[0], id: 'csv-unique' };
    await db.transactions.bulkPut([matching, different, csv]);
    await deduplicateTransactions();
    const survivor = await db.transactions.get('csv-unique');
    expect(survivor?.dedupMatchedApiRow?.importBatchId).toBe('connection-a');
    expect(await db.transactions.get('different-api')).toBeDefined();
  });

  it('leaves an identical two-connection HTX CSV match unreconciled as ambiguous', async () => {
    const base = apiTrades()[0];
    await db.transactions.bulkPut([
      { ...base, id: 'ambiguous-a', importBatchId: 'connection-a' },
      { ...base, id: 'ambiguous-b', importBatchId: 'connection-b' },
      { ...csvRows()[0], id: 'csv-ambiguous' }
    ]);
    await deduplicateTransactions();
    const csv = await db.transactions.get('csv-ambiguous');
    expect(csv?.dedupMatchedApiRow).toBeUndefined();
    expect(await db.transactions.get('ambiguous-a')).toBeDefined();
    expect(await db.transactions.get('ambiguous-b')).toBeDefined();
  });

  it('reconciles HTX candidates correctly in a large mixed ledger', async () => {
    const base = apiTrades()[0];
    const unrelated: Transaction[] = Array.from({ length: 2_000 }, (_, index) => ({
      ...base,
      id: `unrelated-${index}`,
      source: 'htx_api',
      sourceRef: `unrelated-order-${index}`,
      importBatchId: `connection-${index % 20}`
    }));
    const matching = { ...base, id: 'large-match', importBatchId: 'large-a' };
    const other = { ...base, id: 'large-other', importBatchId: 'large-b', amount: 0.2, counterAmount: 10_000 };
    const csv = { ...csvRows()[0], id: 'large-csv' };
    await db.transactions.bulkPut([...unrelated, matching, other, csv]);
    await deduplicateTransactions();
    const survivor = await db.transactions.get('large-csv');
    expect(survivor?.dedupMatchedApiRow?.id).toBe('large-match');
    expect(await db.transactions.get('large-match')).toBeUndefined();
    expect(await db.transactions.get('large-other')).toBeDefined();
    expect(await db.transactions.where('source').equals('htx_api').count()).toBe(2_001);
  });
});
