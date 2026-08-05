import { describe, it, expect } from 'vitest';
import { countPotentialSwapPairs, detectDexSwaps, isLikelyNativeFee } from './swapDetection';
import type { Transaction } from '@/types/transaction';

let seq = 0;
function tx(p: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `id_${seq}`,
    timestamp: 1_700_000_000_000,
    type: 'transfer_in',
    asset: 'X',
    amount: 1,
    fiatCurrency: 'USD',
    source: 'rpc:solana',
    sourceRef: 'sig1',
    chain: 'solana',
    walletAddress: 'Base58Case',
    flags: ['possible_internal_transfer'],
    isInternalTransfer: false,
    ...p
  };
}

describe('detectDexSwaps — multi-hop / split-route merge (C1)', () => {
  it('nets same-asset legs and merges a multi-hop route into one trade', () => {
    // Route: spend 1000 USDC in two hops, receive 3 SOL in two hops.
    const rows = [
      tx({ type: 'transfer_out', asset: 'USDC', amount: 600, sourceRef: 'h1' }),
      tx({ type: 'transfer_out', asset: 'USDC', amount: 400, sourceRef: 'h1' }),
      tx({ type: 'transfer_in', asset: 'SOL', amount: 2, sourceRef: 'h1' }),
      tx({ type: 'transfer_in', asset: 'SOL', amount: 1, sourceRef: 'h1' })
    ];
    const { transactions, tradesCreated } = detectDexSwaps(rows);
    const trade = transactions.find((t) => t.type === 'trade');
    expect(tradesCreated).toBe(1);
    expect(trade).toBeDefined();
    expect(trade!.asset).toBe('USDC');
    expect(trade!.amount).toBe(1000);
    expect(trade!.counterAsset).toBe('SOL');
    expect(trade!.counterAmount).toBe(3);
  });

  it('flags needs_review when the group has multiple distinct in/out assets', () => {
    const rows = [
      tx({ type: 'transfer_out', asset: 'USDC', amount: 500, sourceRef: 'h2' }),
      tx({ type: 'transfer_out', asset: 'DAI', amount: 500, sourceRef: 'h2' }),
      tx({ type: 'transfer_in', asset: 'SOL', amount: 2, sourceRef: 'h2' })
    ];
    const { transactions, tradesCreated } = detectDexSwaps(rows);
    expect(tradesCreated).toBe(0);
    expect(transactions.every((t) => t.flags.includes('needs_review'))).toBe(true);
  });

  it('still handles the simple 1-out / 1-in swap', () => {
    const rows = [
      tx({ type: 'transfer_out', asset: 'USDC', amount: 100, sourceRef: 'h3' }),
      tx({ type: 'transfer_in', asset: 'SOL', amount: 0.5, sourceRef: 'h3' })
    ];
    const { transactions, tradesCreated } = detectDexSwaps(rows);
    expect(tradesCreated).toBe(1);
    const trade = transactions.find((t) => t.type === 'trade')!;
    expect(trade.counterAsset).toBe('SOL');
  });
});

describe('detectDexSwaps wallet-scoped signatures', () => {
  it('groups event-specific refs by their shared transaction hash', () => {
    const rows = [
      tx({
        id: 'event-out', type: 'transfer_out', asset: 'USDC', sourceRef: 'event:log:1',
        txHash: '0xtransaction', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: '0xabc'
      }),
      tx({
        id: 'event-in', type: 'transfer_in', asset: 'ETH', amount: 1, sourceRef: 'event:log:2',
        txHash: '0xtransaction', source: 'rpc:alchemy', chain: 'ethereum', walletAddress: '0xabc'
      })
    ];

    const result = detectDexSwaps(rows);
    expect(result.tradesCreated).toBe(1);
    expect(result.removedIds).toEqual(['event-in']);
    expect(countPotentialSwapPairs(rows)).toBe(1);
  });

  it('does not cross-pair case-distinct Solana wallets sharing a signature', () => {
    const rows = [
      tx({ id: 'wallet-a-out', type: 'transfer_out', asset: 'USDC', sourceRef: 'shared' }),
      tx({
        id: 'wallet-b-in', type: 'transfer_in', asset: 'BONK', sourceRef: 'shared',
        walletAddress: 'base58Case'
      })
    ];

    const result = detectDexSwaps(rows);
    expect(result.tradesCreated).toBe(0);
    expect(result.removedIds).toEqual([]);
    expect(result.transactions.map((row) => row.id)).toEqual(['wallet-a-out', 'wallet-b-in']);
    expect(countPotentialSwapPairs(rows)).toBe(0);
  });

  it('detects each case-distinct wallet pair independently', () => {
    const rows = [
      tx({ id: 'a-out', type: 'transfer_out', asset: 'USDC', sourceRef: 'shared' }),
      tx({ id: 'a-in', type: 'transfer_in', asset: 'BONK', sourceRef: 'shared' }),
      tx({
        id: 'b-out', type: 'transfer_out', asset: 'SOL', amount: 1,
        sourceRef: 'shared', walletAddress: 'base58Case'
      }),
      tx({
        id: 'b-in', type: 'transfer_in', asset: 'JUP', sourceRef: 'shared',
        walletAddress: 'base58Case'
      })
    ];

    const result = detectDexSwaps(rows);
    expect(result.tradesCreated).toBe(2);
    expect(new Set(result.removedIds)).toEqual(new Set(['a-in', 'b-in']));
    expect(result.transactions.filter((row) => row.type === 'trade').map((row) => row.id)).toEqual([
      'a-out', 'b-out'
    ]);
    expect(countPotentialSwapPairs(rows)).toBe(2);
  });

  it('folds EVM address case only within the same canonical chain scope', () => {
    const sameChainPair = [
      tx({
        id: 'eth-out', type: 'transfer_out', asset: 'USDC', sourceRef: 'evm-shared',
        source: 'rpc:ethereum', chain: 'ethereum', walletAddress: '0xAbC'
      }),
      tx({
        id: 'eth-in', type: 'transfer_in', asset: 'ETH', amount: 1, sourceRef: 'evm-shared',
        source: 'rpc:ethereum', chain: 'ethereum', walletAddress: '0xabc'
      })
    ];
    const crossChainLeg = tx({
      id: 'base-in', type: 'transfer_in', asset: 'ETH', amount: 2, sourceRef: 'evm-shared',
      source: 'rpc:base', chain: 'base', walletAddress: '0xabc'
    });

    const result = detectDexSwaps([...sameChainPair, crossChainLeg]);
    expect(result.tradesCreated).toBe(1);
    expect(result.removedIds).toEqual(['eth-in']);
    expect(result.transactions.find((row) => row.id === 'base-in')?.type).toBe('transfer_in');
  });
});

describe('gas-aware dust (C1)', () => {
  it('treats a native leg near the tx fee as dust (gas), not a swap leg', () => {
    // Fee leg says gas was 0.002 SOL; a 0.0021 SOL out leg is gas dust.
    const feeLeg = tx({ type: 'fee', asset: 'SOL', amount: 0.002, sourceRef: 'g1' });
    const nativeDust = tx({ type: 'transfer_out', asset: 'SOL', amount: 0.0021, sourceRef: 'g1' });
    const tokenIn = tx({ type: 'transfer_in', asset: 'BONK', amount: 1000, sourceRef: 'g1' });
    const tokenOut = tx({ type: 'transfer_out', asset: 'USDC', amount: 50, sourceRef: 'g1' });
    const { transactions } = detectDexSwaps([feeLeg, nativeDust, tokenIn, tokenOut]);
    // The USDC↔BONK swap is detected; the tiny SOL leg is excluded as gas dust.
    const trade = transactions.find((t) => t.type === 'trade');
    expect(trade).toBeDefined();
    expect(trade!.asset).toBe('USDC');
    expect(trade!.counterAsset).toBe('BONK');
  });

  it('scales dust to a fraction of the largest same-asset leg (no fee leg)', () => {
    // A 20 SOL swap leg exists in the group; a 0.5 SOL leg is < 5% of it and is
    // dust even though 0.5 exceeds the fixed 0.05 constant. A 2 SOL leg (10%) is
    // a real leg, not dust.
    const ctx = {
      feeByAsset: new Map<string, number>(),
      maxLegByAsset: new Map<string, number>([['SOL', 20]])
    };
    expect(isLikelyNativeFee(tx({ asset: 'SOL', amount: 0.5 }), ctx)).toBe(true);
    expect(isLikelyNativeFee(tx({ asset: 'SOL', amount: 2 }), ctx)).toBe(false);
  });

  it('falls back to fixed thresholds with no context', () => {
    expect(isLikelyNativeFee(tx({ asset: 'SOL', amount: 0.01 }))).toBe(true);
    expect(isLikelyNativeFee(tx({ asset: 'SOL', amount: 0.5 }))).toBe(false);
    expect(isLikelyNativeFee(tx({ asset: 'USDC', amount: 0.001 }))).toBe(false);
  });
});
