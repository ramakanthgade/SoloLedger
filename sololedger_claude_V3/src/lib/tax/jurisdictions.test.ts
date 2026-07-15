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
    method: overrides.method ?? 'FIFO'
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

  it('sets incomeGiftTreatmentLimited when IN income lots present', () => {
    const ts = Date.UTC(2024, 5, 1);
    const withIncome = summarizeYear([], [], [{ fiatValue: 500, timestamp: ts }], 2024, 'IN');
    expect(withIncome.incomeGiftTreatmentLimited).toBe(true);

    const noIncome = summarizeYear([], [], [], 2024, 'IN');
    expect(noIncome.incomeGiftTreatmentLimited).toBeUndefined();
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

/** Local helper mirroring date-fns addYears for building exact boundaries in tests. */
function addExactYears(ts: number, years: number): number {
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + years);
  return d.getTime();
}
