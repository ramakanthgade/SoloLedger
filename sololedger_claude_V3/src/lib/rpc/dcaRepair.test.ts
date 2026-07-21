import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';

// ---- In-memory transactions store ----
let store: Transaction[] = [];

vi.mock('@/lib/storage/db', () => ({
  db: {
    transaction: vi.fn(async (_mode: string, _table: unknown, fn: () => Promise<unknown>) => fn()),
    transactions: {
      toArray: vi.fn(async () => store),
      update: vi.fn(async (id: string, changes: Partial<Transaction>) => {
        const i = store.findIndex((t) => t.id === id);
        if (i >= 0) store[i] = { ...store[i], ...changes };
        return 1;
      }),
      filter: vi.fn((fn: (t: Transaction) => boolean) => ({
        toArray: async () => store.filter(fn)
      })),
      bulkPut: vi.fn(async (txs: Transaction[]) => {
        for (const t of txs) {
          const i = store.findIndex((x) => x.id === t.id);
          if (i >= 0) store[i] = t;
          else store.push(t);
        }
      })
    }
  }
}));

const fetchJupiterRecurringHistory = vi.fn();
vi.mock('@/lib/rpc/jupiterDca', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rpc/jupiterDca')>()),
  fetchJupiterRecurringHistory: (...args: unknown[]) =>
    fetchJupiterRecurringHistory(...(args as []))
}));

vi.mock('@/lib/portfolio/solBalance', () => ({
  normalizeSolLedgerRows: vi.fn(async () => {})
}));
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => false) }));
vi.mock('@/lib/saas/api', () => ({ saasProxyFetch: vi.fn() }));
vi.mock('@/lib/saas/lookupConfig', () => ({ SAAS_PROXY_KEY: 'proxy-key' }));

import { repairDcaMisclassifications } from '@/lib/rpc/dcaRepair';

const WALLET = 'CgSF2tG4uD2EuSuoYBxwySqdaPKqgcbzSGLbRdfBtgfp';
const SENDER = '4EK6KCowZvsinsb7bbmx1fPJfjuDzyjkQuXVMSR5Vb7u';
const VAULT = 'DCAvaultAddress11111111111111111111111111';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DBT_MINT = 'DBTNHU51SBFi3dsoGGCRfKbno4teZXqsDSL37s4jgRKv';
const T = 1735640201000;
const DAY = 86_400_000;

/** The exact rows the OLD code wrote on the user's wallet (the phantom). */
function phantomSeed(): Transaction[] {
  return [
    {
      id: 'phantom-trade',
      timestamp: T,
      type: 'trade',
      asset: 'USDC',
      amount: 1199.25,
      counterAsset: 'USDT',
      counterAmount: 1300,
      contractAddress: USDC_MINT,
      fiatCurrency: 'INR',
      fiatValue: 111354.6,
      source: 'rpc:helius',
      sourceRef: '5Va81EmR-anchor',
      walletAddress: WALLET,
      counterpartyAddress: SENDER,
      chain: 'solana',
      flags: [],
      isInternalTransfer: false,
      notes: 'DCA fill: sold 1199.2500 USDC for 1300.0000 USDT (equal split (1 fills))'
    } as Transaction,
    {
      id: 'hidden-deposit',
      timestamp: T + 70 * 60 * 1000,
      type: 'transfer_out',
      asset: 'USDC',
      amount: 1199.25,
      contractAddress: USDC_MINT,
      fiatCurrency: 'INR',
      source: 'rpc:helius',
      sourceRef: '24LTBD9W-later',
      walletAddress: WALLET,
      counterpartyAddress: 'GeWJUMvrSomeOtherCounterpartyAddress1111111',
      chain: 'solana',
      flags: [],
      isInternalTransfer: true,
      notes: 'DCA deposit: 1199.2500 USDC → vault (GeWJUMvr…1111). Non-taxable escrow.'
    } as Transaction
  ];
}

beforeEach(() => {
  store = [];
  fetchJupiterRecurringHistory.mockReset();
});

describe('repairDcaMisclassifications', () => {
  it('does nothing when no auto-generated DCA rows exist', async () => {
    store = [];
    const r = await repairDcaMisclassifications();
    expect(r.status).toBe('none');
    expect(fetchJupiterRecurringHistory).not.toHaveBeenCalled();
  });

  it('reverts the phantom and re-applies NOTHING (single-fill group fails the hardened rules)', async () => {
    store = phantomSeed();
    fetchJupiterRecurringHistory.mockResolvedValue({ orders: [], fillsByTxId: new Map(), reachable: true });

    const r = await repairDcaMisclassifications();
    expect(r.status).toBe('done');
    expect(r.revertedFills).toBe(1);
    expect(r.revertedDeposits).toBe(1);
    expect(r.reappliedGroups).toBe(0);

    // The fake trade is a plain USDT receive again — priced leg preserved.
    const fill = store.find((t) => t.id === 'phantom-trade')!;
    expect(fill.type).toBe('transfer_in');
    expect(fill.asset).toBe('USDT');
    expect(fill.amount).toBe(1300);
    expect(fill.contractAddress).toBe(USDT_MINT);
    expect(fill.fiatValue).toBe(111354.6);
    expect(fill.counterAsset).toBeUndefined();
    expect(fill.counterAmount).toBeUndefined();
    expect(fill.flags).toContain('needs_review');
    expect(fill.notes).toContain('plain receive');

    // The hidden send is a plain USDC transfer-out again.
    const dep = store.find((t) => t.id === 'hidden-deposit')!;
    expect(dep.type).toBe('transfer_out');
    expect(dep.isInternalTransfer).toBe(false);
    expect(dep.asset).toBe('USDC');
    expect(dep.amount).toBe(1199.25);
    expect(dep.flags).toContain('needs_review');
  });

  it('aborts with ZERO writes when Jupiter is unreachable (never reverts during an outage)', async () => {
    store = phantomSeed();
    fetchJupiterRecurringHistory.mockResolvedValue({ orders: [], fillsByTxId: new Map(), reachable: false });

    const r = await repairDcaMisclassifications();
    expect(r.status).toBe('aborted-unreachable');
    // Store untouched — the phantom is still exactly as before (retry next session).
    expect(store.find((t) => t.id === 'phantom-trade')?.type).toBe('trade');
    expect(store.find((t) => t.id === 'hidden-deposit')?.isInternalTransfer).toBe(true);
  });

  it('re-applies a GENUINE group with exact Jupiter amounts after the revert', async () => {
    store = [
      {
        id: 'dep', timestamp: T - DAY, type: 'transfer_out', asset: 'DBT', amount: 100,
        contractAddress: DBT_MINT, fiatCurrency: 'USD', source: 'rpc:helius', sourceRef: 'dep-sig',
        walletAddress: WALLET, counterpartyAddress: VAULT, chain: 'solana', flags: [],
        isInternalTransfer: true, notes: 'DCA deposit: 100.0000 DBT → vault. Non-taxable escrow.'
      } as Transaction,
      {
        id: 'f1', timestamp: T, type: 'trade', asset: 'DBT', amount: 50, counterAsset: 'USDC', counterAmount: 40,
        contractAddress: DBT_MINT, fiatCurrency: 'USD', source: 'rpc:helius', sourceRef: 'fill-sig-1',
        walletAddress: WALLET, counterpartyAddress: VAULT, chain: 'solana', flags: [],
        isInternalTransfer: false, notes: 'DCA fill: sold 50.0000 DBT for 40.0000 USDC (equal split (2 fills))'
      } as Transaction,
      {
        id: 'f2', timestamp: T + DAY, type: 'trade', asset: 'DBT', amount: 50, counterAsset: 'USDC', counterAmount: 60,
        contractAddress: DBT_MINT, fiatCurrency: 'USD', source: 'rpc:helius', sourceRef: 'fill-sig-2',
        walletAddress: WALLET, counterpartyAddress: VAULT, chain: 'solana', flags: [],
        isInternalTransfer: false, notes: 'DCA fill: sold 50.0000 DBT for 60.0000 USDC (equal split (2 fills))'
      } as Transaction
    ];
    const order = {
      orderKey: VAULT,
      inputMint: DBT_MINT,
      outputMint: USDC_MINT,
      inDeposited: '100000000',
      inLeft: '0',
      fills: [
        { txId: 'fill-sig-1', rawInputAmount: '42000000', rawOutputAmount: '40000000', inputAmount: 42, outputAmount: 40, confirmedAt: '', action: 'filled' },
        { txId: 'fill-sig-2', rawInputAmount: '58000000', rawOutputAmount: '60000000', inputAmount: 58, outputAmount: 60, confirmedAt: '', action: 'filled' }
      ]
    };
    const fillsByTxId = new Map(order.fills.map((f) => [f.txId, { order, fill: f }]));
    fetchJupiterRecurringHistory.mockResolvedValue({ orders: [order], fillsByTxId, reachable: true });

    const r = await repairDcaMisclassifications();
    expect(r.status).toBe('done');
    expect(r.revertedFills).toBe(2);
    expect(r.revertedDeposits).toBe(1);
    expect(r.reappliedGroups).toBe(1);

    // Re-classified with Jupiter-exact amounts — flags cleared, estimates gone.
    const f1 = store.find((t) => t.id === 'f1')!;
    expect(f1.type).toBe('trade');
    expect(f1.asset).toBe('DBT');
    expect(f1.amount).toBe(42);
    expect(f1.counterAsset).toBe('USDC');
    expect(f1.counterAmount).toBe(40);
    expect(f1.flags).toEqual([]);
    expect(f1.notes).toContain('Jupiter API (exact)');

    const f2 = store.find((t) => t.id === 'f2')!;
    expect(f2.amount).toBe(58);

    const dep = store.find((t) => t.id === 'dep')!;
    expect(dep.isInternalTransfer).toBe(true);
    expect(dep.notes).toContain('DCA deposit');
  });
});
