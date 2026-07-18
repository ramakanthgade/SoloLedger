import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  GEOD_TOKEN_MINT_SOLANA,
  GEOD_REWARDS_WALLET_SOLANA,
  GEOD_TOKEN_POLYGON,
  GEOD_REWARDS_WALLET_POLYGON
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

  it('classifies only official rewards in a mixed dataset and is idempotent', async () => {
    const polygonMixedCase = '0xAc0F66379A6D7801D7726D5A943356A172549AdB';
    const polygonDistributorUpper = `0x${GEOD_REWARDS_WALLET_POLYGON.slice(2).toUpperCase()}`;
    const unknownMint = 'So11111111111111111111111111111111111111112';

    store = [
      tx({
        id: 'valid-solana',
        timestamp: 1_700_000_000_000,
        amount: 12.5,
        fiatValue: 34.5,
        chain: 'solana',
        sourceRef: 'solana-hash',
        flags: ['needs_review'],
        contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA,
        walletAddress: USER_WALLET
      }),
      tx({
        id: 'valid-polygon',
        timestamp: 1_700_000_100_000,
        amount: 7.25,
        fiatValue: 19.75,
        chain: 'polygon',
        source: 'rpc:alchemy',
        sourceRef: 'polygon-hash',
        flags: ['needs_review'],
        contractAddress: polygonMixedCase,
        counterpartyAddress: polygonDistributorUpper,
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'valid-dbt', asset: 'DBT', contractAddress: DBT_TOKEN_MINT,
        counterpartyAddress: NON_REWARDS_SENDER, walletAddress: USER_WALLET
      }),
      tx({
        id: 'solana-mint-case', contractAddress: GEOD_TOKEN_MINT_SOLANA.toLowerCase(),
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA, walletAddress: USER_WALLET
      }),
      tx({
        id: 'solana-wallet-case', contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA.toLowerCase(), walletAddress: USER_WALLET
      }),
      tx({
        id: 'cross-solana', contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON, walletAddress: USER_WALLET
      }),
      tx({
        id: 'cross-polygon', contractAddress: GEOD_TOKEN_POLYGON,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA,
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'unrelated', contractAddress: GEOD_TOKEN_POLYGON,
        counterpartyAddress: '0x2222222222222222222222222222222222222222',
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'missing-counterparty', contractAddress: GEOD_TOKEN_POLYGON,
        counterpartyAddress: undefined,
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'unknown-token', asset: 'SOL', contractAddress: unknownMint,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA, walletAddress: USER_WALLET
      }),
      tx({
        id: 'own-wallet-dbt', asset: 'DBT', contractAddress: DBT_TOKEN_MINT,
        counterpartyAddress: 'UserSecondWallet333333333333333333333333333',
        walletAddress: USER_WALLET
      }),
      tx({
        id: 'wallet-marker', type: 'transfer_out', asset: 'SOL',
        walletAddress: 'UserSecondWallet333333333333333333333333333'
      }),
      tx({
        id: 'internal', isInternalTransfer: true, contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA, walletAddress: USER_WALLET
      }),
      tx({
        id: 'spam', isSpam: true, contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA, walletAddress: USER_WALLET
      }),
      tx({
        id: 'already-classified', type: 'income', category: 'airdrop', notes: 'user choice',
        contractAddress: GEOD_TOKEN_MINT_SOLANA,
        counterpartyAddress: GEOD_REWARDS_WALLET_SOLANA, walletAddress: USER_WALLET
      })
    ];

    const originalSolanaDetails = { ...store[0] };
    const originalPolygonDetails = { ...store[1] };
    const untouchedBefore = new Map(
      store.slice(3).map((row) => [row.id, JSON.stringify(row)])
    );

    expect(await reprocessRewardIncome()).toBe(3);

    expect(store[0]).toEqual({
      ...originalSolanaDetails,
      type: 'income',
      category: 'mining_reward',
      notes: 'Geodnet GEOD mining reward on Solana — auto-classified as income',
      flags: [],
      isInternalTransfer: false
    });
    expect(store[1]).toEqual({
      ...originalPolygonDetails,
      type: 'income',
      category: 'mining_reward',
      notes: 'Geodnet GEOD mining reward on Polygon — auto-classified as income',
      flags: [],
      isInternalTransfer: false
    });
    expect(store[2].type).toBe('income');
    expect(store[2].category).toBe('genesis_reward');

    for (const row of store.slice(3)) {
      expect(JSON.stringify(row), row.id).toBe(untouchedBefore.get(row.id));
    }

    const afterFirstPass = JSON.stringify(store);
    expect(await reprocessRewardIncome()).toBe(0);
    expect(JSON.stringify(store)).toBe(afterFirstPass);
  });
});
