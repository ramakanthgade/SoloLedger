import { describe, it, expect } from 'vitest';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import {
  buildScheduleVdaRows,
  buildScheduleVdaEstimate,
  buildScheduleVdaReport,
  serializeScheduleVdaCsv
} from './scheduleVDA';

function row(over: Partial<MatchedGainRow>): MatchedGainRow {
  const buyDate = over.buyDate ?? Date.UTC(2024, 5, 1); // June 2024
  const sellDate = over.sellDate ?? Date.UTC(2025, 5, 1); // June 2025 → FY2025 (IN)
  const proceeds = over.proceeds ?? 100_000;
  const costBasis = over.costBasis ?? 60_000;
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    asset: over.asset ?? 'BTC',
    chain: over.chain,
    sellDate,
    sellAmount: over.sellAmount ?? 1,
    proceeds,
    sellTxId: over.sellTxId ?? 'sell-tx',
    buyDate,
    buyAmount: over.buyAmount ?? 1,
    costBasis,
    buyTxId: over.buyTxId ?? 'buy-tx',
    gain: over.gain ?? proceeds - costBasis,
    holdingDays: over.holdingDays ?? 365,
    method: over.method ?? 'FIFO',
    status: over.status ?? 'matched'
  };
}

describe('buildScheduleVdaRows — 1:1 map to matched lots', () => {
  it('maps acquisition/transfer dates and cost/consideration/income per lot', () => {
    const rows = buildScheduleVdaRows(
      [
        row({ id: 'a:1', asset: 'ETH', buyDate: Date.UTC(2024, 6, 10), sellDate: Date.UTC(2025, 8, 5), costBasis: 20_000, proceeds: 35_000, gain: 15_000 })
      ],
      2025,
      'IN'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'a:1',
      asset: 'ETH',
      acquisitionDate: Date.UTC(2024, 6, 10),
      transferDate: Date.UTC(2025, 8, 5),
      costOfAcquisition: 20_000,
      considerationReceived: 35_000,
      incomeGain: 15_000,
      status: 'matched'
    });
  });

  it('scopes to the financial year by transfer (sell) date', () => {
    const rows = buildScheduleVdaRows(
      [
        row({ id: 'in', sellDate: Date.UTC(2025, 5, 1) }),   // FY2025
        row({ id: 'next', sellDate: Date.UTC(2026, 5, 1) }), // FY2026 — excluded
        row({ id: 'prev', sellDate: Date.UTC(2024, 5, 1) })  // FY2024 — excluded
      ],
      2025,
      'IN'
    );
    expect(rows.map((r) => r.id)).toEqual(['in']);
  });
});

describe('buildScheduleVdaEstimate — 30% + 4% cess with TDS offset', () => {
  it('taxes positive gains × 0.312 and excludes disallowed losses', () => {
    const rows = buildScheduleVdaRows(
      [
        row({ id: 'g1', gain: 100_000 }),
        row({ id: 'g2', gain: 50_000 }),
        row({ id: 'l1', proceeds: 10_000, costBasis: 40_000, gain: -30_000 }) // disallowed loss
      ],
      2025,
      'IN'
    );
    const est = buildScheduleVdaEstimate(rows, 12_000);
    // taxable base = 150_000 (loss excluded)
    expect(est.taxableGains).toBe(150_000);
    expect(est.disallowedLosses).toBe(30_000);
    expect(est.tax).toBe(45_000); // 30%
    expect(est.cess).toBe(1_800); // 4% of tax
    expect(est.estimatedLiability).toBeCloseTo(150_000 * 0.312, 6);
    expect(est.tdsOffset).toBe(12_000);
    expect(est.netAfterTdsOffset).toBeCloseTo(150_000 * 0.312 - 12_000, 6);
  });

  it('offset equals the aggregateTds total supplied by the caller', () => {
    const rows = buildScheduleVdaRows([row({ gain: 100_000 })], 2025, 'IN');
    expect(buildScheduleVdaEstimate(rows, 999).tdsOffset).toBe(999);
    expect(buildScheduleVdaEstimate(rows, 0).tdsOffset).toBe(0);
  });

  it('produces a zero estimate when there are no positive gains', () => {
    const rows = buildScheduleVdaRows(
      [row({ proceeds: 10_000, costBasis: 30_000, gain: -20_000 })],
      2025,
      'IN'
    );
    const est = buildScheduleVdaEstimate(rows, 0);
    expect(est.taxableGains).toBe(0);
    expect(est.estimatedLiability).toBe(0);
    expect(est.disallowedLosses).toBe(20_000);
  });
});

describe('buildScheduleVdaReport + CSV', () => {
  it('surfaces vdaReceiptIncome and factual notes without a limited-handling banner', () => {
    const report = buildScheduleVdaReport(
      [row({ id: 'x:1', gain: 100_000 })],
      5_000,
      2025,
      'IN',
      7_777
    );
    expect(report.rows).toHaveLength(1);
    expect(report.vdaReceiptIncome).toBe(7_777);
    expect(report.estimate.tdsOffset).toBe(5_000);

    const joined = report.notes.join(' ');
    // Factual statutory notes ARE present
    expect(joined).toMatch(/cost of acquisition/i);
    expect(joined).toMatch(/115BBH/);
    expect(joined).toMatch(/56\(2\)\(x\)/);
    // No "limited handling — validate with your CA" banner (B9a cleared it)
    expect(joined).not.toMatch(/limited/i);
    expect(joined).not.toMatch(/validate with your CA/i);
  });

  it('serializes raw-decimal rows plus a labelled estimate + notes', () => {
    const report = buildScheduleVdaReport(
      [
        row({
          id: 'x:1',
          asset: 'BTC',
          buyDate: Date.UTC(2024, 5, 1),
          sellDate: Date.UTC(2025, 5, 1),
          costBasis: 60_000.123456,
          proceeds: 100_000.5,
          gain: 40_000.376544
        })
      ],
      1_000,
      2025,
      'IN',
      500
    );
    const csv = serializeScheduleVdaCsv(report);
    expect(csv).toContain('date_of_acquisition,date_of_transfer,asset');
    // raw decimals, no rounding
    expect(csv).toContain('60000.123456');
    expect(csv).toContain('100000.5');
    // labelled estimate + offset lines
    expect(csv).toMatch(/# Tax @ 30%/);
    expect(csv).toMatch(/# Less: TDS withheld \(Section 194S\) — offset: 1000/);
    expect(csv).toMatch(/# VDA receipt income \(Section 56\(2\)\(x\)/);
    // non-advice + no limited banner
    expect(csv).toMatch(/non-advice estimate/i);
    expect(csv).not.toMatch(/limited/i);
  });

  it('threads missing_cost_basis status into rows and counts them in the estimate + CSV', () => {
    const matched = row({ id: 'd:lotA', proceeds: 100_000, costBasis: 60_000, gain: 40_000, status: 'matched' });
    const unmatched = row({
      id: 'd:unmatched',
      proceeds: 50_000,
      costBasis: 0,
      gain: 50_000,
      status: 'missing_cost_basis'
    });
    const rows = buildScheduleVdaRows([matched, unmatched], 2025, 'IN');
    expect(rows.find((r) => r.id === 'd:unmatched')?.status).toBe('missing_cost_basis');

    const estimate = buildScheduleVdaEstimate(rows, 0);
    // Unmatched proceeds are taxed in full: taxable base = 40k + 50k.
    expect(estimate.taxableGains).toBe(90_000);
    expect(estimate.reviewRequiredCount).toBe(1);

    const report = buildScheduleVdaReport([matched, unmatched], 0, 2025, 'IN');
    const csv = serializeScheduleVdaCsv(report);
    expect(csv).toMatch(/# REVIEW REQUIRED/);
  });

  it('IST date keys reflect the +05:30 civil calendar', () => {
    // 2025-03-31T20:00Z is 2025-04-01 01:30 IST → belongs to the next IST day
    const report = buildScheduleVdaReport(
      [row({ id: 'd:1', buyDate: Date.UTC(2024, 5, 1), sellDate: Date.UTC(2025, 5, 15, 20, 0, 0) })],
      0,
      2025,
      'IN'
    );
    const csv = serializeScheduleVdaCsv(report);
    // sellDate 2025-06-15T20:00Z → 2025-06-16 01:30 IST
    expect(csv).toContain('2025-06-16');
  });
});
