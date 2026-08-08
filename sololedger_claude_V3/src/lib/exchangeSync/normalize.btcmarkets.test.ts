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
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'btcmarkets', file), 'utf8')) as { response: T }).response;
const markets: Record<string, UnifiedMarket> = {
  'BTC/AUD': { id: 'BTC-AUD', symbol: 'BTC/AUD', base: 'BTC', quote: 'AUD', spot: true, active: true },
  'ETH/BTC': { id: 'ETH-BTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};
type CcxtBtcMarkets = {
  parseTrade(row: unknown, market: UnifiedMarket): UnifiedTrade;
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
};
let btcmarkets: CcxtBtcMarkets;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { btcmarkets: new (config: object) => CcxtBtcMarkets };
  btcmarkets = new ccxt.btcmarkets({});
});
beforeEach(async () => clearAllData());

function apiRows(): Transaction[] {
  const trades = fixture<Array<Record<string, unknown>>>('trades.json').map((raw) => {
    const market = Object.values(markets).find((candidate) => candidate.id === raw.marketId)!;
    return btcmarkets.parseTrade(raw, market);
  });
  const transfers = btcmarkets.parseTransactions(fixture<unknown[]>('transfers.json'));
  return [
    ...trades.map((trade) => normalizeTrade('btcmarkets', trade, markets[trade.symbol!])),
    ...transfers.map((transfer) => normalizeTransfer('btcmarkets', transfer))
  ].filter((row): row is Transaction => row != null);
}

describe('BTC Markets normalization, tax semantics and replay identity', () => {
  it('normalizes ordinary AUD buys/sells, crypto trades and settled transfers only', () => {
    const rows = apiRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.type)).toEqual(['trade', 'sell', 'buy', 'transfer_in', 'transfer_out']);
    expect(rows.find((row) => row.type === 'buy')).toMatchObject({
      source: 'btcmarkets_api', sourceRef: '910001', fiatCurrency: 'AUD', fiatValue: 25_000
    });
    expect(rows.find((row) => row.type === 'sell')).toMatchObject({ fiatCurrency: 'AUD', fiatValue: 10_500 });
    expect(rows.find((row) => row.type === 'trade')).toMatchObject({ asset: 'BTC', counterAsset: 'ETH' });
    expect(rows.filter((row) => row.type.startsWith('transfer_')).every(
      (row) => row.flags.includes('possible_internal_transfer') && row.raw?.exchangeSyncKind != null
    )).toBe(true);
  });

  it('keeps tax policy and derived posting signs correct without changing cost-basis code', () => {
    const rows = apiRows().map((row) => ({ ...row, importBatchId: 'btcmarkets-account' }));
    const buy = rows.find((row) => row.type === 'buy')!;
    const sell = rows.find((row) => row.type === 'sell')!;
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: buy, settings: DEFAULT_SETTINGS }).treatment)
      .not.toBe('requires_review');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: sell, settings: DEFAULT_SETTINGS }).treatment)
      .not.toBe('requires_review');
    const postings = derivePostings(rows, {
      exchangeConnections: [{ id: 'btcmarkets-account', exchange: 'btcmarkets' }]
    });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.25, -0.1, -0.05, 0.5]));
    expect(postings.some((posting) => posting.asset === 'ETH' && posting.signedQuantity === 1)).toBe(true);
  });

  it('scopes native ids by connection and endpoint kind and never invents CSV collision', async () => {
    const row = apiRows().find((item) => item.type === 'buy')!;
    const a = { ...row, id: 'a', importBatchId: 'account-a' };
    const replay = { ...row, id: 'replay', importBatchId: 'account-a' };
    const other = { ...row, id: 'other', importBatchId: 'account-b' };
    expect(transactionExchangeKey(a)).toBe('ex-api:account-a:btcmarkets:trade:910001');
    expect(transactionExchangeKey(other)).not.toBe(transactionExchangeKey(a));
    await db.transactions.bulkPut([a, replay, other]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(2);
  });
});
