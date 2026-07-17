import { describe, it, expect } from 'vitest';
import { summarizeYear } from './jurisdictions';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import type { Disposal } from '@/types/transaction';

const DAY = 86_400_000;

let seq = 0;
function row(overrides: Partial<MatchedGainRow>): MatchedGainRow {
  seq += 1;
  const proceeds = overrides.proceeds ?? 0;
  const costBasis = overrides.costBasis ?? 0;
  return {
    id: overrides.id ?? `r${seq}`,
    asset: overrides.asset ?? 'BTC',
    sellDate: overrides.sellDate ?? Date.UTC(2024, 5, 1),
    sellAmount: overrides.sellAmount ?? 1,
    proceeds,
    sellTxId: overrides.sellTxId ?? `sell${seq}`,
    buyDate: overrides.buyDate ?? Date.UTC(2023, 5, 1),
    buyAmount: overrides.buyAmount ?? 1,
    costBasis,
    buyTxId: overrides.buyTxId ?? `buy${seq}`,
    gain: overrides.gain ?? proceeds - costBasis,
    holdingDays: overrides.holdingDays ?? 0,
    method: overrides.method ?? 'FIFO',
    status: overrides.status ?? 'matched'
  };
}

/** A disposal whose disposedAt drives disposalsCount (per-lot splits come from rows). */
function disposal(overrides: Partial<Disposal>): Disposal {
  seq += 1;
  return {
    id: overrides.id ?? `d${seq}`,
    asset: overrides.asset ?? 'BTC',
    disposedAt: overrides.disposedAt ?? Date.UTC(2024, 5, 1),
    amount: overrides.amount ?? 1,
    proceeds: overrides.proceeds ?? 0,
    costBasis: overrides.costBasis ?? 0,
    gain: overrides.gain ?? 0,
    holdingPeriodDays: overrides.holdingPeriodDays ?? 0,
    lotConsumption: overrides.lotConsumption ?? [],
    sourceTxId: overrides.sourceTxId ?? `tx${seq}`,
    method: overrides.method ?? 'FIFO'
  };
}

describe('summarizeYear — India no-offset (Section 115BBH)', () => {
  it('taxes gains only and records the loss as disallowed, never netted', () => {
    // FY 2024-25 (IN) → sells in, e.g., May 2024.
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      row({ proceeds: 300, costBasis: 100, sellDate }), // gain +200
      row({ proceeds: 50, costBasis: 150, sellDate })   // loss -100
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'IN');

    expect(s.totalGains).toBe(200);
    expect(s.totalLosses).toBe(100);
    expect(s.disallowedLosses).toBe(100);
    // Taxable = positive gains only, NOT netted to 100.
    expect(s.totalGain).toBe(200);
  });

  it('does NOT raise incomeGiftTreatmentLimited for IN income lots (B9a — treatment validated)', () => {
    const ts = Date.UTC(2024, 5, 1);
    // Before B9a this was `true`; the 56(2)(x)/115BBH treatment is now validated
    // from primary sources, so the flag is cleared (never raised).
    const withIncome = summarizeYear([], [], [{ fiatValue: 500, timestamp: ts }], 2024, 'IN');
    expect(withIncome.incomeGiftTreatmentLimited).toBe(false);

    const noIncome = summarizeYear([], [], [], 2024, 'IN');
    expect(noIncome.incomeGiftTreatmentLimited).toBe(false);
  });

  it('surfaces vdaReceiptIncome (Sec 56(2)(x) slab-rate income) summed over in-FY events for IN', () => {
    const inFy = Date.UTC(2024, 5, 1);   // within FY 2024-25 (IN)
    const outOfFy = Date.UTC(2023, 5, 1); // prior FY — excluded
    const s = summarizeYear(
      [],
      [],
      [
        { fiatValue: 500, timestamp: inFy },
        { fiatValue: 250, timestamp: inFy },
        { fiatValue: 999, timestamp: outOfFy }
      ],
      2024,
      'IN'
    );
    expect(s.vdaReceiptIncome).toBe(750); // 500 + 250; out-of-FY excluded
  });

  it('leaves vdaReceiptIncome undefined for non-IN jurisdictions', () => {
    const ts = Date.UTC(2024, 5, 1);
    const s = summarizeYear([], [], [{ fiatValue: 500, timestamp: ts }], 2024, 'US');
    expect(s.vdaReceiptIncome).toBeUndefined();
  });
});

describe('summarizeYear — offset jurisdictions net gains and losses', () => {
  it('US nets gain and loss and leaves disallowedLosses undefined', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      row({ proceeds: 300, costBasis: 100, sellDate }), // +200
      row({ proceeds: 50, costBasis: 150, sellDate })   // -100
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'US');
    expect(s.totalGain).toBe(100); // netted
    expect(s.disallowedLosses).toBeUndefined();
    expect(s.totalGains).toBe(200);
    expect(s.totalLosses).toBe(100);
  });
});

describe('summarizeYear — per-lot ST/LT split (US, exact calendar)', () => {
  it('splits a multi-lot disposal across the one-year boundary per lot', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      // held ~2 years → long-term
      row({ proceeds: 300, costBasis: 100, buyDate: Date.UTC(2022, 5, 1), sellDate }),
      // held ~1 month → short-term
      row({ proceeds: 120, costBasis: 100, buyDate: Date.UTC(2024, 4, 1), sellDate })
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'US');
    expect(s.longTermGain).toBe(200);
    expect(s.shortTermGain).toBe(20);
  });

  it('US: exactly 365 days (anniversary) is still short-term (>1yr rule)', () => {
    const buyDate = Date.UTC(2023, 0, 1);
    const sellDate = addExactYears(buyDate, 1); // Jan 1 2024, the one-year anniversary
    const rows = [row({ proceeds: 200, costBasis: 100, buyDate, sellDate })];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'US');
    expect(s.shortTermGain).toBe(100);
    expect(s.longTermGain).toBe(0);
  });

  it('US: one day past the anniversary is long-term', () => {
    const buyDate = Date.UTC(2023, 0, 1);
    const sellDate = addExactYears(buyDate, 1) + DAY; // Jan 2 2024
    const rows = [row({ proceeds: 200, costBasis: 100, buyDate, sellDate })];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'US');
    expect(s.longTermGain).toBe(100);
    expect(s.shortTermGain).toBe(0);
  });

  it('handles a Feb-29 leap-year acquisition via addYears (366 days → LT)', () => {
    const buyDate = Date.UTC(2020, 1, 29); // Feb 29 2020 (leap year)
    // addYears(Feb 29 2020, 1) = Feb 28 2021; anniversary is 365 days later.
    // A sale on Mar 1 2021 (366 days) is strictly past → long-term for US.
    const sellDate = Date.UTC(2021, 2, 1);
    const rows = [row({ proceeds: 200, costBasis: 100, buyDate, sellDate })];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2021, 'US');
    expect(s.longTermGain).toBe(100);
    expect(s.shortTermGain).toBe(0);
  });
});

describe('summarizeYear — unmatched (missing cost basis) rows in totals', () => {
  it('IN: a fully-unmatched zero-cost row puts full proceeds in the taxable base and flags review', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      row({ proceeds: 500, costBasis: 0, gain: 500, sellDate, status: 'missing_cost_basis' })
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'IN');
    expect(s.totalGain).toBe(500);       // taxed in full
    expect(s.totalGains).toBe(500);
    expect(s.reviewRequiredCount).toBe(1);
  });

  it('IN: a partially-matched disposal includes both the matched gain and the unmatched proceeds', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      row({ proceeds: 300, costBasis: 100, gain: 200, sellDate, status: 'matched' }),
      row({ proceeds: 300, costBasis: 0, gain: 300, sellDate, status: 'missing_cost_basis' })
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'IN');
    expect(s.totalGain).toBe(500);       // 200 matched + 300 unmatched, taxed
    expect(s.reviewRequiredCount).toBe(1);
  });
});

describe('summarizeYear — Canada 50% inclusion applied to the taxable base', () => {
  it('applies inclusion to the net gain', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [
      row({ proceeds: 1000, costBasis: 200, sellDate }), // +800
      row({ proceeds: 100, costBasis: 300, sellDate })   // -200
    ];
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'CA');
    expect(s.inclusionRate).toBe(0.5);
    expect(s.totalGain).toBe(600);           // net (offset allowed): 800 − 200
    expect(s.taxableGain).toBe(300);         // 50% inclusion of the net gain
    // Raw gains/losses preserved for display.
    expect(s.totalGains).toBe(800);
    expect(s.totalLosses).toBe(200);
  });

  it('a net loss yields a zero taxable base (no negative inclusion)', () => {
    const sellDate = Date.UTC(2024, 5, 1);
    const rows = [row({ proceeds: 100, costBasis: 500, sellDate })]; // -400
    const s = summarizeYear([disposal({ disposedAt: sellDate })], rows, [], 2024, 'CA');
    expect(s.totalGain).toBe(-400);
    expect(s.taxableGain).toBe(0);
  });
});

describe('summarizeYear — receipt-side income (Sec 56(2)(x))', () => {
  it('derives vdaReceiptIncome from typed receipt events (mining excluded upstream)', () => {
    const ts = Date.UTC(2024, 5, 1);
    // Caller supplies receipt events with mining already excluded.
    const s = summarizeYear([], [], [], 2024, 'IN', {
      receiptIncomeEvents: [
        { fiatValue: 1000, timestamp: ts }, // gift/airdrop/staking
        { fiatValue: 500, timestamp: ts }
      ]
    });
    expect(s.vdaReceiptIncome).toBe(1500);
  });

  it('prefers receiptIncomeEvents over the legacy incomeEvents for vdaReceiptIncome', () => {
    const ts = Date.UTC(2024, 5, 1);
    const s = summarizeYear(
      [],
      [],
      [{ fiatValue: 9999, timestamp: ts }], // legacy income (would include mining)
      2024,
      'IN',
      { receiptIncomeEvents: [{ fiatValue: 700, timestamp: ts }] }
    );
    expect(s.vdaReceiptIncome).toBe(700);
  });
});

/** Local helper mirroring date-fns addYears for building exact boundaries in tests. */
function addExactYears(ts: number, years: number): number {
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + years);
  return d.getTime();
}
