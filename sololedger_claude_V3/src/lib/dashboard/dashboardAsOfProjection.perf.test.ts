import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { PriceCacheRow } from '@/lib/storage/db';
import { projectDashboardAsOf } from './dashboardAsOfProjection';

const DAY = 86_400_000;
const ASSET_COUNT = 30;
const TRANSACTIONS_PER_ASSET = 40;
const SAMPLE_COUNT = 72;
const START = Date.UTC(2025, 3, 1);
const END = Date.UTC(2026, 2, 31);
const NOW = END + DAY;

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

function samples(): number[] {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) =>
    Math.floor((START + ((END - START) * index) / (SAMPLE_COUNT - 1)) / DAY) * DAY);
}

function fixture(): {
  transactions: Transaction[];
  priceCache: PriceCacheRow[];
  chartSamples: number[];
} {
  const transactions: Transaction[] = [];
  const chartSamples = samples();
  const priceCache: PriceCacheRow[] = [];

  for (let assetIndex = 0; assetIndex < ASSET_COUNT; assetIndex += 1) {
    const asset = `ASSET${assetIndex}`;
    for (let index = 0; index < TRANSACTIONS_PER_ASSET; index += 1) {
      const timestamp = START + ((assetIndex * 13 + index * 7) % 320) * DAY + assetIndex * 1_000;
      const acquisition = index < 28;
      transactions.push({
        id: `${asset}:${index}`,
        timestamp,
        type: acquisition ? 'buy' : 'sell',
        asset,
        amount: acquisition ? 2 : 1,
        fiatCurrency: 'INR',
        fiatValue: (assetIndex + 1) * (acquisition ? 200 : 140),
        source: 'manual',
        flags: [],
        isInternalTransfer: false
      });
    }
    for (const sample of chartSamples) {
      priceCache.push({
        key: `sym:${asset}:${dateKey(sample)}:INR`,
        price: 100 + assetIndex * 3 + (sample - START) / DAY / 10,
        fetchedAt: sample + 60_000
      });
    }
  }

  return { transactions, priceCache, chartSamples };
}

describe('Dashboard as-of pure projection performance', () => {
  it('projects a large deterministic ledger and 72-point chart without persistence reads', () => {
    const input = fixture();
    const startedAt = performance.now();
    const output = projectDashboardAsOf({
      ...input,
      exchangeConnections: [],
      openingBalances: [],
      authoritySnapshots: [],
      authorityAssets: [],
      sourceCoverage: [],
      settings: {
        jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO',
        priceApiEnabled: false, rpcLookupEnabled: false
      },
      nominalStart: START,
      nominalEnd: END,
      effectiveEnd: END,
      nowMs: NOW,
      specIdHints: {},
      safetyDecisions: []
    });
    const elapsed = performance.now() - startedAt;

    expect(input.transactions).toHaveLength(ASSET_COUNT * TRANSACTIONS_PER_ASSET);
    expect(input.priceCache).toHaveLength(ASSET_COUNT * SAMPLE_COUNT);
    expect(output.chart).toHaveLength(SAMPLE_COUNT);
    expect(output.chart.every((point) => point.timestamp <= END)).toBe(true);
    expect(output.contributors).toHaveLength(ASSET_COUNT);
    expect(output.totalNetWorth.value).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  });
});
