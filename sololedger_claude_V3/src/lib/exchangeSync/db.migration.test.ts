import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  db,
  clearAllData,
  EXCHANGE_API_SOURCES,
  isStableRefSource,
  transactionExchangeKey,
  type ExchangeConnectionRow
} from '@/lib/storage/db';

function makeRow(id: string): ExchangeConnectionRow {
  return {
    id,
    exchange: 'binance',
    label: 'My Binance',
    apiKey: 'key',
    secret: 'secret',
    createdAt: 1_700_000_000_000,
    cursors: { trades: 1_700_000_000_000 },
    status: 'idle'
  };
}

describe('Dexie v8 — exchangeConnections', () => {
  beforeEach(async () => {
    await db.exchangeConnections.clear();
  });

  it('opens at version 8 with the exchangeConnections table', async () => {
    expect(db.verno).toBe(8);
    await db.open();
    const tableNames = db.tables.map((t) => t.name);
    expect(tableNames).toContain('exchangeConnections');
    // All v7 tables carried over unchanged.
    for (const t of [
      'transactions',
      'lots',
      'disposals',
      'settings',
      'specIdHints',
      'lookupAddresses',
      'priceCache',
      'csvImports'
    ]) {
      expect(tableNames).toContain(t);
    }
    // Declared indexes per the v8 schema: 'id, exchange, lastSyncAt'.
    const schema = db.exchangeConnections.schema;
    expect(schema.primKey.name).toBe('id');
    expect(schema.indexes.map((i) => i.name).sort()).toEqual(['exchange', 'lastSyncAt']);
  });

  it('stores and reads back a connection row (credentials local-only)', async () => {
    await db.exchangeConnections.put(makeRow('exc_test_1'));
    const row = await db.exchangeConnections.get('exc_test_1');
    expect(row?.exchange).toBe('binance');
    expect(row?.cursors.trades).toBe(1_700_000_000_000);
  });

  it('clearAllData() clears exchangeConnections too', async () => {
    await db.exchangeConnections.put(makeRow('exc_test_2'));
    expect(await db.exchangeConnections.count()).toBe(1);
    await clearAllData();
    expect(await db.exchangeConnections.count()).toBe(0);
  });
});

describe('EXCHANGE_API_SOURCES', () => {
  it('registers all five <exchange>_api sources', () => {
    expect([...EXCHANGE_API_SOURCES].sort()).toEqual([
      'binance_api',
      'coinbase_api',
      'kraken_api',
      'kucoin_api',
      'okx_api'
    ]);
  });

  it('isStableRefSource() accepts every API source', () => {
    for (const source of EXCHANGE_API_SOURCES) {
      expect(isStableRefSource(source)).toBe(true);
    }
  });

  it('API-source rows get an exchange dedup key from their sourceRef', () => {
    expect(transactionExchangeKey({ source: 'binance_api', sourceRef: 'binance:1:buy:BTC:1.0000' })).toBe(
      'ex:binance:1:buy:BTC:1.0000'
    );
  });
});
