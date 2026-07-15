import { describe, it, expect } from 'vitest';
import { calculateCostBasis, STRATEGIES, type EngineOptions, type CostBasisMethod } from './engine';
import type { Transaction, TxType, TaxSettings } from '@/types/transaction';

let seq = 0;
function tx(overrides: Partial<Transaction> & { type: TxType }): Transaction {
  seq += 1;
  return {
    id: overrides.id ?? `tx${seq}`,
    timestamp: overrides.timestamp ?? seq * 86_400_000,
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    fiatValue: 100,
    source: 'manual',
    flags: [],
    isInternalTransfer: false,
    ...overrides
  } as Transaction;
}

function run(txs: Transaction[], opts: Partial<EngineOptions> = {}) {
  return calculateCostBasis(txs, { method: 'FIFO', ...opts });
}

const DAY = 86_400_000;

describe('cost-basis engine', () => {
  it('consumes a lot partially and leaves the remainder open', () => {
    const { disposals, lots } = run([
      tx({ id: 'b', type: 'buy', amount: 2, fiatValue: 200, timestamp: 1 * DAY }),
      tx({ id: 's', type: 'sell', amount: 0.5, fiatValue: 80, timestamp: 2 * DAY })
    ]);
    expect(disposals).toHaveLength(1);
    // cost basis = 0.5 * (200/2) = 50; gain = 80 - 50 = 30
    expect(disposals[0].costBasis).toBe(50);
    expect(disposals[0].gain).toBe(30);
    expect(lots[0].amountRemaining).toBe(1.5);
  });

  it('matches a disposal across multiple lots (FIFO order)', () => {
    const { disposals } = run([
      tx({ id: 'b1', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY }),
      tx({ id: 'b2', type: 'buy', amount: 1, fiatValue: 300, timestamp: 2 * DAY }),
      tx({ id: 's', type: 'sell', amount: 1.5, fiatValue: 500, timestamp: 3 * DAY })
    ]);
    // FIFO: 1 @100 + 0.5 @300 = 100 + 150 = 250
    expect(disposals[0].costBasis).toBe(250);
    expect(disposals[0].lotConsumption).toHaveLength(2);
  });

  it('FIFO, LIFO and HIFO produce different cost bases on the same fixture', () => {
    const fixture = () => [
      tx({ id: 'b1', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY }),
      tx({ id: 'b2', type: 'buy', amount: 1, fiatValue: 300, timestamp: 2 * DAY }),
      tx({ id: 'b3', type: 'buy', amount: 1, fiatValue: 200, timestamp: 3 * DAY }),
      tx({ id: 's', type: 'sell', amount: 1, fiatValue: 500, timestamp: 4 * DAY })
    ];
    const fifo = run(fixture(), { method: 'FIFO' }).disposals[0].costBasis;
    const lifo = run(fixture(), { method: 'LIFO' }).disposals[0].costBasis;
    const hifo = run(fixture(), { method: 'HIFO' }).disposals[0].costBasis;
    expect(fifo).toBe(100); // oldest
    expect(lifo).toBe(200); // newest
    expect(hifo).toBe(300); // highest cost/unit
    expect(new Set([fifo, lifo, hifo]).size).toBe(3);
  });

  it('SpecID with a duplicated hint id consumes each lot only once (no negative residual)', () => {
    const buy = tx({ id: 'b1', type: 'buy', amount: 2, fiatValue: 200, timestamp: 1 * DAY });
    const { lots } = run([buy], {}); // get the generated lot id
    // Re-run with a disposal, but SpecID needs the lot id which is generated at runtime.
    // Build via candidates instead: run buy+sell together, capture candidate lot id.
    const res1 = run([buy, tx({ id: 's', type: 'sell', amount: 1, fiatValue: 150, timestamp: 2 * DAY })]);
    const lotId = res1.disposalCandidates['s'][0].lotId;

    const res = calculateCostBasis(
      [buy, tx({ id: 's', type: 'sell', amount: 1, fiatValue: 150, timestamp: 2 * DAY })],
      { method: 'SpecID', specIdHints: { s: [lotId, lotId, lotId] } }
    );
    const disp = res.disposals[0];
    // Only 1 unit consumed from the single lot; cost basis = 1 * 100 = 100
    expect(disp.lotConsumption).toHaveLength(1);
    expect(disp.lotConsumption[0].amount).toBe(1);
    expect(disp.costBasis).toBe(100);
    // lot had 2, disposed 1, remaining 1 (never negative)
    expect(res.lots[0].amountRemaining).toBe(1);
    expect(res.shortfalls).toHaveLength(0);
    expect(lots.length).toBeGreaterThan(0);
  });

  it('records a shortfall/flag when a trade acquisition leg lacks a counterAmount', () => {
    const { flags } = run([
      tx({
        id: 't',
        type: 'trade',
        asset: 'BTC',
        amount: 1,
        fiatValue: 100,
        counterAsset: 'ETH',
        counterAmount: 0,
        timestamp: 1 * DAY
      })
    ]);
    const ethFlag = flags.find((f) => f.asset === 'ETH');
    expect(ethFlag).toBeDefined();
    expect(ethFlag?.reason).toBe('missing_cost_basis');
    expect(ethFlag?.transactionId).toBe('t');
  });

  it('nft_buy opens a lot consumed by a later nft_sell', () => {
    const { disposals, lots } = run([
      tx({ id: 'nb', type: 'nft_buy', asset: 'PUNK', amount: 1, fiatValue: 1000, timestamp: 1 * DAY }),
      tx({ id: 'ns', type: 'nft_sell', asset: 'PUNK', amount: 1, fiatValue: 1500, timestamp: 2 * DAY })
    ]);
    expect(lots).toHaveLength(1);
    expect(lots[0].acquisitionType).toBe('nft_buy');
    expect(disposals).toHaveLength(1);
    expect(disposals[0].costBasis).toBe(1000);
    expect(disposals[0].gain).toBe(500);
  });

  it('dust below DUST creates no phantom lot and no phantom shortfall', () => {
    const buy = tx({ id: 'b', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY });
    const res = run([buy, tx({ id: 's', type: 'sell', amount: 1, fiatValue: 120, timestamp: 2 * DAY })]);
    // full consumption leaves 0 remaining, not a tiny float residual
    expect(res.lots[0].amountRemaining).toBe(0);
    // Selling slightly more than owned by only a dust amount => no shortfall
    const res2 = run([
      tx({ id: 'b2', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY }),
      tx({ id: 's2', type: 'sell', amount: 1 + 1e-12, fiatValue: 120, timestamp: 2 * DAY })
    ]);
    expect(res2.shortfalls).toHaveLength(0);
  });

  it('rejects/flags a zero or negative acquisition instead of opening a lot', () => {
    const resZero = run([tx({ id: 'z', type: 'buy', amount: 0, fiatValue: 100, timestamp: 1 * DAY })]);
    expect(resZero.lots).toHaveLength(0);
    expect(resZero.flags.some((f) => f.transactionId === 'z' && f.reason === 'missing_cost_basis')).toBe(true);

    const resNeg = run([tx({ id: 'n', type: 'buy', amount: -1, fiatValue: 100, timestamp: 1 * DAY })]);
    expect(resNeg.lots).toHaveLength(0);
    expect(resNeg.flags.some((f) => f.transactionId === 'n')).toBe(true);

    const resNaN = run([tx({ id: 'x', type: 'buy', amount: 1, fiatValue: Infinity, timestamp: 1 * DAY })]);
    expect(resNaN.lots).toHaveLength(0);
    expect(resNaN.flags.some((f) => f.transactionId === 'x')).toBe(true);
  });

  it('clamps amountRemaining at 0, never negative, on over-disposal', () => {
    const { lots, shortfalls } = run([
      tx({ id: 'b', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY }),
      tx({ id: 's', type: 'sell', amount: 5, fiatValue: 500, timestamp: 2 * DAY })
    ]);
    expect(lots[0].amountRemaining).toBe(0);
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0].unmatchedAmount).toBeCloseTo(4, 9);
  });

  it('orders same-timestamp acquisitions before disposals deterministically', () => {
    const ts = 5 * DAY;
    const { disposals, shortfalls } = run([
      tx({ id: 's', type: 'sell', amount: 1, fiatValue: 150, timestamp: ts }),
      tx({ id: 'b', type: 'buy', amount: 1, fiatValue: 100, timestamp: ts })
    ]);
    // buy processed first, so the sell finds cost basis and has no shortfall
    expect(shortfalls).toHaveLength(0);
    expect(disposals[0].costBasis).toBe(100);
  });

  it('feePolicy=exclude ignores fees; add_to_basis adds a fiat-denominated fee to cost basis', () => {
    const buyFixture = () =>
      tx({
        id: 'b',
        type: 'buy',
        amount: 1,
        fiatValue: 100,
        feeAsset: 'INR',
        feeAmount: 10,
        timestamp: 1 * DAY
      });
    const excl = run([buyFixture()], { feePolicy: 'exclude' });
    expect(excl.lots[0].costBasisTotal).toBe(100);

    const incl = run([buyFixture()], { feePolicy: 'add_to_basis' });
    expect(incl.lots[0].costBasisTotal).toBe(110);
  });

  it('add_to_basis only counts a fee denominated in the reporting fiat currency', () => {
    const incl = run(
      [
        tx({
          id: 'b',
          type: 'buy',
          amount: 1,
          fiatValue: 100,
          feeAsset: 'BTC', // crypto fee — cannot be valued without a price lookup
          feeAmount: 0.01,
          timestamp: 1 * DAY
        })
      ],
      { feePolicy: 'add_to_basis' }
    );
    expect(incl.lots[0].costBasisTotal).toBe(100);
  });

  it('defaults to exclude fee policy (India) when none is passed', () => {
    const res = run([
      tx({ id: 'b', type: 'buy', amount: 1, fiatValue: 100, feeAsset: 'INR', feeAmount: 10, timestamp: 1 * DAY })
    ]);
    expect(res.lots[0].costBasisTotal).toBe(100);
  });

  it('exposes FIFO, LIFO, HIFO and SpecID in the STRATEGIES map', () => {
    const methods: CostBasisMethod[] = ['FIFO', 'LIFO', 'HIFO', 'SpecID'];
    for (const m of methods) {
      expect(STRATEGIES[m]).toBeDefined();
      expect(STRATEGIES[m].method).toBe(m);
    }
  });

  it('is selectable end-to-end via a settings-typed method producing differing basis', () => {
    const fixture = () => [
      tx({ id: 'b1', type: 'buy', amount: 1, fiatValue: 100, timestamp: 1 * DAY }),
      tx({ id: 'b2', type: 'buy', amount: 1, fiatValue: 300, timestamp: 2 * DAY }),
      tx({ id: 's', type: 'sell', amount: 1, fiatValue: 500, timestamp: 3 * DAY })
    ];
    // Simulate the value coming from TaxSettings.defaultCostBasisMethod / a <select>.
    const asSetting = (m: TaxSettings['defaultCostBasisMethod']) => m;
    const lifo = run(fixture(), { method: asSetting('LIFO') }).disposals[0].costBasis;
    const hifo = run(fixture(), { method: asSetting('HIFO') }).disposals[0].costBasis;
    expect(lifo).toBe(300); // newest lot
    expect(hifo).toBe(300); // highest cost/unit (same here) — confirms method routes
    // LIFO differs from FIFO on this fixture, proving selection is real.
    const fifo = run(fixture(), { method: asSetting('FIFO') }).disposals[0].costBasis;
    expect(fifo).toBe(100);
    expect(lifo).not.toBe(fifo);
  });

  describe('India Sec 56(2)(x) → 115BBH cost-of-acquisition linkage', () => {
    it('income lot opens at FMV-at-receipt; later sale gain = P − F (not P − 0)', () => {
      const { lots, disposals } = run([
        tx({ id: 'inc', type: 'income', amount: 1, fiatValue: 400, timestamp: 1 * DAY }),
        tx({ id: 'sell', type: 'sell', amount: 1, fiatValue: 1000, timestamp: 2 * DAY })
      ]);
      // Lot cost of acquisition = FMV-at-receipt (400), NOT zero.
      expect(lots[0].costBasisTotal).toBe(400);
      // 115BBH sale gain = 1000 − 400 = 600.
      expect(disposals[0].costBasis).toBe(400);
      expect(disposals[0].gain).toBe(600);
    });

    it('gift_received and airdrop-style income both open at FMV-at-receipt', () => {
      const gift = run([
        tx({ id: 'g', type: 'gift_received', amount: 2, fiatValue: 500, timestamp: 1 * DAY }),
        tx({ id: 's', type: 'sell', amount: 2, fiatValue: 1500, timestamp: 2 * DAY })
      ]);
      expect(gift.disposals[0].costBasis).toBe(500);
      expect(gift.disposals[0].gain).toBe(1000);
    });

    it('mining reward is the DISTINCT case: cost basis 0, later gain = full sale price', () => {
      const { lots, disposals } = run([
        tx({ id: 'mine', type: 'income', category: 'mining', amount: 1, fiatValue: 400, timestamp: 1 * DAY }),
        tx({ id: 'sell', type: 'sell', amount: 1, fiatValue: 1000, timestamp: 2 * DAY })
      ]);
      // Mining cost of acquisition is treated as ZERO regardless of FMV.
      expect(lots[0].costBasisTotal).toBe(0);
      expect(disposals[0].costBasis).toBe(0);
      expect(disposals[0].gain).toBe(1000); // full consideration
    });
  });

  it('decimal-vs-float regression on a long synthetic history', () => {
    const txs: Transaction[] = [];
    let t = 1;
    // 300 buys of 0.1 each at rising price, then sell everything.
    let totalCost = 0;
    for (let i = 0; i < 300; i++) {
      const price = 100 + i;
      const fiat = 0.1 * price;
      totalCost += fiat;
      txs.push(tx({ id: `b${i}`, type: 'buy', amount: 0.1, fiatValue: fiat, timestamp: t++ * DAY }));
    }
    txs.push(tx({ id: 'sell', type: 'sell', amount: 30, fiatValue: 100000, timestamp: (t + 1) * DAY }));
    const { disposals, lots } = run(txs);
    // All lots fully consumed (30 = 300 * 0.1), remaining sums to ~0
    const remaining = lots.reduce((s, l) => s + l.amountRemaining, 0);
    expect(remaining).toBeLessThanOrEqual(1e-9);
    // Cost basis equals sum of all buy fiat values, exactly.
    expect(disposals[0].costBasis).toBeCloseTo(totalCost, 6);
  });
});
