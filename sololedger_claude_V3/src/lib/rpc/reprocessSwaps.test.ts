import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  GEOD_TOKEN_MINT_SOLANA,
  GEOD_REWARDS_WALLET_SOLANA
} from '@/lib/assets/rewardRegistry';
import { DBT_TOKEN_MINT } from '@/lib/assets/dabbaRegistry';

// ---- In-memory transactions store ----
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

// These are imported by reprocessSwaps.ts but not exercised by reprocessRewardIncome.
vi.mock('@/lib/rpc/swapDetection', () => ({
  detectDexSwaps: vi.fn(() => ({ transactions: [], removedIds: [], tradesCreated: 0 }))
}));
vi.mock('@/lib/rpc/noves', () => ({ batchClassifyNoves: vi.fn(async () => []) }));

import { reprocessRewardIncome } from '@/lib/rpc/reprocessSwaps';

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: over.id ?? `tx${seq}`,
    timestamp: over.timestamp ?? seq * 86_400_000,
    type: over.type ?? 'transfer_in',
    asset: over.asset ?? 'GEOD',
    amount: over.amount ?? 1,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:helius',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    ...over
  } as Transaction;
}

const NON_REWARDS_SENDER = 'Gh2nJr3gxiYBxFaSGBsi6VVhdefkMYX6jGR3PCD7h8t4';
const USER_WALLET = 'UserWallet1111111111111111111111111111111';

describe('reprocessRewardIncome', () => {
  beforeEach(() => {
    store = [];
    seq = 0;
  });

  it('flips a stored GEOD transfer_in from the rewards wallet to income/mining_reward', async () => {
    store = [
      tx({
        id: 'geod',
        contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA,
        walletAddress: USER_WALLET
      })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(1);
    expect(store[0].type).toBe('income');
    expect(store[0].category).toBe('mining_reward');
    expect(store[0].flags).toEqual([]);
  });

  it('leaves a stored GEOD transfer_in from a NON-rewards sender untouched', async () => {
    store = [
      tx({
        id: 'geod-peer',
        contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: NON_REWARDS_SENDER,
        walletAddress: USER_WALLET
      })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(0);
    expect(store[0].type).toBe('transfer_in');
  });

  it('still flips DBT (no regression) and sets an income category', async () => {
    store = [
      tx({
        id: 'dbt',
        asset: 'DBT',
        contractAddress: DBT_TOKEN_MINT,
        counterpartyAddress: NON_REWARDS_SENDER, // unknown sender → genesis_reward fallback
        walletAddress: USER_WALLET
      })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(1);
    expect(store[0].type).toBe('income');
    expect(store[0].category).toBe('genesis_reward');
  });

  it('does not touch rows the user already classified / made internal / spammed', async () => {
    store = [
      tx({ id: 'already-income', type: 'income', contractAddress: GEOD_TOKEN_MINT_SOLANA, counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA }),
      tx({ id: 'internal', isInternalTransfer: true, contractAddress: GEOD_TOKEN_MINT_SOLANA, counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA }),
      tx({ id: 'spam', isSpam: true, contractAddress: GEOD_TOKEN_MINT_SOLANA, counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(0);
    expect(store.find((t) => t.id === 'already-income')!.type).toBe('income');
    expect(store.find((t) => t.id === 'internal')!.type).toBe('transfer_in');
    expect(store.find((t) => t.id === 'spam')!.type).toBe('transfer_in');
  });

  it('skips reward rows sent from one of the user\'s own wallets', async () => {
    store = [
      // user has two wallets; one sends GEOD to the other → self-transfer, not income
      tx({ id: 'self', contractAddress: GEOD_TOKEN_MINT_SOLANA, counterpartyAddress: USER_WALLET, walletAddress: 'OtherWallet222222222222222222222222222222' })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(0);
    expect(store[0].type).toBe('transfer_in');
  });

  it('flips a stored DBT transfer_in with NO counterparty (ATA path) to income/genesis_reward', async () => {
    store = [
      tx({
        id: 'dbt-nocp',
        asset: 'DBT',
        contractAddress: DBT_TOKEN_MINT,
        counterpartyAddress: undefined,
        walletAddress: USER_WALLET
      })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(1);
    expect(store[0].type).toBe('income');
    expect(store[0].category).toBe('genesis_reward');
  });

  it('leaves a stored GEOD transfer_in with NO counterparty untouched', async () => {
    store = [
      tx({
        id: 'geod-nocp',
        contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: undefined,
        walletAddress: USER_WALLET
      })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(0);
    expect(store[0].type).toBe('transfer_in');
  });

  it('ignores non-registry tokens entirely', async () => {
    store = [
      tx({ id: 'usdc', asset: 'USDC', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA })
    ];
    const n = await reprocessRewardIncome();
    expect(n).toBe(0);
    expect(store[0].type).toBe('transfer_in');
  });
});
