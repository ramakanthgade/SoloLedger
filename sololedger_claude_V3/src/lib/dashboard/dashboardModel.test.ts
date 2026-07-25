import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { PriceCacheRow } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import {
  allocationSlices,
  buildChartSeries,
  buildInsights,
  buildPriceIndex,
  formatRelativeTime,
  itrDeadline,
  latestSyncAt,
  moneyStrip,
  periodRange,
  priceAt,
  sourceBreakdown,
  valueHoldings
} from './dashboardModel';

const DAY = 86_400_000;
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12, 0, 0);
/** dd-mm-yyyy (UTC) cache-key date fragment, matching toCoinGeckoDate. */
const keyDate = (ts: number) => {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
};

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? `t-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: day(2026, 5, 1),
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'INR',
    source: 'manual',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

function priceRow(key: string, price: number): PriceCacheRow {
  return { key, price, fetchedAt: Date.now() };
}

describe('buildPriceIndex', () => {
  it('indexes sym rows by symbol in the matching currency, ascending', () => {
    const index = buildPriceIndex(
      [
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 10))}:INR`, 100),
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 1))}:INR`, 90),
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 5))}:USD`, 50), // other currency — dropped
        priceRow('sym:BTC:not-a-date:INR', 1), // malformed — dropped
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 3))}:INR`, 0) // non-positive — dropped
      ],
      'INR'
    );
    const btc = index.bySymbol.get('BTC');
    expect(btc?.map((p) => p.price)).toEqual([90, 100]);
    expect(btc?.[0].dateMs).toBe(Date.UTC(2026, 6, 1));
  });

  it('indexes ctr rows under platform:contract', () => {
    const index = buildPriceIndex(
      [priceRow(`ctr:solana:${'A'.repeat(44).toLowerCase()}:${keyDate(day(2026, 7, 2))}:INR`, 7)],
      'INR'
    );
    expect(index.byContract.get(`solana:${'a'.repeat(44)}`)?.[0].price).toBe(7);
  });
});

describe('priceAt', () => {
  const points = [
    { dateMs: day(2026, 7, 1), price: 10 },
    { dateMs: day(2026, 7, 10), price: 20 }
  ];
  it('returns the last close at or before ts (step interpolation)', () => {
    expect(priceAt(points, day(2026, 7, 5))).toBe(10);
    expect(priceAt(points, day(2026, 7, 10))).toBe(20);
    expect(priceAt(points, day(2026, 8, 1))).toBe(20);
  });
  it('returns null before the first cached close', () => {
    expect(priceAt(points, day(2026, 6, 1))).toBeNull();
  });
});

describe('valueHoldings', () => {
  const holdings = [
    { asset: 'BTC', amount: 2, costBasis: 100 },
    { asset: 'DOGE', amount: 50, costBasis: 10 }
  ];
  it('values priced holdings and leaves unpriced ones null', () => {
    const index = buildPriceIndex(
      [
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 24))}:INR`, 80),
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 23))}:INR`, 70)
      ],
      'INR'
    );
    const [btc, doge] = valueHoldings(holdings, index);
    expect(btc.priceNow).toBe(80);
    expect(btc.valueNow).toBe(160);
    expect(btc.unrealized).toBe(60);
    expect(btc.unrealizedPct).toBeCloseTo(60);
    expect(btc.avgCost).toBe(50);
    // The two latest closes sit ~24h apart → an honest 24h change figure.
    expect(btc.dayChangePct).toBeCloseTo(((80 - 70) / 70) * 100);
    expect(doge.priceNow).toBeNull();
    expect(doge.valueNow).toBeNull();
    expect(doge.unrealized).toBeNull();
  });

  it('omits the 24h figure when the previous close is not ~24h away', () => {
    const index = buildPriceIndex(
      [
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 24))}:INR`, 80),
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 1))}:INR`, 70)
      ],
      'INR'
    );
    expect(valueHoldings([holdings[0]], index)[0].dayChangePct).toBeNull();
  });
});

describe('periodRange', () => {
  it('FY (IN) starts at the Apr 1 IST boundary with an honest caption', () => {
    const now = day(2026, 7, 25);
    const range = periodRange('FY', 'IN', now, null);
    expect(range.sinceCaption).toContain('FY 2026-27');
    expect(range.start).toBe(Date.UTC(2026, 3, 1) - (5 * 60 + 30) * 60 * 1000);
    expect(range.end).toBe(now);
  });
  it('ALL starts at the first transaction', () => {
    const first = day(2025, 11, 3);
    expect(periodRange('ALL', 'IN', day(2026, 7, 25), first).start).toBe(first);
  });
  it('1M spans 30 days', () => {
    const now = day(2026, 7, 25);
    expect(periodRange('1M', 'IN', now, null).start).toBe(now - 30 * DAY);
  });
});

describe('buildChartSeries', () => {
  const txs = [
    tx({ id: 'b1', timestamp: day(2026, 4, 1), asset: 'BTC', amount: 1, fiatValue: 100 }),
    tx({ id: 'b2', timestamp: day(2026, 5, 1), asset: 'BTC', amount: 1, fiatValue: 120 }),
    tx({ id: 's1', timestamp: day(2026, 6, 1), type: 'sell', asset: 'BTC', amount: 0.5, fiatValue: 80 })
  ];

  it('builds cumulative cost from the portfolio engine, final point = current holdings', () => {
    const index = buildPriceIndex([], 'INR');
    const series = buildChartSeries(txs, index, day(2026, 4, 1), day(2026, 6, 15));
    expect(series.length).toBeGreaterThan(10);
    expect(series[0].cost).toBe(100);
    expect(series.every((p) => p.market == null)).toBe(true);
    const last = series[series.length - 1];
    // 1.5 BTC held: cost 220 − 0.5 × avg(110) = 165.
    expect(last.cost).toBeCloseTo(165);
  });

  it('values the market line at last cached close ≤ day, counting unpriced assets', () => {
    const index = buildPriceIndex(
      [
        priceRow(`sym:BTC:${keyDate(day(2026, 4, 15))}:INR`, 200),
        priceRow(`sym:BTC:${keyDate(day(2026, 6, 10))}:INR`, 300)
      ],
      'INR'
    );
    const series = buildChartSeries(txs, index, day(2026, 4, 1), day(2026, 6, 15));
    // Before the first cached close nothing is priced.
    const early = series.find((p) => p.t < day(2026, 4, 15));
    expect(early?.market ?? null).toBeNull();
    // After: market = qty × last close ≤ day.
    const mid = series.find((p) => p.t >= day(2026, 4, 15) && p.market != null);
    expect(mid?.market).toBeCloseTo(200); // 1 BTC × 200
    const last = series[series.length - 1];
    expect(last.market).toBeCloseTo(1.5 * 300);
    expect(last.unpricedCount).toBe(0);
  });
});

describe('moneyStrip', () => {
  it('buckets period flows and realized gains, skipping spam and out-of-range rows', () => {
    const start = day(2026, 4, 1);
    const end = day(2026, 7, 25);
    const txs = [
      tx({ id: 'in', timestamp: day(2026, 5, 1), type: 'buy', fiatValue: 1000 }),
      tx({ id: 'out', timestamp: day(2026, 6, 1), type: 'sell', fiatValue: 1500 }),
      tx({ id: 'inc', timestamp: day(2026, 6, 2), type: 'income', asset: 'ETH', fiatValue: 40 }),
      tx({ id: 'fee', timestamp: day(2026, 6, 3), type: 'fee', fiatValue: 5 }),
      tx({ id: 'old', timestamp: day(2025, 1, 1), type: 'buy', fiatValue: 9999 }), // out of range
      tx({ id: 'spam', timestamp: day(2026, 6, 4), type: 'buy', fiatValue: 777, isSpam: true })
    ];
    const { disposals } = calculateCostBasis(
      [
        tx({ id: 'cb-b', timestamp: day(2026, 4, 2), type: 'buy', amount: 1, fiatValue: 100 }),
        tx({ id: 'cb-s', timestamp: day(2026, 6, 5), type: 'sell', amount: 1, fiatValue: 160 })
      ],
      { method: 'FIFO' }
    );
    const strip = moneyStrip(txs, disposals, start, end);
    expect(strip.moneyIn).toBe(1000);
    expect(strip.moneyOut).toBe(1500);
    expect(strip.income).toBe(40);
    expect(strip.fees).toBe(5);
    expect(strip.realizedGains).toBeCloseTo(60);
  });
});

describe('sourceBreakdown', () => {
  const holding = { asset: 'BTC', amount: 0.8, costBasis: 800 };
  it('nets acquisitions minus disposals per exchange source', () => {
    const slices = sourceBreakdown(
      [
        tx({ id: 'a', type: 'buy', amount: 1, fiatValue: 1000, source: 'binance' }),
        tx({ id: 'b', type: 'sell', amount: 0.4, fiatValue: 500, source: 'binance' }),
        tx({ id: 'c', type: 'transfer_in', amount: 0.2, source: 'wazirx' })
      ],
      holding,
      []
    );
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ name: 'Binance', iconId: 'binance', qty: 0.6 });
    expect(slices[1]).toMatchObject({ name: 'WazirX', iconId: 'wazirx', qty: 0.2 });
  });

  it('attributes wallet rows to the wallet label and drops zero-balance sources', () => {
    const addr = 'SoLanaAddress1111111111111111111111111111';
    const slices = sourceBreakdown(
      [
        tx({ id: 'a', type: 'transfer_in', amount: 1, source: 'rpc:helius', walletAddress: addr, chain: 'solana' }),
        tx({ id: 'b', type: 'transfer_out', amount: 1, source: 'rpc:helius', walletAddress: addr, chain: 'solana' }),
        tx({ id: 'c', type: 'buy', amount: 0.5, fiatValue: 500, source: 'binance' })
      ],
      holding,
      [{ id: `solana:${addr}`, chain: 'solana', address: addr, label: 'My Phantom', lastSyncedAt: 1, txCount: 2 }]
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].name).toBe('Binance');
  });

  it('counts the counter leg of a trade toward the acquired asset', () => {
    const usdt = { asset: 'USDT', amount: 50, costBasis: 50 };
    const slices = sourceBreakdown(
      [
        tx({
          id: 't',
          type: 'trade',
          asset: 'BTC',
          amount: 0.1,
          counterAsset: 'USDT',
          counterAmount: 50,
          fiatValue: 50,
          source: 'binance'
        })
      ],
      usdt,
      []
    );
    expect(slices[0]).toMatchObject({ name: 'Binance', qty: 50 });
  });
});

describe('itrDeadline', () => {
  it('counts down to Jul 31 for the FY that just ended (IN)', () => {
    // 25 Jul 2026 UTC → FY 2025-26 filing due 31 Jul 2026, 6 days left.
    const d = itrDeadline(day(2026, 7, 25), 'IN');
    expect(d).not.toBeNull();
    expect(d!.daysLeft).toBe(6);
    expect(d!.filingFy).toBe(2025);
  });
  it('rolls to the next Jul 31 once the deadline passes', () => {
    const d = itrDeadline(day(2026, 8, 5), 'IN');
    expect(d!.filingFy).toBe(2026);
    expect(d!.daysLeft).toBeGreaterThan(300);
  });
  it('is null outside India', () => {
    expect(itrDeadline(day(2026, 7, 25), 'US')).toBeNull();
  });
});

describe('buildInsights', () => {
  const base = {
    needsPriceCount: 0,
    needsReviewCount: 0,
    jurisdiction: 'IN' as const,
    nowMs: day(2026, 7, 25),
    tdsTotalInr: 0,
    tdsFyLabel: 'FY 2026-27',
    biggestLoss: null,
    formatMoney: (v: number) => `₹${v}`
  };

  it('uses correct singular/plural grammar for price and review cards', () => {
    const one = buildInsights({ ...base, needsPriceCount: 1, needsReviewCount: 1 });
    expect(one.find((i) => i.kind === 'needs-price')?.title).toBe('1 transaction needs a price');
    expect(one.find((i) => i.kind === 'needs-review')?.title).toBe('1 transaction needs review');
    const many = buildInsights({ ...base, needsPriceCount: 3, needsReviewCount: 2 });
    expect(many.find((i) => i.kind === 'needs-price')?.title).toBe('3 transactions need a price');
    expect(many.find((i) => i.kind === 'needs-review')?.title).toBe('2 transactions need review');
  });

  it('shows the ITR card inside the 90-day window, keyed per FY', () => {
    const insights = buildInsights(base);
    const itr = insights.find((i) => i.kind === 'itr-deadline');
    expect(itr?.title).toBe('ITR due in 6 days');
    expect(itr?.id).toBe('itr-deadline-fy2025');
    expect(itr?.body).toContain('Jul 31');
    // Outside the window: no card.
    expect(
      buildInsights({ ...base, nowMs: day(2026, 1, 15) }).some((i) => i.kind === 'itr-deadline')
    ).toBe(false);
  });

  it('explains Sec 115BBH correctly on the unrealized-loss card (no harvesting)', () => {
    const insights = buildInsights({
      ...base,
      biggestLoss: { asset: 'MATIC', amountInr: -12000, pct: -10.9 }
    });
    const loss = insights.find((i) => i.kind === 'unrealized-loss');
    expect(loss?.body).toContain("VDA losses can't offset gains");
    expect(loss?.title).toContain('MATIC');
    expect(loss?.cta).toBeUndefined();
  });

  it('surfaces the TDS card only when TDS rows exist', () => {
    expect(buildInsights(base).some((i) => i.kind === 'tds')).toBe(false);
    const withTds = buildInsights({ ...base, tdsTotalInr: 18240 });
    const tds = withTds.find((i) => i.kind === 'tds');
    expect(tds?.title).toBe('₹18240 TDS deducted');
    expect(tds?.body).toContain('194S');
    expect(tds?.cta?.tab).toBe('capital-gains');
  });

  it('orders cards by priority: price → review → ITR → TDS → loss', () => {
    const insights = buildInsights({
      ...base,
      needsPriceCount: 2,
      needsReviewCount: 4,
      tdsTotalInr: 100,
      biggestLoss: { asset: 'X', amountInr: -1, pct: -1 }
    });
    expect(insights.map((i) => i.kind)).toEqual([
      'needs-price',
      'needs-review',
      'itr-deadline',
      'tds',
      'unrealized-loss'
    ]);
  });
});

describe('latestSyncAt / formatRelativeTime', () => {
  it('takes the newest timestamp across wallets, exchanges and imports', () => {
    expect(
      latestSyncAt(
        [{ id: 'w', chain: 'solana', address: 'a', lastSyncedAt: 100, txCount: 1 }],
        [{ lastSyncAt: 300 }],
        [{ importedAt: 200 }]
      )
    ).toBe(300);
    expect(latestSyncAt([], [], [])).toBeNull();
  });

  it('formats relative sync times', () => {
    const now = day(2026, 7, 25);
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe('2 min ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hr ago');
    expect(formatRelativeTime(now - 4 * DAY, now)).toBe('4 days ago');
    expect(formatRelativeTime(now - 20_000, now)).toBe('just now');
  });
});

describe('allocationSlices', () => {
  it('keeps the top 5 and folds the remainder into Other', () => {
    const valued = Array.from({ length: 7 }, (_, i) => ({
      asset: `A${i}`,
      amount: 1,
      costBasis: (i + 1) * 10,
      priceNow: null,
      priceAsOf: null,
      dayChangePct: null,
      avgCost: (i + 1) * 10,
      valueNow: null,
      unrealized: null,
      unrealizedPct: null
    }));
    const slices = allocationSlices(valued, false);
    expect(slices).toHaveLength(6);
    expect(slices[0].asset).toBe('A6');
    expect(slices[5].asset).toBe('Other');
    expect(slices.reduce((s, a) => s + a.pct, 0)).toBeCloseTo(100);
  });

  it('uses market values for priced holdings when useMarket is set', () => {
    const valued = [
      {
        asset: 'BTC', amount: 1, costBasis: 100, priceNow: 300, priceAsOf: 1,
        dayChangePct: null, avgCost: 100, valueNow: 300, unrealized: 200, unrealizedPct: 200
      },
      {
        asset: 'DOGE', amount: 1, costBasis: 50, priceNow: null, priceAsOf: null,
        dayChangePct: null, avgCost: 50, valueNow: null, unrealized: null, unrealizedPct: null
      }
    ];
    const slices = allocationSlices(valued, true);
    // BTC 300 market + DOGE 50 at cost = 350.
    expect(slices[0].pct).toBeCloseTo((300 / 350) * 100);
  });
});
