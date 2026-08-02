import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { Transaction } from '@/types/transaction';

/**
 * Dexie v6 → v7 migration smoke test.
 *
 * B3 adds a single new schema version (7) that introduces the optional TDS
 * fields on transactions. This is a field-only migration, so opening an
 * existing v6 database at v7 must leave every stored row intact and let the
 * new fields be written afterwards.
 */

const V6_STORES = {
  transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId',
  lots: 'id, asset, acquiredAt, sourceTxId',
  disposals: 'id, asset, disposedAt, sourceTxId',
  settings: 'id',
  specIdHints: 'txId',
  lookupAddresses: 'id, chain, address, lastSyncedAt',
  priceCache: 'key, fetchedAt',
  csvImports: 'id, importedAt, fileName'
};

function makeTx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: 'sell',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 50_000,
    source: 'wazirx_trades',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('Dexie v6 → v7 migration', () => {
  it('preserves existing rows and accepts the new TDS fields', async () => {
    const name = `migration_test_${Math.random().toString(36).slice(2)}`;

    // 1. Create the DB at v6 and seed a row (no TDS fields).
    const v6 = new Dexie(name);
    v6.version(6).stores(V6_STORES);
    await v6.open();
    await v6.table('transactions').put(makeTx('legacy-1'));
    v6.close();

    // 2. Reopen the same DB with v6 + v7 (the new field-only version).
    const v7 = new Dexie(name);
    v7.version(6).stores(V6_STORES);
    v7.version(7).stores(V6_STORES);
    await v7.open();

    // Existing row survives the upgrade untouched.
    const legacy = (await v7.table('transactions').get('legacy-1')) as Transaction | undefined;
    expect(legacy).toBeDefined();
    expect(legacy!.asset).toBe('BTC');
    expect(legacy!.tdsInr).toBeUndefined();

    // New rows can carry structured TDS fields.
    await v7.table('transactions').put(makeTx('new-1', { tdsAmount: 500, tdsAsset: 'INR', tdsInr: 500 }));
    const fresh = (await v7.table('transactions').get('new-1')) as Transaction | undefined;
    expect(fresh!.tdsInr).toBe(500);

    // Total row count is preserved plus the new one.
    expect(await v7.table('transactions').count()).toBe(2);

    v7.close();
  });
});

const V8_STORES = {
  ...V6_STORES,
  exchangeConnections: 'id, exchange, lastSyncAt'
};

describe('Dexie v8 → v9 migration (walletBalances truth anchor)', () => {
  it('adds the walletBalances table and preserves every existing row', async () => {
    const name = `migration_v9_test_${Math.random().toString(36).slice(2)}`;

    const v8 = new Dexie(name);
    v8.version(6).stores(V6_STORES);
    v8.version(7).stores(V6_STORES);
    v8.version(8).stores(V8_STORES);
    await v8.open();
    await v8.table('transactions').put(makeTx('legacy-1'));
    await v8.table('lookupAddresses').put({
      id: 'bitcoin:1abc', chain: 'bitcoin', address: '1abc', lastSyncedAt: 1, txCount: 3
    });
    v8.close();

    const v9 = new Dexie(name);
    v9.version(6).stores(V6_STORES);
    v9.version(7).stores(V6_STORES);
    v9.version(8).stores(V8_STORES);
    v9.version(9).stores({ ...V8_STORES, walletBalances: 'id, chain, address, asset' });
    await v9.open();

    expect(await v9.table('transactions').count()).toBe(1);
    expect(await v9.table('lookupAddresses').count()).toBe(1);

    // The new table accepts rows (incl. a confirmed-zero balance).
    await v9.table('walletBalances').put({
      id: 'bitcoin:1abc:BTC', chain: 'bitcoin', address: '1abc',
      asset: 'BTC', amount: 0, asOf: 123, source: 'rpc'
    });
    const row = await v9.table('walletBalances').get('bitcoin:1abc:BTC');
    expect(row.amount).toBe(0);

    v9.close();
  });
});

describe('walletBalances storage helpers', () => {
  it('walletBalanceId keys tokens by contract, natives by symbol', async () => {
    const { walletBalanceId } = await import('@/lib/storage/db');
    expect(walletBalanceId('bitcoin', '1abc', 'BTC')).toBe('bitcoin:1abc:bitcoin:native');
    expect(walletBalanceId('ethereum', '0xA', 'wbtc', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'))
      .toBe('ethereum:0xa:evm:1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599');
  });

  it('replaceWalletBalances upserts fresh rows and zeroes vanished assets', async () => {
    const { db, replaceWalletBalances, getWalletBalancesForAddress } = await import('@/lib/storage/db');
    await db.walletBalances.clear();
    await replaceWalletBalances('bitcoin', '1abc', [{ asset: 'BTC', amount: 1.5 }], 100);
    await replaceWalletBalances('bitcoin', '1abc', [{ asset: 'BTC', amount: 0 }], 200);
    let rows = await getWalletBalancesForAddress('1abc');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 0, asOf: 200, source: 'rpc' });

    // A second asset appears, then vanishes from the next fetch → explicit 0.
    await replaceWalletBalances('ethereum', '0xwallet', [
      { asset: 'ETH', amount: 1 },
      { asset: 'WBTC', amount: 0.25, contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' }
    ], 300);
    await replaceWalletBalances('ethereum', '0xwallet', [{ asset: 'ETH', amount: 0.5 }], 400);
    rows = await getWalletBalancesForAddress('0xwallet');
    const byAsset = new Map(rows.map((r) => [r.asset, r]));
    expect(byAsset.get('ETH')).toMatchObject({ amount: 0.5, asOf: 400 });
    expect(byAsset.get('WBTC')).toMatchObject({ amount: 0, asOf: 400 });
  });
});

const V10_STORES = {
  ...V8_STORES,
  walletBalances: 'id, chain, address, asset',
  exchangeBalances: 'id, connectionId, exchange, asset'
};

describe('Dexie v10 → v11 reconciliation evidence migration', () => {
  it('preserves legacy consumers and migrates only exact coherent asOf sets', async () => {
    const name = `migration_v11_test_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    await legacy.table('transactions').put(makeTx('untouched'));
    await legacy.table('exchangeConnections').bulkPut([
      {
        id: 'coherent', exchange: 'binance', apiKey: 'k', secret: 's', createdAt: 1,
        cursors: {}, status: 'idle'
      },
      {
        id: 'mixed', exchange: 'binance', apiKey: 'k', secret: 's', createdAt: 1,
        cursors: {}, status: 'idle'
      }
    ]);
    await legacy.table('exchangeBalances').bulkPut([
      { id: 'coherent:BTC', connectionId: 'coherent', exchange: 'binance', asset: 'BTC', amount: 1, asOf: 100, source: 'exchange_api' },
      { id: 'coherent:ETH', connectionId: 'coherent', exchange: 'binance', asset: 'ETH', amount: 2, asOf: 100, source: 'exchange_api' },
      { id: 'mixed:BTC', connectionId: 'mixed', exchange: 'binance', asset: 'BTC', amount: 3, asOf: 100, source: 'exchange_api' },
      { id: 'mixed:ETH', connectionId: 'mixed', exchange: 'binance', asset: 'ETH', amount: 4, asOf: 101, source: 'exchange_api' }
    ]);
    await legacy.table('lookupAddresses').bulkPut([
      { id: 'bitcoin:bc1qcoherent', chain: 'bitcoin', address: 'bc1qcoherent', lastSyncedAt: 100, txCount: 0 },
      { id: 'ethereum:0xMixed', chain: 'ethereum', address: '0xMixed', lastSyncedAt: 101, txCount: 0 }
    ]);
    await legacy.table('walletBalances').bulkPut([
      { id: 'bitcoin:bc1qcoherent:BTC', chain: 'bitcoin', address: 'bc1qcoherent', asset: 'BTC', amount: 1, asOf: 200, source: 'rpc' },
      { id: 'ethereum:0xMixed:ETH', chain: 'ethereum', address: '0xMixed', asset: 'ETH', amount: 2, asOf: 200, source: 'rpc' },
      { id: 'ethereum:0xMixed:USDC', chain: 'ethereum', address: '0xMixed', asset: 'USDC', contractAddress: '0xToken', amount: 3, asOf: 201, source: 'rpc' }
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(11);
    expect(await upgraded.table('transactions').get('untouched')).toEqual(makeTx('untouched'));
    expect(await upgraded.table('exchangeBalances').count()).toBe(4);
    const connection = await upgraded.table('exchangeConnections').get('coherent');
    expect(connection).toMatchObject({ credentialsState: 'ready', authorityGeneration: 1, revision: 0 });
    expect((await upgraded.table('lookupAddresses').get('bitcoin:bc1qcoherent')).sourceIncarnation)
      .toEqual(expect.any(String));

    const coherent = await upgraded.table('authoritySnapshots').get('legacy:exchange:coherent:1');
    expect(coherent).toMatchObject({ asOf: 100, status: 'complete', generation: 1 });
    expect(await upgraded.table('authorityAssets').where('snapshotId').equals(coherent.snapshotId).count()).toBe(2);

    const mixed = await upgraded.table('authoritySnapshots').get('legacy:exchange:mixed:1');
    expect(mixed).toMatchObject({ status: 'complete' });
    expect(mixed.asOf).toBeUndefined();
    expect(await upgraded.table('authorityAssets').where('snapshotId').equals(mixed.snapshotId).count()).toBe(0);
    const { selectAuthoritySnapshot } = await import('@/lib/reconcile/authoritySelection');
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:mixed', accountClass: 'spot',
      snapshots: [mixed], assets: [], now: 200
    }).authorityStatus).toBe('non_comparable');

    const coherentWallet = await upgraded.table('authoritySnapshots').get('legacy:wallet:bitcoin:bc1qcoherent:1');
    expect(coherentWallet).toMatchObject({
      scopeId: 'wallet:bitcoin:bitcoin:bc1qcoherent', accountClass: 'wallet', asOf: 200, status: 'complete'
    });
    expect(await upgraded.table('authorityAssets').where('snapshotId').equals(coherentWallet.snapshotId).first())
      .toMatchObject({ assetKey: 'bitcoin:native', quantity: 1 });
    const mixedWallet = await upgraded.table('authoritySnapshots').get('legacy:wallet:ethereum:0xMixed:1');
    expect(mixedWallet).toMatchObject({ status: 'complete' });
    expect(mixedWallet.asOf).toBeUndefined();
    expect(await upgraded.table('authorityAssets').where('snapshotId').equals(mixedWallet.snapshotId).count()).toBe(0);

    upgraded.close();
    await Dexie.delete(name);
  });

  it('declares the exact v11 primary keys and compound indexes', async () => {
    const { createDb } = await import('@/lib/storage/db');
    const name = `schema_v11_test_${Math.random().toString(36).slice(2)}`;
    const current = createDb(name);
    await current.open();
    expect(current.authoritySnapshots.schema.primKey.name).toBe('snapshotId');
    expect(current.authoritySnapshots.schema.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'generation', 'scopeId', 'sourceIdentityId', '[scopeId+accountClass]', '[sourceIdentityId+generation]'
    ]));
    expect(current.authorityAssets.schema.indexes.map((index) => index.name)).toContain('[snapshotId+assetKey]');
    expect(current.sourceCoverage.schema.indexes.map((index) => index.name)).toContain('[scopeId+generation]');
    expect(current.openingBalances.schema.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'logicalKey', '[scopeId+accountClass+assetKey]', '[scopeId+accountClass+assetKey+effectiveAt]'
    ]));
    expect(current.openingBalances.schema.indexes.find((index) => index.name === 'logicalKey')?.unique).toBe(true);
    current.close();
    await Dexie.delete(name);
  });
});
