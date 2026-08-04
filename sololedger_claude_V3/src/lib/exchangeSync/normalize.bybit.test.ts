import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bybitParser } from '@/lib/parsers/bybit';
import { loadFixtureRows } from '@/lib/parsers/__fixtures__/fixtureUtils';
import {
  db,
  deduplicateTransactions,
  filterAlreadyImported,
  transactionExchangeKey
} from '@/lib/storage/db';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { bybitNextCursor } from './engine';
import { normalizeBybitTradesByOrder, normalizeTransfer } from './normalize';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/USDT': { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true }
};

interface CcxtBybit {
  parseTrades(rows: unknown[], market?: unknown): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
  markets: Record<string, unknown>;
  markets_by_id: Record<string, unknown[]>;
}

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bybit', file), 'utf8')) as {
    response: T;
  }).response;
}

let bybit: CcxtBybit;

beforeAll(async () => {
  const ccxt = (await import('ccxt')) as unknown as { bybit: new (config: object) => CcxtBybit };
  bybit = new ccxt.bybit({ options: { defaultType: 'spot' } });
  bybit.markets = MARKETS;
  bybit.markets_by_id = Object.fromEntries(Object.values(MARKETS).map((market) => [market.id!, [market]]));
});

function apiTrades() {
  const response = fixture<{ result: { list: unknown[] } }>('myTrades.json');
  const parsed = bybit.parseTrades(response.result.list);
  return normalizeBybitTradesByOrder(parsed, MARKETS);
}

function csvTrades() {
  return bybitParser.parse(
    loadFixtureRows('../../exchangeSync/__fixtures__/bybit/tradeHistory.csv')
  ).transactions;
}

describe('Bybit normalization', () => {
  it('finds real-CCXT parsed cursors after trade/deposit/withdrawal sorting moves the tagged row', () => {
    const tradeRows = fixture<{ result: { list: Array<Record<string, unknown>> } }>('myTrades.json').result.list;
    const rawTrades = [...tradeRows].reverse().map((item) => ({ ...item }));
    rawTrades[0].nextPageCursor = 'trade-cursor';
    const parsedTrades = bybit.parseTrades(rawTrades);

    const depositRows = fixture<{ result: { rows: Array<Record<string, unknown>> } }>('deposits.json').result.rows;
    const rawDeposits = [...depositRows].reverse().map((item) => ({ ...item }));
    rawDeposits[0].nextPageCursor = 'deposit-cursor';
    const parsedDeposits = bybit.parseTransactions(rawDeposits);

    const withdrawalRows = fixture<{ result: { rows: Array<Record<string, unknown>> } }>('withdrawals.json').result.rows;
    const rawWithdrawals = [...withdrawalRows].reverse().map((item) => ({ ...item }));
    rawWithdrawals[0].nextPageCursor = 'withdrawal-cursor';
    const parsedWithdrawals = bybit.parseTransactions(rawWithdrawals);

    expect(parsedTrades.findIndex((row) => row.info?.nextPageCursor === 'trade-cursor')).toBeGreaterThan(0);
    expect(parsedDeposits.findIndex((row) => row.info?.nextPageCursor === 'deposit-cursor')).toBeGreaterThan(0);
    expect(parsedWithdrawals.findIndex((row) => row.info?.nextPageCursor === 'withdrawal-cursor')).toBeGreaterThan(0);
    expect(bybitNextCursor(parsedTrades)).toBe('trade-cursor');
    expect(bybitNextCursor(parsedDeposits)).toBe('deposit-cursor');
    expect(bybitNextCursor(parsedWithdrawals)).toBe('withdrawal-cursor');
  });

  it('aggregates execution fills by Order ID and matches the order-level CSV refs', () => {
    const normalized = apiTrades();
    expect(normalized.skipped).toBe(0);
    expect(normalized.transactions).toHaveLength(2);
    expect(normalized.transactions[0]).toMatchObject({
      source: 'bybit_api', sourceRef: 'bb-order-buy-001', type: 'buy',
      asset: 'BTC', amount: 0.1, counterAsset: 'USDT', counterAmount: 5000,
      feeAmount: 0.0001, feeAsset: 'BTC'
    });
    expect(normalized.transactions.map(transactionExchangeKey).sort())
      .toEqual(csvTrades().map(transactionExchangeKey).sort());
  });

  it('normalizes settled deposits/withdrawals and excludes pending rows', () => {
    const deposits = bybit.parseTransactions(fixture<{ result: { rows: unknown[] } }>('deposits.json').result.rows);
    const withdrawals = bybit.parseTransactions(fixture<{ result: { rows: unknown[] } }>('withdrawals.json').result.rows);
    expect(normalizeTransfer('bybit', deposits[0])).toMatchObject({
      source: 'bybit_api', type: 'transfer_in', asset: 'USDT', amount: 1250
    });
    expect(normalizeTransfer('bybit', deposits[1])).toBeNull();
    expect(normalizeTransfer('bybit', withdrawals[0])).toMatchObject({
      source: 'bybit_api', sourceRef: 'bb-withdraw-001', type: 'transfer_out',
      asset: 'ETH', amount: 0.25, feeAmount: 0.001
    });
    expect(normalizeTransfer('bybit', withdrawals[1])).toBeNull();
  });

  it('keeps distinct Bybit deposits with equal asset, amount and second via native tx identity', () => {
    const timestamp = 1_735_516_800_123;
    const first = normalizeTransfer('bybit', {
      type: 'deposit', timestamp, currency: 'USDT', amount: 10, status: 'ok',
      txid: 'native-deposit-tx', info: { txID: 'native-deposit-tx', txIndex: '1' }
    });
    const second = normalizeTransfer('bybit', {
      type: 'deposit', timestamp: timestamp + 500, currency: 'USDT', amount: 10, status: 'ok',
      txid: 'native-deposit-tx', info: { txID: 'native-deposit-tx', txIndex: '2' }
    });
    expect(first?.sourceRef).toBe('bybit:native-deposit-tx:1');
    expect(second?.sourceRef).toBe('bybit:native-deposit-tx:2');
    expect(transactionExchangeKey(first!)).not.toBe(transactionExchangeKey(second!));
  });

  it('falls through an empty txIndex to distinct raw native ids for the same txID', () => {
    const common = {
      type: 'deposit', timestamp: 1_735_516_800_123, currency: 'USDT', amount: 10,
      status: 'ok', txid: 'shared-native-tx'
    } as const;
    const first = normalizeTransfer('bybit', {
      ...common, info: { txID: 'shared-native-tx', txIndex: '', id: 'native-deposit-a' }
    });
    const second = normalizeTransfer('bybit', {
      ...common, timestamp: common.timestamp + 500,
      info: { txID: 'shared-native-tx', txIndex: '', id: 'native-deposit-b' }
    });
    expect(first?.sourceRef).toBe('bybit:shared-native-tx:native-deposit-a');
    expect(second?.sourceRef).toBe('bybit:shared-native-tx:native-deposit-b');
    expect(transactionExchangeKey(first!)).not.toBe(transactionExchangeKey(second!));
  });
});

describe('Bybit dedup full pipeline', () => {
  beforeEach(async () => {
    await db.transactions.clear();
  });

  it('CSV import followed by normalized API replay contributes zero net-new rows', async () => {
    const csv = csvTrades();
    await db.transactions.bulkPut(csv);
    await deduplicateTransactions();

    const api = apiTrades().transactions.map((row) => ({ ...row, importBatchId: 'bybit-connection' }));
    expect(await filterAlreadyImported(api)).toEqual([]);
    await db.transactions.bulkPut(api);
    expect(await deduplicateTransactions()).toBe(2);
    const survivors = await db.transactions.toArray();
    expect(survivors).toHaveLength(2);
    expect(survivors.every((row) => row.source === 'bybit')).toBe(true);
    expect(survivors.every((row) => row.dedupMatchedApiRow?.source === 'bybit_api')).toBe(true);
    expect(survivors.every((row) => row.dedupMatchedApiId?.startsWith('bybit-connection:bybit-order:'))).toBe(true);
  });
});
