import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { MatchedGainRow } from '@/lib/costBasis/matchedGains';
import { buildScheduleVdaReport } from '@/lib/reports/scheduleVDA';
import { aggregateTds } from '@/lib/tax/tds';
import {
  prettyExchangeLabel,
  allocateTdsToRows,
  buildScheduleVdaTableRows,
  sumScheduleVdaTotals,
  buildTdsExchangeRows,
  serializeTdsReconciliationCsv,
  INDIA_CEX_LABELS
} from './reportExports';

// ── Seeded fixtures ──────────────────────────────────────────────────────────
// FY 2025 (IN) = 1 Apr 2025 → 31 Mar 2026. All sells below fall in FY2025.

function matched(over: Partial<MatchedGainRow>): MatchedGainRow {
  const buyDate = over.buyDate ?? Date.UTC(2024, 5, 1);
  const sellDate = over.sellDate ?? Date.UTC(2025, 5, 1);
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
    method: over.method ?? 'FIFO'
  };
}

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    timestamp: over.timestamp ?? Date.UTC(2025, 5, 1),
    type: over.type ?? 'sell',
    asset: over.asset ?? 'BTC',
    amount: over.amount ?? 1,
    fiatCurrency: 'INR',
    source: over.source ?? 'coindcx',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('prettyExchangeLabel', () => {
  it('maps supported Indian CEX sources (with sheet suffixes) to friendly names', () => {
    expect(prettyExchangeLabel('wazirx_trades')).toBe('WazirX');
    expect(prettyExchangeLabel('coindcx')).toBe('CoinDCX');
    expect(prettyExchangeLabel('coinswitch_ledger')).toBe('CoinSwitch');
    expect(prettyExchangeLabel('zebpay_deposits')).toBe('ZebPay');
    expect(prettyExchangeLabel('mudrex')).toBe('Mudrex');
  });

  it('references all five MVP Indian exchanges', () => {
    expect(Object.values(INDIA_CEX_LABELS).sort()).toEqual(
      ['CoinDCX', 'CoinSwitch', 'Mudrex', 'WazirX', 'ZebPay']
    );
  });

  it('title-cases unknown sources as a fallback', () => {
    expect(prettyExchangeLabel('some_other_exchange')).toBe('Some Other Exchange');
  });
});

describe('allocateTdsToRows — per-lot split of per-transaction TDS', () => {
  it('splits a sale TDS across its matched lots proportional to proceeds', () => {
    const rows = [
      matched({ id: 's1:l1', sellTxId: 's1', proceeds: 60_000 }),
      matched({ id: 's1:l2', sellTxId: 's1', proceeds: 40_000 })
    ];
    const txs = [tx({ id: 's1', tdsInr: 1_000 })];
    const alloc = allocateTdsToRows(rows, txs, 2025, 'IN');
    // 60/40 split, last row absorbs rounding → totals to 1000 exactly.
    expect(alloc['s1:l1']).toBeCloseTo(600, 6);
    expect(alloc['s1:l2']).toBeCloseTo(400, 6);
    expect(alloc['s1:l1'] + alloc['s1:l2']).toBeCloseTo(1_000, 6);
  });

  it('assigns 0 when the sale transaction carries no TDS', () => {
    const rows = [matched({ id: 's2:l1', sellTxId: 's2' })];
    const alloc = allocateTdsToRows(rows, [tx({ id: 's2' })], 2025, 'IN');
    expect(alloc['s2:l1']).toBe(0);
  });

  it('excludes rows whose transfer is outside the FY', () => {
    const rows = [matched({ id: 'next:l1', sellTxId: 'next', sellDate: Date.UTC(2026, 5, 1) })];
    const alloc = allocateTdsToRows(rows, [tx({ id: 'next', tdsInr: 500 })], 2025, 'IN');
    expect(alloc['next:l1']).toBeUndefined();
  });
});

describe('Schedule VDA table shaping (seeded fixture snapshot)', () => {
  const rows = [
    matched({ id: 'btc:1', asset: 'BTC', sellTxId: 'sBTC', buyDate: Date.UTC(2025, 0, 15), sellDate: Date.UTC(2025, 4, 8), costBasis: 1_240_000, proceeds: 1_860_000, gain: 620_000 }),
    matched({ id: 'eth:1', asset: 'ETH', sellTxId: 'sETH', buyDate: Date.UTC(2025, 1, 1), sellDate: Date.UTC(2025, 5, 21), costBasis: 980_000, proceeds: 1_245_000, gain: 265_000 }),
    matched({ id: 'matic:1', asset: 'MATIC', sellTxId: 'sMATIC', buyDate: Date.UTC(2025, 7, 18), sellDate: Date.UTC(2025, 10, 14), costBasis: 560_000, proceeds: 410_000, gain: -150_000 })
  ];
  const txs = [
    tx({ id: 'sBTC', source: 'coindcx', timestamp: Date.UTC(2025, 4, 8), tdsInr: 18_600 }),
    tx({ id: 'sETH', source: 'wazirx_trades', timestamp: Date.UTC(2025, 5, 21), tdsInr: 12_450 }),
    tx({ id: 'sMATIC', source: 'zebpay', timestamp: Date.UTC(2025, 10, 14), tdsInr: 4_100 })
  ];

  it('builds display rows joined with allocated TDS and matches the fixture', () => {
    const tds = aggregateTds(txs, 2025, 'IN');
    const report = buildScheduleVdaReport(rows, tds.totalTdsInr, 2025, 'IN', 124_000);
    const alloc = allocateTdsToRows(rows, txs, 2025, 'IN');
    const table = buildScheduleVdaTableRows(report, alloc);

    expect(table.map((r) => ({
      asset: r.asset,
      acq: r.acquisitionDateKey,
      xfer: r.transferDateKey,
      cost: r.costOfAcquisition,
      cons: r.considerationReceived,
      gain: r.incomeGain,
      tds: r.tdsInr
    }))).toEqual([
      { asset: 'BTC', acq: '2025-01-15', xfer: '2025-05-08', cost: 1_240_000, cons: 1_860_000, gain: 620_000, tds: 18_600 },
      { asset: 'ETH', acq: '2025-02-01', xfer: '2025-06-21', cost: 980_000, cons: 1_245_000, gain: 265_000, tds: 12_450 },
      { asset: 'MATIC', acq: '2025-08-18', xfer: '2025-11-14', cost: 560_000, cons: 410_000, gain: -150_000, tds: 4_100 }
    ]);
  });

  it('totals the table columns', () => {
    const tds = aggregateTds(txs, 2025, 'IN');
    const report = buildScheduleVdaReport(rows, tds.totalTdsInr, 2025, 'IN');
    const totals = sumScheduleVdaTotals(buildScheduleVdaTableRows(report, allocateTdsToRows(rows, txs, 2025, 'IN')));
    expect(totals).toEqual({
      costOfAcquisition: 2_780_000,
      considerationReceived: 3_515_000,
      incomeGain: 735_000,
      tdsInr: 35_150
    });
  });
});

describe('TDS reconciliation shaping + CSV (seeded fixture snapshot)', () => {
  const txs = [
    tx({ id: 't1', source: 'coindcx', timestamp: Date.UTC(2025, 4, 8), tdsInr: 18_600 }),
    tx({ id: 't2', source: 'coindcx', timestamp: Date.UTC(2026, 1, 11), tdsInr: 1_850 }),
    tx({ id: 't3', source: 'wazirx_trades', timestamp: Date.UTC(2025, 5, 21), tdsInr: 12_450 }),
    tx({ id: 't4', source: 'zebpay', timestamp: Date.UTC(2025, 10, 14), tdsInr: 4_100 })
  ];

  it('aggregates per-exchange rows sorted by TDS desc', () => {
    const recon = aggregateTds(txs, 2025, 'IN');
    const rows = buildTdsExchangeRows(recon);
    expect(rows.map((r) => ({ label: r.label, deductions: r.deductions, tds: r.tdsInr }))).toEqual([
      { label: 'CoinDCX', deductions: 2, tds: 20_450 },
      { label: 'WazirX', deductions: 1, tds: 12_450 },
      { label: 'ZebPay', deductions: 1, tds: 4_100 }
    ]);
  });

  it('serializes import-side CSV with a compare prompt and no 26AS status columns', () => {
    const recon = aggregateTds(txs, 2025, 'IN');
    const csv = serializeTdsReconciliationCsv(recon, 'FY 2025-26');
    expect(csv).toContain('exchange,deductions,tds_in_your_imports_inr');
    expect(csv).toContain('CoinDCX,2,20450');
    expect(csv).toMatch(/# Total TDS in your imports \(Section 194S\): 37000/);
    expect(csv).toMatch(/Compare it with your Form 26AS/);
    // No machine-computed matching statuses in the MVP export.
    expect(csv).not.toMatch(/Matched|Mismatch|Not in 26AS/);
  });

  it('appends user-supplied 26AS columns only when the user entered amounts', () => {
    const recon = aggregateTds(txs, 2025, 'IN');
    const csv = serializeTdsReconciliationCsv(recon, 'FY 2025-26', { coindcx: 20_450, wazirx_trades: 12_450 });
    expect(csv).toContain('form_26as_amount_inr_user_entered');
    expect(csv).toContain('delta_inr_user_supplied');
    // CoinDCX matches (delta 0), so the delta column is 0 for that row.
    expect(csv).toMatch(/CoinDCX,2,20450,20450,0/);
    expect(csv).toMatch(/amounts YOU entered — not verified by this app/);
  });
});
