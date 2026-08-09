import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearAllData, db, deduplicateTransactions, transactionExchangeKey, DEFAULT_SETTINGS } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';
import { normalizeTrade, normalizeTransfer, resolveMarket } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bitmart', file), 'utf8')) as { response: T }).response;
const markets: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/BTC': { id: 'ETH_BTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};
type CcxtBitmart = {
  parseTrades(rows: unknown[]): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};
let bitmart: CcxtBitmart;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { bitmart: new (config: object) => CcxtBitmart };
  bitmart = new ccxt.bitmart({});
});
beforeEach(async () => clearAllData());

function apiRows(): Transaction[] {
  // The transport sends orderMode=spot, so its fixture server excludes the
  // margin fill before CCXT normalization just as BitMart does.
  const tradeRows = fixture<{ data: Array<{ orderMode?: string }> }>('trades.json').data
    .filter((row) => row.orderMode === 'spot');
  const trades = bitmart.parseTrades(tradeRows);
  const deposits = bitmart.parseTransactions(fixture<{ data: { records: unknown[] } }>('deposits.json').data.records);
  const withdrawals = bitmart.parseTransactions(fixture<{ data: { records: unknown[] } }>('withdrawals.json').data.records);
  return [
    ...trades.map((trade) => normalizeTrade('bitmart', trade, resolveMarket(markets, trade.symbol))),
    ...deposits.map((transfer) => normalizeTransfer('bitmart', transfer)),
    ...withdrawals.map((transfer) => normalizeTransfer('bitmart', transfer))
  ].filter((row): row is Transaction => row != null);
}

describe('BitMart real-parser normalization, tax semantics and scoped identity', () => {
  it('imports spot fills and settled transfers, including pinned-CCXT withdraw mapping', () => {
    const rows = apiRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.type)).toEqual(['buy', 'sell', 'trade', 'transfer_in', 'transfer_out']);
    expect(rows.find((row) => row.type === 'buy')).toMatchObject({
      source: 'bitmart_api', sourceRef: 'bm-trade-1', fiatCurrency: 'USD', fiatValue: 25_000
    });
    expect(rows.find((row) => row.type === 'transfer_out')).toMatchObject({
      sourceRef: 'bm-transfer-2', amount: 0.05, feeAmount: 0.0001,
      raw: { exchangeSyncKind: 'withdrawal', transferType: 'withdraw' }
    });
    expect(rows.find((row) => row.type === 'transfer_in')).toMatchObject({
      sourceRef: 'bm-transfer-1', amount: 0.5, feeAmount: undefined, feeAsset: undefined,
      raw: { providerFee: { amount: 0.001, asset: 'BTC', includedInAmount: true } }
    });
    expect(rows.filter((row) => row.type.startsWith('transfer_')).every(
      (row) => row.flags.includes('possible_internal_transfer'))).toBe(true);
  });

  it('uses existing tax policy and posting signs without cost-basis changes', () => {
    const rows = apiRows().map((row) => ({ ...row, importBatchId: 'bitmart-account' }));
    for (const row of rows.filter((item) => item.type === 'buy' || item.type === 'sell')) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: row, settings: DEFAULT_SETTINGS }).treatment)
        .not.toBe('requires_review');
    }
    const postings = derivePostings(rows, {
      exchangeConnections: [{ id: 'bitmart-account', exchange: 'bitmart' }]
    });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.25, -0.1, -0.05, 0.5]));
    expect(postings.filter((posting) => posting.transactionId === rows.find((row) => row.type === 'transfer_in')?.id)
      .map((posting) => posting.signedQuantity)).toEqual([0.5]);
    expect(postings.some((posting) => posting.asset === 'ETH' && posting.signedQuantity === 1)).toBe(true);
    expect(postings.every((posting) => !('costBasis' in posting) && !('gain' in posting))).toBe(true);
  });

  it('scopes native ids by connection and immutable endpoint kind', async () => {
    const row = apiRows().find((item) => item.type === 'buy')!;
    const same = { ...row, id: 'same', importBatchId: 'account-a' };
    const replay = { ...row, id: 'replay', importBatchId: 'account-a' };
    const other = { ...row, id: 'other', importBatchId: 'account-b' };
    expect(transactionExchangeKey(same)).toBe('ex-api:account-a:bitmart:trade:bm-trade-1');
    expect(transactionExchangeKey(other)).not.toBe(transactionExchangeKey(same));
    await db.transactions.bulkPut([same, replay, other]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(2);
  });
});
import 'fake-indexeddb/auto';
