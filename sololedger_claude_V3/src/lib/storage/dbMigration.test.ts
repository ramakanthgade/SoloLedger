import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { Transaction } from '@/types/transaction';

const VALID_BITCOIN_ADDRESS = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';
const VALID_SOLANA_ADDRESS = '11111111111111111111111111111111';

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

const V11_STORES = {
  ...V10_STORES,
  authoritySnapshots: 'snapshotId, generation, scopeId, sourceIdentityId, [scopeId+accountClass], [sourceIdentityId+generation]',
  authorityAssets: 'id, snapshotId, scopeId, [scopeId+accountClass], [snapshotId+assetKey]',
  sourceCoverage: 'id, generation, scopeId, sourceIdentityId, evidenceId, [scopeId+generation], [sourceIdentityId+generation]',
  openingBalances: 'id, &logicalKey, scopeId, [scopeId+accountClass+assetKey], [scopeId+accountClass+assetKey+effectiveAt]'
};

describe('Dexie v11 → v12 CSV survivor-count migration', () => {
  it('backfills stale positive and zero-survivor metadata from matching importBatchId rows', async () => {
    const name = `migration_v12_test_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();
    await legacy.table('csvImports').bulkPut([
      { id: 'partial', fileName: 'partial.csv', importedAt: 1, txCount: 7, parserId: 'binance' },
      { id: 'zero', fileName: 'zero.csv', importedAt: 1, txCount: 3, parserId: 'binance' }
    ]);
    await legacy.table('transactions').bulkPut([
      makeTx('partial-1', { importBatchId: 'partial' }),
      makeTx('partial-2', { importBatchId: 'partial' }),
      makeTx('unrelated', { importBatchId: 'not-a-csv-import' })
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(18);
    expect(await upgraded.table('walletDefiRefreshManifests').count()).toBe(0);
    expect(await upgraded.csvImports.bulkGet(['partial', 'zero'])).toEqual([
      expect.objectContaining({ id: 'partial', txCount: 2 }),
      expect.objectContaining({ id: 'zero', txCount: 0 })
    ]);
    expect(await upgraded.transactions.get('unrelated')).toBeDefined();

    upgraded.close();
    await Dexie.delete(name);
  });
});

describe('Dexie v12 → v13 safety migration', () => {
  it('migrates isSpam=true to a user-hidden event decision without fabricating provider evidence', async () => {
    const name = `migration_v13_test_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(12).stores(V11_STORES);
    await legacy.open();
    await legacy.table('transactions').bulkPut([
      makeTx('spam', { isSpam: true, chain: 'ethereum', txHash: '0xabc', contractAddress: '0xToken', type: 'transfer_in' }),
      makeTx('visible', { isSpam: false })
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();
    const spam = await upgraded.transactions.get('spam');
    expect(spam).toMatchObject({ safetyState: 'user_hidden' });
    expect(spam?.safetySubjectKey).toBe('event:ethereum:0xabc:0xtoken:0:in');
    expect(await upgraded.safetyDecisions.get(spam!.safetySubjectKey!)).toMatchObject({
      state: 'user_hidden', origin: 'migration'
    });
    expect(await upgraded.providerEvidence.count()).toBe(0);
    expect((await upgraded.transactions.get('visible'))?.safetyState).toBeUndefined();
    upgraded.close();
    await Dexie.delete(name);
  });
});

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
      { id: `bitcoin:${VALID_BITCOIN_ADDRESS}`, chain: 'bitcoin', address: VALID_BITCOIN_ADDRESS, lastSyncedAt: 100, txCount: 0 },
      { id: 'ethereum:0x9999999999999999999999999999999999999999', chain: 'ethereum', address: '0x9999999999999999999999999999999999999999', lastSyncedAt: 101, txCount: 0 }
    ]);
    await legacy.table('walletBalances').bulkPut([
      { id: `bitcoin:${VALID_BITCOIN_ADDRESS}:BTC`, chain: 'bitcoin', address: VALID_BITCOIN_ADDRESS, asset: 'BTC', amount: 1, asOf: 200, source: 'rpc' },
      { id: 'ethereum:0x9999999999999999999999999999999999999999:ETH', chain: 'ethereum', address: '0x9999999999999999999999999999999999999999', asset: 'ETH', amount: 2, asOf: 200, source: 'rpc' },
      { id: 'ethereum:0x9999999999999999999999999999999999999999:USDC', chain: 'ethereum', address: '0x9999999999999999999999999999999999999999', asset: 'USDC', contractAddress: '0xToken', amount: 3, asOf: 201, source: 'rpc' }
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(18);
    expect(await upgraded.table('walletDefiRefreshManifests').count()).toBe(0);
    expect(await upgraded.table('transactions').get('untouched')).toEqual(makeTx('untouched'));
    expect(await upgraded.table('exchangeBalances').count()).toBe(4);
    const connection = await upgraded.table('exchangeConnections').get('coherent');
    expect(connection).toMatchObject({ credentialsState: 'ready', authorityGeneration: 1, revision: 0 });
    expect((await upgraded.table('lookupAddresses').get(`bitcoin:${VALID_BITCOIN_ADDRESS}`)).sourceIncarnation)
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

    const coherentWallet = await upgraded.table('authoritySnapshots').get(`legacy:wallet:bitcoin:${VALID_BITCOIN_ADDRESS}:1`);
    expect(coherentWallet).toMatchObject({
      scopeId: `wallet:bitcoin:bitcoin:${VALID_BITCOIN_ADDRESS}`, accountClass: 'wallet', asOf: 200, status: 'complete'
    });
    expect(await upgraded.table('authorityAssets').where('snapshotId').equals(coherentWallet.snapshotId).first())
      .toMatchObject({ assetKey: 'bitcoin:native', quantity: 1 });
    const mixedWallet = await upgraded.table('authoritySnapshots').get('legacy:wallet:ethereum:0x9999999999999999999999999999999999999999:1');
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

const V13_STORES = {
  ...V11_STORES,
  providerEvidence: 'id, subjectKey, subjectKind, provider, ruleId, ruleVersion, confidence, observedAt, [subjectKey+provider]',
  safetyDecisions: 'subjectKey, state, updatedAt, [state+updatedAt]'
};

const V14_STORES = {
  ...V13_STORES,
  defiPositionSnapshots: 'snapshotId, generation, accountIdentityScope, protocolId, chainId, status, [accountIdentityScope+protocolId]',
  defiPositionRows: 'id, snapshotId, protocolId, reserveKey, role, [snapshotId+role]'
};

const V16_STORES = {
  ...V14_STORES,
  transactions: 'id, timestamp, asset, type, source, *flags, isSpam, importBatchId, category, internalTransferPairId',
  lookupAddresses: 'id, chain, address, lastSyncedAt, accountIdentityId',
  csvImports: 'id, importedAt, fileName, accountIdentityId',
  exchangeConnections: 'id, exchange, lastSyncAt, accountIdentityId',
  accountIdentities: 'id, kind, &canonicalKey, ownershipStatus, [kind+canonicalKey]',
  walletDefiRefreshManifests: 'accountIdentityScope, custodyScopeId, custodySnapshotId, capturedAt'
};

describe('Dexie v17 → v18 Bitstamp kind backfill', () => {
  it('backfills immutable mixed-ledger kinds without overwriting existing evidence', async () => {
    const name = `migration_v18_bitstamp_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(17).stores(V16_STORES);
    await legacy.open();
    await legacy.table('transactions').bulkPut([
      makeTx('trade', {
        source: 'bitstamp_api', sourceRef: '101', raw: { tradeId: '101', preserved: true }
      }),
      makeTx('deposit', { source: 'bitstamp_api', sourceRef: '102', type: 'transfer_in' }),
      makeTx('withdrawal', { source: 'bitstamp_api', sourceRef: '103', type: 'transfer_out' }),
      makeTx('unknown', { source: 'bitstamp_api', sourceRef: '104', type: 'income' }),
      makeTx('existing-kind', {
        source: 'bitstamp_api', sourceRef: '105', type: 'transfer_in',
        raw: { exchangeSyncKind: 'withdrawal' }
      }),
      makeTx('other-exchange', {
        source: 'binance_api', sourceRef: '106', type: 'transfer_in', raw: { preserved: true }
      })
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(18);
    expect((await upgraded.transactions.get('trade'))?.raw).toEqual({
      tradeId: '101', preserved: true, exchangeSyncKind: 'trade'
    });
    expect((await upgraded.transactions.get('deposit'))?.raw?.exchangeSyncKind).toBe('deposit');
    expect((await upgraded.transactions.get('withdrawal'))?.raw?.exchangeSyncKind).toBe('withdrawal');
    expect((await upgraded.transactions.get('unknown'))?.raw?.exchangeSyncKind).toBe('unknown');
    expect((await upgraded.transactions.get('existing-kind'))?.raw?.exchangeSyncKind).toBe('withdrawal');
    expect((await upgraded.transactions.get('other-exchange'))?.raw).toEqual({ preserved: true });

    upgraded.close();
    await Dexie.delete(name);
  });
});

describe('Dexie v16 → v17 exact asset safety backfill', () => {
  it('hides all rows for the exact provider-flagged contract and is idempotent on reopen', async () => {
    const name = `migration_v17_safety_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(16).stores(V16_STORES);
    await legacy.open();
    const contract = '0x1111111111111111111111111111111111111111';
    const restoredContract = '0x3333333333333333333333333333333333333333';
    const trustedContract = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const flaggedSubject = `event:ethereum:0xflagged:${contract}:1:in`;
    const restoredSubject = `event:ethereum:0xrestored:${restoredContract}:1:in`;
    const trustedSubject = `event:ethereum:0xtrusted:${trustedContract}:1:in`;
    await legacy.table('transactions').bulkPut([
      makeTx('flagged', {
        type: 'transfer_in', asset: 'SCAM', chain: 'ethereum', contractAddress: contract,
        txHash: '0xflagged', safetySubjectKey: flaggedSubject,
        safetyState: 'high_confidence_spam', isSpam: true
      }),
      makeTx('same-contract', {
        type: 'buy', asset: 'SAME-SYMBOL-IS-IRRELEVANT', chain: 'ethereum', contractAddress: contract,
        txHash: '0xother', safetyState: 'unverified', isSpam: false
      }),
      makeTx('same-symbol-other-contract', {
        type: 'buy', asset: 'SCAM', chain: 'ethereum',
        contractAddress: '0x2222222222222222222222222222222222222222', isSpam: false
      }),
      makeTx('restored-contract', {
        type: 'transfer_in', asset: 'RESTORED', chain: 'ethereum', contractAddress: restoredContract,
        txHash: '0xrestored', safetySubjectKey: restoredSubject, isSpam: true
      }),
      makeTx('trusted-contract', {
        type: 'transfer_in', asset: 'USDC', chain: 'ethereum', contractAddress: trustedContract,
        txHash: '0xtrusted', safetySubjectKey: trustedSubject, isSpam: true
      })
    ]);
    await legacy.table('providerEvidence').bulkPut([
      { id: 'legacy-event-evidence', subjectKey: flaggedSubject, subjectKind: 'event', provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.95, observedAt: 100 },
      { id: 'restored-event-evidence', subjectKey: restoredSubject, subjectKind: 'event', provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.95, observedAt: 100 },
      { id: 'trusted-event-evidence', subjectKey: trustedSubject, subjectKind: 'event', provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.95, observedAt: 100 }
    ]);
    await legacy.table('safetyDecisions').bulkPut([
      { subjectKey: flaggedSubject, state: 'high_confidence_spam', updatedAt: 100, origin: 'automatic', evidenceIds: ['legacy-event-evidence'] },
      { subjectKey: `asset:ethereum:${restoredContract}`, state: 'user_visible', updatedAt: 101, origin: 'user', evidenceIds: ['restored-event-evidence'] },
      { subjectKey: `asset:ethereum:${trustedContract}`, state: 'trusted', updatedAt: 101, origin: 'automatic', evidenceIds: ['trusted-event-evidence'] }
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    let upgraded = createDb(name);
    await upgraded.open();
    const assetKey = `asset:ethereum:${contract}`;
    expect(await upgraded.safetyDecisions.get(assetKey)).toMatchObject({
      state: 'high_confidence_spam', origin: 'automatic'
    });
    expect(await upgraded.providerEvidence.get('legacy-event-evidence:asset')).toMatchObject({
      subjectKey: assetKey, subjectKind: 'asset'
    });
    expect(await upgraded.transactions.get('same-contract')).toMatchObject({
      safetyState: 'high_confidence_spam', isSpam: true
    });
    expect(await upgraded.transactions.get('same-symbol-other-contract')).toMatchObject({ isSpam: false });
    expect((await upgraded.transactions.get('same-symbol-other-contract'))?.safetyState).toBeUndefined();
    expect(await upgraded.transactions.get('restored-contract')).toMatchObject({ isSpam: true });
    expect((await upgraded.transactions.get('restored-contract'))?.safetyState).toBeUndefined();
    expect(await upgraded.transactions.get('trusted-contract')).toMatchObject({ isSpam: true });
    expect((await upgraded.transactions.get('trusted-contract'))?.safetyState).toBeUndefined();
    expect(await upgraded.safetyDecisions.get(`asset:ethereum:${trustedContract}`)).toMatchObject({
      state: 'trusted'
    });
    const counts = [await upgraded.providerEvidence.count(), await upgraded.safetyDecisions.count()];
    upgraded.close();

    upgraded = createDb(name);
    await upgraded.open();
    expect([await upgraded.providerEvidence.count(), await upgraded.safetyDecisions.count()]).toEqual(counts);
    upgraded.close();
    await Dexie.delete(name);
  });

  it('never creates an automatic spam decision for canonical Ethereum USDC', async () => {
    const name = `migration_v17_usdc_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(16).stores(V16_STORES);
    await legacy.open();
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const eventSubject = `event:ethereum:0xusdc:${usdc}:1:in`;
    await legacy.table('transactions').put(makeTx('canonical-usdc', {
      type: 'transfer_in', asset: 'USDC', chain: 'ethereum', contractAddress: usdc,
      txHash: '0xusdc', safetySubjectKey: eventSubject, isSpam: false
    }));
    await legacy.table('providerEvidence').put({
      id: 'usdc-provider-spam', subjectKey: eventSubject, subjectKind: 'event',
      provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1', confidence: 0.99, observedAt: 100
    });
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();
    expect(await upgraded.safetyDecisions.get(`asset:ethereum:${usdc}`)).toBeUndefined();
    expect(await upgraded.transactions.get('canonical-usdc')).toMatchObject({ isSpam: false });
    expect((await upgraded.transactions.get('canonical-usdc'))?.safetyState).toBeUndefined();
    expect(await upgraded.providerEvidence.get('usdc-provider-spam:asset')).toBeDefined();
    upgraded.close();
    await Dexie.delete(name);
  });
});

describe('Dexie v15 B1 and v16 wallet DeFi manifest migrations', () => {
  it('runs v12→v13→v14→v15 sequentially while preserving evidence and grouping accounts conservatively', async () => {
    const name = `migration_v15_sequential_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(12).stores(V11_STORES);
    await legacy.open();
    const address = '0xA000000000000000000000000000000000000001';
    await legacy.table('lookupAddresses').bulkPut([
      { id: `ethereum:${address}`, chain: 'ethereum', address, lastSyncedAt: 1, txCount: 1 },
      { id: `polygon:${address.toLowerCase()}`, chain: 'polygon', address: address.toLowerCase(), lastSyncedAt: 2, txCount: 1 },
      { id: `base:${address}`, chain: 'base', address, lastSyncedAt: 3, txCount: 1 },
      { id: `solana:${VALID_SOLANA_ADDRESS}`, chain: 'solana', address: VALID_SOLANA_ADDRESS, lastSyncedAt: 4, txCount: 0 }
    ]);
    await legacy.table('exchangeConnections').bulkPut([
      { id: 'same-brand-1', exchange: 'binance', createdAt: 1, cursors: {}, status: 'idle' },
      { id: 'same-brand-2', exchange: 'binance', createdAt: 2, cursors: {}, status: 'idle' }
    ]);
    await legacy.table('csvImports').bulkPut([
      { id: 'hash-one', fileName: 'statement.csv', importedAt: 1, txCount: 0, parserId: 'binance' },
      { id: 'hash-two', fileName: 'statement.csv', importedAt: 2, txCount: 0, parserId: 'binance' }
    ]);
    const raw = { Operation: 'Provider mystery', signed: '-1.25' };
    await legacy.table('transactions').bulkPut([
      makeTx('typed-alias', {
        type: 'income', category: 'staking' as never, amount: 1.25, source: 'legacy-provider',
        sourceRef: 'raw-ref', txHash: '0xHASH', raw
      }),
      makeTx('unknown-category', { type: 'income', category: 'Unmapped legacy label' as never, raw: { exact: true } }),
      makeTx('legacy-perp-funding', {
        type: 'fee', category: 'perp_funding' as never, instrumentClass: 'derivative', amount: 2
      }),
      makeTx('legacy-internal', { type: 'transfer_out', isInternalTransfer: true, amount: 3 }),
      makeTx('legacy-hidden', {
        type: 'transfer_in', isSpam: true, chain: 'ethereum', txHash: '0xlegacy-hidden',
        contractAddress: '0xLegacyToken'
      })
    ]);
    legacy.close();

    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(18);
    expect(await upgraded.walletDefiRefreshManifests.count()).toBe(0);
    expect(await upgraded.transactions.get('typed-alias')).toMatchObject({
      category: 'staking_reward', categoryOrigin: 'legacy', amount: 1.25,
      source: 'legacy-provider', sourceRef: 'raw-ref', txHash: '0xHASH', raw
    });
    expect(await upgraded.transactions.get('unknown-category')).toMatchObject({
      category: 'other', legacyCategory: 'Unmapped legacy label', raw: { exact: true }
    });
    expect(await upgraded.transactions.get('legacy-perp-funding')).toMatchObject({
      category: 'funding_fee', categoryOrigin: 'legacy', type: 'fee', amount: 2,
      instrumentClass: 'derivative'
    });
    expect(await upgraded.transactions.get('legacy-internal')).toMatchObject({ isInternalTransfer: true });
    expect((await upgraded.transactions.get('legacy-internal'))?.linkedTransferId).toBeUndefined();
    expect(await upgraded.transactions.get('legacy-hidden')).toMatchObject({
      safetyState: 'user_hidden', safetySubjectKey: 'event:ethereum:0xlegacy-hidden:0xlegacytoken:0:in'
    });
    expect(await upgraded.safetyDecisions.get('event:ethereum:0xlegacy-hidden:0xlegacytoken:0:in'))
      .toMatchObject({ state: 'user_hidden', origin: 'migration' });
    expect(await upgraded.providerEvidence.count()).toBe(0);
    expect(await upgraded.defiPositionSnapshots.count()).toBe(0);
    const evmRows = await upgraded.lookupAddresses.filter((row) => row.chain !== 'solana').toArray();
    expect(new Set(evmRows.map((row) => row.accountIdentityId))).toEqual(new Set([
      `wallet:evm:${address.toLowerCase()}`
    ]));
    expect((await upgraded.lookupAddresses.get(`solana:${VALID_SOLANA_ADDRESS}`))?.accountIdentityId)
      .toBe(`wallet:solana:solana:${VALID_SOLANA_ADDRESS}`);
    expect((await upgraded.exchangeConnections.bulkGet(['same-brand-1', 'same-brand-2']))
      .map((row) => row?.accountIdentityId)).toEqual(['exchange:same-brand-1', 'exchange:same-brand-2']);
    expect((await upgraded.csvImports.bulkGet(['hash-one', 'hash-two'])).map((row) => row?.accountIdentityId))
      .toEqual(['csv-account:hash-one', 'csv-account:hash-two']);
    expect(upgraded.transactions.schema.indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'category', 'internalTransferPairId'
    ]));
    upgraded.close();
    await Dexie.delete(name);
  });

  it('supports a direct v14 existing-user upgrade without changing DeFi snapshot ids/scopes', async () => {
    const name = `migration_v15_direct_${Math.random().toString(36).slice(2)}`;
    const legacy = new Dexie(name);
    legacy.version(14).stores(V14_STORES);
    await legacy.open();
    const address = '0xb000000000000000000000000000000000000001';
    await legacy.table('lookupAddresses').put({
      id: `ethereum:${address}`, chain: 'ethereum', address, lastSyncedAt: 1, txCount: 0
    });
    await legacy.table('defiPositionSnapshots').put({
      snapshotId: 'unchanged-snapshot', generation: 1, accountIdentityScope: `wallet:evm:${address}`,
      protocolId: 'aave-v3-ethereum', chainId: 1, status: 'partial', capturedAt: 1, evidence: []
    });
    legacy.close();
    const { createDb } = await import('@/lib/storage/db');
    const upgraded = createDb(name);
    await upgraded.open();
    expect(await upgraded.defiPositionSnapshots.get('unchanged-snapshot')).toMatchObject({
      snapshotId: 'unchanged-snapshot', accountIdentityScope: `wallet:evm:${address}`
    });
    expect(await upgraded.accountIdentities.get(`wallet:evm:${address}`)).toMatchObject({ kind: 'wallet' });
    expect(await upgraded.walletDefiRefreshManifests.count()).toBe(0);
    upgraded.close();
    await Dexie.delete(name);
  });
});
