import { describe, it, expect } from 'vitest';
import { calculateCostBasis, STRATEGIES, type EngineOptions, type CostBasisMethod } from './engine';
import { buildMatchedGainRows } from './matchedGains';
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
  return calculateCostBasis(txs, { method: 'FIFO', settings: POLICY_SETTINGS, ...opts });
}

const DAY = 86_400_000;
const POLICY_SETTINGS: TaxSettings = {
  jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false, rpcLookupEnabled: false
};

describe('cost-basis engine', () => {
  it('uses canonical policy to exclude unsupported/suggested outcomes while retaining conservative spot basis', () => {
    const result = run([
      tx({ id: 'buy', type: 'buy', amount: 1, fiatValue: 100, timestamp: DAY }),
      tx({ id: 'sell', type: 'sell', amount: 1, fiatValue: 200, timestamp: 2 * DAY }),
      tx({ id: 'suggested', type: 'income', category: 'defi_reward', categoryOrigin: 'suggestion',
        amount: 10, fiatValue: 10, timestamp: 3 * DAY }),
      tx({ id: 'options', type: 'income', category: 'options_premium', instrumentClass: 'derivative',
        amount: 10, fiatValue: 10, timestamp: 4 * DAY })
    ], { settings: POLICY_SETTINGS });
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]).toMatchObject({ proceeds: 200, costBasis: 100, gain: 100 });
    expect(result.lots.map((lot) => lot.sourceTxId)).toEqual(['buy']);
  });
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
      { method: 'SpecID', specIdHints: { s: [lotId, lotId, lotId] }, settings: POLICY_SETTINGS }
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

  it('records neutral invalid-row guidance when a trade acquisition leg lacks a counterAmount', () => {
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
    expect(ethFlag?.reason).toBe('invalid_transaction_data');
    expect(ethFlag?.transactionId).toBe('t');
  });

  it('conserves BTC→WBTC swap FMV while never fabricating prior BTC basis', () => {
    const result = run([
      tx({
        id: 'wrap', type: 'trade', asset: 'BTC', amount: 1,
        counterAsset: 'WBTC', counterAmount: 0.9995, fiatValue: 5_000_000,
        timestamp: 2 * DAY
      })
    ]);

    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]).toMatchObject({ asset: 'BTC', proceeds: 5_000_000, costBasis: 0 });
    expect(result.shortfalls).toEqual([{ transactionId: 'wrap', asset: 'BTC', unmatchedAmount: 1 }]);
    const wbtcLot = result.lots.find((lot) => lot.asset === 'WBTC');
    expect(wbtcLot).toMatchObject({ amountOriginal: 0.9995, costBasisTotal: 5_000_000, sourceTxId: 'wrap' });
    expect(result.lots.some((lot) => lot.asset === 'BTC')).toBe(false);
    const reportRows = buildMatchedGainRows(result.disposals, result.lots, []);
    expect(reportRows.reduce((sum, row) => sum + row.proceeds, 0)).toBe(5_000_000);
    expect(reportRows[0]).toMatchObject({ status: 'missing_cost_basis', asset: 'BTC', costBasis: 0 });
  });

  it('does not confirm missing acquisition FMV as zero, while preserving explicit zero and mining basis', () => {
    const missing = run([tx({ id: 'missing', type: 'buy', fiatValue: undefined })]);
    expect(missing.lots).toHaveLength(0);
    expect(missing.flags).toContainEqual({ transactionId: 'missing', asset: 'BTC', reason: 'missing_market_value' });

    const explicitZero = run([tx({ id: 'zero', type: 'buy', fiatValue: 0 })]);
    expect(explicitZero.lots[0].costBasisTotal).toBe(0);

    const mining = run([tx({ id: 'mine-unpriced', type: 'income', category: 'mining', fiatValue: undefined })]);
    expect(mining.lots[0].costBasisTotal).toBe(0);
  });

  it('consumes inventory for an unpriced disposal without finalizing proceeds or gain', () => {
    const result = run([
      tx({ id: 'buy', type: 'buy', amount: 1, fiatValue: 100, timestamp: DAY }),
      tx({ id: 'sell-unpriced', type: 'sell', amount: 2, fiatValue: undefined, timestamp: 2 * DAY })
    ]);
    expect(result.disposals).toHaveLength(0);
    expect(result.inventoryDisposals).toHaveLength(1);
    expect(result.inventoryDisposals[0]).toMatchObject({ sourceTxId: 'sell-unpriced', amount: 2, costBasis: 100, finalized: false });
    expect(result.shortfalls).toEqual([{ transactionId: 'sell-unpriced', asset: 'BTC', unmatchedAmount: 1 }]);
    expect(result.lots[0].amountRemaining).toBe(0);
    expect(result.flags).toContainEqual({ transactionId: 'sell-unpriced', asset: 'BTC', reason: 'missing_market_value' });
  });

  it('keeps later FIFO sales correct after an earlier unpriced disposal consumes the oldest lot', () => {
    const result = run([
      tx({ id: 'buy-old', type: 'buy', amount: 1, fiatValue: 100, timestamp: DAY }),
      tx({ id: 'buy-new', type: 'buy', amount: 1, fiatValue: 300, timestamp: 2 * DAY }),
      tx({ id: 'sell-unpriced', type: 'sell', amount: 1, fiatValue: undefined, timestamp: 3 * DAY }),
      tx({ id: 'sell-priced', type: 'sell', amount: 1, fiatValue: 500, timestamp: 4 * DAY })
    ]);
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]).toMatchObject({ sourceTxId: 'sell-priced', costBasis: 300, proceeds: 500, gain: 200 });
    expect(result.inventoryDisposals.map((row) => row.finalized)).toEqual([false, true]);
    expect(result.lots.map((lot) => lot.amountRemaining)).toEqual([0, 0]);
    expect(buildMatchedGainRows(result.disposals, result.lots, []).map((row) => row.buyTxId)).toEqual(['buy-new']);
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
    expect(resZero.flags.some((f) => f.transactionId === 'z' && f.reason === 'invalid_transaction_data')).toBe(true);

    const resNeg = run([tx({ id: 'n', type: 'buy', amount: -1, fiatValue: 100, timestamp: 1 * DAY })]);
    expect(resNeg.lots).toHaveLength(0);
    expect(resNeg.flags.some((f) => f.transactionId === 'n' && f.reason === 'invalid_transaction_data')).toBe(true);

    const resNaN = run([tx({ id: 'x', type: 'buy', amount: 1, fiatValue: Infinity, timestamp: 1 * DAY })]);
    expect(resNaN.lots).toHaveLength(0);
    expect(resNaN.flags.some((f) => f.transactionId === 'x' && f.reason === 'missing_market_value')).toBe(true);
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

    it('excludes unsupported gift receipts from automatic lot creation', () => {
      const gift = run([
        tx({ id: 'g', type: 'gift_received', amount: 2, fiatValue: 500, timestamp: 1 * DAY }),
        tx({ id: 's', type: 'sell', amount: 2, fiatValue: 1500, timestamp: 2 * DAY })
      ]);
      expect(gift.lots).toEqual([]);
      expect(gift.disposals[0]).toMatchObject({ sourceTxId: 's', costBasis: 0, gain: 1500 });
      expect(gift.shortfalls).toMatchObject([{ transactionId: 's', unmatchedAmount: 2 }]);
    });

    it('airdrop-style income still opens at FMV-at-receipt', () => {
      const airdrop = run([
        tx({ id: 'a', type: 'income', category: 'airdrop', amount: 2, fiatValue: 500, timestamp: 1 * DAY }),
        tx({ id: 's', type: 'sell', amount: 2, fiatValue: 1500, timestamp: 2 * DAY })
      ]);
      expect(airdrop.disposals[0].costBasis).toBe(500);
      expect(airdrop.disposals[0].gain).toBe(1000);
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

    it('GEOD-style mining_reward (category mining_reward) opens a NORMAL FMV-cost lot, NOT zero-cost', () => {
      const { lots, disposals } = run([
        tx({ id: 'geod', type: 'income', category: 'mining_reward', amount: 1, fiatValue: 400, timestamp: 1 * DAY }),
        tx({ id: 'sell', type: 'sell', amount: 1, fiatValue: 1000, timestamp: 2 * DAY })
      ]);
      // Receipt-side income at FMV: cost of acquisition = FMV at receipt (400),
      // so the later sale is taxed only on the gain above that (not the full 1000).
      expect(lots[0].costBasisTotal).toBe(400);
      expect(disposals[0].costBasis).toBe(400);
      expect(disposals[0].gain).toBe(600);
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
