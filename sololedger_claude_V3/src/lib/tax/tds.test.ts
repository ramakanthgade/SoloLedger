import { describe, it, expect } from 'vitest';
import { aggregateTds } from './tds';
import type { Transaction } from '@/types/transaction';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: Date.UTC(2025, 5, 1), // June 2025 → FY2025 (IN)
    type: 'sell',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    source: 'wazirx_trades',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('aggregateTds', () => {
  it('sums only in-FY rows and totals the INR TDS', () => {
    const txs = [
      tx({ tdsInr: 100, timestamp: Date.UTC(2025, 5, 1) }),   // in FY2025
      tx({ tdsInr: 50, timestamp: Date.UTC(2025, 8, 15) }),   // in FY2025
      tx({ tdsInr: 999, timestamp: Date.UTC(2026, 5, 1) }),   // FY2026 — excluded
      tx({ tdsInr: 777, timestamp: Date.UTC(2024, 5, 1) })    // FY2024 — excluded
    ];
    const res = aggregateTds(txs, 2025, 'IN');
    expect(res.totalTdsInr).toBe(150);
    expect(res.rows).toHaveLength(2);
  });

  it('ignores rows with no positive INR TDS', () => {
    const txs = [
      tx({ tdsInr: undefined }),
      tx({ tdsInr: 0 }),
      tx({ tdsInr: 42 })
    ];
    const res = aggregateTds(txs, 2025, 'IN');
    expect(res.totalTdsInr).toBe(42);
    expect(res.rows).toHaveLength(1);
  });

  it('groups by exchange', () => {
    const txs = [
      tx({ tdsInr: 100, source: 'wazirx_trades' }),
      tx({ tdsInr: 25, source: 'wazirx_trades' }),
      tx({ tdsInr: 60, source: 'wazirx_ledger' })
    ];
    const res = aggregateTds(txs, 2025, 'IN');
    expect(res.byExchange).toEqual({ wazirx_trades: 125, wazirx_ledger: 60 });
  });

  it('groups by IST calendar month', () => {
    const txs = [
      tx({ tdsInr: 100, timestamp: Date.UTC(2025, 5, 10) }), // June 2025
      tx({ tdsInr: 40, timestamp: Date.UTC(2025, 5, 20) }),  // June 2025
      tx({ tdsInr: 30, timestamp: Date.UTC(2025, 6, 1) })    // July 2025
    ];
    const res = aggregateTds(txs, 2025, 'IN');
    expect(res.byMonth['2025-06']).toBe(140);
    expect(res.byMonth['2025-07']).toBe(30);
  });

  it('returns sorted rows oldest → newest', () => {
    const txs = [
      tx({ tdsInr: 10, timestamp: Date.UTC(2025, 7, 1) }),
      tx({ tdsInr: 20, timestamp: Date.UTC(2025, 5, 1) })
    ];
    const res = aggregateTds(txs, 2025, 'IN');
    expect(res.rows.map((r) => r.tdsInr)).toEqual([20, 10]);
  });
});
