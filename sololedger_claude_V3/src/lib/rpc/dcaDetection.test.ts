import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';

// ---- In-memory transactions store (same pattern as rewardSuggestions.test.ts) ----
let store: Transaction[] = [];

vi.mock('@/lib/storage/db', () => ({
  db: {
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

import {
  detectDcaGroups,
  applyDcaClassification,
  type DcaGroup
} from '@/lib/rpc/dcaDetection';

// ---- Fixtures mirroring the live phantom (wallet CgSF…, Dec 2024) ----
const WALLET = 'CgSF2tG4uD2EuSuoYBxwySqdaPKqgcbzSGLbRdfBtgfp';
const SENDER = '4EK6KCowZvsinsb7bbmx1fPJfjuDzyjkQuXVMSR5Vb7u';
const OTHER = 'GeWJUMvrSomeOtherCounterpartyAddress1111111';
const VAULT = 'DCAvaultAddress11111111111111111111111111';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DBT_MINT = 'DBTNHU51SBFi3dsoGGCRfKbno4teZXqsDSL37s4jgRKv';
/** 2024-12-31 10:16:41 UTC — the real USDT transfer-in blockTime. */
const T = 1735640201000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: over.id ?? `tx${seq}`,
    timestamp: over.timestamp ?? T,
    type: over.type ?? 'transfer_in',
    asset: over.asset ?? 'USDT',
    amount: over.amount ?? 100,
    fiatCurrency: 'USD',
    source: 'rpc:helius',
    chain: 'solana',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    walletAddress: over.walletAddress ?? WALLET,
    ...over
  } as Transaction;
}

/** The exact phantom shape: 1,300 USDT in, then 1,199.25 USDC out 70 min later. */
function phantomRows(): Transaction[] {
  return [
    tx({
      id: 'usdt-in',
      timestamp: T,
      type: 'transfer_in',
      asset: 'USDT',
      amount: 1300,
      contractAddress: USDT_MINT,
      counterpartyAddress: SENDER,
      sourceRef: '5Va81EmR-anchor'
    }),
    tx({
      id: 'usdc-out',
      timestamp: T + 70 * 60 * 1000,
      type: 'transfer_out',
      asset: 'USDC',
      amount: 1199.25,
      contractAddress: USDC_MINT,
      counterpartyAddress: OTHER,
      sourceRef: '24LTBD9W-later'
    })
  ];
}

beforeEach(() => {
  store = [];
  seq = 0;
  fetchJupiterRecurringHistory.mockReset();
});

describe('detectDcaGroups — hardened against the phantom-trade false positive', () => {
  it('RULE ≥2 fills: a single receive + an unrelated later send is NOT a recurring order', () => {
    // The exact live phantom: old code paired these and fabricated a trade.
    expect(detectDcaGroups(phantomRows())).toEqual([]);
  });

  it('RULE ordering: a "deposit" that lands AFTER the first fill is rejected (2 fills present)', () => {
    const rows = [
      tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'USDT', amount: 500, contractAddress: USDT_MINT, counterpartyAddress: SENDER, sourceRef: 's1' }),
      tx({ id: 'f2', timestamp: T + 2 * HOUR, type: 'transfer_in', asset: 'USDT', amount: 500, contractAddress: USDT_MINT, counterpartyAddress: SENDER, sourceRef: 's2' }),
      // Send lands BETWEEN the fills — after the first. Cannot fund them.
      tx({ id: 'dep', timestamp: T + HOUR, type: 'transfer_out', asset: 'USDC', amount: 900, contractAddress: USDC_MINT, counterpartyAddress: OTHER, sourceRef: 's3' })
    ];
    expect(detectDcaGroups(rows)).toEqual([]);
  });

  it('detects a genuine 2-fill group when the deposit precedes the fills (pass 2)', () => {
    const rows = [
      tx({ id: 'dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'DBT', amount: 900, contractAddress: DBT_MINT, counterpartyAddress: undefined, sourceRef: 's0' }),
      tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: SENDER, sourceRef: 's1' }),
      tx({ id: 'f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: SENDER, sourceRef: 's2' })
    ];
    const groups = detectDcaGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].inputAsset).toBe('DBT');
    expect(groups[0].outputAsset).toBe('USDC');
    expect(groups[0].unclassifiedFillTxs.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
  });

  it('pass 1: deposit + fills sharing the vault counterparty, single fill is NOT enough', () => {
    const oneFill = [
      tx({ id: 'dep', timestamp: T, type: 'transfer_out', asset: 'DBT', amount: 900, contractAddress: DBT_MINT, counterpartyAddress: VAULT, sourceRef: 's0' }),
      tx({ id: 'f1', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: VAULT, sourceRef: 's1' })
    ];
    expect(detectDcaGroups(oneFill)).toEqual([]);

    const twoFills = [
      ...oneFill,
      tx({ id: 'f2', timestamp: T + 2 * DAY, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: VAULT, sourceRef: 's2' })
    ];
    const groups = detectDcaGroups(twoFills);
    expect(groups).toHaveLength(1);
    expect(groups[0].vaultAddress).toBe(VAULT);
  });

  it('a fully-classified group is NOT re-detected (no unclassified fills → nothing to do)', () => {
    const rows = [
      tx({ id: 'dep', timestamp: T, type: 'transfer_out', asset: 'DBT', amount: 900, contractAddress: DBT_MINT, counterpartyAddress: VAULT, sourceRef: 's0', isInternalTransfer: true, notes: 'DCA deposit: 900.0000 DBT → vault. Non-taxable escrow.' }),
      tx({ id: 'f1', timestamp: T + DAY, type: 'trade', asset: 'DBT', amount: 450, counterAsset: 'USDC', counterAmount: 440, contractAddress: DBT_MINT, counterpartyAddress: VAULT, sourceRef: 's1', notes: 'DCA fill: sold 450.0000 DBT for 440.0000 USDC (Jupiter API (exact))' }),
      tx({ id: 'f2', timestamp: T + 2 * DAY, type: 'trade', asset: 'DBT', amount: 450, counterAsset: 'USDC', counterAmount: 445, contractAddress: DBT_MINT, counterpartyAddress: VAULT, sourceRef: 's2', notes: 'DCA fill: sold 450.0000 DBT for 445.0000 USDC (Jupiter API (exact))' })
    ];
    expect(detectDcaGroups(rows)).toEqual([]);
  });

  it('drip: 2 classified fills + 1 new fill from the same counterparty → group for ONLY the new fill', () => {
    // Deposit WITHOUT counterparty (old import) forces the fill-side pass, where
    // classified fills must count toward recurrence under the OUTPUT asset key.
    const rows = [
      tx({ id: 'dep', timestamp: T - DAY, type: 'transfer_out', asset: 'DBT', amount: 900, contractAddress: DBT_MINT, counterpartyAddress: undefined, sourceRef: 's0' }),
      tx({ id: 'f1', timestamp: T, type: 'trade', asset: 'DBT', amount: 300, counterAsset: 'USDC', counterAmount: 290, contractAddress: DBT_MINT, counterpartyAddress: SENDER, sourceRef: 's1', notes: 'DCA fill: sold 300.0000 DBT for 290.0000 USDC (Jupiter API (exact))' }),
      tx({ id: 'f2', timestamp: T + DAY, type: 'trade', asset: 'DBT', amount: 300, counterAsset: 'USDC', counterAmount: 295, contractAddress: DBT_MINT, counterpartyAddress: SENDER, sourceRef: 's2', notes: 'DCA fill: sold 300.0000 DBT for 295.0000 USDC (Jupiter API (exact))' }),
      tx({ id: 'f3', timestamp: T + 2 * DAY, type: 'transfer_in', asset: 'USDC', amount: 298, contractAddress: USDC_MINT, counterpartyAddress: SENDER, sourceRef: 's3' })
    ];
    const groups = detectDcaGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].fillTxs.map((f) => f.id).sort()).toEqual(['f1', 'f2', 'f3']);
    expect(groups[0].unclassifiedFillTxs.map((f) => f.id)).toEqual(['f3']);
    expect(groups[0].outputAsset).toBe('USDC');
  });

  it('spam rows never count as fills', () => {
    const rows = [
      tx({ id: 'dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'DBT', amount: 900, contractAddress: DBT_MINT, counterpartyAddress: undefined, sourceRef: 's0' }),
      tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: SENDER, sourceRef: 's1' }),
      tx({ id: 'f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', amount: 450, contractAddress: USDC_MINT, counterpartyAddress: SENDER, sourceRef: 's2', isSpam: true })
    ];
    expect(detectDcaGroups(rows)).toEqual([]);
  });

  it('transfers between the user’s own wallets are never vault activity', () => {
    const rows = [
      tx({ id: 'dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'USDC', amount: 900, contractAddress: USDC_MINT, counterpartyAddress: WALLET, sourceRef: 's0' }),
      tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'USDT', amount: 450, contractAddress: USDT_MINT, counterpartyAddress: WALLET, sourceRef: 's1' }),
      tx({ id: 'f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDT', amount: 450, contractAddress: USDT_MINT, counterpartyAddress: WALLET, sourceRef: 's2' })
    ];
    expect(detectDcaGroups(rows)).toEqual([]);
  });

  it('keeps the same EVM wallet and vault on different chains in separate groups', () => {
    const evmWallet = '0xAbC';
    const evmVault = '0xDeF';
    const chainRows = (chain: 'ethereum' | 'base', prefix: string) => [
      tx({
        id: `${prefix}-dep`, timestamp: T - HOUR, type: 'transfer_out', asset: 'USDC',
        chain, walletAddress: evmWallet, counterpartyAddress: evmVault, sourceRef: `${prefix}-dep`
      }),
      tx({
        id: `${prefix}-f1`, type: 'transfer_in', asset: 'TOKEN', chain,
        walletAddress: evmWallet.toLowerCase(), counterpartyAddress: evmVault.toUpperCase(),
        sourceRef: `${prefix}-f1`
      }),
      tx({
        id: `${prefix}-f2`, timestamp: T + DAY, type: 'transfer_in', asset: 'TOKEN', chain,
        walletAddress: evmWallet, counterpartyAddress: evmVault, sourceRef: `${prefix}-f2`
      })
    ];

    const groups = detectDcaGroups([
      ...chainRows('ethereum', 'eth'),
      ...chainRows('base', 'base')
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.chain))).toEqual(new Set(['ethereum', 'base']));
    for (const group of groups) {
      expect(new Set(group.fillTxs.map((fill) => fill.chain))).toEqual(new Set([group.chain]));
    }
  });

  it('keeps case-distinct Solana wallets and vaults in separate groups', () => {
    const rows = [
      tx({ id: 'a-dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'DBT', walletAddress: 'Base58Case', counterpartyAddress: 'VaultCase', sourceRef: 'a-dep' }),
      tx({ id: 'a-f1', type: 'transfer_in', asset: 'USDC', walletAddress: 'Base58Case', counterpartyAddress: 'VaultCase', sourceRef: 'a-f1' }),
      tx({ id: 'a-f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', walletAddress: 'Base58Case', counterpartyAddress: 'VaultCase', sourceRef: 'a-f2' }),
      tx({ id: 'b-dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'DBT', walletAddress: 'base58Case', counterpartyAddress: 'vaultCase', sourceRef: 'b-dep' }),
      tx({ id: 'b-f1', type: 'transfer_in', asset: 'USDC', walletAddress: 'base58Case', counterpartyAddress: 'vaultCase', sourceRef: 'b-f1' }),
      tx({ id: 'b-f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', walletAddress: 'base58Case', counterpartyAddress: 'vaultCase', sourceRef: 'b-f2' })
    ];

    const groups = detectDcaGroups(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.depositTx.id).sort()).toEqual(['a-dep', 'b-dep']);
    expect(groups.map((group) => group.fillTxs.map((fill) => fill.id).sort())).toEqual([
      ['a-f1', 'a-f2'],
      ['b-f1', 'b-f2']
    ]);
  });
});

// ---- applyDcaClassification ----

function genuineGroupRows(): Transaction[] {
  return [
    tx({ id: 'dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'DBT', amount: 100, contractAddress: DBT_MINT, counterpartyAddress: VAULT, sourceRef: 'dep-sig', chain: 'solana' }),
    tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'USDC', amount: 40, contractAddress: USDC_MINT, counterpartyAddress: VAULT, sourceRef: 'fill-sig-1', chain: 'solana' }),
    tx({ id: 'f2', timestamp: T + DAY, type: 'transfer_in', asset: 'USDC', amount: 60, contractAddress: USDC_MINT, counterpartyAddress: VAULT, sourceRef: 'fill-sig-2', chain: 'solana' })
  ];
}

function jupiterResult(over: Partial<{
  reachable: boolean;
  orderKey: string;
  fills: Record<string, number>;
}> = {}) {
  const order = {
    orderKey: over.orderKey ?? VAULT,
    inputMint: DBT_MINT,
    outputMint: USDC_MINT,
    inDeposited: '100000000',
    inLeft: '0',
    fills: Object.entries(over.fills ?? {}).map(([txId, inputAmount]) => ({
      txId,
      rawInputAmount: String(inputAmount * 1e6),
      rawOutputAmount: '0',
      inputAmount,
      outputAmount: 0,
      confirmedAt: '',
      action: 'filled'
    }))
  };
  const fillsByTxId = new Map();
  for (const fill of order.fills) fillsByTxId.set(fill.txId, { order, fill });
  return {
    orders: over.orderKey === null ? [] : [order],
    fillsByTxId,
    reachable: over.reachable ?? true
  };
}

describe('applyDcaClassification — Jupiter verification (Solana)', () => {
  it('skips with NO writes when Jupiter is unreachable (fail-open, retry later)', async () => {
    store = genuineGroupRows();
    const groups = detectDcaGroups(store);
    expect(groups).toHaveLength(1);
    fetchJupiterRecurringHistory.mockResolvedValueOnce({ orders: [], fillsByTxId: new Map(), reachable: false });

    const r = await applyDcaClassification(groups, undefined);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.skipReasons.join(' ')).toContain('unreachable');
    // Nothing was written — deposit still a plain send, fills still plain receives.
    expect(store.find((t) => t.id === 'dep')?.isInternalTransfer).toBe(false);
    expect(store.find((t) => t.id === 'f1')?.type).toBe('transfer_in');
  });

  it('skips when Jupiter confirms there is NO matching recurring order', async () => {
    store = genuineGroupRows();
    const groups = detectDcaGroups(store);
    fetchJupiterRecurringHistory.mockResolvedValueOnce({ orders: [], fillsByTxId: new Map(), reachable: true });

    const r = await applyDcaClassification(groups, undefined);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.skipReasons.join(' ')).toContain('no recurring order');
    expect(store.find((t) => t.id === 'dep')?.isInternalTransfer).toBe(false);
  });

  it('classifies with EXACT Jupiter amounts when the order is confirmed', async () => {
    store = genuineGroupRows();
    const groups = detectDcaGroups(store);
    fetchJupiterRecurringHistory.mockResolvedValueOnce(
      jupiterResult({ fills: { 'fill-sig-1': 40, 'fill-sig-2': 60 } })
    );

    const r = await applyDcaClassification(groups, undefined);
    expect(r.applied).toBe(1);
    expect(r.fillsClassified).toBe(2);
    expect(r.estimated).toBe(0);

    const dep = store.find((t) => t.id === 'dep')!;
    expect(dep.isInternalTransfer).toBe(true);
    expect(dep.notes).toContain('DCA deposit');

    const f1 = store.find((t) => t.id === 'f1')!;
    expect(f1.type).toBe('trade');
    expect(f1.asset).toBe('DBT');
    expect(f1.amount).toBe(40); // exact from Jupiter, NOT the 50 equal split
    expect(f1.counterAsset).toBe('USDC');
    expect(f1.counterAmount).toBe(40);
    expect(f1.flags).toEqual([]);
    expect(f1.notes).toContain('Jupiter API (exact)');
  });

  it('flags equal-split estimates needs_review (never silently invents an amount)', async () => {
    store = genuineGroupRows();
    const groups = detectDcaGroups(store);
    // Order confirmed by account address, but no per-fill amounts and no Alchemy key.
    fetchJupiterRecurringHistory.mockResolvedValueOnce(jupiterResult({ fills: {} }));

    const r = await applyDcaClassification(groups, undefined);
    expect(r.applied).toBe(1);
    expect(r.estimated).toBe(2);
    const f1 = store.find((t) => t.id === 'f1')!;
    expect(f1.type).toBe('trade');
    expect(f1.amount).toBe(50); // 100 DBT / 2 fills
    expect(f1.flags).toContain('needs_review');
    expect(f1.notes).toContain('estimated');
  });

  it('EVM groups classify without the Jupiter gate (estimated + flagged)', async () => {
    store = [
      tx({ id: 'dep', timestamp: T - HOUR, type: 'transfer_out', asset: 'OG', amount: 342, contractAddress: '0xOG', counterpartyAddress: '0x264127vault', sourceRef: '0xdep', chain: 'bsc' }),
      tx({ id: 'f1', timestamp: T, type: 'transfer_in', asset: 'FORTE', amount: 10, contractAddress: '0xFORTE', counterpartyAddress: '0x264127vault', sourceRef: '0xf1', chain: 'bsc' }),
      tx({ id: 'f2', timestamp: T + DAY, type: 'transfer_in', asset: 'FORTE', amount: 12, contractAddress: '0xFORTE', counterpartyAddress: '0x264127vault', sourceRef: '0xf2', chain: 'bsc' })
    ];
    const groups = detectDcaGroups(store);
    expect(groups).toHaveLength(1);

    const r = await applyDcaClassification(groups, undefined);
    expect(fetchJupiterRecurringHistory).not.toHaveBeenCalled();
    expect(r.applied).toBe(1);
    expect(r.estimated).toBe(2);
    const dep = store.find((t) => t.id === 'dep')!;
    expect(dep.isInternalTransfer).toBe(true);
    const f1 = store.find((t) => t.id === 'f1')!;
    expect(f1.type).toBe('trade');
    expect(f1.asset).toBe('OG');
    expect(f1.counterAsset).toBe('FORTE');
    expect(f1.flags).toContain('needs_review');
  });

  it('does not form a DCA group without canonical wallet identity', async () => {
    const rows = genuineGroupRows().map((t) => ({ ...t, walletAddress: undefined }));
    store = rows;
    const groups = detectDcaGroups(rows);
    expect(groups).toHaveLength(0);
    const r = await applyDcaClassification(groups as DcaGroup[], undefined);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(0);
    expect(fetchJupiterRecurringHistory).not.toHaveBeenCalled();
  });

  it('scopes other deposits and tiny SOL mutations to the exact wallet operation', async () => {
    store = genuineGroupRows();
    const groups = detectDcaGroups(store);
    expect(groups).toHaveLength(1);
    store.push(
      tx({
        id: 'same-scope-other-deposit', timestamp: T - 2 * HOUR, type: 'transfer_out',
        asset: 'DBT', amount: 25, counterpartyAddress: VAULT, sourceRef: 'other-dep'
      }),
      tx({
        id: 'other-chain-deposit', timestamp: T - 2 * HOUR, type: 'transfer_out',
        asset: 'DBT', amount: 25, chain: 'ethereum', walletAddress: '0xAbC',
        counterpartyAddress: VAULT, sourceRef: 'other-dep'
      }),
      tx({
        id: 'other-wallet-same-signature', type: 'transfer_out', asset: 'SOL', amount: 0.002,
        walletAddress: WALLET.toLowerCase(), sourceRef: 'dep-sig'
      }),
      tx({
        id: 'deposit-rent', type: 'transfer_out', asset: 'SOL', amount: 0.002,
        sourceRef: 'dep-sig'
      }),
      tx({
        id: 'fill-rent', type: 'transfer_out', asset: 'SOL', amount: 0.003,
        sourceRef: 'fill-sig-1'
      }),
      tx({
        id: 'explicit-refund', type: 'transfer_in', asset: 'SOL', amount: 0.004,
        sourceRef: 'fill-sig-2'
      }),
      tx({
        id: 'unrelated-tiny-inbound', type: 'transfer_in', asset: 'SOL', amount: 0.005,
        sourceRef: 'unrelated-signature', flags: ['missing_cost_basis']
      })
    );
    fetchJupiterRecurringHistory.mockResolvedValueOnce(
      jupiterResult({ fills: { 'fill-sig-1': 40, 'fill-sig-2': 60 } })
    );

    await applyDcaClassification(groups);

    expect(store.find((row) => row.id === 'same-scope-other-deposit')).toMatchObject({
      isInternalTransfer: true
    });
    expect(store.find((row) => row.id === 'other-chain-deposit')).toMatchObject({
      isInternalTransfer: false
    });
    expect(store.find((row) => row.id === 'deposit-rent')).toMatchObject({
      type: 'fee', notes: 'Token account rent (Jupiter DCA setup) — reduces wallet SOL balance'
    });
    expect(store.find((row) => row.id === 'fill-rent')).toMatchObject({ type: 'fee' });
    expect(store.find((row) => row.id === 'other-wallet-same-signature')?.type).toBe('transfer_out');
    expect(store.find((row) => row.id === 'other-wallet-same-signature')?.notes).toBeUndefined();
    expect(store.find((row) => row.id === 'explicit-refund')).toMatchObject({
      type: 'transfer_in', notes: 'Token account rent refund (DCA account close)'
    });
    expect(store.find((row) => row.id === 'unrelated-tiny-inbound')).toMatchObject({
      type: 'transfer_in', flags: ['missing_cost_basis']
    });
    expect(store.find((row) => row.id === 'unrelated-tiny-inbound')?.notes).toBeUndefined();
  });
});
