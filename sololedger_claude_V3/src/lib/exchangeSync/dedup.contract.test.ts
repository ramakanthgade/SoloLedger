/**
 * Dedup contract (plan §B-6 + fixed decision 2): API-synced rows must carry
 * sourceRefs that COLLIDE with the CSV parsers' refs, so the existing dedup
 * machinery removes API↔CSV twins with zero new machinery.
 *
 * This test drives the REAL binanceSpot/binanceTransfers CSV parsers over the
 * CSV-twin fixtures and the REAL ccxt binance parser over the API fixtures,
 * then asserts key equality pairwise and end-to-end dedup through
 * fake-indexeddb (bulkPut → deduplicateTransactions → filterAlreadyImported).
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/lib/saas/config', () => ({
  isSaasMode: vi.fn(() => true)
}));
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt'),
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: false,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: false,
    exchangeSyncEnabled: true
  }))
}));

import { apiFetch } from '@/lib/saas/api';
import type { Transaction } from '@/types/transaction';
import { binanceSpotParser } from '@/lib/parsers/binanceSpot';
import { binanceTransfersParser } from '@/lib/parsers/binanceTransfers';
import { loadFixtureRows } from '@/lib/parsers/__fixtures__/fixtureUtils';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import {
  db,
  deduplicateTransactions,
  filterAlreadyImported,
  getSettings,
  isStableRefSource,
  transactionExchangeKey
} from '@/lib/storage/db';
import { convertOrNormalizeForImport } from '@/lib/pricing/fiatConvert';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { addConnection } from './connections';
import {
  commitInitialSync,
  exchangeSyncJob,
  runInitialSync,
  syncNow
} from './syncJob';
import { normalizeTrade, normalizeTransfer, resolveMarket } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import {
  REPLAY_NOW,
  binanceReplayDeps,
  installBinanceFixtureServer
} from './__fixtures__/binanceReplay';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadApiFixture<T>(file: string): T {
  const parsed = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'binance', file), 'utf8')) as {
    response: T;
  };
  return parsed.response;
}

interface CcxtBinance {
  parseTrades(trades: unknown, market?: unknown): UnifiedTrade[];
  parseTransactions(
    transactions: unknown,
    currency?: unknown,
    since?: unknown,
    limit?: unknown,
    params?: unknown
  ): UnifiedTransfer[];
}

const MARKETS: Record<string, UnifiedMarket> = {
  'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  'ETH/USDT': { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true },
  'ETH/BTC': { id: 'ETHBTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};

let binance: CcxtBinance;

beforeAll(async () => {
  const ccxt = (await import('ccxt')) as unknown as { binance: new (config: object) => CcxtBinance };
  binance = new ccxt.binance({});
});

/** API rows normalized from the recorded myTrades fixture (all 4 fills). */
function apiTradeRows(): Transaction[] {
  const fixture = loadApiFixture<Record<string, unknown[]>>('myTrades.json');
  const rows: Transaction[] = [];
  for (const market of Object.values(MARKETS)) {
    const parsed = binance.parseTrades(fixture[market.id!], market);
    for (const trade of parsed) {
      const row = normalizeTrade('binance', trade, resolveMarket(MARKETS, trade.symbol));
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** API rows normalized from the recorded capital deposit/withdrawal fixtures. */
function apiTransferRows(): Transaction[] {
  const rows: Transaction[] = [];
  const deposits = binance.parseTransactions(
    loadApiFixture<unknown[]>('deposits.json'),
    undefined,
    undefined,
    undefined,
    { type: 'deposit' }
  );
  const withdrawals = binance.parseTransactions(
    loadApiFixture<unknown[]>('withdrawals.json'),
    undefined,
    undefined,
    undefined,
    { type: 'withdrawal' }
  );
  for (const transfer of [...deposits, ...withdrawals]) {
    const row = normalizeTransfer('binance', transfer);
    if (row) rows.push(row);
  }
  return rows;
}

/** CSV-twin rows parsed by the REAL CSV parsers. */
function csvTradeRows(): Transaction[] {
  const rows = loadFixtureRows('../../exchangeSync/__fixtures__/binance/tradeHistory.csv');
  return binanceSpotParser.parse(rows).transactions;
}

function csvTransferRows(): Transaction[] {
  const rows = loadFixtureRows('../../exchangeSync/__fixtures__/binance/depositWithdraw.csv');
  return binanceTransfersParser.parse(rows).transactions;
}

describe('dedup contract — API sources are stable-ref sources', () => {
  it.each(['binance_api', 'coinbase_api', 'kraken_api', 'okx_api', 'kucoin_api'])(
    'isStableRefSource(%s) === true',
    (source) => {
      expect(isStableRefSource(source)).toBe(true);
    }
  );
});

describe('dedup contract — API refs collide with CSV-parser refs', () => {
  it('trade rows: the 4 fixture fills key-match the 4 tradeHistory.csv rows', () => {
    const apiKeys = apiTradeRows().map((t) => transactionExchangeKey(t));
    const csvKeys = csvTradeRows().map((t) => transactionExchangeKey(t));
    expect(apiKeys.every(Boolean)).toBe(true);
    expect(csvKeys.every(Boolean)).toBe(true);
    expect(new Set(apiKeys).size).toBe(4);
    expect([...apiKeys].sort()).toEqual([...csvKeys].sort());
  });

  it('transfer rows: the settled deposit + withdrawal key-match depositWithdraw.csv', () => {
    const apiKeys = apiTransferRows().map((t) => transactionExchangeKey(t));
    const csvKeys = csvTransferRows().map((t) => transactionExchangeKey(t));
    expect(apiKeys).toHaveLength(2); // pending/failed fixture entries excluded
    expect(csvKeys).toHaveLength(2);
    expect([...apiKeys].sort()).toEqual([...csvKeys].sort());
  });

  it('API rows are stamped with the binance_api source', () => {
    for (const row of [...apiTradeRows(), ...apiTransferRows()]) {
      expect(row.source).toBe('binance_api');
    }
  });
});

describe('dedup contract — end to end through fake-indexeddb', () => {
  beforeEach(async () => {
    await db.transactions.clear();
  });

  it('deduplicateTransactions() removes exactly the API/CSV twins', async () => {
    const csv = [...csvTradeRows(), ...csvTransferRows()];
    const api = [...apiTradeRows(), ...apiTransferRows()];
    await db.transactions.bulkPut([...csv, ...api]);
    expect(await db.transactions.count()).toBe(12);

    const removed = await deduplicateTransactions();
    expect(removed).toBe(6);

    const remaining = await db.transactions.toArray();
    expect(remaining).toHaveLength(6);
    const keys = remaining.map((t) => transactionExchangeKey(t));
    expect(new Set(keys).size).toBe(6);
  });

  it('the crypto-quoted ETH/BTC twin resolves to the CSV row (survivor score 5 vs 2)', async () => {
    const csv = csvTradeRows();
    const api = apiTradeRows();
    await db.transactions.bulkPut([...api, ...csv]); // API first on purpose
    await deduplicateTransactions();
    const remaining = await db.transactions.toArray();
    // The ETH/BTC key is the one whose ref carries the ETH base asset buy.
    const ethBtc = remaining.filter((t) => transactionExchangeKey(t)?.includes(':buy:ETH:0.500000'));
    expect(ethBtc).toHaveLength(1);
    expect(ethBtc[0].source).toBe('binance_spot');
  });

  it('CSV import first, then API sync → filterAlreadyImported drops every API row', async () => {
    await db.transactions.bulkPut([...csvTradeRows(), ...csvTransferRows()]);
    const netNew = await filterAlreadyImported([...apiTradeRows(), ...apiTransferRows()]);
    expect(netNew).toEqual([]);
  });

  it('API sync first, then CSV import → filterAlreadyImported drops every CSV row', async () => {
    await db.transactions.bulkPut([...apiTradeRows(), ...apiTransferRows()]);
    const netNew = await filterAlreadyImported([...csvTradeRows(), ...csvTransferRows()]);
    expect(netNew).toEqual([]);
  });

  it('re-running the API sync imports zero new rows (API↔API idempotence)', async () => {
    await db.transactions.bulkPut([...apiTradeRows(), ...apiTransferRows()]);
    // Fresh normalize run (new makeId ids, same refs) — as a re-sync would produce.
    const replay = [...apiTradeRows(), ...apiTransferRows()];
    for (const a of replay) {
      expect(
        (await db.transactions.toArray()).some(
          (b) => transactionExchangeKey(b) === transactionExchangeKey(a)
        )
      ).toBe(true);
    }
    const netNew = await filterAlreadyImported(replay);
    expect(netNew).toEqual([]);
  });
});

/**
 * Full pipeline (plan §B-5): REAL CSV parsers → the REAL ImportTab persist
 * pipeline → a REAL replay sync (ccxt binance + tunnel + engine) → the sync
 * must contribute ZERO net-new rows and the CSV twins must survive.
 */
describe('dedup contract — full pipeline: CSV import → replay sync → zero net-new', () => {
  const apiFetchMock = vi.mocked(apiFetch);

  /** Mirrors ImportTab.persistTransactions exactly (minus csvImports bookkeeping). */
  async function persistCsvBatch(txs: Transaction[], hash: string): Promise<void> {
    const settings = await getSettings();
    const { priceApiEnabled } = await getEffectiveSettings();
    const stamped = txs.map((t) => ({
      ...t,
      importBatchId: hash,
      fiatValue: normalizeFiatMagnitude(t.fiatValue),
      feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
    }));
    const { transactions: converted } = await convertOrNormalizeForImport(
      stamped,
      settings,
      priceApiEnabled
    );
    await db.transactions.bulkPut(converted);
    await deduplicateTransactions();
  }

  async function seedBinanceConnection(): Promise<string> {
    const view = await addConnection({
      exchange: 'binance',
      label: 'Dedup Replay Binance',
      apiKey: 'replay-key',
      secret: 'replay-secret'
    });
    return view.id;
  }

  beforeEach(async () => {
    await db.transactions.clear();
    await db.exchangeConnections.clear();
    exchangeSyncJob.reset();
    apiFetchMock.mockReset();
    installBinanceFixtureServer(apiFetchMock);
  });

  it('first sync stages everything as duplicates; commit saves 0 and keeps the CSV twins', async () => {
    const csvRows = [...csvTradeRows(), ...csvTransferRows()];
    expect(csvRows).toHaveLength(6);
    await persistCsvBatch(csvRows, 'csv-batch-full-pipeline');
    expect(await db.transactions.count()).toBe(6);

    const id = await seedBinanceConnection();
    const preview = await runInitialSync(id, binanceReplayDeps());
    expect(preview.transactions).toHaveLength(6); // fetched rows are shown…
    expect(preview.duplicatesSkipped).toBe(6); // …but ALL are already imported

    const { saved } = await commitInitialSync(id, binanceReplayDeps());
    expect(saved).toBe(0);

    // The CSV twins survive — the API sync contributed nothing.
    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(6);
    expect(rows.every((t) => t.importBatchId === 'csv-batch-full-pipeline')).toBe(true);
    expect(
      rows.every((t) => t.source === 'binance_spot' || t.source === 'binance_transfers')
    ).toBe(true);

    // Cursors/lastSyncAt still advance post-save: the sync SUCCEEDED, there
    // was simply nothing new — the next sync must not re-fetch from zero.
    const row = (await db.exchangeConnections.get(id))!;
    expect(row.status).toBe('ok');
    expect(row.lastSyncAt).toBe(REPLAY_NOW);
    expect(row.cursors.trades).toBe(1700259200111);
  });

  it('syncNow after a CSV import reports 0 imported and leaves the table untouched', async () => {
    await persistCsvBatch(
      [...csvTradeRows(), ...csvTransferRows()],
      'csv-batch-full-pipeline'
    );
    const id = await seedBinanceConnection();

    await syncNow(id, binanceReplayDeps());
    const state = exchangeSyncJob.get();
    expect(state.error).toBeNull();
    expect(state.result?.imported).toBe(0);

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(6);
    expect(rows.every((t) => t.importBatchId === 'csv-batch-full-pipeline')).toBe(true);
  });
});
