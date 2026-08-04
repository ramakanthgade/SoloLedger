import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateioParser } from '@/lib/parsers/gateio';
import { loadFixtureRows } from '@/lib/parsers/__fixtures__/fixtureUtils';
import {
  db,
  deduplicateTransactions,
  filterAlreadyImported,
  transactionExchangeKey
} from '@/lib/storage/db';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { normalizeTrade, normalizeTransfer, resolveMarket } from './normalize';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTC_USDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/USDT': { id: 'ETH_USDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true }
};

interface CcxtGate {
  parseTrades(rows: unknown[], market?: unknown): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
  markets: Record<string, unknown>;
  markets_by_id: Record<string, unknown[]>;
}

function fixture<T>(file: string): T {
  return (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'gateio', file), 'utf8')) as {
    response: T;
  }).response;
}

let gate: CcxtGate;

beforeAll(async () => {
  const ccxt = (await import('ccxt')) as unknown as { gate: new (config: object) => CcxtGate };
  gate = new ccxt.gate({ options: { defaultType: 'spot', unifiedAccount: false } });
  gate.markets = MARKETS;
  gate.markets_by_id = Object.fromEntries(Object.values(MARKETS).map((market) => [market.id!, [market]]));
});

function apiRows() {
  const trades = gate.parseTrades(fixture<unknown[]>('myTrades.json'));
  const deposits = gate.parseTransactions(fixture<unknown[]>('deposits.json'));
  const withdrawals = gate.parseTransactions(fixture<unknown[]>('withdrawals.json'));
  return [
    ...trades.map((trade) => normalizeTrade('gateio', trade, resolveMarket(MARKETS, trade.symbol))),
    ...deposits.map((transfer) => normalizeTransfer('gateio', transfer)),
    ...withdrawals.map((transfer) => normalizeTransfer('gateio', transfer))
  ].filter((row): row is NonNullable<typeof row> => row != null);
}

function csvRows() {
  return gateioParser.parse(
    loadFixtureRows('../../exchangeSync/__fixtures__/gateio/history.csv')
  ).transactions;
}

describe('Gate.io real-CCXT normalization', () => {
  beforeEach(async () => {
    await db.transactions.clear();
  });

  it('normalizes fills and settled wallet rows with native Gate ids', () => {
    const rows = apiRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      source: 'gateio_api', sourceRef: 'gt-fill-1001', type: 'buy', asset: 'BTC', amount: 0.1,
      counterAsset: 'USDT', counterAmount: 5000, feeAmount: 0.0001, feeAsset: 'BTC'
    });
    expect(rows[1]).toMatchObject({ sourceRef: 'gt-fill-1002', type: 'sell', amount: 2, counterAmount: 6000 });
    expect(rows[2]).toMatchObject({ sourceRef: 'd33361395', type: 'transfer_in', asset: 'USDT', amount: 1250 });
    expect(gate.parseTransactions(fixture<unknown[]>('deposits.json'))[0].status).toBe('DEP_CREDITED');
    expect(rows[3]).toMatchObject({ sourceRef: 'w64413318', type: 'transfer_out', asset: 'ETH', amount: 0.249, feeAmount: 0.001 });
  });

  it('accepts only Gate terminal DEP_CREDITED deposits, never pending or failed markers', () => {
    const base: UnifiedTransfer = {
      id: 'gate-status', type: 'deposit', timestamp: Date.UTC(2025, 0, 1),
      currency: 'USDT', amount: 10, status: 'DEP_CREDITED', info: { status: 'DEP_CREDITED' }
    };
    expect(normalizeTransfer('gateio', base)).toMatchObject({ type: 'transfer_in', sourceRef: 'gate-status' });
    for (const status of ['PEND', 'DEP_WAIT', 'REQUEST', 'PROCES', 'FAIL']) {
      expect(normalizeTransfer('gateio', { ...base, status, info: { status } })).toBeNull();
    }
    expect(normalizeTransfer('gateio', {
      ...base, type: 'withdrawal', status: 'DEP_CREDITED', info: { status: 'DEP_CREDITED' }
    })).toBeNull();
  });

  it('uses the beta CSV ID when it equals the API native id, without asserting universal export equivalence', () => {
    expect(apiRows().map(transactionExchangeKey).sort()).toEqual(csvRows().map(transactionExchangeKey).sort());
  });

  it('dedups CSV then API, API then CSV, and an API replay', async () => {
    const csv = csvRows();
    const api = apiRows().map((row) => ({ ...row, importBatchId: 'gateio-connection' }));

    await db.transactions.bulkPut(csv);
    expect(await filterAlreadyImported(api)).toEqual([]);
    await db.transactions.clear();

    await db.transactions.bulkPut(api);
    expect(await filterAlreadyImported(csv)).toEqual([]);
    expect(await filterAlreadyImported(apiRows())).toEqual([]);

    await db.transactions.bulkPut(csv);
    expect(await deduplicateTransactions()).toBe(4);
    const survivors = await db.transactions.toArray();
    expect(survivors).toHaveLength(4);
    expect(new Set(survivors.map(transactionExchangeKey)).size).toBe(4);
    expect(survivors.every((row) => row.source === 'gateio' || row.source === 'gateio_api')).toBe(true);
  });
});
