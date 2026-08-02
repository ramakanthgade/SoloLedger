import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Round-4 item 3 — paid-only auto-sync on app open.
 *
 * The orchestrator is exercised through injected deps; the default-dep
 * modules (exchange engine, import job, storage, providers) are mocked so
 * the suite never touches Dexie/ccxt/network.
 */

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  syncNow: vi.fn(),
  exchangeJobGet: vi.fn(() => ({ error: null as string | null, result: null as { imported: number } | null })),
  runWalletImport: vi.fn(),
  importJobGet: vi.fn(() => ({ error: null as string | null, result: null as { imported: number } | null })),
  getLookupAddresses: vi.fn(async () => []),
  getEffectiveSettings: vi.fn(async () => ({})),
  buildLookupConfig: vi.fn(() => ({})),
  getMode: vi.fn(() => 'local')
}));

vi.mock('@/lib/exchangeSync', () => ({
  listConnections: mocks.listConnections,
  syncNow: mocks.syncNow
}));
vi.mock('@/lib/exchangeSync/syncJob', () => ({
  exchangeSyncJob: { get: mocks.exchangeJobGet }
}));
vi.mock('@/lib/importJob', () => ({
  importJob: { get: mocks.importJobGet },
  runWalletImport: mocks.runWalletImport,
  useImportJob: vi.fn()
}));
vi.mock('@/lib/storage/db', () => ({
  getLookupAddresses: mocks.getLookupAddresses
}));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: mocks.getEffectiveSettings
}));
vi.mock('@/lib/saas/lookupConfig', () => ({
  buildLookupConfig: mocks.buildLookupConfig
}));
vi.mock('@/lib/saas/mode', () => ({
  getMode: mocks.getMode
}));
vi.mock('@/lib/rpc/providers', () => ({
  CHAINS: [{ id: 'solana', label: 'Solana' }]
}));

import {
  maybeAutoSyncOnOpen,
  __resetAutoSyncOnOpenForTests,
  type AutoSyncOnOpenDeps,
  type AutoSyncToast,
  type SyncUnitOutcome
} from './autoSyncOnOpen';
import type { PublicUser } from '@/lib/saas/api';
import type { LookupAddressRow } from '@/lib/storage/db';

function userOf(plan: PublicUser['plan'], subscriptionActive: boolean): PublicUser {
  return {
    id: 'u1',
    email: 'u@example.com',
    role: 'subscriber',
    plan,
    subscriptionStatus: subscriptionActive ? 'active' : 'canceled',
    subscriptionExpiresAt: null,
    includedUnits: 5000,
    subscriptionActive
  };
}

function walletRow(chain: string, address: string): LookupAddressRow {
  return { id: `${chain}:${address}`, chain, address, lastSyncedAt: 1, txCount: 1 };
}

const EX = (
  id: string,
  credentialsState: 'ready' | 'reauthorization_required' = 'ready'
) => ({ id, exchange: 'binance', label: id, credentialsState }) as never;

interface Harness {
  deps: AutoSyncOnOpenDeps;
  toasts: AutoSyncToast[];
  sequence: string[];
  syncExchange: ReturnType<typeof vi.fn>;
  syncWalletGroup: ReturnType<typeof vi.fn>;
}

/**
 * Two exchange connections + two wallet groups (one address watched on two
 * chains = ONE group/connection card).
 */
function makeHarness(): Harness {
  const toasts: AutoSyncToast[] = [];
  const sequence: string[] = [];
  const syncExchange = vi.fn(async (id: string): Promise<SyncUnitOutcome> => {
    sequence.push(`ex:${id}`);
    return { imported: 2, failed: false };
  });
  const syncWalletGroup = vi.fn(async (rows: LookupAddressRow[]): Promise<SyncUnitOutcome> => {
    sequence.push(`w:${rows.map((r) => `${r.chain}:${r.address}`).join('|')}`);
    return { imported: 1, failed: false };
  });
  const deps: AutoSyncOnOpenDeps = {
    hosted: true,
    listExchangeConnections: async () => [EX('conn-1'), EX('conn-2')],
    listWalletRows: async () => [
      walletRow('solana', 'SoLAddr'),
      walletRow('ethereum', '0xABC'),
      walletRow('polygon', '0xabc') // same address, second chain → same group
    ],
    syncExchange,
    syncWalletGroup,
    toast: (t) => toasts.push(t)
  };
  return { deps, toasts, sequence, syncExchange, syncWalletGroup };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAutoSyncOnOpenForTests();
});

describe('maybeAutoSyncOnOpen', () => {
  it('paid hosted user → every exchange and wallet group syncs sequentially, toasts start + summary', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(result).toEqual({ ran: true, total: 4, synced: 4, failed: 0, newTransactions: 6 });
    // Exchanges first, then wallet groups — sequentially, in order.
    expect(h.sequence).toEqual([
      'ex:conn-1',
      'ex:conn-2',
      'w:solana:SoLAddr',
      'w:ethereum:0xABC|polygon:0xabc'
    ]);
    expect(h.syncExchange).toHaveBeenCalledTimes(2);
    expect(h.syncWalletGroup).toHaveBeenCalledTimes(2);

    expect(h.toasts[0]).toEqual({ tone: 'primary', title: 'Syncing 4 connections…' });
    expect(h.toasts[1]).toEqual({
      tone: 'gain',
      title: 'Synced 4 connections · 6 new transactions'
    });
    expect(h.toasts).toHaveLength(2);
  });

  it('keeps case-distinct Base58 wallets as separate auto-sync units while folding EVM case', async () => {
    const h = makeHarness();
    h.deps.listExchangeConnections = async () => [];
    h.deps.listWalletRows = async () => [
      walletRow('solana', 'Base58Case'),
      walletRow('solana', 'base58Case'),
      walletRow('ethereum', '0xAbC'),
      walletRow('polygon', '0xabc')
    ];

    const result = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(result).toMatchObject({ ran: true, total: 3, synced: 3 });
    expect(h.syncWalletGroup.mock.calls.map(([rows]) =>
      rows.map((row: LookupAddressRow) => `${row.chain}:${row.address}`)
    )).toEqual([
      ['solana:Base58Case'],
      ['solana:base58Case'],
      ['ethereum:0xAbC', 'polygon:0xabc']
    ]);
  });

  it('free plan (local tier) → no sync calls, no toasts', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(userOf('local', true), h.deps);

    expect(result).toEqual({ ran: false, reason: 'not-paid' });
    expect(h.syncExchange).not.toHaveBeenCalled();
    expect(h.syncWalletGroup).not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(0);
  });

  it('paid plan but lapsed subscription → treated as not paid', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(userOf('pro', false), h.deps);

    expect(result).toEqual({ ran: false, reason: 'not-paid' });
    expect(h.syncExchange).not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(0);
  });

  it('local (non-hosted) mode → no sync calls even for a paid user', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(userOf('pro', true), { ...h.deps, hosted: false });

    expect(result).toEqual({ ran: false, reason: 'not-hosted' });
    expect(h.syncExchange).not.toHaveBeenCalled();
    expect(h.syncWalletGroup).not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(0);
  });

  it('no session user → no-op', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(null, h.deps);

    expect(result).toEqual({ ran: false, reason: 'no-user' });
    expect(h.syncExchange).not.toHaveBeenCalled();
  });

  it('one connection throwing → the rest still sync and the summary reports the failure', async () => {
    const h = makeHarness();
    h.syncExchange.mockImplementation(async (id: string): Promise<SyncUnitOutcome> => {
      h.sequence.push(`ex:${id}`);
      if (id === 'conn-1') throw new Error('region_blocked');
      return { imported: 3, failed: false };
    });

    const result = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(result).toEqual({ ran: true, total: 4, synced: 3, failed: 1, newTransactions: 5 });
    // Every later connection still ran.
    expect(h.sequence).toEqual([
      'ex:conn-1',
      'ex:conn-2',
      'w:solana:SoLAddr',
      'w:ethereum:0xABC|polygon:0xabc'
    ]);
    const summary = h.toasts[1];
    expect(summary.tone).toBe('warn');
    expect(summary.title).toBe('Synced 3 of 4 connections · 5 new transactions');
    expect(summary.description).toBe("1 couldn't sync — open Connections to retry");
  });

  it('a failed (not thrown) unit outcome also counts as a failure', async () => {
    const h = makeHarness();
    h.syncWalletGroup.mockImplementation(async (rows: LookupAddressRow[]): Promise<SyncUnitOutcome> => {
      h.sequence.push(`w:${rows.length}`);
      return { imported: 0, failed: true };
    });

    const result = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(result).toMatchObject({ ran: true, synced: 2, failed: 2, newTransactions: 4 });
    expect(h.toasts[1].description).toBe("2 couldn't sync — open Connections to retry");
  });

  it('zero connections → no-op, no toasts', async () => {
    const h = makeHarness();
    const result = await maybeAutoSyncOnOpen(userOf('pro', true), {
      ...h.deps,
      listExchangeConnections: async () => [],
      listWalletRows: async () => []
    });

    expect(result).toEqual({ ran: false, reason: 'no-connections' });
    expect(h.toasts).toHaveLength(0);
  });

  it('mixed ready and paused exchanges count and sync only ready units', async () => {
    const h = makeHarness();
    h.deps.listExchangeConnections = async () => [
      EX('ready-1'),
      EX('paused', 'reauthorization_required'),
      EX('ready-2')
    ];
    h.deps.listWalletRows = async () => [walletRow('solana', 'SoLAddr')];

    const result = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(result).toEqual({ ran: true, total: 3, synced: 3, failed: 0, newTransactions: 5 });
    expect(h.sequence).toEqual(['ex:ready-1', 'ex:ready-2', 'w:solana:SoLAddr']);
    expect(h.syncExchange).not.toHaveBeenCalledWith('paused');
    expect(h.toasts[0]).toEqual({ tone: 'primary', title: 'Syncing 3 connections…' });
    expect(h.toasts[1]).toEqual({
      tone: 'gain',
      title: 'Synced 3 connections · 5 new transactions'
    });
  });

  it('all-paused exchanges do not start a run or invoke the default syncNow', async () => {
    mocks.listConnections.mockResolvedValue([
      EX('paused-1', 'reauthorization_required'),
      EX('paused-2', 'reauthorization_required')
    ]);
    const toasts: AutoSyncToast[] = [];

    const result = await maybeAutoSyncOnOpen(userOf('pro', true), {
      hosted: true,
      listWalletRows: async () => [],
      toast: (toast) => toasts.push(toast)
    });

    expect(result).toEqual({ ran: false, reason: 'reauthorization-required' });
    expect(mocks.syncNow).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('runs once per boot — a second call collapses onto the latch', async () => {
    const h = makeHarness();
    const first = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);
    const second = await maybeAutoSyncOnOpen(userOf('pro', true), h.deps);

    expect(first.ran).toBe(true);
    expect(second).toEqual({ ran: false, reason: 'already-ran' });
    expect(h.syncExchange).toHaveBeenCalledTimes(2); // from the first run only
  });
});
