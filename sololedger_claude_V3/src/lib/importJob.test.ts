import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaxSettings, Transaction } from '@/types/transaction';
import type { ChainDef, LookupConfig } from '@/lib/rpc/providers';

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
  applyDcaClassification: vi.fn(async () => 0)
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
    transactions: {
      toArray: async () => Array.from(store.values()),
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
