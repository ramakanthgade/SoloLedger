import { describe, it, expect } from 'vitest';
import { buildMatchedGainRows, buildReceiptIncomeRows, buildIncomeRows } from './matchedGains';
import type { Disposal, Lot, Transaction } from '@/types/transaction';

const DAY = 86_400_000;

let seq = 0;
function lot(over: Partial<Lot>): Lot {
  seq += 1;
  return {
    id: over.id ?? `lot${seq}`,
    asset: over.asset ?? 'BTC',
    acquiredAt: over.acquiredAt ?? 1 * DAY,
    amountRemaining: over.amountRemaining ?? 0,
    amountOriginal: over.amountOriginal ?? 1,
    costBasisPerUnit: over.costBasisPerUnit ?? 100,
    costBasisTotal: over.costBasisTotal ?? 100,
    sourceTxId: over.sourceTxId ?? `buytx${seq}`,
    acquisitionType: over.acquisitionType ?? 'buy'
  };
}

function disposal(over: Partial<Disposal>): Disposal {
  seq += 1;
  return {
    id: over.id ?? `d${seq}`,
    asset: over.asset ?? 'BTC',
    disposedAt: over.disposedAt ?? 10 * DAY,
    amount: over.amount ?? 1,
    proceeds: over.proceeds ?? 0,
    costBasis: over.costBasis ?? 0,
    gain: over.gain ?? 0,
    holdingPeriodDays: over.holdingPeriodDays ?? 0,
    lotConsumption: over.lotConsumption ?? [],
    sourceTxId: over.sourceTxId ?? `selltx${seq}`,
    method: over.method ?? 'FIFO'
  };
}

function tx(over: Partial<Transaction> & { type: Transaction['type'] }): Transaction {
  seq += 1;
  return {
    id: over.id ?? `tx${seq}`,
    timestamp: over.timestamp ?? seq * DAY,
    asset: over.asset ?? 'BTC',
    amount: over.amount ?? 1,
    fiatCurrency: over.fiatCurrency ?? 'INR',
    fiatValue: over.fiatValue ?? 100,
    source: over.source ?? 'manual',
    flags: over.flags ?? [],
    isInternalTransfer: over.isInternalTransfer ?? false,
    ...over
  } as Transaction;
}

describe('buildMatchedGainRows — unmatched proceeds are never dropped', () => {
  it('emits an explicit zero-cost review row for a FULLY unmatched disposal', () => {
    // Sell 2 BTC for 500 with NO acquisition history at all.
    const d = disposal({ amount: 2, proceeds: 500, lotConsumption: [] });
    const rows = buildMatchedGainRows([d], [], []);

    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.status).toBe('missing_cost_basis');
    expect(r.costBasis).toBe(0);
    // Full proceeds taxed as gain (conservative 115BBH treatment).
    expect(r.proceeds).toBe(500);
    expect(r.gain).toBe(500);
    expect(r.sellAmount).toBe(2);
  });

  it('splits a PARTIALLY matched disposal into a matched row + a review row', () => {
    // Sell 2 BTC for 600; only 1 BTC (cost 100) is matched.
    const l = lot({ id: 'lotA', costBasisPerUnit: 100, costBasisTotal: 100 });
    const d = disposal({
      amount: 2,
      proceeds: 600,
      lotConsumption: [{ lotId: 'lotA', amount: 1, costBasis: 100 }]
    });
    const rows = buildMatchedGainRows([d], [l], []);

    const matched = rows.find((r) => r.status === 'matched')!;
    const review = rows.find((r) => r.status === 'missing_cost_basis')!;
    expect(matched).toBeDefined();
    expect(review).toBeDefined();

    // Proceeds split 50/50 by amount: 300 each.
    expect(matched.proceeds).toBe(300);
    expect(matched.costBasis).toBe(100);
    expect(matched.gain).toBe(200);

    expect(review.proceeds).toBe(300);
    expect(review.costBasis).toBe(0);
    expect(review.gain).toBe(300);

    // All proceeds accounted for — nothing dropped.
    const totalProceeds = rows.reduce((s, r) => s + r.proceeds, 0);
    expect(totalProceeds).toBeCloseTo(600, 6);
  });

  it('marks fully-matched rows with status "matched" (no review row)', () => {
    const l = lot({ id: 'lotB', costBasisPerUnit: 100, costBasisTotal: 100 });
    const d = disposal({
      amount: 1,
      proceeds: 250,
      lotConsumption: [{ lotId: 'lotB', amount: 1, costBasis: 100 }]
    });
    const rows = buildMatchedGainRows([d], [l], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('matched');
  });
});

describe('buildReceiptIncomeRows — Section 56(2)(x) inclusion/exclusion', () => {
  it('includes explicit income and gift_received receipts', () => {
    const rows = buildReceiptIncomeRows([
      tx({ id: 'inc', type: 'income', fiatValue: 1000, timestamp: 5 * DAY }),
      tx({ id: 'gift', type: 'gift_received', fiatValue: 500, timestamp: 6 * DAY })
    ]);
    const ids = rows.map((r) => r.txId).sort();
    expect(ids).toEqual(['gift', 'inc']);
    expect(rows.reduce((s, r) => s + r.fiatValue, 0)).toBe(1500);
  });

  it('includes a heuristic airdrop/staking receipt', () => {
    const rows = buildReceiptIncomeRows([
      tx({
        id: 'drop',
        type: 'transfer_in',
        asset: 'FOO',
        chain: 'ethereum',
        fiatValue: 200,
        counterpartyAddress: '0x' + 'a'.repeat(40),
        walletAddress: '0x' + 'b'.repeat(40)
      })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('airdrop_suspected');
    expect(rows[0].fiatValue).toBe(200);
  });

  it('EXCLUDES mining income (zero-cost / no receipt-side income)', () => {
    const rows = buildReceiptIncomeRows([
      tx({ id: 'mine', type: 'income', category: 'mining', fiatValue: 9999, timestamp: 7 * DAY }),
      tx({ id: 'stake', type: 'income', category: 'staking', fiatValue: 300, timestamp: 8 * DAY })
    ]);
    const ids = rows.map((r) => r.txId);
    expect(ids).not.toContain('mine');
    expect(ids).toContain('stake');
    expect(rows.reduce((s, r) => s + r.fiatValue, 0)).toBe(300);
  });

  it('INCLUDES a GEOD-style mining_reward (category mining_reward, NOT mining) as receipt income', () => {
    const rows = buildReceiptIncomeRows([
      tx({ id: 'geod', type: 'income', category: 'mining_reward', fiatValue: 250, timestamp: 9 * DAY })
    ]);
    const ids = rows.map((r) => r.txId);
    expect(ids).toContain('geod');
    const geod = rows.find((r) => r.txId === 'geod')!;
    expect(geod.kind).toBe('mining_reward');
    expect(geod.fiatValue).toBe(250);
  });
});

describe('buildIncomeRows — reward kind + label', () => {
  it('GEOD mining_reward row yields kind mining_reward and label "Mining reward"', () => {
    const rows = buildIncomeRows([
      tx({ id: 'geod', type: 'income', category: 'mining_reward', asset: 'GEOD', fiatValue: 250, timestamp: 9 * DAY })
    ]);
    const geod = rows.find((r) => r.txId === 'geod')!;
    expect(geod.kind).toBe('mining_reward');
    expect(geod.kindLabel).toBe('Mining reward');
  });

  it('a control mining row (category mining) keeps no mining_reward label', () => {
    const rows = buildIncomeRows([
      tx({ id: 'mine', type: 'income', category: 'mining', fiatValue: 250, timestamp: 9 * DAY })
    ]);
    const mine = rows.find((r) => r.txId === 'mine')!;
    expect(mine.kind).not.toBe('mining_reward');
  });
});
