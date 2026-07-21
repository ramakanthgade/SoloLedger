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
vi.mock('@/lib/storage/db', () => ({
  db: {
    lookupAddresses: {
      get: async () => undefined
    },
    transactions: {
      toArray: async () => Array.from(store.values()),
      bulkGet: async (ids: string[]) => ids.map((id) => store.get(id)),
      bulkPut: async (txs: Transaction[]) => {
        for (const t of txs) store.set(t.id, t);
      },
      filter: () => ({ toArray: async () => [] })
    }
  },
  getLookupAddresses: vi.fn(async () => []),
  upsertLookupAddress: vi.fn(async () => {}),
  deduplicateTransactions: vi.fn(async () => 0),
  filterAlreadyImported: vi.fn(async (txs: Transaction[]) => txs)
}));

vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => false) }));
vi.mock('@/lib/saas/lookupConfig', () => ({ SAAS_PROXY_KEY: 'proxy-key' }));

import { runWalletImport, importJob } from '@/lib/importJob';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { isSaasMode } from '@/lib/saas/config';
import { upsertLookupAddress } from '@/lib/storage/db';

const CHAIN: ChainDef = {
  id: 'ethereum',
  label: 'Ethereum',
  asset: 'ETH',
  provider: 'alchemy_evm',
  needsKey: true
};
const CONFIG = {} as LookupConfig;

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
    await runWalletImport(['0xabc'], CHAIN, settings(), CONFIG, true);

    expect(upsertLookupAddress).toHaveBeenCalled();
    const upsertedAddresses = vi.mocked(upsertLookupAddress).mock.calls.map((c) => c[1]);
    expect(new Set(upsertedAddresses)).toEqual(new Set(['0xabc']));
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
