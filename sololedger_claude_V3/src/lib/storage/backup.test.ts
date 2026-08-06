import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitCsvImportGeneration, db, DEFAULT_SETTINGS, getSettings, setTransactionSafetyVisibility } from '@/lib/storage/db';
import { createFullBackupPayload, importFullBackup } from '@/lib/storage/backup';
import { selectAuthoritySnapshot } from '@/lib/reconcile/authoritySelection';
import type { Transaction } from '@/types/transaction';
import { buildCsvImportEvidenceGeneration } from '@/lib/parsers/importEvidence';
import { filterRows, type RowFilterOptions } from '@/lib/review/reviewTableView';
import { buildHoldingsProjection } from '@/lib/portfolio/holdingsProjection';
import { calculateCostBasis } from '@/lib/costBasis/engine';

const VALID_BITCOIN_ADDRESS = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';
const VALID_SOLANA_ADDRESS = '11111111111111111111111111111111';

function makeTx(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 1000,
    source: 'manual',
    flags: [],
    isInternalTransfer: false,
    ...overrides
  };
}

/** Builds a File whose contents are the given backup payload as JSON. */
function backupFile(payload: unknown): File {
  return new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
}

function v2Payload(transactions: Transaction[]) {
  return {
    formatVersion: 2 as const,
    exportedAt: new Date().toISOString(),
    transactions,
    lots: [],
    disposals: [],
    specIdHints: [],
    lookupAddresses: [],
    priceCache: [],
    csvImports: [],
    settings: DEFAULT_SETTINGS
  };
}

async function clearDb() {
  await db.transaction(
    'rw',
    [
      db.transactions,
      db.lots,
      db.disposals,
      db.specIdHints,
      db.lookupAddresses,
      db.priceCache,
      db.csvImports,
      db.exchangeConnections,
      db.walletBalances,
      db.exchangeBalances,
      db.authoritySnapshots,
      db.authorityAssets,
      db.sourceCoverage,
      db.openingBalances,
      db.providerEvidence,
      db.safetyDecisions,
      db.defiPositionSnapshots,
      db.defiPositionRows,
      db.accountIdentities,
      db.settings
    ],
    async () => {
      await Promise.all([
        db.transactions.clear(),
        db.lots.clear(),
        db.disposals.clear(),
        db.specIdHints.clear(),
        db.lookupAddresses.clear(),
        db.priceCache.clear(),
        db.csvImports.clear(),
        db.exchangeConnections.clear(),
        db.walletBalances.clear(),
        db.exchangeBalances.clear(),
        db.authoritySnapshots.clear(),
        db.authorityAssets.clear(),
        db.sourceCoverage.clear(),
        db.openingBalances.clear(),
        db.providerEvidence.clear(),
        db.safetyDecisions.clear(),
        db.defiPositionSnapshots.clear(),
        db.defiPositionRows.clear(),
        db.accountIdentities.clear(),
        db.settings.clear()
      ]);
    }
  );
}

describe('importFullBackup', () => {
  beforeEach(async () => {
    await clearDb();
  });

  it('round-trips exported data on import', async () => {
    const txs = [makeTx('a'), makeTx('b', { asset: 'ETH' })];
    const { imported } = await importFullBackup(backupFile(v2Payload(txs)));

    expect(imported).toBe(2);
    const stored = await db.transactions.toArray();
    expect(stored.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('round-trips v6 account, classification, and reciprocal pair metadata', async () => {
    await db.lookupAddresses.put({
      id: 'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: 'ethereum', address: '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA', lastSyncedAt: 1, txCount: 2,
      accountIdentityId: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    await db.accountIdentities.put({
      id: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'wallet', canonicalKey: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownershipStatus: 'owned', ownershipOrigin: 'user', ownershipConfirmedAt: 10,
      createdAt: 1, updatedAt: 10, lifecycleRevision: 1
    });
    const pair = {
      internalTransferPairId: 'pair-1', internalTransferDecision: 'confirmed' as const,
      internalTransferMatchMethod: 'exact_onchain_event' as const, internalTransferMatcherVersion: 'b4-contract-v1',
      internalTransferDecisionAt: 20, isInternalTransfer: true
    };
    await db.transactions.bulkPut([
      makeTx('pair-out', {
        ...pair, type: 'transfer_out', linkedTransferId: 'pair-in', category: 'other',
        categoryOrigin: 'user', categoryLocked: true, legacyCategory: 'Custom transfer label'
      }),
      makeTx('pair-in', {
        ...pair, type: 'transfer_in', linkedTransferId: 'pair-out', category: 'other',
        categoryOrigin: 'user', categoryLocked: true, legacyCategory: 'Custom transfer label'
      })
    ]);
    const payload = await createFullBackupPayload();
    expect(payload).toMatchObject({ formatVersion: 6, accountIdentities: [{ ownershipStatus: 'owned' }] });
    await clearDb();
    await importFullBackup(backupFile(payload));
    expect(await db.accountIdentities.get('wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      ownershipStatus: 'owned', ownershipConfirmedAt: 10
    });
    expect(await db.transactions.get('pair-out')).toMatchObject({
      linkedTransferId: 'pair-in', category: 'other', categoryOrigin: 'user', legacyCategory: 'Custom transfer label'
    });
  });

  it('projects account identities to an explicit safe shape and recursively rejects nested credentials', async () => {
    const accountId = 'exchange:safe-account';
    await db.accountIdentities.put({
      id: accountId, kind: 'exchange', canonicalKey: accountId, ownershipStatus: 'unknown',
      ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0,
      profile: { harmless: 'not persisted', nested: { api_key: 'must-not-export' } }
    } as never);
    const safePayload = await createFullBackupPayload();
    expect(safePayload.accountIdentities[0]).not.toHaveProperty('profile');
    await clearDb();
    await importFullBackup(backupFile(safePayload));
    expect(await db.accountIdentities.get(accountId)).toEqual({
      id: accountId, kind: 'exchange', canonicalKey: accountId, ownershipStatus: 'unknown',
      ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0
    });

    const malformed = structuredClone(safePayload) as typeof safePayload & {
      accountIdentities: Array<(typeof safePayload.accountIdentities)[number] & { metadata?: unknown }>;
    };
    malformed.accountIdentities[0].metadata = { auth: { bearer_token: 'nested-secret' } };
    await db.transactions.put(makeTx('credential-sentinel'));
    await expect(importFullBackup(backupFile(malformed))).rejects.toThrow(/credential material/i);
    expect(await db.transactions.get('credential-sentinel')).toBeDefined();
  });

  it.each([
    ['unknown harmless field', { display: { color: 'orange' } }, /unknown fields/i],
    ['API token', { metadata: { apiToken: 'secret' } }, /credential material/i],
    ['session token', { metadata: [{ sessionToken: 'secret' }] }, /credential material/i],
    ['access token', { metadata: { auth: { access_token: 'secret' } } }, /credential material/i],
    ['client secret', { metadata: { clientSecret: 'secret' } }, /credential material/i]
  ])('rejects account identity %s before clearing current data', async (_label, unknownField, error) => {
    const accountId = 'exchange:strict-shape';
    await db.accountIdentities.put({
      id: accountId, kind: 'exchange', canonicalKey: accountId, ownershipStatus: 'unknown',
      ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0
    });
    const malformed = await createFullBackupPayload() as Awaited<ReturnType<typeof createFullBackupPayload>> & {
      accountIdentities: Array<Record<string, unknown>>;
    };
    Object.assign(malformed.accountIdentities[0], unknownField);
    await db.transactions.put(makeTx(`sentinel-${_label}`));
    await expect(importFullBackup(backupFile(malformed))).rejects.toThrow(error);
    expect(await db.transactions.get(`sentinel-${_label}`)).toBeDefined();
  });

  it.each([
    ['account FK', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.lookupAddresses[0].accountIdentityId = 'missing-account';
    }],
    ['dangling pair', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions[0].linkedTransferId = 'missing-transaction';
    }],
    ['classification', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions[0].category = 'salary';
    }],
    ['reused pair id', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions.push({ ...payload.transactions[1], id: 'restore-third', linkedTransferId: 'restore-out' });
    }],
    ['same-direction pair', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions.forEach((row) => { row.type = 'transfer_out'; });
    }],
    ['heuristic confirmation', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions.forEach((row) => { row.internalTransferMatchMethod = 'heuristic'; });
    }],
    ['rejected taxable state', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions.forEach((row) => { row.internalTransferDecision = 'rejected'; });
    }],
    ['malformed canonical EVM account', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      const malformedId = `wallet:evm:0x${'A'.repeat(40)}`;
      payload.accountIdentities[0].id = malformedId;
      payload.accountIdentities[0].canonicalKey = malformedId;
      payload.lookupAddresses[0].accountIdentityId = malformedId;
    }],
    ['malformed Bitcoin account', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.accountIdentities[0].id = 'wallet:bitcoin:bitcoin:x';
      payload.accountIdentities[0].canonicalKey = 'wallet:bitcoin:bitcoin:x';
      payload.lookupAddresses[0].chain = 'bitcoin';
      payload.lookupAddresses[0].address = 'x';
      payload.lookupAddresses[0].accountIdentityId = 'wallet:bitcoin:bitcoin:x';
    }],
    ['malformed Solana account', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.accountIdentities[0].id = 'wallet:solana:solana:abc';
      payload.accountIdentities[0].canonicalKey = 'wallet:solana:solana:abc';
      payload.lookupAddresses[0].chain = 'solana';
      payload.lookupAddresses[0].address = 'abc';
      payload.lookupAddresses[0].accountIdentityId = 'wallet:solana:solana:abc';
    }],
    ['malformed Starknet account', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.accountIdentities[0].id = 'wallet:starknet:starknet:not-an-address';
      payload.accountIdentities[0].canonicalKey = 'wallet:starknet:starknet:not-an-address';
      payload.lookupAddresses[0].chain = 'starknet';
      payload.lookupAddresses[0].address = 'not-an-address';
      payload.lookupAddresses[0].accountIdentityId = 'wallet:starknet:starknet:not-an-address';
    }]
  ])('rejects malformed v6 %s before clearing current data', async (_label, mutate) => {
    await db.lookupAddresses.put({
      id: 'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: 'ethereum', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lastSyncedAt: 1, txCount: 0,
      accountIdentityId: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    await db.accountIdentities.put({
      id: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'wallet', canonicalKey: 'wallet:evm:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownershipStatus: 'unknown', ownershipOrigin: 'migration', createdAt: 1, updatedAt: 1, lifecycleRevision: 0
    });
    const pair = {
      internalTransferPairId: 'pair-1', internalTransferDecision: 'confirmed' as const,
      internalTransferMatchMethod: 'manual' as const, internalTransferMatcherVersion: 'contract-v1',
      internalTransferDecisionAt: 2, isInternalTransfer: true
    };
    await db.transactions.bulkPut([
      makeTx('restore-out', { ...pair, type: 'transfer_out', linkedTransferId: 'restore-in', category: 'other' }),
      makeTx('restore-in', { ...pair, type: 'transfer_in', linkedTransferId: 'restore-out', category: 'other' })
    ]);
    const malformed = await createFullBackupPayload();
    mutate(malformed);
    await db.transactions.put(makeTx('current-sentinel'));
    await expect(importFullBackup(backupFile(malformed))).rejects.toThrow();
    expect(await db.transactions.get('current-sentinel')).toBeDefined();
  });

  it('keeps v5 payloads importable by conservatively adapting durable accounts and legacy categories', async () => {
    const current = await createFullBackupPayload();
    const { accountIdentities: _accounts, ...v5 } = { ...current, formatVersion: 5 as const };
    v5.transactions = [makeTx('legacy-v5', { type: 'income', category: 'staking' as never })];
    await importFullBackup(backupFile(v5));
    expect(await db.transactions.get('legacy-v5')).toMatchObject({ category: 'staking_reward', categoryOrigin: 'legacy' });
  });

  it('round-trips v4 provider evidence, all five states, and user-restore audit losslessly', async () => {
    const spamSubject = 'event:ethereum:0xspam:0xdead:3:in';
    await db.transactions.put(makeTx('safety-tx', {
      chain: 'ethereum', txHash: '0xspam', contractAddress: '0xdead',
      safetySubjectKey: spamSubject, safetyState: 'high_confidence_spam', isSpam: true
    }));
    await db.providerEvidence.put({
      id: 'evidence:spam', subjectKey: spamSubject, subjectKind: 'event',
      provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1',
      confidence: 0.95, observedAt: 1_700_000_000_000,
      raw: { possible_spam: true, unknown_provider_field: { retained: 7 } }
    });
    await db.safetyDecisions.bulkPut([
      { subjectKey: 'asset:ethereum:native', state: 'trusted', updatedAt: 1, origin: 'automatic' },
      { subjectKey: 'asset:ethereum:0xbeef', state: 'unverified', updatedAt: 3, origin: 'automatic' },
      { subjectKey: 'event:ethereum:0xhidden:0xdead:1:out', state: 'user_hidden', updatedAt: 4, origin: 'user' },
      {
        subjectKey: 'event:ethereum:0xvisible:0xbeef:2:in', state: 'user_visible',
        updatedAt: 5, origin: 'user'
      },
      {
        subjectKey: spamSubject, state: 'high_confidence_spam', updatedAt: 2, origin: 'automatic',
        evidenceIds: ['evidence:spam'], reason: 'Allowlisted provider evidence met the threshold.'
      }
    ]);

    const payload = await createFullBackupPayload();
    expect(payload.formatVersion).toBe(6);
    await clearDb();
    await importFullBackup(backupFile(payload));

    expect((await db.safetyDecisions.toArray()).map((row) => row.state).sort()).toEqual([
      'high_confidence_spam', 'trusted', 'unverified', 'user_hidden', 'user_visible'
    ]);
    expect(await db.safetyDecisions.get(spamSubject)).toMatchObject({
      state: 'high_confidence_spam', origin: 'automatic', evidenceIds: ['evidence:spam']
    });
    expect(await db.providerEvidence.get('evidence:spam')).toMatchObject({
      raw: { possible_spam: true, unknown_provider_field: { retained: 7 } }
    });
    const restoredHidden = (await db.transactions.get('safety-tx'))!;
    expect(restoredHidden).toMatchObject({ safetyState: 'high_confidence_spam' });
    const reviewOptions: RowFilterOptions = {
      showSpam: false, showNeedsPrice: false, showNeedsReview: false,
      assetFilter: 'all', typeFilter: 'all', flagFilter: 'all', walletFilter: 'all',
      fyBounds: null, instrumentFilter: 'all', query: '',
      isNeedsReview: () => false, isDerivative: () => false
    };
    expect(filterRows([restoredHidden], reviewOptions)).toEqual([]);
    expect(filterRows([restoredHidden], { ...reviewOptions, showSpam: true })).toEqual([restoredHidden]);
    expect(buildHoldingsProjection({
      transactions: [restoredHidden], exchangeConnections: [], openingBalances: [],
      snapshots: [], assets: [], coverage: [], now: Date.now()
    }).holdings).toEqual([]);
    expect(calculateCostBasis([restoredHidden], { method: 'FIFO' }).lots).toEqual([]);

    await setTransactionSafetyVisibility(restoredHidden, true, 6);
    const restoredVisible = (await db.transactions.get('safety-tx'))!;
    expect(restoredVisible).toMatchObject({ safetyState: 'user_visible', isSpam: false });
    expect(await db.safetyDecisions.get(spamSubject)).toMatchObject({
      state: 'user_visible', origin: 'user', evidenceIds: ['evidence:spam'],
      previousAutomaticState: 'high_confidence_spam'
    });
    expect(await db.providerEvidence.get('evidence:spam')).toBeDefined();
    expect(filterRows([restoredVisible], reviewOptions)).toEqual([restoredVisible]);
    expect(buildHoldingsProjection({
      transactions: [restoredVisible], exchangeConnections: [], openingBalances: [],
      snapshots: [], assets: [], coverage: [], now: Date.now()
    }).holdings).toEqual([expect.objectContaining({ asset: 'BTC', quantity: 1 })]);
    expect(calculateCostBasis([restoredVisible], { method: 'FIFO' }).lots).toHaveLength(1);
  });

  it('round-trips v5 coherent DeFi generations and marks restored authority stale', async () => {
    const scope = `wallet:evm:0x${'1'.repeat(40)}`;
    await db.lookupAddresses.add({ id: `ethereum:0x${'1'.repeat(40)}`, chain: 'ethereum', address: `0x${'1'.repeat(40)}`, lastSyncedAt: 100, txCount: 0 });
    await db.defiPositionSnapshots.add({
      snapshotId: 'defi-1', generation: 1, accountIdentityScope: scope,
      protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 100,
      blockNumber: 20_000_000, evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 20_000_000, detail: 'fixture' }]
    });
    await db.defiPositionRows.add({
      id: 'defi-row-1', snapshotId: 'defi-1', protocolId: 'aave-v3-ethereum',
      reserveKey: `0x${'2'.repeat(40)}`, role: 'supply',
      underlying: { chainId: 1, contractAddress: `0x${'2'.repeat(40)}`, symbol: 'USDC', decimals: 6 },
      protocolToken: { chainId: 1, contractAddress: `0x${'3'.repeat(40)}`, symbol: 'aUSDC', decimals: 6 },
      quantity: 10, rawQuantity: '10000000', isCollateral: true
    });
    const payload = await createFullBackupPayload();
    expect(payload).toMatchObject({ formatVersion: 6, defiPositionSnapshots: [{ snapshotId: 'defi-1' }], defiPositionRows: [{ id: 'defi-row-1' }] });
    await clearDb();
    await importFullBackup(backupFile(payload));
    expect(await db.defiPositionSnapshots.get('defi-1')).toMatchObject({ status: 'complete', restoredAt: expect.any(Number) });
    expect(await db.defiPositionRows.get('defi-row-1')).toMatchObject({ role: 'supply', isCollateral: true });
  });

  it('rejects malformed v5 role identities before clearing existing data', async () => {
    const wallet = `0x${'1'.repeat(40)}`;
    const underlying = `0x${'2'.repeat(40)}`;
    const scope = `wallet:evm:${wallet}`;
    await db.lookupAddresses.add({ id: `ethereum:${wallet}`, chain: 'ethereum', address: wallet, lastSyncedAt: 100, txCount: 0 });
    await db.defiPositionSnapshots.add({
      snapshotId: 'strict-snapshot', generation: 1, accountIdentityScope: scope,
      protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 100,
      blockNumber: 20_000_000, evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 20_000_000, detail: 'fixture' }]
    });
    await db.defiPositionRows.bulkAdd([{
      id: 'strict-supply', snapshotId: 'strict-snapshot', protocolId: 'aave-v3-ethereum', reserveKey: underlying, role: 'supply',
      underlying: { chainId: 1, contractAddress: underlying, symbol: 'USDC', decimals: 6 },
      protocolToken: { chainId: 1, contractAddress: `0x${'3'.repeat(40)}`, symbol: 'aUSDC', decimals: 6 },
      quantity: 1, rawQuantity: '1000000', isCollateral: true
    }, {
      id: 'strict-debt', snapshotId: 'strict-snapshot', protocolId: 'aave-v3-ethereum', reserveKey: underlying, role: 'debt',
      underlying: { chainId: 1, contractAddress: underlying, symbol: 'USDC', decimals: 6 },
      protocolToken: { chainId: 1, contractAddress: `0x${'4'.repeat(40)}`, symbol: 'variableDebtUSDC', decimals: 6 },
      quantity: 1, rawQuantity: '1000000', debtRateMode: 'variable'
    }]);
    const valid = await createFullBackupPayload();
    await db.transactions.put(makeTx('must-survive-invalid-v5'));
    const corruptions: Array<[string, (payload: typeof valid) => void]> = [
      ['snapshot scope', (payload) => { payload.defiPositionSnapshots[0].accountIdentityScope = `wallet:evm:0x${'A'.repeat(40)}`; }],
      ['underlying address', (payload) => { payload.defiPositionRows[0].underlying.contractAddress = `0x${'A'.repeat(40)}`; }],
      ['protocol-token address', (payload) => { payload.defiPositionRows[0].protocolToken.contractAddress = `0x${'B'.repeat(40)}`; }],
      ['underlying symbol', (payload) => { payload.defiPositionRows[0].underlying.symbol = ' '; }],
      ['protocol-token symbol', (payload) => { payload.defiPositionRows[0].protocolToken.symbol = ''; }],
      ['decimals', (payload) => { payload.defiPositionRows[0].underlying.decimals = Number.MAX_SAFE_INTEGER; }],
      ['supply collateral', (payload) => { (payload.defiPositionRows.find((row) => row.role === 'supply') as { isCollateral?: boolean }).isCollateral = undefined; }],
      ['debt rate mode', (payload) => { (payload.defiPositionRows.find((row) => row.role === 'debt') as { debtRateMode?: string }).debtRateMode = 'floating'; }],
      ['debt magnitude', (payload) => { payload.defiPositionRows.find((row) => row.role === 'debt')!.quantity = 0; }]
    ];
    for (const [label, corrupt] of corruptions) {
      const payload = structuredClone(valid);
      corrupt(payload);
      let rejected = false;
      try { await importFullBackup(backupFile(payload)); } catch { rejected = true; }
      expect(rejected, label).toBe(true);
      expect(await db.transactions.get('must-survive-invalid-v5')).toBeDefined();
    }
  });

  it.each([
    ['malformed subject keys', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.providerEvidence[0].subjectKey = 'not-an-exact-subject';
    }],
    ['out-of-range confidence', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.providerEvidence[0].confidence = 1.01;
    }],
    ['missing evidence references', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.safetyDecisions[0].evidenceIds = ['missing-evidence'];
    }],
    ['cross-subject evidence references', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.safetyDecisions[0].subjectKey = 'asset:ethereum:0xbeef';
    }],
    ['nonallowlisted automatic evidence', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.providerEvidence[0].ruleVersion = 'revoked';
    }],
    ['contradictory transaction materialization', (payload: Awaited<ReturnType<typeof createFullBackupPayload>>) => {
      payload.transactions[0].safetySubjectKey = payload.safetyDecisions[0].subjectKey;
      payload.transactions[0].safetyState = 'user_visible';
      payload.transactions[0].isSpam = false;
    }]
  ])('rejects v4 %s before destructive restore', async (_label, corrupt) => {
    await db.transactions.put(makeTx('existing'));
    await db.providerEvidence.put({
      id: 'evidence:one', subjectKey: 'asset:ethereum:0xdead', subjectKind: 'asset',
      provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1',
      confidence: 0.95, observedAt: 1
    });
    await db.safetyDecisions.put({
      subjectKey: 'asset:ethereum:0xdead', state: 'high_confidence_spam', updatedAt: 1,
      origin: 'automatic', evidenceIds: ['evidence:one']
    });
    const payload = await createFullBackupPayload();
    corrupt(payload);

    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(/safety|evidence/i);
    expect(await db.transactions.get('existing')).toBeDefined();
  });

  it('REPLACES existing data rather than merging', async () => {
    // Seed two transactions.
    await db.transactions.bulkPut([makeTx('old-1'), makeTx('old-2')]);
    expect(await db.transactions.count()).toBe(2);

    // Import a backup that contains a single, different transaction.
    const { imported } = await importFullBackup(backupFile(v2Payload([makeTx('new-1')])));

    expect(imported).toBe(1);
    expect(await db.transactions.count()).toBe(1);
    const stored = await db.transactions.toArray();
    expect(stored[0].id).toBe('new-1');
  });

  it('imports a v1 backup (missing lookupAddresses/priceCache/csvImports) without throwing', async () => {
    const v1 = {
      formatVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      transactions: [makeTx('v1-tx')],
      lots: [],
      disposals: [],
      specIdHints: [],
      settings: DEFAULT_SETTINGS
    };

    const { imported } = await importFullBackup(backupFile(v1));
    expect(imported).toBe(1);
    expect(await db.lookupAddresses.count()).toBe(0);
    expect(await db.priceCache.count()).toBe(0);
    expect(await db.csvImports.count()).toBe(0);
  });

  it('throws on a malformed payload', async () => {
    await expect(importFullBackup(backupFile({ nope: true }))).rejects.toThrow();
    await expect(
      importFullBackup(backupFile({ ...v2Payload([]), transactions: 'not-an-array' }))
    ).rejects.toThrow();
  });

  it('rejects an unknown/newer format version', async () => {
    await expect(
      importFullBackup(backupFile({ ...v2Payload([]), formatVersion: 99 }))
    ).rejects.toThrow(/version/i);
  });

  it('restores settings under the singleton key even when the backup carries an id', async () => {
    // Pre-existing (pre-restore) settings that must NOT survive the restore.
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    const payload = {
      ...v2Payload([]),
      // Hand-edited/older backup whose settings object carries a stray `id`.
      settings: { id: 'not-singleton', ...DEFAULT_SETTINGS, jurisdiction: 'US', reportingCurrency: 'USD' }
    };

    await importFullBackup(backupFile(payload));

    // getSettings reads the 'singleton' row — it must reflect the imported values.
    const restored = await getSettings();
    expect(restored.jurisdiction).toBe('US');
    expect(restored.reportingCurrency).toBe('USD');

    // No stray non-singleton row should have been written.
    expect(await db.settings.count()).toBe(1);
    const only = await db.settings.toArray();
    expect(only[0].id).toBe('singleton');
  });

  it('replaces ALL tables (lookupAddresses, priceCache, csvImports, settings)', async () => {
    // Seed every table with pre-existing rows.
    await db.transactions.bulkPut([makeTx('old-tx')]);
    await db.lookupAddresses.bulkPut([
      { id: 'old:addr', chain: 'ethereum', address: '0xold', lastSyncedAt: 1, txCount: 5 }
    ]);
    await db.priceCache.bulkPut([{ key: 'old-key', price: 1, fetchedAt: 1 }]);
    await db.csvImports.bulkPut([
      { id: 'old-csv', fileName: 'old.csv', importedAt: 1, txCount: 3, parserId: null }
    ]);
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    const payload = {
      ...v2Payload([makeTx('new-tx')]),
      lookupAddresses: [
        { id: 'new:addr', chain: 'solana', address: VALID_SOLANA_ADDRESS, lastSyncedAt: 2, txCount: 1 }
      ],
      priceCache: [{ key: 'new-key', price: 42, fetchedAt: 2 }],
      csvImports: [
        { id: 'new-csv', fileName: 'new.csv', importedAt: 2, txCount: 1, parserId: 'coinbase' }
      ],
      settings: { ...DEFAULT_SETTINGS, jurisdiction: 'US', reportingCurrency: 'USD' }
    };

    await importFullBackup(backupFile(payload));

    expect((await db.transactions.toArray()).map((t) => t.id)).toEqual(['new-tx']);
    expect((await db.lookupAddresses.toArray()).map((r) => r.id)).toEqual(['new:addr']);
    expect((await db.priceCache.toArray()).map((r) => r.key)).toEqual(['new-key']);
    expect((await db.csvImports.toArray()).map((r) => r.id)).toEqual(['new-csv']);
    const restored = await getSettings();
    expect(restored.jurisdiction).toBe('US');
    expect(restored.reportingCurrency).toBe('USD');
  });

  it('repairs stale partial and zero-survivor CSV counts while restoring a backup', async () => {
    const transactions = [
      makeTx('partial-1', { importBatchId: 'partial-csv' }),
      makeTx('partial-2', { importBatchId: 'partial-csv' })
    ];
    const payload = {
      ...v2Payload(transactions),
      csvImports: [
        { id: 'partial-csv', fileName: 'partial.csv', importedAt: 1, txCount: 9, parserId: 'wazirx' },
        { id: 'zero-csv', fileName: 'zero.csv', importedAt: 1, txCount: 4, parserId: 'binance' }
      ]
    };

    await importFullBackup(backupFile(payload));

    expect(await db.csvImports.bulkGet(['partial-csv', 'zero-csv'])).toEqual([
      expect.objectContaining({ id: 'partial-csv', txCount: 2 }),
      expect.objectContaining({ id: 'zero-csv', txCount: 0 })
    ]);
  });

  it('rolls back atomically when a bulkPut fails partway through', async () => {
    // Seed pre-existing data that must survive a failed restore.
    await db.transactions.bulkPut([makeTx('keep-1'), makeTx('keep-2')]);
    await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, jurisdiction: 'IN' });

    // csvImports rows require a string primary key `id`. A row missing `id`
    // makes bulkPut throw AFTER earlier tables were cleared/written — the whole
    // transaction must roll back.
    const payload = {
      ...v2Payload([makeTx('should-not-persist')]),
      csvImports: [{ fileName: 'broken.csv', importedAt: 1, txCount: 1, parserId: null }]
    };

    await expect(importFullBackup(backupFile(payload))).rejects.toThrow();

    // Pre-existing rows and settings must be intact (nothing half-applied).
    expect(await db.transactions.count()).toBe(2);
    expect((await db.transactions.toArray()).map((t) => t.id).sort()).toEqual(['keep-1', 'keep-2']);
    const settings = await getSettings();
    expect(settings.jurisdiction).toBe('IN');
    expect(await db.csvImports.count()).toBe(0);
  });

  it('exports v4 source/evidence tables while recursively removing every credential class', async () => {
    await db.settings.put({
      id: 'singleton', ...DEFAULT_SETTINGS, alchemyApiKey: 'provider-secret',
      customExplorerApiKey: 'custom-secret', licenseKey: 'license-secret',
      customProvider: { authToken: 'nested-auth', bearerToken: 'nested-bearer' }
    } as never);
    await db.exchangeConnections.put({
      id: 'source-1', exchange: 'binance', label: 'Safe label', apiKey: 'key', secret: 'secret',
      passphrase: 'phrase', createdAt: 1, cursors: {}, status: 'ok',
      providerMetadata: { sessionToken: 'nested-session' }
    } as never);
    await db.csvImports.put({
      id: 'csv-1', fileName: 'safe.csv', importedAt: 1, txCount: 0, parserId: 'binance',
      providerMetadata: { apiToken: 'nested-api-token' }
    } as never);
    await db.lookupAddresses.put({
      id: `bitcoin:${VALID_BITCOIN_ADDRESS}`, chain: 'bitcoin', address: VALID_BITCOIN_ADDRESS, lastSyncedAt: 1, txCount: 0,
      providerMetadata: { bearerToken: 'lookup-bearer' }
    } as never);

    const payload = await createFullBackupPayload();
    const serialized = JSON.stringify(payload);
    expect(payload.formatVersion).toBe(6);
    expect(payload.exchangeConnections[0]).toMatchObject({ id: 'source-1', exchange: 'binance', label: 'Safe label' });
    expect(payload.csvImports[0].id).toBe('csv-1');
    expect(payload.lookupAddresses[0].id).toBe(`bitcoin:${VALID_BITCOIN_ADDRESS}`);
    for (const forbidden of [
      'apiKey', 'secret', 'passphrase', 'provider-secret', 'custom-secret', 'license-secret',
      'authToken', 'bearerToken', 'sessionToken', 'apiToken', 'nested-auth', 'nested-bearer',
      'nested-session', 'nested-api-token', 'lookup-bearer', 'providerMetadata', 'customProvider'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('restores redacted exchange identity and marks unchanged authority evidence explicitly stale', async () => {
    await db.exchangeConnections.put({
      id: 'source-1', exchange: 'binance', apiKey: 'key', secret: 'secret', createdAt: 1,
      cursors: { trades: 10 }, lastSyncAt: 20, status: 'ok'
    });
    await db.authoritySnapshots.put({
      snapshotId: 'snapshot-1', generation: 1, scopeId: 'exchange:source-1', authorityKind: 'api',
      authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: Date.now(), capturedAt: 123, sourceIdentityId: 'source-1', endpointProof: {
        authorityKind: 'api', provider: 'binance', operation: 'fetchBalance', parametersClass: 'spot',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }, status: 'complete'
    });
    await db.authorityAssets.put({
      id: 'asset-1', snapshotId: 'snapshot-1', generation: 1, scopeId: 'exchange:source-1',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    });
    const payload = await createFullBackupPayload();
    await clearDb();
    await importFullBackup(backupFile(payload));

    const connection = await db.exchangeConnections.get('source-1');
    expect(connection).toMatchObject({ id: 'source-1', credentialsState: 'reauthorization_required', status: 'idle' });
    expect(connection).not.toHaveProperty('apiKey');
    expect(connection).not.toHaveProperty('secret');
    const snapshot = (await db.authoritySnapshots.get('snapshot-1'))!;
    expect(snapshot).toMatchObject({ asOf: payload.authoritySnapshots[0].asOf, capturedAt: 123 });
    expect(snapshot.restoredAt).toEqual(expect.any(Number));
    expect(selectAuthoritySnapshot({
      scopeId: snapshot.scopeId, accountClass: 'spot', snapshots: [snapshot],
      assets: await db.authorityAssets.toArray(), now: snapshot.asOf!, comparisonAt: snapshot.asOf
    }).authorityStatus).toBe('stale');
  });

  it('round-trips wallet-app identity and accepts legacy lookup rows without it', async () => {
    await db.lookupAddresses.bulkPut([
      {
        id: 'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        chain: 'ethereum',
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        label: 'Long-term savings',
        walletAppId: 'metamask',
        lastSyncedAt: 1,
        txCount: 0
      },
      {
        id: `bitcoin:${VALID_BITCOIN_ADDRESS}`,
        chain: 'bitcoin',
        address: VALID_BITCOIN_ADDRESS,
        label: 'Legacy wallet',
        lastSyncedAt: 2,
        txCount: 0
      }
    ]);

    const payload = await createFullBackupPayload();
    expect(payload.lookupAddresses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', walletAppId: 'metamask' }),
      expect.not.objectContaining({ id: `bitcoin:${VALID_BITCOIN_ADDRESS}`, walletAppId: expect.anything() })
    ]));

    await clearDb();
    await importFullBackup(backupFile(payload));

    expect(await db.lookupAddresses.get('ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      label: 'Long-term savings',
      walletAppId: 'metamask'
    });
    expect((await db.lookupAddresses.get(`bitcoin:${VALID_BITCOIN_ADDRESS}`))?.walletAppId).toBeUndefined();
  });

  it('round-trips validated exchange replay checkpoints without credentials', async () => {
    await db.exchangeConnections.bulkPut([{
      id: 'cryptocom-source', exchange: 'cryptocom', apiKey: 'key', secret: 'secret', createdAt: 1,
      cursors: {}, status: 'ok', cryptocomPendingTransfers: { deposits: 100, withdrawals: 200 }
    }, {
      id: 'htx-source', exchange: 'htx', apiKey: 'key', secret: 'secret', createdAt: 1,
      cursors: {}, status: 'ok', htxTradeProgress: {
        windowStart: 300, windowEnd: 400, completedSymbols: ['BTC/USDT']
      }
    }, {
      id: 'bitfinex-source', exchange: 'bitfinex', apiKey: 'key', secret: 'secret', createdAt: 1,
      cursors: {}, status: 'ok', bitfinexPendingTransfers: { deposits: 500, withdrawals: 600 }
    }]);
    const payload = await createFullBackupPayload();
    await importFullBackup(backupFile(payload));

    expect(await db.exchangeConnections.get('cryptocom-source')).toMatchObject({
      credentialsState: 'reauthorization_required',
      cryptocomPendingTransfers: { deposits: 100, withdrawals: 200 }
    });
    expect(await db.exchangeConnections.get('htx-source')).toMatchObject({
      credentialsState: 'reauthorization_required',
      htxTradeProgress: { windowStart: 300, windowEnd: 400, completedSymbols: ['BTC/USDT'] }
    });
    expect(await db.exchangeConnections.get('bitfinex-source')).toMatchObject({
      credentialsState: 'reauthorization_required',
      bitfinexPendingTransfers: { deposits: 500, withdrawals: 600 }
    });
  });

  it.each([NaN, -1, 1.5])('rejects malformed Crypto.com pending checkpoint %s', async (timestamp) => {
    await db.exchangeConnections.put({
      id: 'cryptocom-source', exchange: 'cryptocom', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    payload.exchangeConnections[0].cryptocomPendingTransfers = { deposits: timestamp };
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Crypto.com pending-transfer checkpoint is malformed'
    );
  });

  it('rejects an array Crypto.com pending checkpoint', async () => {
    await db.exchangeConnections.put({
      id: 'cryptocom-source', exchange: 'cryptocom', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    (payload.exchangeConnections[0] as unknown as { cryptocomPendingTransfers: unknown })
      .cryptocomPendingTransfers = [];
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Crypto.com pending-transfer checkpoint is malformed'
    );
  });

  it('rejects an unexpected Crypto.com pending checkpoint shape', async () => {
    await db.exchangeConnections.put({
      id: 'cryptocom-source', exchange: 'cryptocom', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    (payload.exchangeConnections[0] as unknown as { cryptocomPendingTransfers: unknown })
      .cryptocomPendingTransfers = { deposits: 1, unexpected: 2 };
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Crypto.com pending-transfer checkpoint is malformed'
    );
  });

  it.each([NaN, -1, 1.5])('rejects malformed Bitfinex pending checkpoint %s', async (timestamp) => {
    await db.exchangeConnections.put({
      id: 'bitfinex-source', exchange: 'bitfinex', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    payload.exchangeConnections[0].bitfinexPendingTransfers = { deposits: timestamp };
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Bitfinex pending-movement checkpoint is malformed'
    );
  });

  it('rejects an array Bitfinex pending checkpoint', async () => {
    await db.exchangeConnections.put({
      id: 'bitfinex-source', exchange: 'bitfinex', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    (payload.exchangeConnections[0] as unknown as { bitfinexPendingTransfers: unknown })
      .bitfinexPendingTransfers = [];
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Bitfinex pending-movement checkpoint is malformed'
    );
  });

  it('rejects an unexpected Bitfinex pending checkpoint shape', async () => {
    await db.exchangeConnections.put({
      id: 'bitfinex-source', exchange: 'bitfinex', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    (payload.exchangeConnections[0] as unknown as { bitfinexPendingTransfers: unknown })
      .bitfinexPendingTransfers = { withdrawals: 1, unexpected: 2 };
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'Bitfinex pending-movement checkpoint is malformed'
    );
  });

  it('rejects restored HTX progress with equal window bounds', async () => {
    await db.exchangeConnections.put({
      id: 'htx-source', exchange: 'htx', createdAt: 1, cursors: {}, status: 'idle'
    });
    const payload = await createFullBackupPayload();
    payload.exchangeConnections[0].htxTradeProgress = {
      windowStart: 100, windowEnd: 100, completedSymbols: []
    };
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(
      'HTX trade progress is malformed'
    );
  });

  it('does not reactivate exported v10 wallet or exchange balance anchors on restore', async () => {
    await db.transactions.put(makeTx('history-kept'));
    await db.lookupAddresses.put({
      id: `solana:${VALID_SOLANA_ADDRESS}`, chain: 'solana', address: VALID_SOLANA_ADDRESS, lastSyncedAt: 1, txCount: 0,
      sourceIncarnation: 'incarnation-before'
    });
    await db.walletBalances.put({
      id: `solana:${VALID_SOLANA_ADDRESS}:solana:native`, chain: 'solana', address: VALID_SOLANA_ADDRESS,
      asset: 'SOL', amount: 3, asOf: 10, source: 'rpc'
    });
    await db.exchangeConnections.put({
      id: 'exchange-1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    await db.exchangeBalances.put({
      id: 'exchange-1:BTC', connectionId: 'exchange-1', exchange: 'binance',
      asset: 'BTC', amount: 4, asOf: 10, source: 'exchange_api'
    });
    const payload = await createFullBackupPayload();
    expect(payload.walletBalances).toHaveLength(1);
    expect(payload.exchangeBalances).toHaveLength(1);

    await importFullBackup(backupFile(payload));
    expect(await db.transactions.get('history-kept')).toBeDefined();
    expect(await db.walletBalances.count()).toBe(0);
    expect(await db.exchangeBalances.count()).toBe(0);
    expect((await db.lookupAddresses.get('solana:Base58Case'))?.sourceIncarnation)
      .not.toBe('incarnation-before');
  });

  it.each([
    ['timestamped', 1_700_000_000_000],
    ['untimestamped', undefined]
  ] as const)('round-trips v3 %s CSV final-balance evidence with aligned class scope', async (_label, asOf) => {
    const tx = makeTx('csv-evidence', {
      source: 'binance', sourceRef: 'csv-row', importBatchId: 'csv-backup'
    });
    await commitCsvImportGeneration({
      id: 'csv-backup', fileName: 'history.csv', parserId: 'binance', transactions: [tx],
      completedAt: 1_700_000_000_100,
      metadata: { balanceSnapshot: { BTC: 4 }, optionsBalanceIncluded: true, optionsCoverageThrough: 99 },
      buildGeneration: ({ generation, savedAfterDedup, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-backup', parserId: 'binance', parsedBeforeDedup: 1,
          savedAfterDedup, generation, completedAt,
          evidence: {
            declaredHistory: { start: 1, end: 2 },
            finalBalanceSnapshots: [{ accountClass: 'spot', asOf, balances: { BTC: 4 } }],
            coveredAccountClasses: ['spot'],
            requiredOutcomes: [{
              id: 'history', accountClass: 'spot', required: true, status: 'complete',
              recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0
            }],
            recognizedCount: 1, parsedCount: 1, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });
    const payload = await createFullBackupPayload();
    expect(payload.authoritySnapshots[0]).toMatchObject({
      scopeId: 'file:csv-backup:spot', asOf
    });
    expect(payload.sourceCoverage[0]).toMatchObject({
      scopeId: 'file:csv-backup:spot', authoritySnapshotId: payload.authoritySnapshots[0].snapshotId,
      authorityAsOf: asOf
    });
    expect(payload.csvImports[0]).toMatchObject({
      balanceSnapshot: { BTC: 4 }, optionsBalanceIncluded: true, optionsCoverageThrough: 99
    });

    await clearDb();
    await importFullBackup(backupFile(payload));
    const restored = (await db.authoritySnapshots.toArray())[0];
    expect(restored).toMatchObject({ scopeId: 'file:csv-backup:spot', asOf });
    expect(await db.authorityAssets.toArray()).toEqual([
      expect.objectContaining({ snapshotId: restored.snapshotId, scopeId: restored.scopeId, quantity: 4 })
    ]);
    expect((await db.sourceCoverage.toArray())[0]).toMatchObject({
      scopeId: restored.scopeId, authoritySnapshotId: restored.snapshotId, authorityAsOf: asOf
    });
  });

  it('round-trips multiple class-scoped CSV coverage rows with unique evidence identities', async () => {
    const funding = makeTx('csv-funding', { source: 'binance', sourceRef: 'funding', importBatchId: 'csv-multi' });
    const margin = makeTx('csv-margin', { source: 'binance', sourceRef: 'margin', importBatchId: 'csv-multi' });
    await commitCsvImportGeneration({
      id: 'csv-multi', fileName: 'multi.csv', parserId: 'binance', transactions: [funding, margin],
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: 'csv-multi', parserId: 'binance', parsedBeforeDedup: 2,
          savedAfterDedup, savedTransactions, generation, completedAt,
          evidence: {
            declaredHistory: { completeHistory: true }, coveredAccountClasses: ['funding', 'margin'],
            requiredOutcomes: [
              { id: 'funding', accountClass: 'funding', required: true, status: 'complete',
                recognizedCount: 3, parsedCount: 3, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: funding.id, sourceRowCount: 3 }] },
              { id: 'margin', accountClass: 'margin', required: true, status: 'complete',
                recognizedCount: 3, parsedCount: 3, excludedCount: 0, skippedCount: 0, failedCount: 0,
                parsedTransactionRows: [{ transactionId: margin.id, sourceRowCount: 3 }] }
            ],
            recognizedCount: 6, parsedCount: 6, excludedCount: 0, skippedCount: 0, failedCount: 0,
            exclusionReasons: [], skippedReasons: [], failureReasons: []
          }
        })
    });

    const payload = await createFullBackupPayload();
    expect(payload.sourceCoverage.map((row) => row.scopeId).sort()).toEqual([
      'file:csv-multi:funding', 'file:csv-multi:margin'
    ]);
    expect(new Set(payload.sourceCoverage.map((row) => row.evidenceId)).size).toBe(2);
    const malformed = structuredClone(payload);
    malformed.sourceCoverage[0].accountClasses = ['funding', 'margin'];
    await expect(importFullBackup(backupFile(malformed))).rejects.toThrow(/exactly one account class/i);
    const duplicateEvidence = structuredClone(payload);
    duplicateEvidence.sourceCoverage[1].evidenceId = duplicateEvidence.sourceCoverage[0].evidenceId;
    await expect(importFullBackup(backupFile(duplicateEvidence))).rejects.toThrow(/duplicate coverage evidence identity/i);
    const duplicateLogical = structuredClone(payload);
    duplicateLogical.sourceCoverage[1].scopeId = duplicateLogical.sourceCoverage[0].scopeId;
    duplicateLogical.sourceCoverage[1].accountClasses = [...duplicateLogical.sourceCoverage[0].accountClasses];
    duplicateLogical.sourceCoverage[1].endpointOutcomes = duplicateLogical.sourceCoverage[1].endpointOutcomes
      .map((outcome) => ({ ...outcome, accountClass: 'funding' }));
    await expect(importFullBackup(backupFile(duplicateLogical))).rejects.toThrow(/duplicate coverage logical key/i);
    expect(await db.csvImports.get('csv-multi')).toBeDefined();
    await clearDb();
    await importFullBackup(backupFile(payload));
    expect((await db.sourceCoverage.toArray()).map((row) => row.scopeId).sort()).toEqual([
      'file:csv-multi:funding', 'file:csv-multi:margin'
    ]);
  });

  it('rejects duplicate and inconsistent v3 evidence before destructive restore', async () => {
    await db.transactions.put(makeTx('keep'));
    const payload = await createFullBackupPayload();
    payload.transactions.push(makeTx('keep'));
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(/duplicate transactions/i);
    expect(await db.transactions.get('keep')).toBeDefined();

    payload.transactions.pop();
    payload.authorityAssets.push({
      id: 'orphan', snapshotId: 'missing', generation: 1, scopeId: 'exchange:x',
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity: 1
    });
    await expect(importFullBackup(backupFile(payload))).rejects.toThrow(/inconsistent/i);
    expect(await db.transactions.get('keep')).toBeDefined();
  });

  it('exhaustively rejects malformed v3 dependent references before clearing existing data', async () => {
    await db.transactions.put(makeTx('keep'));
    await db.lots.put({
      id: 'lot-1', asset: 'BTC', acquiredAt: 1, amountRemaining: 1, amountOriginal: 1,
      costBasisPerUnit: 1, costBasisTotal: 1, sourceTxId: 'keep', acquisitionType: 'buy'
    });
    await db.disposals.put({
      id: 'disposal-1', asset: 'BTC', disposedAt: 2, amount: 1, proceeds: 2,
      costBasis: 1, gain: 1, holdingPeriodDays: 0,
      lotConsumption: [{ lotId: 'lot-1', amount: 1, costBasis: 1 }], sourceTxId: 'keep', method: 'FIFO'
    });
    await db.specIdHints.put({ txId: 'keep', preferredLotIds: ['lot-1'] });
    await db.lookupAddresses.put({
      id: `bitcoin:${VALID_BITCOIN_ADDRESS}`, chain: 'bitcoin', address: VALID_BITCOIN_ADDRESS, lastSyncedAt: 1, txCount: 0
    });
    await db.walletBalances.put({
      id: `bitcoin:${VALID_BITCOIN_ADDRESS}:BTC`, chain: 'bitcoin', address: VALID_BITCOIN_ADDRESS, asset: 'BTC',
      amount: 1, asOf: 1, source: 'rpc'
    });
    await db.exchangeConnections.put({
      id: 'source-1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok'
    });
    const snapshot = (snapshotId: string, generation: number, supersedesSnapshotId?: string) => ({
      snapshotId, generation, scopeId: 'exchange:source-1', authorityKind: 'api' as const,
      authorityClass: 'exchange_balance' as const, accountClass: 'spot' as const,
      coveredAccountClasses: ['spot' as const], capturedAt: generation, sourceIdentityId: 'source-1',
      endpointProof: {
        authorityKind: 'api' as const, provider: 'binance', operation: 'fetchBalance', parametersClass: 'spot',
        requestedAccountClasses: ['spot' as const], provenAccountClasses: ['spot' as const]
      }, status: 'failed' as const, supersedesSnapshotId
    });
    await db.authoritySnapshots.bulkPut([snapshot('snapshot-1', 1), snapshot('snapshot-2', 2, 'snapshot-1')]);
    await db.sourceCoverage.put({
      id: 'coverage-2', generation: 2, scopeId: 'exchange:source-1', sourceIdentityId: 'source-1',
      evidenceId: 'sync-2', kind: 'api', accountClasses: ['spot'], endpoints: ['trades'],
      authoritySnapshotId: 'snapshot-2', startedAt: 1, status: 'failed', endpointOutcomes: []
    });
    const valid = await createFullBackupPayload();
    const cases: Array<[string, (payload: typeof valid) => void]> = [
      ['wallet balance', (payload) => { payload.walletBalances[0].address = 'missing'; }],
      ['lot consumption', (payload) => { payload.disposals[0].lotConsumption[0].lotId = 'missing'; }],
      ['specIdHint', (payload) => { payload.specIdHints[0].preferredLotIds = ['missing']; }],
      ['coverage source/scope', (payload) => {
        payload.sourceCoverage[0].authoritySnapshotId = undefined;
        payload.sourceCoverage[0].scopeId = 'exchange:other';
      }],
      ['superseded authority snapshot', (payload) => {
        payload.authoritySnapshots[1].supersedesSnapshotId = 'missing';
      }],
      ['dependent shape', (payload) => {
        (payload.disposals[0] as unknown as { lotConsumption: unknown }).lotConsumption = 'broken';
      }]
    ];
    for (const [expected, mutate] of cases) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      await expect(importFullBackup(backupFile(malformed)), expected).rejects.toThrow();
      expect(await db.transactions.get('keep'), expected).toBeDefined();
      expect(await db.lots.get('lot-1'), expected).toBeDefined();
    }
  });

  it('rejects missing transaction source identities and invalid coverage/opening domains before clear', async () => {
    await db.transactions.put(makeTx('keep'));
    await db.exchangeConnections.put({
      id: 'exchange-1', exchange: 'binance', apiKey: 'key', secret: 'secret',
      createdAt: 1, cursors: {}, status: 'ok', authorityGeneration: 1
    });
    await db.csvImports.put({
      id: 'csv-1', fileName: 'history.csv', importedAt: 1, txCount: 1,
      parserId: 'binance', authorityGeneration: 1
    });
    await db.transactions.bulkPut([
      makeTx('api-direct', {
        source: 'binance_api', sourceRef: 'api-ref', importBatchId: 'exchange-1'
      }),
      makeTx('csv-direct', {
        source: 'binance_spot', importBatchId: 'csv-1',
        dedupMatchedApiId: 'exchange-1:buy:BTC:api-ref',
        dedupMatchedApiRow: makeTx('embedded-api', {
          source: 'binance_api', sourceRef: 'api-ref', importBatchId: 'exchange-1'
        })
      })
    ]);
    await db.sourceCoverage.put({
      id: 'coverage-1', generation: 1, scopeId: 'exchange:exchange-1', sourceIdentityId: 'exchange-1',
      evidenceId: 'sync-1', kind: 'api', accountClasses: ['spot'], endpoints: ['trades'],
      requestedHistoryStart: 1, requestedHistoryEnd: 2, startedAt: 1, completedAt: 2,
      status: 'failed', endpointOutcomes: [{
        endpoint: 'trades', accountClass: 'spot', required: true, status: 'failed',
        requestedStart: 1, requestedEnd: 2
      }]
    });
    await db.openingBalances.put({
      id: 'opening-1', logicalKey: ['manual', 'manual', 'asset:BTC', '1'].join('\u001f'),
      scopeId: 'manual', accountClass: 'manual', assetKey: 'asset:BTC', asset: 'BTC',
      absoluteQuantity: 1, effectiveAt: 1, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
    });
    await db.openingBalances.put({
      id: 'csv-opening', logicalKey: ['file:csv-1:spot', 'spot', 'asset:ETH', '2'].join('\u001f'),
      scopeId: 'file:csv-1:spot', accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH',
      absoluteQuantity: 1, effectiveAt: 2, provenance: 'source_snapshot', createdAt: 2, updatedAt: 2
    });
    const valid = await createFullBackupPayload();
    const cases: Array<[string, (payload: typeof valid) => void]> = [
      ['missing API connection', (payload) => { payload.transactions.find((row) => row.id === 'api-direct')!.importBatchId = 'missing'; }],
      ['missing CSV import', (payload) => { payload.transactions.find((row) => row.id === 'csv-direct')!.importBatchId = 'missing'; }],
      ['direct API exchange mismatch', (payload) => {
        payload.transactions.find((row) => row.id === 'api-direct')!.source = 'kraken_api';
      }],
      ['embedded twin exchange mismatch', (payload) => {
        payload.transactions.find((row) => row.id === 'csv-direct')!.dedupMatchedApiRow!.source = 'kraken_api';
      }],
      ['embedded twin identity mismatch', (payload) => {
        payload.transactions.find((row) => row.id === 'csv-direct')!.dedupMatchedApiId = 'exchange-1:wrong';
      }],
      ['negative opening', (payload) => { payload.openingBalances[0].absoluteQuantity = -1; }],
      ['deleted opening source id', (payload) => {
        const opening = payload.openingBalances.find((row) => row.id === 'opening-1')!;
        opening.scopeId = 'exchange:deleted-id';
        opening.accountClass = 'spot';
        opening.logicalKey = ['exchange:deleted-id', 'spot', opening.assetKey, String(opening.effectiveAt)].join('\u001f');
      }],
      ['file spot/options mismatch', (payload) => {
        const opening = payload.openingBalances.find((row) => row.id === 'csv-opening')!;
        opening.accountClass = 'options';
        opening.logicalKey = [opening.scopeId, 'options', opening.assetKey, String(opening.effectiveAt)].join('\u001f');
      }],
      ['invalid coverage kind', (payload) => { (payload.sourceCoverage[0] as { kind: string }).kind = 'oauth'; }],
      ['unknown runtime coverage status', (payload) => { (payload.sourceCoverage[0] as { status: string }).status = 'mystery'; }],
      ['invalid coverage bounds', (payload) => { payload.sourceCoverage[0].requestedHistoryEnd = undefined; }],
      ['invalid endpoint status', (payload) => {
        (payload.sourceCoverage[0].endpointOutcomes[0] as { status: string }).status = 'mystery';
      }],
      ['complete coverage with failed required endpoint', (payload) => {
        payload.sourceCoverage[0].status = 'complete';
      }],
      ['invalid coverage count', (payload) => { payload.sourceCoverage[0].parsedCount = -1; }]
    ];
    for (const [label, mutate] of cases) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      await expect(importFullBackup(backupFile(malformed)), label).rejects.toThrow();
      expect(await db.transactions.get('keep'), label).toBeDefined();
      expect(await db.openingBalances.get('opening-1'), label).toBeDefined();
    }
  });
});
