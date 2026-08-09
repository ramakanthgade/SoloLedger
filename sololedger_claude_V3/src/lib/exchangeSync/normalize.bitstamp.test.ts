import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearAllData, db, deduplicateTransactions, transactionExchangeKey, DEFAULT_SETTINGS
} from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';
import { normalizeTrade, normalizeTransfer } from './normalize';
import { parseBitstampRawTransfer } from './engine';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bitstamp', file), 'utf8')) as { response: T }).response;
const markets: Record<string, UnifiedMarket> = {
  'BTC/USD': {
    id: 'btcusd', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true,
    baseId: 'BTC', quoteId: 'USD'
  } as UnifiedMarket,
  'ETH/BTC': {
    id: 'ethbtc', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true,
    baseId: 'ETH', quoteId: 'BTC'
  } as UnifiedMarket
};
type CcxtBitstamp = {
  parseTrade(row: unknown, market: UnifiedMarket): UnifiedTrade;
};
let bitstamp: CcxtBitstamp;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { bitstamp: new (config: object) => CcxtBitstamp };
  bitstamp = new ccxt.bitstamp({});
});
beforeEach(async () => clearAllData());

function normalizedRows(): Transaction[] {
  const raw = fixture<Array<Record<string, unknown>>>('userTransactions.json');
  const trades = raw.filter((row) => row.type === '2' && (row.id === 100 || row.id === 101 || row.id === 109))
    .map((row) => {
      const market = row.eth_btc != null ? markets['ETH/BTC'] : markets['BTC/USD'];
      return normalizeTrade('bitstamp', bitstamp.parseTrade(row, market), market);
    });
  const transfers = raw.filter((row) =>
    (row.type === '0' || row.type === '1') && (row.id === 102 || row.id === 103 || row.id === 109))
    .map(parseBitstampRawTransfer)
    .filter((row): row is UnifiedTransfer => row != null);
  return [...trades, ...transfers.map((row) => normalizeTransfer('bitstamp', row))]
    .filter((row): row is Transaction => row != null);
}

describe('Bitstamp normalization, tax semantics and replay identity', () => {
  it('normalizes real pinned-CCXT spot trades and settled transfers with immutable kinds', () => {
    const rows = normalizedRows();
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.sourceRef)).toEqual(['100', '101', '109', '102', '103', '109']);
    expect(rows.every((row) => row.source === 'bitstamp_api')).toBe(true);
    expect(rows.find((row) => row.sourceRef === '100')).toMatchObject({
      type: 'buy', asset: 'BTC', fiatCurrency: 'USD', fiatValue: 5_000
    });
    expect(rows.find((row) => row.sourceRef === '101')).toMatchObject({
      type: 'trade', asset: 'ETH', counterAsset: 'BTC'
    });
    expect(new Set(rows.map((row) => row.raw?.exchangeSyncKind))).toEqual(
      new Set(['trade', 'deposit', 'withdrawal'])
    );
  });

  it('preserves tax policy and posting signs without changing cost-basis behavior', () => {
    const rows = normalizedRows().map((row) => ({ ...row, importBatchId: 'bitstamp-account' }));
    for (const row of rows.filter((candidate) => candidate.type === 'buy' || candidate.type === 'sell' || candidate.type === 'trade')) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: row, settings: DEFAULT_SETTINGS }).treatment)
        .not.toBe('requires_review');
    }
    const postings = derivePostings(rows, {
      exchangeConnections: [{ id: 'bitstamp-account', exchange: 'bitstamp' }]
    });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.1, 0.05, 0.25, 0.03, 0.02]));
    expect(postings.some((posting) => posting.asset === 'ETH' && posting.signedQuantity === -1)).toBe(true);
    expect(postings.some((posting) => posting.asset === 'ETH' && posting.signedQuantity === -0.5)).toBe(true);
  });

  it('scopes the same native id by account and immutable kind', async () => {
    const sameId = normalizedRows().filter((row) => row.sourceRef === '109');
    expect(sameId).toHaveLength(2);
    const trade = { ...sameId.find((row) => row.raw?.exchangeSyncKind === 'trade')!, id: 'trade', importBatchId: 'a' };
    const deposit = { ...sameId.find((row) => row.raw?.exchangeSyncKind === 'deposit')!, id: 'deposit', importBatchId: 'a' };
    const replay = { ...trade, id: 'replay' };
    const otherAccount = { ...trade, id: 'other', importBatchId: 'b' };
    expect(transactionExchangeKey(trade)).toBe('ex-api:a:bitstamp:trade:109');
    expect(transactionExchangeKey(deposit)).toBe('ex-api:a:bitstamp:deposit:109');
    expect(transactionExchangeKey(otherAccount)).toBe('ex-api:b:bitstamp:trade:109');
    await db.transactions.bulkPut([trade, deposit, replay, otherAccount]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(3);
  });
});
