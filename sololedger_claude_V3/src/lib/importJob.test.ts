import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { lookupManyAddresses, type ChainDef, type LookupConfig } from '@/lib/rpc/providers';
import { deduplicateTransactions } from '@/lib/storage/db';

// --- Mock the RPC + classification transports so no real network happens ---
const importedTx: Transaction = {
  id: 'tx-1',
  timestamp: 1_700_000_000_000,
  type: 'buy',
  asset: 'ETH',
  amount: 1,
  fiatCurrency: 'INR',
  fiatValue: undefined,
  source: 'rpc:ethereum',
  sourceRef: 'sig-1',
  walletAddress: '0xabc',
  chain: 'ethereum',
  flags: [],
  isInternalTransfer: false
};

vi.mock('@/lib/rpc/providers', () => ({
  lookupManyAddresses: vi.fn(async () => ({
    transactions: [importedTx],
    warnings: [],
    failed: [],
    perAddress: [{ address: '0xabc', count: 1 }]
  }))
}));

vi.mock('@/lib/rpc/reprocessSwaps', () => ({
  reprocessRewardIncome: vi.fn(async () => 0),
  reprocessSwapDetectionInDb: vi.fn(async () => ({
    tradesCreated: 0,
    reclassified: 0,
    message: ''
  }))
}));

const applyDefiLlamaRewardSuggestions = vi.fn(async () => ({
  hintsCount: 1,
  candidates: 0,
  suggested: 0,
  fromCache: true,
  message: 'DefiLlama: 1 Solana reward mint checked — no new reward suggestions.'
}));
vi.mock('@/lib/rpc/rewardSuggestions', () => ({
  applyDefiLlamaRewardSuggestions: (...args: unknown[]) =>
    applyDefiLlamaRewardSuggestions(...(args as [])),
}));

vi.mock('@/lib/rpc/swapDetection', () => ({
  isAbsorbedTradeLeg: vi.fn(() => false)
}));

vi.mock('@/lib/rpc/dcaDetection', () => ({
  detectDcaGroups: vi.fn(() => []),
  applyDcaClassification: vi.fn(async () => ({
    applied: 0,
    fillsClassified: 0,
    estimated: 0,
    skipped: 0,
    skipReasons: []
  }))
}));

const refreshWalletBalancesForAddresses = vi.fn(
  async (_entries: Array<{
    chain: ChainDef;
    address: string;
    historyEndpointOutcomes?: unknown[];
  }>, _settings: TaxSettings) => ({
    updated: 1,
    skipped: [] as { address: string; chain: string; reason: string }[],
    failed: [] as { address: string; message: string }[]
  })
);
vi.mock('@/lib/rpc/balances', () => ({
  refreshWalletBalancesForAddresses: (
    entries: Array<{ chain: ChainDef; address: string; historyEndpointOutcomes?: unknown[] }>,
    settings: TaxSettings
  ) => refreshWalletBalancesForAddresses(entries, settings),
  refreshWalletBalances: vi.fn(async () => ({ updated: 0, skipped: [], failed: [] }))
}));

const fetchMissingPricesForAllTransactions = vi.fn(async (..._args: unknown[]) => ({
  updated: 3,
  failed: 0,
  total: 3
}));
vi.mock('@/lib/pricing/autoFetch', () => ({
  fetchMissingPricesForAllTransactions: (...args: unknown[]) =>
    fetchMissingPricesForAllTransactions(...args)
}));

// Minimal in-memory DB stub so we don't depend on the full Dexie schema.
const store = new Map<string, Transaction>();
let lookupRows: Array<{ id: string; chain: string; address: string; lastSyncedSignature?: string }> = [];
let coverageRows: Array<{ sourceIdentityId: string; generation: number; endpointOutcomes: Array<{
  endpoint: string; required: boolean; status: string;
}> }> = [];
const reserveWalletBalanceOperation = vi.fn(async (chain: string, address: string) => ({
  sourceIdentityId: `${chain}:${address}`, chain, address,
  scopeId: `wallet:${chain}:${address}`, generation: 1, expectedRevision: 1,
  sourceIncarnation: 'incarnation', startedAt: 1
}));
const appendFailedWalletBalanceCoverage = vi.fn(async (_args: unknown) => true);
vi.mock('@/lib/storage/db', () => ({
  db: {
    lookupAddresses: {
      get: async (id: string) => lookupRows.find((row) => row.id === id),
      filter: (predicate: (row: typeof lookupRows[number]) => boolean) => ({
        first: async () => lookupRows.find(predicate)
      })
    },
    sourceCoverage: {
      where: () => ({ equals: (sourceIdentityId: string) => ({
        toArray: async () => coverageRows.filter((row) => row.sourceIdentityId === sourceIdentityId)
      }) })
    },
    transactions: {
      toArray: async () => Array.from(store.values()),
      bulkGet: async (ids: string[]) => ids.map((id) => store.get(id)),
      bulkPut: async (txs: Transaction[]) => {
        for (const t of txs) store.set(t.id, t);
      },
      filter: (predicate: (row: Transaction) => boolean) => ({
        toArray: async () => Array.from(store.values()).filter(predicate)
      })
    }
  },
  getLookupAddresses: vi.fn(async () => lookupRows),
  upsertLookupAddress: vi.fn(async () => {}),
  reserveWalletBalanceOperation: (...args: unknown[]) =>
    reserveWalletBalanceOperation(...(args as [string, string])),
  appendFailedWalletBalanceCoverage: (...args: unknown[]) =>
    appendFailedWalletBalanceCoverage(args[0]),
  deduplicateTransactions: vi.fn(async () => 0),
  filterAlreadyImported: vi.fn(async (txs: Transaction[]) => txs)
}));

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => false) }));
vi.mock('@/lib/saas/lookupConfig', () => ({ SAAS_PROXY_KEY: 'proxy-key' }));

import { runWalletImport, importJob } from '@/lib/importJob';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { isSaasMode } from '@/lib/saas/config';
import { upsertLookupAddress } from '@/lib/storage/db';
import { isAbsorbedTradeLeg } from '@/lib/rpc/swapDetection';

const CHAIN: ChainDef = {
  id: 'ethereum',
  label: 'Ethereum',
  asset: 'ETH',
  provider: 'alchemy_evm',
  needsKey: true
};
const CONFIG = {} as LookupConfig;
const SOL_CHAIN: ChainDef = {
  id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', needsKey: true
};

beforeEach(() => {
  lookupRows = [];
  coverageRows = [];
});

function settings(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return {
    jurisdiction: 'IN',
    reportingCurrency: 'INR',
    defaultCostBasisMethod: 'FIFO',
    priceApiEnabled: false,
    rpcLookupEnabled: true,
    ...overrides
  };
}

describe('runWalletImport auto-pricing gate', () => {
  beforeEach(() => {
    store.clear();
    lookupRows = [];
    vi.mocked(isAbsorbedTradeLeg).mockReturnValue(false);
    fetchMissingPricesForAllTransactions.mockClear();
    applyDefiLlamaRewardSuggestions.mockClear();
    importJob.reset();
  });

  it('does NOT fetch prices when effective priceApiEnabled is false (local/BYOK)', async () => {
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: false }), CONFIG);
    expect(fetchMissingPricesForAllTransactions).not.toHaveBeenCalled();
    expect(importJob.get().result?.pricesUpdated).toBe(0);
  });

  it('fetches prices when effective priceApiEnabled is true (hosted)', async () => {
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(fetchMissingPricesForAllTransactions).toHaveBeenCalledTimes(1);
    expect(importJob.get().result?.pricesUpdated).toBe(3);
  });
});

describe('runWalletImport DefiLlama reward-suggestion gate', () => {
  beforeEach(() => {
    store.clear();
    fetchMissingPricesForAllTransactions.mockClear();
    applyDefiLlamaRewardSuggestions.mockClear();
    importJob.reset();
  });

  it('does NOT run DefiLlama suggestions when priceApiEnabled is false', async () => {
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: false }), CONFIG);
    expect(applyDefiLlamaRewardSuggestions).not.toHaveBeenCalled();
  });

  it('runs DefiLlama suggestions when priceApiEnabled is true', async () => {
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(applyDefiLlamaRewardSuggestions).toHaveBeenCalledTimes(1);
  });

  it('surfaces the suggestion message as a warning when rows were suggested', async () => {
    applyDefiLlamaRewardSuggestions.mockResolvedValueOnce({
      hintsCount: 1,
      candidates: 1,
      suggested: 1,
      fromCache: true,
      message: 'DefiLlama: 1 Solana reward mint checked — 1 suggested reward income flagged for review.'
    });
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(importJob.get().warnings.some((w) => w.includes('suggested reward income'))).toBe(true);
  });

  it('treats a DefiLlama failure as non-fatal: import completes, prices still fetched', async () => {
    applyDefiLlamaRewardSuggestions.mockRejectedValueOnce(new Error('DefiLlama request failed (HTTP 503)'));
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    const state = importJob.get();
    // Import is not stranded — it finished, not stuck 'active'/'classifying'.
    expect(state.active).toBe(false);
    expect(state.phase).toBe('idle');
    expect(state.error).toBeNull();
    // A non-fatal warning explains the skip.
    expect(state.warnings.some((w) => w.includes('DefiLlama reward suggestions skipped'))).toBe(true);
    // Pricing still ran despite the DefiLlama outage.
    expect(fetchMissingPricesForAllTransactions).toHaveBeenCalledTimes(1);
    expect(state.result?.pricesUpdated).toBe(3);
  });
});

describe('runWalletImport DCA auto-classification gate', () => {
  const fakeGroup = {
    vaultAddress: 'vault111',
    depositTx: importedTx,
    fillTxs: [],
    unclassifiedFillTxs: [],
    inputAsset: 'DBT',
    outputAsset: 'USDC',
    totalInput: 100,
    totalOutput: 50
  };

  beforeEach(() => {
    store.clear();
    importJob.reset();
    vi.mocked(isSaasMode).mockReturnValue(false);
    vi.mocked(detectDcaGroups).mockClear();
    vi.mocked(applyDcaClassification).mockClear();
    fetchMissingPricesForAllTransactions.mockClear();
  });

  afterEach(() => {
    vi.mocked(isSaasMode).mockReturnValue(false);
  });

  it('skips DCA auto-classification in local/BYOK mode (Review banner stays manual)', async () => {
    vi.mocked(detectDcaGroups).mockReturnValueOnce([fakeGroup] as never);
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(applyDcaClassification).not.toHaveBeenCalled();
  });

  it('auto-classifies detected DCA groups in hosted mode and surfaces the warning', async () => {
    vi.mocked(isSaasMode).mockReturnValue(true);
    vi.mocked(detectDcaGroups).mockReturnValueOnce([fakeGroup] as never);
    vi.mocked(applyDcaClassification).mockResolvedValueOnce({
      applied: 1,
      fillsClassified: 2,
      estimated: 0,
      skipped: 0,
      skipReasons: []
    });
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(applyDcaClassification).toHaveBeenCalledTimes(1);
    expect(importJob.get().warnings.some((w) => w.includes('Auto-classified 1 DCA order'))).toBe(true);
  });

  it('treats a DCA classification failure as non-fatal: import completes, prices still fetched', async () => {
    vi.mocked(isSaasMode).mockReturnValue(true);
    vi.mocked(detectDcaGroups).mockReturnValueOnce([fakeGroup] as never);
    vi.mocked(applyDcaClassification).mockRejectedValueOnce(new Error('boom'));
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    const state = importJob.get();
    expect(state.active).toBe(false);
    expect(state.error).toBeNull();
    expect(fetchMissingPricesForAllTransactions).toHaveBeenCalledTimes(1);
  });
});

describe('runWalletImport post-dedup imported count', () => {
  const secondImportedTx: Transaction = {
    ...importedTx,
    id: 'tx-2',
    sourceRef: 'sig-2'
  };
  const unrelatedTx: Transaction = {
    ...importedTx,
    id: 'existing-unrelated',
    sourceRef: 'existing-sig'
  };

  beforeEach(() => {
    store.clear();
    importJob.reset();
  });

  it('counts only staged rows that survive dedup while preserving the duplicate warning', async () => {
    store.set(unrelatedTx.id, unrelatedTx);
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [importedTx, secondImportedTx],
      warnings: [],
      failed: [],
      perAddress: [{ address: '0xabc', count: 2 }]
    });
    vi.mocked(deduplicateTransactions).mockImplementationOnce(async () => {
      store.delete(importedTx.id);
      store.delete(unrelatedTx.id);
      return 2;
    });

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG);

    const state = importJob.get();
    expect(state.result?.imported).toBe(1);
    expect(store.has(secondImportedTx.id)).toBe(true);
    expect(state.warnings).toContain('Removed 2 duplicate transactions (re-sync detected).');
  });

  it('reports no new transactions when sync dedup removes every staged row', async () => {
    lookupRows = [{ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' }];
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [importedTx, secondImportedTx],
      warnings: [],
      failed: [],
      perAddress: [{ address: '0xabc', count: 2 }]
    });
    vi.mocked(deduplicateTransactions).mockImplementationOnce(async () => {
      store.delete(importedTx.id);
      store.delete(secondImportedTx.id);
      return 2;
    });

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);

    const state = importJob.get();
    expect(state.result?.imported).toBe(0);
    expect(state.warnings).toContain('No new transactions found since last sync.');
    expect(state.active).toBe(false);
    expect(state.phase).toBe('idle');
    expect(state.error).toBeNull();
  });
});

describe('runWalletImport trade protection identity', () => {
  beforeEach(() => {
    store.clear();
    lookupRows = [];
    importJob.reset();
    vi.mocked(isAbsorbedTradeLeg).mockReturnValue(false);
  });

  it('does not let a trade suppress a case-distinct Solana wallet with the same signature', async () => {
    store.set('wallet-a-trade', {
      ...importedTx,
      id: 'wallet-a-trade',
      type: 'trade',
      asset: 'USDC',
      counterAsset: 'BONK',
      counterAmount: 10,
      chain: 'solana',
      walletAddress: 'Base58Case',
      source: 'rpc:helius',
      sourceRef: 'shared-signature'
    });
    const walletBTransfer: Transaction = {
      ...importedTx,
      id: 'wallet-b-transfer',
      type: 'transfer_in',
      asset: 'BONK',
      chain: 'solana',
      walletAddress: 'base58Case',
      source: 'rpc:helius',
      sourceRef: 'shared-signature'
    };
    vi.mocked(isAbsorbedTradeLeg).mockReturnValue(true);
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [walletBTransfer], warnings: [], failed: [],
      perAddress: [{ address: 'base58Case', count: 1 }]
    });

    await runWalletImport(['base58Case'], SOL_CHAIN, settings(), CONFIG);

    expect(store.get('wallet-b-transfer')).toEqual(walletBTransfer);
  });

  it('protects an existing trade by txHash when incoming event refs differ', async () => {
    store.set('existing-trade', {
      ...importedTx, id: 'existing-trade', type: 'trade', asset: 'USDC',
      counterAsset: 'ETH', counterAmount: 1, sourceRef: 'event:trade', txHash: '0xshared'
    });
    const incoming = {
      ...importedTx, id: 'incoming-leg', type: 'transfer_in' as const, asset: 'ETH',
      sourceRef: 'event:log:2', txHash: '0xshared'
    };
    vi.mocked(isAbsorbedTradeLeg).mockReturnValue(true);
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [incoming], warnings: [], failed: [], perAddress: [{ address: '0xabc', count: 1 }]
    });

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG);

    expect(store.has('incoming-leg')).toBe(false);
  });
});

describe('runWalletImport wallet-registry gating (Item 5g — never persist failed wallets)', () => {
  beforeEach(() => {
    store.clear();
    importJob.reset();
    vi.mocked(upsertLookupAddress).mockClear();
  });

  it('does NOT upsert a wallet whose first import failed — it stays retryable', async () => {
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [],
      warnings: [],
      failed: [{ address: '0xabc', message: 'Alchemy API returned 403 — check your API key' }],
      perAddress: []
    });

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG);

    expect(upsertLookupAddress).not.toHaveBeenCalled();
    // The failure still surfaces in the job state (the user sees why).
    expect(importJob.get().failed).toEqual([
      { address: '0xabc', message: 'Alchemy API returned 403 — check your API key' }
    ]);
    expect(importJob.get().active).toBe(false);
  });

  it('persists only the succeeded addresses of a mixed batch', async () => {
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [importedTx],
      warnings: [],
      failed: [{ address: '0xdef', message: 'boom' }],
      perAddress: [{ address: '0xabc', count: 1 }]
    });

    await runWalletImport(['0xabc', '0xdef'], CHAIN, settings(), CONFIG);

    const upsertedAddresses = vi.mocked(upsertLookupAddress).mock.calls.map((c) => c[1]);
    expect(upsertedAddresses.length).toBeGreaterThan(0);
    expect(new Set(upsertedAddresses)).toEqual(new Set(['0xabc']));
    expect(upsertedAddresses).not.toContain('0xdef');
  });

  it('does NOT touch the registry when the lookup itself throws', async () => {
    vi.mocked(lookupManyAddresses).mockRejectedValueOnce(new Error('relay down'));

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG);

    expect(upsertLookupAddress).not.toHaveBeenCalled();
    expect(importJob.get().error).toBe('relay down');
  });

  it('still refreshes the registry row after a successful Sync (existing-wallet path intact)', async () => {
    lookupRows = [{ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' }];
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);

    expect(upsertLookupAddress).toHaveBeenCalled();
    const upsertedAddresses = vi.mocked(upsertLookupAddress).mock.calls.map((c) => c[1]);
    expect(new Set(upsertedAddresses)).toEqual(new Set(['0xabc']));
  });

  it('does not fetch or recreate a wallet removed before a queued Sync starts', async () => {
    lookupRows = [];
    vi.mocked(lookupManyAddresses).mockClear();

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);

    expect(lookupManyAddresses).not.toHaveBeenCalled();
    expect(upsertLookupAddress).not.toHaveBeenCalled();
    expect(importJob.get().warnings).toContain('0xabc…xabc: wallet was removed — sync skipped.');
  });

  it('does not skip a case-distinct Base58 wallet that is already registered', async () => {
    lookupRows = [{ id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case' }];
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [], warnings: [], failed: [], perAddress: [{ address: 'base58Case', count: 0 }]
    });
    await runWalletImport(['base58Case'], SOL_CHAIN, settings(), CONFIG);
    expect(lookupManyAddresses).toHaveBeenCalledWith(['base58Case'], expect.anything(), expect.any(Function));
    expect(upsertLookupAddress).toHaveBeenCalledWith('solana', 'base58Case', 0);
  });

  it('keeps incremental cursors and skip signatures scoped to exact chain/address identity', async () => {
    lookupRows = [{ id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case' }];
    store.set('exact', {
      ...importedTx, id: 'exact', chain: 'solana', walletAddress: 'Base58Case',
      source: 'rpc:helius', sourceRef: 'exact-sig', timestamp: 20
    });
    store.set('case-other', {
      ...importedTx, id: 'case-other', chain: 'solana', walletAddress: 'base58Case',
      source: 'rpc:helius', sourceRef: 'other-case-sig', timestamp: 30
    });
    store.set('chain-other', {
      ...importedTx, id: 'chain-other', chain: 'ethereum', walletAddress: 'Base58Case',
      source: 'rpc:ethereum', sourceRef: 'other-chain-sig', timestamp: 40
    });
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [], warnings: [], failed: [], perAddress: [{ address: 'Base58Case', count: 0 }]
    });
    await runWalletImport(['Base58Case'], SOL_CHAIN, settings(), CONFIG, true);
    const calls = vi.mocked(lookupManyAddresses).mock.calls;
    const passedConfig = calls[calls.length - 1]?.[1];
    expect(passedConfig).toMatchObject({ afterSignature: 'exact-sig', incrementalOnly: true });
    expect([...(passedConfig?.skipSignatures ?? [])]).toEqual(['exact-sig']);
  });

  it('restarts a Solana backfill when prior initial history was partial', async () => {
    lookupRows = [{
      id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case',
      lastSyncedSignature: 'newest-imported'
    }];
    coverageRows = [{
      sourceIdentityId: 'solana:Base58Case', generation: 2,
      endpointOutcomes: [{
        endpoint: 'solana:history:helius:transactions', required: true, status: 'partial'
      }]
    }];
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [], warnings: [], failed: [], perAddress: [{ address: 'Base58Case', count: 0 }]
    });

    await runWalletImport(['Base58Case'], SOL_CHAIN, settings(), CONFIG, true);

    const lookupCalls = vi.mocked(lookupManyAddresses).mock.calls;
    const passedConfig = lookupCalls[lookupCalls.length - 1]?.[1];
    expect(passedConfig).toMatchObject({ incrementalOnly: true });
    expect(passedConfig?.afterSignature).toBeUndefined();
  });
});

describe('wallet-remove reset guard', () => {
  beforeEach(() => {
    importJob.reset();
  });

  // Mirrors the WalletLookupPanel remove handler: `if (!importJob.get().active) importJob.reset();`
  function clearBannersIfIdle() {
    if (!importJob.get().active) importJob.reset();
  }

  it('clears stale result/warnings when the job is idle (finished import)', async () => {
    // Simulate a finished import that left a success banner + price note behind.
    await runWalletImport(['0xabc'], CHAIN, settings({ priceApiEnabled: true }), CONFIG);
    expect(importJob.get().result).not.toBeNull();
    expect(importJob.get().active).toBe(false);

    clearBannersIfIdle();

    expect(importJob.get().result).toBeNull();
    expect(importJob.get().warnings).toEqual([]);
  });

  it('leaves an in-progress import untouched (never wipes live progress)', () => {
    // Simulate an active import in the classifying phase.
    importJob._setPhase('classifying', { done: 2, total: 5 });
    expect(importJob.get().active).toBe(true);

    clearBannersIfIdle();

    // Active job state must be preserved — the guard skips reset.
    expect(importJob.get().active).toBe(true);
    expect(importJob.get().phase).toBe('classifying');
    expect(importJob.get().progress).toEqual({ done: 2, total: 5 });
  });
});

describe('multi-chain batch lock', () => {
  it('keeps the shared job active across per-chain completion gaps', () => {
    importJob.reset();
    const token = importJob._beginBatch();
    importJob._setPhase('importing');

    importJob._finish(
      { imported: 2, pricesUpdated: 0, swapsDetected: 0 },
      [],
      []
    );

    expect(importJob.get()).toMatchObject({ active: true, batchActive: true });
    importJob._endBatch(token);
    expect(importJob.get()).toMatchObject({ active: false, batchActive: false });
  });

  it('releases only the matching owner and reset cannot clear live ownership', () => {
    importJob.reset();
    const first = importJob._beginBatch();
    const second = importJob._beginBatch();
    importJob.reset();
    expect(importJob.get()).toMatchObject({ active: true, batchActive: true });
    importJob._endBatch(first);
    expect(importJob.get()).toMatchObject({ active: true, batchActive: true });
    importJob._endBatch(second);
    expect(importJob.get()).toMatchObject({ active: false, batchActive: false });
  });

  it('queues a later owner until the current owner releases', async () => {
    importJob.reset();
    const first = importJob._beginBatch();
    const second = importJob._beginBatch();
    let secondReady = false;
    void importJob._waitForBatch(second).then(() => { secondReady = true; });
    await Promise.resolve();
    expect(secondReady).toBe(false);

    importJob._endBatch(first);
    await Promise.resolve();
    expect(secondReady).toBe(true);
    importJob._endBatch(second);
  });
});

describe('runWalletImport post-sync balance refresh (round 4)', () => {
  beforeEach(() => {
    store.clear();
    lookupRows = [{ id: 'ethereum:0xabc', chain: 'ethereum', address: '0xabc' }];
    importJob.reset();
    vi.mocked(lookupManyAddresses).mockReset().mockResolvedValue({
      transactions: [importedTx],
      warnings: [],
      failed: [],
      perAddress: [{ address: '0xabc', count: 1 }]
    });
    vi.mocked(deduplicateTransactions).mockReset().mockResolvedValue(0);
    refreshWalletBalancesForAddresses.mockClear();
    refreshWalletBalancesForAddresses.mockResolvedValue({ updated: 1, skipped: [], failed: [] });
    reserveWalletBalanceOperation.mockClear();
    appendFailedWalletBalanceCoverage.mockClear();
  });

  it('refreshes on-chain balances for succeeded addresses after the sync', async () => {
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);
    expect(refreshWalletBalancesForAddresses).toHaveBeenCalledTimes(1);
    const [entries, passedSettings] = refreshWalletBalancesForAddresses.mock.calls[0];
    expect(entries).toEqual([expect.objectContaining({ chain: CHAIN, address: '0xabc' })]);
    expect(passedSettings).toEqual(settings());
  });

  it('passes only each canonical address history evidence into its balance refresh', async () => {
    lookupRows.push({ id: 'ethereum:0xdef', chain: 'ethereum', address: '0xdef' });
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [importedTx], warnings: [], failed: [], streamOutcomes: [],
      perAddress: [
        { address: '0xABC', count: 1, streamOutcomes: [{
          endpoint: 'moralis:wallet-history', required: true, status: 'partial',
          paginationRequired: true, paginationExhausted: false, pages: 2,
          termination: 'partial_error', warning: 'page three failed'
        }] },
        { address: '0xdef', count: 0, streamOutcomes: [{
          endpoint: 'alchemy_getAssetTransfers:incoming', required: true, status: 'complete',
          paginationRequired: false, paginationExhausted: true, pages: 1,
          termination: 'exhausted'
        }] }
      ]
    });

    await runWalletImport(['0xabc', '0xdef'], CHAIN, settings(), CONFIG, true);

    const [entries] = refreshWalletBalancesForAddresses.mock.calls[0];
    expect(entries[0].historyEndpointOutcomes).toEqual([
      expect.objectContaining({
        endpoint: 'ethereum:history:moralis:wallet-history', status: 'partial', pages: 2
      })
    ]);
    expect(entries[1].historyEndpointOutcomes).toEqual([
      expect.objectContaining({
        endpoint: 'ethereum:history:alchemy_getAssetTransfers:incoming', status: 'complete'
      })
    ]);
    expect(importJob.get().warnings).toContain('0xabc: page three failed');
  });

  it('does NOT refresh balances for addresses whose lookup failed', async () => {
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [],
      warnings: [],
      failed: [{ address: '0xabc', message: 'boom' }],
      perAddress: []
    });
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG);
    expect(refreshWalletBalancesForAddresses).not.toHaveBeenCalled();
  });

  it('appends durable failed history coverage for a failed existing sync', async () => {
    vi.mocked(lookupManyAddresses).mockResolvedValueOnce({
      transactions: [], warnings: [],
      failed: [{ address: '0xabc', message: 'history provider unavailable' }],
      perAddress: []
    });

    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);

    expect(reserveWalletBalanceOperation).toHaveBeenCalledWith('ethereum', '0xabc');
    expect(appendFailedWalletBalanceCoverage).toHaveBeenCalledWith(expect.objectContaining({
      failureKind: 'provider', message: 'history provider unavailable',
      endpointOutcomes: [expect.objectContaining({
        endpoint: 'ethereum:history:lookup', status: 'failed', required: true
      })]
    }));
    expect(refreshWalletBalancesForAddresses).not.toHaveBeenCalled();
  });

  it('a balance-refresh failure warns but never fails the sync', async () => {
    refreshWalletBalancesForAddresses.mockResolvedValueOnce({
      updated: 0,
      skipped: [],
      failed: [{ address: '0xabc', message: 'Explorer API returned 502' }]
    });
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);
    const state = importJob.get();
    expect(state.error).toBeNull();
    expect(state.active).toBe(false);
    expect(state.result?.imported).toBe(1);
    expect(state.warnings.some((w) => w.includes('balance refresh failed'))).toBe(true);
  });

  it('a balance-refresh throw warns but never fails the sync', async () => {
    refreshWalletBalancesForAddresses.mockRejectedValueOnce(new Error('kaboom'));
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);
    const state = importJob.get();
    expect(state.error).toBeNull();
    expect(state.warnings.some((w) => w.includes('Balance refresh failed'))).toBe(true);
  });
});
