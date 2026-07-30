import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow, PriceCacheRow, WalletBalanceRow } from '@/lib/storage/db';
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
  reconcileHoldings,
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
  it('merges the same asset carried on multiple per-source rows into one slice', () => {
    const base = { amount: 1, priceNow: null, priceAsOf: null, dayChangePct: null, avgCost: 10, valueNow: null, unrealized: null, unrealizedPct: null };
    const valued = [
      { ...base, asset: 'ETH', costBasis: 60 },
      { ...base, asset: 'ETH', costBasis: 40 },
      { ...base, asset: 'BTC', costBasis: 50 }
    ];
    const slices = allocationSlices(valued, false);
    expect(slices.map((s) => s.asset)).toEqual(['ETH', 'BTC']);
    expect(slices[0].value).toBe(100);
    expect(slices[0].pct).toBeCloseTo((100 / 150) * 100);
  });

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


// ---------------------------------------------------------------------------
// Round 4 — on-chain balance reconciliation
// ---------------------------------------------------------------------------

const BTC_ADDR = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';

function balanceRow(over: Partial<WalletBalanceRow>): WalletBalanceRow {
  return {
    id: over.id ?? `bitcoin:${BTC_ADDR}:BTC`,
    chain: 'bitcoin',
    address: BTC_ADDR,
    asset: 'BTC',
    amount: 0,
    asOf: Date.now(),
    source: 'rpc',
    ...over
  };
}

function exchangeBalanceRow(over: Partial<ExchangeBalanceRow>): ExchangeBalanceRow {
  return {
    id: over.id ?? 'conn1:BTC',
    connectionId: 'conn1',
    exchange: 'binance',
    asset: 'BTC',
    amount: 0,
    asOf: Date.now(),
    source: 'exchange_api',
    ...over
  };
}

/** The phantom scenario: a receive the ledger holds + a send it missed. */
function phantomTxs(): Transaction[] {
  return [
    tx({
      id: 'recv',
      type: 'transfer_in',
      asset: 'BTC',
      amount: 32.65574623,
      source: 'rpc:blockstream',
      chain: 'bitcoin',
      walletAddress: BTC_ADDR
    })
  ];
}

describe('reconcileHoldings', () => {
  it('balance 0 kills the phantom holding entirely (drained Binance deposit address)', () => {
    const txs = phantomTxs();
    const holdings = [{ asset: 'BTC', amount: 32.65574623, costBasis: 32.65574623 * 5_000_000, chain: 'bitcoin' }];
    const result = reconcileHoldings(txs.length ? holdings : [], txs, [balanceRow({ amount: 0 })]);
    expect(result.holdings).toHaveLength(0); // phantom gone from the table
    expect(result.adjustedDownCount).toBe(1); // …and the adjustment is disclosed
    expect(result.reconciledCount).toBe(1);
  });

  it('balance < tx-derived clamps the holding down, scaling cost per unit', () => {
    const txs = phantomTxs();
    const holdings = [{ asset: 'BTC', amount: 32.65574623, costBasis: 326.5574623, chain: 'bitcoin' }];
    const result = reconcileHoldings(holdings, txs, [balanceRow({ amount: 10 })]);
    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0];
    expect(h.amount).toBe(10);
    expect(h.qtySource).toBe('on-chain');
    expect(h.txDerivedAmount).toBeCloseTo(32.65574623, 8);
    // Per-unit cost = 326.5574623 / 32.65574623 = 10 → 10 × 10 = 100.
    expect(h.costBasis).toBeCloseTo(100, 6);
    expect(result.adjustedDownCount).toBe(1);
  });

  it('balance > tx-derived shows the on-chain balance (reconciled up)', () => {
    const txs = phantomTxs();
    const holdings = [{ asset: 'BTC', amount: 10, costBasis: 100, chain: 'bitcoin' }];
    const result = reconcileHoldings(holdings, txs, [balanceRow({ amount: 12.5 })]);
    expect(result.holdings[0].amount).toBe(12.5);
    expect(result.holdings[0].qtySource).toBe('on-chain');
    expect(result.adjustedDownCount).toBe(0); // not a downward adjustment
  });

  it('no balance row for the address falls back to the tx-derived quantity', () => {
    const txs = phantomTxs();
    const holdings = [{ asset: 'BTC', amount: 32.65574623, costBasis: 326.5574623, chain: 'bitcoin' }];
    // A balance row for a DIFFERENT address must not affect this holding.
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({ id: 'bitcoin:bc1qother:BTC', address: 'bc1qother', amount: 0 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(32.65574623, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
    expect(result.reconciledCount).toBe(0);
  });

  it('empty balance set leaves everything tx-derived', () => {
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20, chain: 'bitcoin' }];
    const result = reconcileHoldings(holdings, phantomTxs(), []);
    expect(result.holdings[0]).toMatchObject({ amount: 2, costBasis: 20, qtySource: 'tx-history' });
    expect(result.adjustedDownCount).toBe(0);
  });

  it('exchange holdings are untouched while the same-chain wallet phantom drains', () => {
    // The portfolio engine keys holdings per chain — an exchange BTC row
    // (no chain) and a bitcoin-chain BTC row are SEPARATE holdings.
    const txs = [
      ...phantomTxs(),
      tx({ id: 'exch-buy', type: 'buy', asset: 'BTC', amount: 0.5, fiatValue: 25_000, source: 'binance' })
    ];
    const holdings = [
      { asset: 'BTC', amount: 0.5, costBasis: 25_000 }, // exchange row (chain undefined)
      { asset: 'BTC', amount: 32.65574623, costBasis: 326.5574623, chain: 'bitcoin' } // phantom row
    ];
    const result = reconcileHoldings(holdings, txs, [balanceRow({ amount: 0 })]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({ amount: 0.5, costBasis: 25_000, qtySource: 'tx-history' });
    expect(result.adjustedDownCount).toBe(1);
  });

  it('a manual wallet-less row on the SAME chain counts as a non-wallet slice', () => {
    const txs = [
      ...phantomTxs(),
      tx({
        id: 'manual-btc', type: 'buy', asset: 'BTC', amount: 0.5, fiatValue: 25_000,
        source: 'manual', chain: 'bitcoin'
      })
    ];
    const holdings = [{ asset: 'BTC', amount: 33.15574623, costBasis: 331.5574623, chain: 'bitcoin' }];
    const result = reconcileHoldings(holdings, txs, [balanceRow({ amount: 0 })]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(0.5, 8); // manual slice stays tx-derived
    expect(result.holdings[0].qtySource).toBe('on-chain'); // wallet slice was reconciled
  });

  it('D-3: chain-less manual SOL + wallet send survive unrelated balance rows (SOL does not vanish)', () => {
    // The F6 repro: manual chain-less transfer_in 10 SOL merged upstream into
    // the single solana-keyed SOL holding; a Phantom transfer_out −2.500005;
    // balance rows exist only for OTHER chains (ethereum/bitcoin). The SOL
    // holding must stay at the tx-derived 7.499995, captioned tx-history.
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const txs = [
      tx({ id: 'manual-sol', type: 'transfer_in', asset: 'SOL', amount: 10, source: 'manual' }),
      tx({
        id: 'phantom-send', type: 'transfer_out', asset: 'SOL', amount: 2.500005,
        source: 'rpc:helius', chain: 'solana', walletAddress: 'phantomAddr'
      })
    ];
    const holdings = [
      { asset: 'SOL', amount: 7.499995, costBasis: 75, chain: 'solana', contractAddress: SOL_MINT }
    ];
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({ id: 'ethereum:0xA:ETH', chain: 'ethereum', address: '0xA', asset: 'ETH', amount: 0 }),
      balanceRow({ amount: 0 }) // bitcoin phantom row
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(7.499995, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
    expect(result.reconciledCount).toBe(0);
    expect(result.adjustedDownCount).toBe(0);
  });

  it('D-3: a no-row wallet send REDUCES the tx-derived qty instead of clamping to 0', () => {
    // Manual 10 in, wallet 4 out, no balance row anywhere for the chain:
    // the honest estimate is 6, not 10.
    const txs = [
      tx({ id: 'm-in', type: 'transfer_in', asset: 'BTC', amount: 10, source: 'manual', chain: 'bitcoin' }),
      tx({
        id: 'w-out', type: 'transfer_out', asset: 'BTC', amount: 4,
        source: 'rpc:blockstream', chain: 'bitcoin', walletAddress: BTC_ADDR
      })
    ];
    const holdings = [{ asset: 'BTC', amount: 6, costBasis: 60, chain: 'bitcoin' }];
    // Unrelated-chain balance rows only → no row for (bitcoin, BTC_ADDR).
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({ id: 'ethereum:0xA:ETH', chain: 'ethereum', address: '0xA', asset: 'ETH', amount: 5 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(6, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
  });

  it('internal transfer-outs never reduce a holding (parity with buildPortfolioHoldings)', () => {
    const txs = [
      tx({ id: 'w-in', type: 'transfer_in', asset: 'BTC', amount: 3, source: 'rpc:blockstream', chain: 'bitcoin', walletAddress: BTC_ADDR }),
      tx({
        id: 'w-internal', type: 'transfer_out', asset: 'BTC', amount: 1,
        source: 'rpc:blockstream', chain: 'bitcoin', walletAddress: BTC_ADDR,
        isInternalTransfer: true
      })
    ];
    const holdings = [{ asset: 'BTC', amount: 3, costBasis: 30, chain: 'bitcoin' }];
    // An unrelated-chain balance row forces the scan to execute (an empty
    // balances array early-returns and would make this test vacuous).
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({ id: 'ethereum:0xA:ETH', chain: 'ethereum', address: '0xA', asset: 'ETH', amount: 5 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(3, 8); // 3 in, internal out skipped
    expect(result.holdings[0].qtySource).toBe('tx-history');
  });

  it('native SOL holding matches a contract-less native balance row (wrapped mint vs SOL)', () => {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const txs = [
      tx({
        id: 'sol-in', type: 'transfer_in', asset: 'SOL', amount: 9,
        source: 'rpc:helius', chain: 'solana', walletAddress: 'phantomAddr'
      })
    ];
    const holdings = [
      { asset: 'SOL', amount: 9, costBasis: 90, chain: 'solana', contractAddress: SOL_MINT }
    ];
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({
        id: 'solana:phantomAddr:SOL', chain: 'solana', address: 'phantomAddr',
        asset: 'SOL', amount: 4.25
      })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(4.25, 8);
    expect(result.holdings[0].qtySource).toBe('on-chain');
    expect(result.adjustedDownCount).toBe(1);
  });

  it('token holdings reconcile by contract address, not by symbol', () => {
    const wbtc = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
    const txs = [
      tx({
        id: 'wbtc-in', type: 'transfer_in', asset: 'WBTC', amount: 3,
        source: 'rpc:alchemy', chain: 'ethereum', walletAddress: '0xWaLlet', contractAddress: wbtc
      })
    ];
    const holdings = [{ asset: 'WBTC', amount: 3, costBasis: 300, chain: 'ethereum', contractAddress: wbtc }];
    const result = reconcileHoldings(holdings, txs, [
      balanceRow({
        id: 'ethereum:0xWaLlet:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
        chain: 'ethereum', address: '0xWaLlet', asset: 'WBTC',
        contractAddress: wbtc.toLowerCase(), amount: 0
      })
    ]);
    expect(result.holdings).toHaveLength(0);
    expect(result.adjustedDownCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Round 5 — exchange-authority reconciliation (design doc §3.3)
  // ---------------------------------------------------------------------

  it('an exchange slice anchors to the persisted fetchBalance row, draining the phantom', () => {
    // Ledger implies 9.17 BTC on Binance (conn1) but fetchBalance says 0.0000049.
    // API-sync rows carry source = 'binance_api' + importBatchId = connectionId.
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 10, source: 'binance_api', importBatchId: 'conn1' }),
      tx({ id: 's1', type: 'sell', asset: 'BTC', amount: 0.83, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 9.17, costBasis: 91.7 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0.0000049 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(0.0000049, 8);
    expect(result.holdings[0].qtySource).toBe('exchange-api');
    expect(result.holdings[0].txDerivedAmount).toBeCloseTo(9.17, 8);
    // cost basis scales per-unit: 91.7/9.17 = 10 × 0.0000049
    expect(result.holdings[0].costBasis).toBeCloseTo(0.000049, 8);
    expect(result.adjustedDownCount).toBe(1);
  });

  it('a confirmed-zero exchange balance drops the holding entirely', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 2, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0 })
    ]);
    expect(result.holdings).toHaveLength(0);
    expect(result.adjustedDownCount).toBe(1);
  });

  it('an exchange slice without a balance row stays tx-derived', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 2, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    // Balance row is for a DIFFERENT asset — no authority for BTC.
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'ETH', amount: 5 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(2, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
  });

  it('a CSV-imported exchange row (no API connection) stays tx-derived', () => {
    const txs = [
      // CSV import: source = 'binance' (not '_api'), importBatchId = file hash.
      tx({ id: 'c1', type: 'buy', asset: 'BTC', amount: 2, source: 'binance', importBatchId: 'csv-filehash-abc' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    // No exchange balance anchor at all → tx-derived.
    const result = reconcileHoldings(holdings, txs, [], []);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(2, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
  });

  it('REGRESSION (CSV+API double-source): CSV ledger of an exchange the user ALSO connected via API is subsumed by the authority, not added on top', () => {
    // The user's real flow: a giant CSV statement backfill (source 'binance',
    // importBatchId = file hash) PLUS an API auto-sync of the same Binance
    // account (source 'binance_api', importBatchId = connectionId, with a
    // fetchBalance anchor). Both describe the SAME coins — the CSV is the
    // history backfill for the API ledger. The Dashboard must report the
    // exchange-reported balance ONCE, not authority + CSV phantom.
    const txs = [
      // CSV statement rows: ledger implies a huge holding (phantom).
      tx({ id: 'csv1', type: 'buy', asset: 'BTC', amount: 10, source: 'binance', importBatchId: 'csv-filehash-abc' }),
      tx({ id: 'csv2', type: 'sell', asset: 'BTC', amount: 0.83, source: 'binance', importBatchId: 'csv-filehash-abc' }),
      // API rows for the same account (recent window).
      tx({ id: 'api1', type: 'buy', asset: 'BTC', amount: 0.0000049, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 9.17, costBasis: 91.7 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0.0000049 })
    ]);
    // The CSV phantom (9.17) is subsumed; only the real balance survives.
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(0.0000049, 8);
    expect(result.holdings[0].qtySource).toBe('exchange-api');
    expect(result.adjustedDownCount).toBe(1);
  });

  it('REGRESSION (CSV-only user): no API connection → CSV ledger stays tx-derived (the honest pre-anchor ceiling)', () => {
    // CSV import only, NO API connection, NO balance anchor. There is no
    // authority to drain the phantom, so the Dashboard reports the tx-derived
    // number — this is the known ceiling for a CSV-only user (fixed by
    // connecting the exchange via API once).
    const txs = [
      tx({ id: 'csv1', type: 'buy', asset: 'BTC', amount: 10, source: 'binance', importBatchId: 'csv-filehash-abc' }),
      tx({ id: 'csv2', type: 'sell', asset: 'BTC', amount: 0.83, source: 'binance', importBatchId: 'csv-filehash-abc' })
    ];
    const holdings = [{ asset: 'BTC', amount: 9.17, costBasis: 91.7 }];
    const result = reconcileHoldings(holdings, txs, [], []);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(9.17, 8);
    expect(result.holdings[0].qtySource).toBe('tx-history');
  });

  it('multiple connections of the same exchange sum their authority for a shared asset', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 1, source: 'binance_api', importBatchId: 'conn1' }),
      tx({ id: 'b2', type: 'buy', asset: 'BTC', amount: 1, source: 'binance_api', importBatchId: 'conn2' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0.3 }),
      exchangeBalanceRow({ id: 'conn2:BTC', connectionId: 'conn2', asset: 'BTC', amount: 0.7 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(1.0, 8);
    expect(result.holdings[0].qtySource).toBe('exchange-api');
  });

  it('wallet and exchange slices reconcile independently within one holding', () => {
    // BTC on-chain (bitcoin) and BTC on Binance are SEPARATE holdings (chain
    // keying) — this test guards that an exchange balance row does NOT touch
    // the on-chain holding and vice versa.
    const txs = [
      tx({ id: 'w-in', type: 'transfer_in', asset: 'BTC', amount: 3, source: 'rpc:blockstream', chain: 'bitcoin', walletAddress: BTC_ADDR }),
      tx({ id: 'e-buy', type: 'buy', asset: 'BTC', amount: 1, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [
      { asset: 'BTC', amount: 3, costBasis: 30, chain: 'bitcoin' },
      { asset: 'BTC', amount: 1, costBasis: 10 }
    ];
    const result = reconcileHoldings(holdings, txs,
      [balanceRow({ amount: 1.5 })], // on-chain: 3 → 1.5
      [exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0.25 })] // exchange: 1 → 0.25
    );
    const wallet = result.holdings.find((h) => h.chain === 'bitcoin');
    const exch = result.holdings.find((h) => !h.chain);
    expect(wallet?.amount).toBeCloseTo(1.5, 8);
    expect(wallet?.qtySource).toBe('on-chain');
    expect(exch?.amount).toBeCloseTo(0.25, 8);
    expect(exch?.qtySource).toBe('exchange-api');
  });
});

describe('sourceBreakdown with on-chain balances', () => {
  const holding = { asset: 'BTC', amount: 1, costBasis: 100, chain: 'bitcoin' };

  it('a wallet slice with a balance row reports the on-chain amount (0 drops the slice)', () => {
    const slices = sourceBreakdown(
      phantomTxs(),
      holding,
      [{ id: `bitcoin:${BTC_ADDR}`, chain: 'bitcoin', address: BTC_ADDR, label: 'Binance deposit', lastSyncedAt: 1, txCount: 1 }],
      [balanceRow({ amount: 0 })]
    );
    expect(slices).toHaveLength(0); // drained address no longer listed
  });

  it('a wallet slice without a balance row keeps its tx-derived estimate', () => {
    const slices = sourceBreakdown(
      phantomTxs(),
      holding,
      [{ id: `bitcoin:${BTC_ADDR}`, chain: 'bitcoin', address: BTC_ADDR, label: 'Binance deposit', lastSyncedAt: 1, txCount: 1 }],
      [balanceRow({ id: 'bitcoin:bc1qother:BTC', address: 'bc1qother', amount: 0 })]
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].qty).toBeCloseTo(32.65574623, 8);
  });
});
