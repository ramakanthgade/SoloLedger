import { describe, it, expect } from 'vitest';
import { detectDexSwaps, isLikelyNativeFee } from './swapDetection';
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
