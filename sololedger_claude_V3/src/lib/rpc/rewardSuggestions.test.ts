import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { LlamaRewardHint } from '@/lib/assets/defiLlamaRewards';

// ---- In-memory transactions store (same pattern as reprocessSwaps.test.ts) ----
let store: Transaction[] = [];

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: {
      toArray: vi.fn(async () => store),
      update: vi.fn(async (id: string, changes: Partial<Transaction>) => {
        const i = store.findIndex((t) => t.id === id);
        if (i >= 0) store[i] = { ...store[i], ...changes };
        return 1;
      })
    }
  }
}));

import { applyDefiLlamaRewardSuggestions, countNeedsReview, reclassifyTypePatch } from '@/lib/rpc/rewardSuggestions';

const REWARD_MINT = 'R'.repeat(44);
const SENDER = 'S'.repeat(44);
const USER_WALLET = 'UserWallet1111111111111111111111111111111';

function hint(mint: string, projects: string[] = ['orca-dex']): LlamaRewardHint {
  return { mint, projects, poolSymbols: ['SOL-XYZ'], poolCount: 1 };
}

const HINTS = new Map([[REWARD_MINT, hint(REWARD_MINT)]]);

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: over.id ?? `tx${seq}`,
    timestamp: over.timestamp ?? seq * 86_400_000,
    type: over.type ?? 'transfer_in',
    asset: over.asset ?? 'XYZ',
    amount: over.amount ?? 1,
    fiatCurrency: 'USD',
    source: 'rpc:helius',
    chain: 'solana',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    walletAddress: over.walletAddress ?? USER_WALLET,
    ...over
  } as Transaction;
}

describe('applyDefiLlamaRewardSuggestions', () => {
  beforeEach(() => {
    store = [];
    seq = 0;
  });

  it('flips a hinted Solana transfer_in to income/defi_reward flagged needs_review', async () => {
    store = [
      tx({
        id: 'cand',
        contractAddress: REWARD_MINT,
        counterpartyAddress: SENDER,
        flags: ['possible_internal_transfer', 'missing_cost_basis', 'duplicate_suspected']
      })
    ];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.suggested).toBe(1);
    expect(r.candidates).toBe(1);
    const t = store[0];
    expect(t.type).toBe('income');
    expect(t.category).toBe('defi_reward');
    // needs_review added; auto-derived flags dropped; unrelated flags kept
    expect(t.flags).toContain('needs_review');
    expect(t.flags).not.toContain('possible_internal_transfer');
    expect(t.flags).not.toContain('missing_cost_basis');
    expect(t.flags).toContain('duplicate_suspected');
    expect(t.notes).toContain('DefiLlama');
    expect(t.notes).toContain('orca-dex');
  });

  it('strips both auto-derived flags (possible_internal_transfer + missing_cost_basis) while preserving user-set flags', async () => {
    store = [
      tx({
        id: 'cand',
        contractAddress: REWARD_MINT,
        counterpartyAddress: SENDER,
        flags: ['possible_internal_transfer', 'missing_cost_basis', 'duplicate_suspected', 'unrecognized_asset']
      })
    ];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.suggested).toBe(1);
    const t = store[0];
    expect(t.category).toBe('defi_reward');
    expect(t.flags).not.toContain('possible_internal_transfer');
    expect(t.flags).not.toContain('missing_cost_basis');
    // User-set flags survive the suggestion pass.
    expect(t.flags).toContain('duplicate_suspected');
    expect(t.flags).toContain('unrecognized_asset');
    expect(t.flags).toContain('needs_review');
  });

  it('skips transfers from the user\'s own wallets', async () => {
    store = [
      tx({ id: 'self', contractAddress: REWARD_MINT, counterpartyAddress: USER_WALLET })
    ];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.suggested).toBe(0);
    expect(store[0].type).toBe('transfer_in');
  });

  it('skips rows the user already classified, made internal, or marked spam', async () => {
    store = [
      tx({ id: 'income', type: 'income', contractAddress: REWARD_MINT, counterpartyAddress: SENDER }),
      tx({ id: 'internal', isInternalTransfer: true, contractAddress: REWARD_MINT, counterpartyAddress: SENDER }),
      tx({ id: 'spam', isSpam: true, contractAddress: REWARD_MINT, counterpartyAddress: SENDER })
    ];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.suggested).toBe(0);
    expect(store.every((t) => t.type !== 'income' || t.id === 'income')).toBe(true);
    expect(store.find((t) => t.id === 'income')!.category).not.toBe('defi_reward');
  });

  it('skips non-Solana rows and mints not in the hint set', async () => {
    store = [
      tx({ id: 'evm', chain: 'ethereum', contractAddress: REWARD_MINT, counterpartyAddress: SENDER }),
      tx({ id: 'unknown', contractAddress: 'U'.repeat(44), counterpartyAddress: SENDER }),
      tx({ id: 'native-sol', contractAddress: undefined, asset: 'SOL', counterpartyAddress: SENDER })
    ];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.suggested).toBe(0);
    expect(store.every((t) => t.type === 'transfer_in')).toBe(true);
  });

  it('is idempotent — a second run suggests nothing new', async () => {
    store = [tx({ id: 'cand', contractAddress: REWARD_MINT, counterpartyAddress: SENDER })];
    const first = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(first.suggested).toBe(1);
    const second = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(second.suggested).toBe(0);
    expect(second.candidates).toBe(0);
  });

  it('does not re-suggest a row the user rejected back to transfer_in', async () => {
    store = [tx({ id: 'cand', contractAddress: REWARD_MINT, counterpartyAddress: SENDER })];
    const first = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(first.suggested).toBe(1);
    expect(store[0].category).toBe('defi_reward');

    // Reject via the REAL reclassify patch (the exact code path ReviewTab uses)
    // so this test breaks if reclassify ever starts clearing the category marker.
    const rejected = store[0];
    store[0] = { ...rejected, ...reclassifyTypePatch(rejected.flags, 'transfer_in') };
    expect(store[0].type).toBe('transfer_in');
    expect(store[0].flags).not.toContain('needs_review'); // left the review queue
    expect(store[0].category).toBe('defi_reward'); // rejection marker persists

    const second = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(second.suggested).toBe(0);
    expect(second.candidates).toBe(0);
    expect(store[0].type).toBe('transfer_in'); // not flipped back to income
  });

  it('reports a useful message', async () => {
    store = [tx({ id: 'cand', contractAddress: REWARD_MINT, counterpartyAddress: SENDER })];
    const r = await applyDefiLlamaRewardSuggestions({ hints: HINTS });
    expect(r.message).toContain('1 Solana reward mint');
    expect(r.message).toContain('1 suggested reward income');
    expect(r.message).toContain('Needs review');
  });
});

describe('reclassifyTypePatch', () => {
  it('strips auto-derived + needs_review flags but returns no category (preserves the rejection marker)', () => {
    const patch = reclassifyTypePatch(
      ['possible_internal_transfer', 'missing_cost_basis', 'needs_review', 'duplicate_suspected'],
      'transfer_in'
    );
    expect(patch.type).toBe('transfer_in');
    expect(patch.flags).toEqual(['duplicate_suspected']);
    // Must NOT touch category — a rejected defi_reward row keeps that marker so
    // applyDefiLlamaRewardSuggestions won't re-suggest it.
    expect('category' in patch).toBe(false);
  });
});

describe('countNeedsReview', () => {
  it('counts non-spam rows flagged needs_review', () => {
    const txs = [
      tx({ flags: ['needs_review'] }),
      tx({ flags: ['needs_review'], isSpam: true }),
      tx({ flags: [] })
    ];
    expect(countNeedsReview(txs)).toBe(1);
  });
});
