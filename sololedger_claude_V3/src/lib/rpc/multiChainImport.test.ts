import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import type { TaxSettings } from '@/types/transaction';
import {
  toggleChain,
  setAllChains,
  allChainsChecked,
  reconcileCheckedChains,
  runSequentialChainImport
} from './multiChainImport';

// ---- Module mocks (importJob / db / lookupConfig stay fake; CHAINS is real) ----

const mocks = vi.hoisted(() => ({
  runWalletImport: vi.fn(),
  importJobGet: vi.fn(),
  getLookupAddresses: vi.fn(),
  buildLookupConfig: vi.fn()
}));

vi.mock('@/lib/importJob', () => ({
  importJob: { get: mocks.importJobGet },
  runWalletImport: mocks.runWalletImport
}));

vi.mock('@/lib/storage/db', () => ({
  getLookupAddresses: mocks.getLookupAddresses
}));

vi.mock('@/lib/saas/lookupConfig', () => ({
  buildLookupConfig: mocks.buildLookupConfig
}));

const SETTINGS = {} as TaxSettings;
const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function jobState(overrides: Record<string, unknown> = {}) {
  return {
    error: null,
    result: { imported: 3, pricesUpdated: 0, swapsDetected: 0 },
    warnings: [] as string[],
    failed: [] as { address: string; message: string }[],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks + the orchestrator's awaits settle. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLookupAddresses.mockResolvedValue([]);
  mocks.buildLookupConfig.mockImplementation((chain: unknown) => ({ chain }));
  mocks.importJobGet.mockReturnValue(jobState());
});

// ---- Checkbox helpers ----

describe('chain-picker checkbox helpers', () => {
  it('toggleChain adds and removes without mutating the input set', () => {
    const initial = new Set<ChainId>(['ethereum', 'polygon']);
    const off = toggleChain(initial, 'polygon', false);
    expect(off).toEqual(new Set(['ethereum']));
    expect(initial).toEqual(new Set(['ethereum', 'polygon'])); // untouched

    const on = toggleChain(off, 'bsc', true);
    expect(on).toEqual(new Set(['ethereum', 'bsc']));
    expect(off).toEqual(new Set(['ethereum']));
  });

  it('setAllChains checks all or clears all', () => {
    expect(setAllChains(['ethereum', 'polygon'], true)).toEqual(new Set(['ethereum', 'polygon']));
    expect(setAllChains(['ethereum', 'polygon'], false)).toEqual(new Set());
  });

  it('allChainsChecked is true only when every detected chain is checked', () => {
    expect(allChainsChecked(['ethereum', 'polygon'], new Set(['ethereum', 'polygon']))).toBe(true);
    expect(allChainsChecked(['ethereum', 'polygon'], new Set(['ethereum']))).toBe(false);
    expect(allChainsChecked([], new Set())).toBe(false);
  });

  it('reconcileCheckedChains keeps surviving choices, defaults new chains on, drops removed ones', () => {
    const prevChecked = new Set<ChainId>(['ethereum']); // polygon was UNCHECKED by the user
    const prevDetected: ChainId[] = ['ethereum', 'polygon'];
    const nextDetected: ChainId[] = ['polygon', 'bsc']; // ethereum gone, bsc new

    const next = reconcileCheckedChains(prevChecked, prevDetected, nextDetected);
    expect(next.has('polygon')).toBe(false); // user uncheck survives re-detection
    expect(next.has('bsc')).toBe(true); // newly detected defaults to checked
    expect(next.has('ethereum')).toBe(false); // no longer detected → dropped
  });

  it('reconcileCheckedChains keeps a surviving chain checked', () => {
    const next = reconcileCheckedChains(
      new Set<ChainId>(['ethereum', 'polygon']),
      ['ethereum', 'polygon'],
      ['ethereum']
    );
    expect(next).toEqual(new Set(['ethereum']));
  });
});

// ---- Sequential orchestration ----

describe('runSequentialChainImport', () => {
  it('runs chains strictly one at a time, in order', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.runWalletImport
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const done = runSequentialChainImport([ADDR_A], ['ethereum', 'polygon'], {
      settings: SETTINGS,
      lookupExtras: {}
    });

    await flush();
    expect(mocks.runWalletImport).toHaveBeenCalledTimes(1);
    expect((mocks.runWalletImport.mock.calls[0][1] as { id: string }).id).toBe('ethereum');

    // Resolving chain 1 is what allows chain 2 to start.
    first.resolve();
    await flush();
    expect(mocks.runWalletImport).toHaveBeenCalledTimes(2);
    expect((mocks.runWalletImport.mock.calls[1][1] as { id: string }).id).toBe('polygon');

    second.resolve();
    const outcomes = await done;
    expect(outcomes.map((o) => [o.chainId, o.status])).toEqual([
      ['ethereum', 'imported'],
      ['polygon', 'imported']
    ]);
  });

  it('forwards fresh addresses, chain, settings and the built lookup config', async () => {
    mocks.runWalletImport.mockResolvedValue(undefined);
    const extras = { customBaseUrl: 'https://example.test' };
    await runSequentialChainImport([ADDR_A], ['ethereum'], {
      settings: SETTINGS,
      lookupExtras: extras
    });

    const eth = CHAINS.find((c) => c.id === 'ethereum')!;
    expect(mocks.buildLookupConfig).toHaveBeenCalledWith(eth, SETTINGS, extras);
    expect(mocks.runWalletImport).toHaveBeenCalledWith(
      [ADDR_A],
      eth,
      SETTINGS,
      { chain: eth }
    );
  });

  it('aggregates imported counts, warnings and failures from the import job state', async () => {
    mocks.runWalletImport.mockResolvedValue(undefined);
    mocks.importJobGet.mockReturnValue(
      jobState({
        result: { imported: 7, pricesUpdated: 2, swapsDetected: 1 },
        warnings: ['price missing'],
        failed: [{ address: ADDR_B, message: 'rate limited' }]
      })
    );

    const [outcome] = await runSequentialChainImport([ADDR_A, ADDR_B], ['ethereum'], {
      settings: SETTINGS,
      lookupExtras: {}
    });
    expect(outcome).toMatchObject({
      chainId: 'ethereum',
      chainLabel: CHAINS.find((c) => c.id === 'ethereum')!.label,
      status: 'imported',
      imported: 7,
      skippedAddresses: 0,
      warnings: ['price missing'],
      failures: [{ address: ADDR_B, message: 'rate limited' }]
    });
  });

  it('skips a chain whose addresses are all already imported without calling runWalletImport', async () => {
    mocks.getLookupAddresses.mockResolvedValue([
      { chain: 'ethereum', address: ADDR_A },
      { chain: 'ethereum', address: ADDR_B.toUpperCase() } // case-insensitive match
    ]);

    const outcomes = await runSequentialChainImport([ADDR_A, ADDR_B], ['ethereum'], {
      settings: SETTINGS,
      lookupExtras: {}
    });

    expect(mocks.runWalletImport).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      chainId: 'ethereum',
      status: 'skipped',
      imported: 0,
      skippedAddresses: 2
    });
  });

  it('passes only the not-yet-imported addresses to runWalletImport', async () => {
    mocks.getLookupAddresses.mockResolvedValue([{ chain: 'ethereum', address: ADDR_A }]);
    mocks.runWalletImport.mockResolvedValue(undefined);

    const [outcome] = await runSequentialChainImport([ADDR_A, ADDR_B], ['ethereum'], {
      settings: SETTINGS,
      lookupExtras: {}
    });

    expect(mocks.runWalletImport).toHaveBeenCalledTimes(1);
    expect(mocks.runWalletImport.mock.calls[0][0]).toEqual([ADDR_B]);
    expect(outcome.skippedAddresses).toBe(1);
  });

  it('re-reads the lookup registry per chain so earlier imports count as known', async () => {
    // First chain import "registers" the address; the second chain's fresh
    // read sees it and skips.
    mocks.getLookupAddresses
      .mockResolvedValueOnce([]) // ethereum: nothing known
      .mockResolvedValueOnce([{ chain: 'polygon', address: ADDR_A }]); // polygon: known now
    mocks.runWalletImport.mockResolvedValue(undefined);

    const outcomes = await runSequentialChainImport([ADDR_A], ['ethereum', 'polygon'], {
      settings: SETTINGS,
      lookupExtras: {}
    });

    expect(mocks.getLookupAddresses).toHaveBeenCalledTimes(2);
    expect(mocks.runWalletImport).toHaveBeenCalledTimes(1); // ethereum only
    expect(outcomes.map((o) => o.status)).toEqual(['imported', 'skipped']);
  });

  it('marks a chain failed when the job state carries an error, without inheriting stale results', async () => {
    mocks.runWalletImport.mockResolvedValue(undefined);
    // importJob._error leaves the previous chain's result/warnings/failed in
    // place — the failed outcome must NOT inherit them.
    mocks.importJobGet.mockReturnValue(
      jobState({
        error: 'provider exploded',
        result: { imported: 9, pricesUpdated: 9, swapsDetected: 2 },
        warnings: ['stale warning from the previous chain'],
        failed: [{ address: ADDR_B, message: 'stale failure' }]
      })
    );

    const [outcome] = await runSequentialChainImport([ADDR_A], ['ethereum'], {
      settings: SETTINGS,
      lookupExtras: {}
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      imported: 0,
      warnings: [],
      failures: [],
      error: 'provider exploded'
    });
  });

  it('fails soft: a throwing chain is recorded and the remaining chains still run', async () => {
    mocks.runWalletImport
      .mockRejectedValueOnce(new Error('boom')) // ethereum throws
      .mockResolvedValueOnce(undefined); // polygon succeeds

    const outcomes = await runSequentialChainImport([ADDR_A], ['ethereum', 'polygon'], {
      settings: SETTINGS,
      lookupExtras: {}
    });

    expect(mocks.runWalletImport).toHaveBeenCalledTimes(2);
    expect(outcomes[0]).toMatchObject({ chainId: 'ethereum', status: 'failed', error: 'boom' });
    expect(outcomes[1]).toMatchObject({ chainId: 'polygon', status: 'imported' });
  });

  it('reports progress through onChainStart with 1-based position context', async () => {
    mocks.runWalletImport.mockResolvedValue(undefined);
    const starts: [ChainId, number, number][] = [];
    await runSequentialChainImport([ADDR_A], ['ethereum', 'polygon'], {
      settings: SETTINGS,
      lookupExtras: {},
      onChainStart: (chainId, index, total) => starts.push([chainId, index, total])
    });
    expect(starts).toEqual([
      ['ethereum', 0, 2],
      ['polygon', 1, 2]
    ]);
  });

  it('returns an empty outcome list when no chains are selected', async () => {
    const outcomes = await runSequentialChainImport([ADDR_A], [], {
      settings: SETTINGS,
      lookupExtras: {}
    });
    expect(outcomes).toEqual([]);
    expect(mocks.runWalletImport).not.toHaveBeenCalled();
  });
});
