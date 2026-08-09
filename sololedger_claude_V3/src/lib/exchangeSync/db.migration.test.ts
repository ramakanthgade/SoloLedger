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

  it('opens at the current version with the exchangeConnections table', async () => {
    // v9 added walletBalances; v10 added exchangeBalances; v11 added coherent
    // reconciliation evidence, v12 finalized CSV survivor counts, v13 added
    // immutable safety evidence/decisions, and v14 added immutable Ethereum
    // protocol position generations, v15 added canonical accounts/FKs, and
    // v16 added atomic wallet/DeFi refresh manifests.
    expect(db.verno).toBe(17);
    await db.open();
    const tableNames = db.tables.map((t) => t.name);
    expect(tableNames).toContain('exchangeConnections');
    expect(tableNames).toContain('exchangeBalances');
    for (const table of ['authoritySnapshots', 'authorityAssets', 'sourceCoverage', 'openingBalances']) {
      expect(tableNames).toContain(table);
    }
    for (const table of ['providerEvidence', 'safetyDecisions']) {
      expect(tableNames).toContain(table);
    }
    for (const table of ['defiPositionSnapshots', 'defiPositionRows']) {
      expect(tableNames).toContain(table);
    }
    expect(tableNames).toContain('accountIdentities');
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
    expect(schema.indexes.map((i) => i.name).sort()).toEqual(['accountIdentityId', 'exchange', 'lastSyncAt']);
    expect(db.providerEvidence.schema.primKey.name).toBe('id');
    expect(db.providerEvidence.schema.indexes.map((index) => index.name).sort()).toEqual([
      '[subjectKey+provider]', 'confidence', 'observedAt', 'provider', 'ruleId', 'ruleVersion',
      'subjectKey', 'subjectKind'
    ]);
    expect(db.safetyDecisions.schema.primKey.name).toBe('subjectKey');
    expect(db.safetyDecisions.schema.indexes.map((index) => index.name).sort()).toEqual([
      '[state+updatedAt]', 'state', 'updatedAt'
    ]);
    expect(db.defiPositionSnapshots.schema.primKey.name).toBe('snapshotId');
    expect(db.defiPositionSnapshots.schema.indexes.map((index) => index.name).sort()).toEqual([
      '[accountIdentityScope+protocolId]', 'accountIdentityScope', 'chainId', 'generation',
      'protocolId', 'status'
    ]);
    expect(db.defiPositionRows.schema.primKey.name).toBe('id');
    expect(db.defiPositionRows.schema.indexes.map((index) => index.name).sort()).toEqual([
      '[snapshotId+role]', 'protocolId', 'reserveKey', 'role', 'snapshotId'
    ]);
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
  it('registers every <exchange>_api source', () => {
    expect([...EXCHANGE_API_SOURCES].sort()).toEqual([
      'binance_api',
      'bitfinex_api',
      'btcmarkets_api',
      'bybit_api',
      'coinbase_api',
      'cryptocom_api',
      'gateio_api',
      'gemini_api',
      'htx_api',
      'kraken_api',
      'kucoin_api',
      'mexc_api',
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
