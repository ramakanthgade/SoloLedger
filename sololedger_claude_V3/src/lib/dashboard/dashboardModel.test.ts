import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow, PriceCacheRow, WalletBalanceRow } from '@/lib/storage/db';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import {
  allocationSlices,
  buildChartSeries,
  buildPostingChartSeries,
  buildInsights,
  buildPriceIndex,
  currentPriceFor,
  formatRelativeTime,
  itrDeadline,
  latestSyncAt,
  moneyStrip,
  periodRange,
  projectionSourceBreakdown,
  sourceVisualShares,
  priceAt,
  reconcileHoldings,
  sourceBreakdown,
  valueHoldings
} from './dashboardModel';
import { TEST_TAX_SETTINGS } from '@/test/taxSettings';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { preparePostingAggregation } from '@/lib/ledger/postingBalances';
import { buildPortfolioDcaContext } from '@/lib/portfolio/portfolioHoldings';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';

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

  it('keeps current spot marks separate from historical chart closes', () => {
    const index = buildPriceIndex([
      priceRow('spot:sym:UNI:INR', 405),
      priceRow(`sym:UNI:${keyDate(day(2024, 12, 12))}:INR`, 1_282.25)
    ], 'INR');
    expect(index.currentBySymbol.get('UNI')?.price).toBe(405);
    expect(index.bySymbol.get('UNI')?.map((point) => point.price)).toEqual([1_282.25]);
  });

  it('indexes current exact-contract marks by platform and ignores contract-as-symbol fallbacks', () => {
    const index = buildPriceIndex([
      priceRow('spot:ctr:ethereum:0xsame:USD', 10),
      priceRow('spot:ctr:polygon-pos:0xsame:USD', 20),
      priceRow('spot:sym:0XSAME:USD', 999)
    ], 'USD');
    expect(currentPriceFor({ asset: 'ONE', chain: 'ethereum', contractAddress: '0xsame', safetyState: 'unverified' }, index)?.price).toBe(10);
    expect(currentPriceFor({ asset: 'TWO', chain: 'polygon', contractAddress: '0xsame', safetyState: 'unverified' }, index)?.price).toBe(20);
  });

  it('uses exact-contract marks for canonical trusted holdings without enabling symbol fallback', () => {
    const index = buildPriceIndex([
      priceRow('spot:ctr:ethereum:0xtrusted:USD', 1),
      priceRow('spot:sym:USDC:USD', 999)
    ], 'USD');
    expect(currentPriceFor({
      asset: 'USDC', chain: 'ethereum', contractAddress: '0xtrusted', safetyState: 'trusted'
    }, index)?.price).toBe(1);
    expect(currentPriceFor({
      asset: 'USDC', chain: 'ethereum', contractAddress: '0xunknown'
    }, index)).toBeNull();
  });

  it('uses exact custody identities before malformed receipt quotes and for probed stablecoins', () => {
    const aWeth = '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8';
    const polygonUsdc = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    const bscBusd = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
    const index = buildPriceIndex([
      priceRow(`spot:ctr:ethereum:${aWeth}:INR`, 281_426_277),
      priceRow('spot:sym:ETH:INR', 179_198),
      priceRow('spot:sym:USDC:INR', 95.37),
      priceRow('spot:sym:BUSD:INR', 95.37)
    ], 'INR');
    expect(currentPriceFor({ asset: 'aEthWETH', chain: 'ethereum', contractAddress: aWeth, safetyState: 'unverified' }, index)?.price).toBe(179_198);
    expect(currentPriceFor({ asset: 'USDC', chain: 'polygon', contractAddress: polygonUsdc, safetyState: 'trusted' }, index)?.price).toBe(95.37);
    expect(currentPriceFor({ asset: 'BUSD', chain: 'bsc', contractAddress: bscBusd, safetyState: 'trusted' }, index)?.price).toBe(95.37);
    const contractOnly = buildPriceIndex([
      priceRow(`spot:ctr:ethereum:${aWeth}:INR`, 281_426_277)
    ], 'INR');
    expect(currentPriceFor({
      asset: 'aEthWETH', chain: 'ethereum', contractAddress: aWeth, safetyState: 'unverified'
    }, contractOnly)).toBeNull();
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
        priceRow('spot:sym:BTC:INR', 80),
        priceRow(`sym:BTC:${keyDate(day(2026, 7, 24))}:INR`, 79),
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
    expect(btc.dayChangePct).toBeNull();
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

  it('never applies a symbol-only spot mark to a contract token', () => {
    const index = buildPriceIndex([priceRow('spot:sym:USDT:INR', 95)], 'INR');
    const [fake] = valueHoldings([
      { asset: 'USDT', amount: 1_000_000, costBasis: 0, chain: 'ethereum', contractAddress: '0xfake' }
    ], index);
    expect(fake.priceNow).toBeNull();
    expect(fake.valueNow).toBeNull();
  });

  it('applies the SOL spot mark to the canonical native-SOL holding', () => {
    const index = buildPriceIndex([priceRow('spot:sym:SOL:INR', 12_000)], 'INR');
    const [sol] = valueHoldings([{
      asset: 'SOL', amount: 2, costBasis: 10_000, chain: 'solana',
      contractAddress: 'So11111111111111111111111111111111111111112'
    }], index);
    expect(sol.priceNow).toBe(12_000);
    expect(sol.valueNow).toBe(24_000);
  });
});

describe('periodRange', () => {
  it('FY (IN) selects the most recently completed Apr-to-Mar year', () => {
    const now = day(2026, 7, 25);
    const range = periodRange('FY', 'IN', now, null);
    expect(range.sinceCaption).toContain('FY 2025-26');
    expect(range.start).toBe(Date.UTC(2025, 3, 1) - (5 * 60 + 30) * 60 * 1000);
    expect(range.end).toBe(Date.UTC(2026, 3, 1) - (5 * 60 + 30) * 60 * 1000 - 1);
  });
  it('ALL starts at the first transaction', () => {
    const first = day(2025, 11, 3);
    expect(periodRange('ALL', 'IN', day(2026, 7, 25), first).start).toBe(first);
  });
  it('1M spans 30 days', () => {
    const now = day(2026, 7, 25);
    expect(periodRange('1M', 'IN', now, null).start).toBe(now - 30 * DAY);
  });
  it('derives FY from the supplied now rather than the host wall clock', () => {
    const now = day(2025, 1, 15);
    const range = periodRange('FY', 'IN', now, null);
    expect(range.sinceCaption).toContain('FY 2023-24');
    expect(range.start).toBe(Date.UTC(2023, 3, 1) - (5 * 60 + 30) * 60 * 1000);
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

  it('uses the chronological posting cursor for quantity market values, including counter legs', () => {
    const rows = [tx({
      id: 'trade', timestamp: day(2026, 4, 2), type: 'trade', asset: 'BTC', amount: 1,
      counterAsset: 'USDT', counterAmount: 50, source: 'manual'
    })];
    const postings = derivePostings(rows, { exchangeConnections: [] });
    const prepared = preparePostingAggregation(postings);
    const index = buildPriceIndex([
      priceRow(`sym:USDT:${keyDate(day(2026, 4, 2))}:INR`, 2)
    ], 'INR');
    const series = buildPostingChartSeries(
      rows, postings, prepared, index, day(2026, 4, 1), day(2026, 4, 3), 3
    );
    expect(series[series.length - 1]?.market).toBe(100);
  });

  it('keeps the conservative posting-cost fast path equivalent for an ordinary ledger', () => {
    const rows = [
      tx({ id: 'buy', timestamp: day(2026, 4, 1), type: 'buy', amount: 2, fiatValue: 200 }),
      tx({ id: 'sell', timestamp: day(2026, 4, 2), type: 'sell', amount: 0.5, fiatValue: 80 })
    ];
    const postings = derivePostings(rows, { exchangeConnections: [] });
    const prepared = preparePostingAggregation(postings);
    const args = [
      rows, postings, prepared, buildPriceIndex([], 'INR'),
      day(2026, 4, 1), day(2026, 4, 3), 3
    ] as const;
    const custody = buildPostingChartSeries(...args);
    const posting = buildPostingChartSeries(...args, undefined, true);
    expect(posting).toEqual(custody);
  });

  it.each([
    ['Ethereum', 'ethereum', 'ethereum', '0xabc'],
    ['Starknet', 'starknet', 'starknet', '0xdef']
  ] as const)('uses %s contract history instead of a colliding symbol fallback', (
    _label, chain, platform, contractAddress
  ) => {
    const rows = [tx({
      id: `contract-${chain}`, timestamp: day(2026, 4, 2), type: 'transfer_in',
      asset: 'USDC', amount: 2, chain, contractAddress, source: 'manual'
    })];
    const postings = derivePostings(rows, { exchangeConnections: [] });
    const index = buildPriceIndex([
      priceRow(`sym:USDC:${keyDate(day(2026, 4, 2))}:INR`, 999),
      priceRow(`ctr:${platform}:${contractAddress}:${keyDate(day(2026, 4, 2))}:INR`, 7)
    ], 'INR');
    const series = buildPostingChartSeries(
      rows, postings, preparePostingAggregation(postings), index,
      day(2026, 4, 1), day(2026, 4, 3), 3
    );
    expect(series[series.length - 1]?.market).toBe(14);
  });

  it('preserves account-level opening-balance resets while aggregating assets', () => {
    const rows = [tx({
      id: 'after-opening', timestamp: day(2026, 4, 3), type: 'transfer_in',
      asset: 'BTC', amount: 1, source: 'manual'
    })];
    const postings = derivePostings(rows, {
      exchangeConnections: [],
      openingBalances: [{
        id: 'opening-1', logicalKey: 'manual-btc-1', scopeId: 'manual', accountClass: 'manual',
        assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 5, effectiveAt: day(2026, 4, 1),
        provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
      }, {
        id: 'opening-2', logicalKey: 'manual-btc-2', scopeId: 'manual', accountClass: 'manual',
        assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 2, effectiveAt: day(2026, 4, 2),
        provenance: 'user_confirmed', createdAt: 2, updatedAt: 2
      }]
    });
    const series = buildPostingChartSeries(
      rows, postings, preparePostingAggregation(postings),
      buildPriceIndex([priceRow(`sym:BTC:${keyDate(day(2026, 4, 1))}:INR`, 10)], 'INR'),
      day(2026, 4, 1), day(2026, 4, 3), 3
    );
    expect(series.map((point) => point.market)).toEqual([50, 20, 30]);
  });

  it.each([
    ['internal transfer', [
      tx({ id: 'internal-buy', timestamp: day(2026, 4, 1), amount: 2, fiatValue: 200 }),
      tx({ id: 'internal-out', timestamp: day(2026, 4, 2), type: 'transfer_out', amount: 1,
        source: 'binance', importBatchId: 'internal', isInternalTransfer: true, notes: 'custody move',
        raw: { Account: 'Spot' } }),
      tx({ id: 'internal-in', timestamp: day(2026, 4, 2) + 1_000, type: 'transfer_in', amount: 1,
        source: 'binance', importBatchId: 'internal', isInternalTransfer: true, notes: 'custody move',
        raw: { Account: 'Funding' } })
    ]],
    ['fee overlay', [
      tx({ id: 'fee-buy', timestamp: day(2026, 4, 1), amount: 2, fiatValue: 200 }),
      tx({ id: 'fee-row', timestamp: day(2026, 4, 2), type: 'fee', amount: 0.5, fiatValue: 10 })
    ]],
    ['trade overlay', [
      tx({ id: 'trade-buy', timestamp: day(2026, 4, 1), amount: 1, fiatValue: 100 }),
      tx({ id: 'trade-row', timestamp: day(2026, 4, 2), type: 'trade', amount: 0.5,
        counterAsset: 'ETH', counterAmount: 2, fiatValue: 80 })
    ]],
    ['Binance Options signed journal', [
      tx({ id: 'option-paid', timestamp: day(2026, 4, 1), type: 'fee', asset: 'USDT', amount: 100,
        fiatValue: 100, source: 'binance_options', category: 'options_premium' }),
      tx({ id: 'option-received', timestamp: day(2026, 4, 2), type: 'income', asset: 'USDT', amount: 120,
        fiatValue: 120, source: 'binance_options', category: 'options_premium' })
    ]],
    ['native SOL trade and fee', [
      tx({ id: 'sol-buy', timestamp: day(2026, 4, 1), type: 'buy', asset: 'SOL', amount: 2,
        fiatValue: 200, chain: 'solana' }),
      tx({ id: 'sol-trade', timestamp: day(2026, 4, 2), type: 'trade', asset: 'SOL', amount: 0.5,
        counterAsset: 'USDC', counterAmount: 50, fiatValue: 50, chain: 'solana', feeAsset: 'SOL', feeAmount: 0.01 })
    ]],
    ['classified DCA deposit and fills', [
      tx({ id: 'dca-buy', timestamp: day(2026, 4, 1), asset: 'DBT', amount: 10, fiatValue: 100,
        chain: 'solana' }),
      tx({ id: 'dca-deposit', timestamp: day(2026, 4, 2), type: 'transfer_out', asset: 'DBT', amount: 10,
        chain: 'solana', isInternalTransfer: true, notes: 'DCA deposit — non-taxable escrow' }),
      tx({ id: 'dca-fill-1', timestamp: day(2026, 4, 3), type: 'trade', asset: 'DBT', amount: 2,
        counterAsset: 'USDC', counterAmount: 3, fiatValue: 30, chain: 'solana', notes: 'DCA fill' }),
      tx({ id: 'dca-fill-2', timestamp: day(2026, 4, 4), type: 'trade', asset: 'DBT', amount: 2,
        counterAsset: 'USDC', counterAmount: 4, fiatValue: 40, chain: 'solana', notes: 'DCA fill' })
    ]],
    ['detected DCA deposit and counterparty fills', [
      tx({ id: 'dca-buy', timestamp: day(2026, 4, 1), asset: 'DBT', amount: 10, fiatValue: 100,
        chain: 'solana' }),
      tx({ id: 'dca-deposit', timestamp: day(2026, 4, 2), type: 'transfer_out', asset: 'DBT', amount: 10,
        chain: 'solana', source: 'rpc:helius', walletAddress: 'wallet', counterpartyAddress: 'vault' }),
      tx({ id: 'dca-fill-1', timestamp: day(2026, 4, 3), type: 'transfer_in', asset: 'USDC', amount: 3,
        chain: 'solana', source: 'rpc:helius', walletAddress: 'wallet', counterpartyAddress: 'vault' }),
      tx({ id: 'dca-fill-2', timestamp: day(2026, 4, 4), type: 'transfer_in', asset: 'USDC', amount: 4,
        chain: 'solana', source: 'rpc:helius', walletAddress: 'wallet', counterpartyAddress: 'vault' })
    ]],
    ['unordered rows with spam', [
      tx({ id: 'late', timestamp: day(2026, 4, 3), asset: 'BTC', amount: 2, fiatValue: 200 }),
      tx({ id: 'spam', timestamp: day(2026, 4, 1), asset: 'BTC', amount: 100,
        fiatValue: 10_000, isSpam: true }),
      tx({ id: 'early', timestamp: day(2026, 4, 2), asset: 'BTC', amount: 1, fiatValue: 100 })
    ]],
    ['address-shaped asset and matching contract remain distinct', [
      tx({ id: 'raw-address', timestamp: day(2026, 4, 1), type: 'buy', asset: '0xabc',
        amount: 1, fiatValue: 100, chain: 'ethereum' }),
      tx({ id: 'resolved-contract', timestamp: day(2026, 4, 2), type: 'buy', asset: 'TOKEN',
        amount: 1, fiatValue: 200, chain: 'ethereum', contractAddress: '0xabc' }),
      tx({ id: 'resolved-disposal', timestamp: day(2026, 4, 3), type: 'sell', asset: 'TOKEN',
        amount: 1, fiatValue: 250, chain: 'ethereum', contractAddress: '0xabc' })
    ]],
    ['empty contracts retain separate asset holdings', [
      tx({ id: 'btc-empty-contract', timestamp: day(2026, 4, 1), type: 'buy', asset: 'BTC',
        amount: 1, fiatValue: 100, chain: 'ethereum', contractAddress: '' }),
      tx({ id: 'eth-empty-contract', timestamp: day(2026, 4, 2), type: 'buy', asset: 'ETH',
        amount: 1, fiatValue: 200, chain: 'ethereum', contractAddress: '' }),
      tx({ id: 'eth-empty-disposal', timestamp: day(2026, 4, 3), type: 'sell', asset: 'ETH',
        amount: 1, fiatValue: 250, chain: 'ethereum', contractAddress: '' })
    ]]
  ] as const)('matches legacy chart costs exactly for %s', (_name, rows) => {
    const transactions = [...rows] as Transaction[];
    const postings = derivePostings(transactions, { exchangeConnections: [] });
    const start = day(2026, 4, 1);
    const end = day(2026, 4, 6);
    const legacy = buildChartSeries(transactions, buildPriceIndex([], 'INR'), start, end, 6);
    const indexed = buildPostingChartSeries(
      transactions, postings, preparePostingAggregation(postings), buildPriceIndex([], 'INR'), start, end, 6
    );
    expect(indexed.map((point) => point.cost)).toEqual(legacy.map((point) => point.cost));
  });

  it.each([
    ['partial and full SOL buys', [
      tx({ id: 'sol-buy-1', timestamp: day(2026, 4, 1), type: 'buy', asset: 'SOL', amount: 2,
        counterAsset: 'INR', counterAmount: 200, fiatValue: 200, chain: 'solana' }),
      tx({ id: 'sol-buy-2', timestamp: day(2026, 4, 2), type: 'buy', asset: 'SOL', amount: 1,
        counterAsset: 'INR', counterAmount: 120, fiatValue: 120, chain: 'solana' })
    ]],
    ['SOL transfers and fee', [
      tx({ id: 'sol-in', timestamp: day(2026, 4, 1), type: 'transfer_in', asset: 'SOL', amount: 3,
        fiatValue: 0, chain: 'solana' }),
      tx({ id: 'sol-out', timestamp: day(2026, 4, 2), type: 'transfer_out', asset: 'SOL', amount: 1,
        chain: 'solana', feeAsset: 'SOL', feeAmount: 0.01 }),
      tx({ id: 'sol-fee', timestamp: day(2026, 4, 3), type: 'fee', asset: 'SOL', amount: 0.02,
        chain: 'solana' })
    ]],
    ['SOL sold and received through trades', [
      tx({ id: 'sol-buy', timestamp: day(2026, 4, 1), type: 'buy', asset: 'SOL', amount: 3,
        fiatValue: 300, chain: 'solana' }),
      tx({ id: 'sol-sell-trade', timestamp: day(2026, 4, 2), type: 'trade', asset: 'SOL', amount: 1,
        counterAsset: 'USDC', counterAmount: 100, fiatValue: 100, chain: 'solana', feeAsset: 'SOL', feeAmount: 0.01 }),
      tx({ id: 'sol-buy-trade', timestamp: day(2026, 4, 3), type: 'trade', asset: 'USDC', amount: 50,
        counterAsset: 'SOL', counterAmount: 0.5, fiatValue: 50, chain: 'solana' })
    ]],
    ['full SOL drain and reacquire', [
      tx({ id: 'sol-first-buy', timestamp: day(2026, 4, 1), type: 'buy', asset: 'SOL', amount: 2,
        fiatValue: 200, chain: 'solana' }),
      tx({ id: 'sol-drain', timestamp: day(2026, 4, 2), type: 'sell', asset: 'SOL', amount: 2,
        chain: 'solana' }),
      tx({ id: 'sol-reacquire', timestamp: day(2026, 4, 3), type: 'buy', asset: 'SOL', amount: 1,
        counterAsset: 'INR', counterAmount: 150, fiatValue: 150, chain: 'solana' })
    ]]
  ] as const)('matches legacy native SOL chart semantics for %s', (_name, rows) => {
    const transactions = [...rows] as Transaction[];
    const postings = derivePostings(transactions, { exchangeConnections: [] });
    const start = day(2026, 4, 1);
    const end = day(2026, 4, 4);
    const legacy = buildChartSeries(transactions, buildPriceIndex([], 'INR'), start, end, 4);
    const indexed = buildPostingChartSeries(
      transactions, postings, preparePostingAggregation(postings), buildPriceIndex([], 'INR'), start, end, 4
    );
    expect(indexed.map((point) => point.cost)).toEqual(legacy.map((point) => point.cost));
  });

  it('indexes 30k adversarial DCA counterparty rows with linear candidate work', () => {
    const groups = 10_000;
    const rows = new Array<Transaction>(groups * 3);
    for (let index = 0; index < groups; index++) {
      const timestamp = index * 1_000_000;
      const common = {
        chain: 'solana', source: 'rpc:helius', walletAddress: `wallet-${index}`,
        counterpartyAddress: `vault-${index}`
      } as const;
      rows[index * 3] = tx({
        ...common, id: `deposit-${index}`, timestamp, type: 'transfer_out', asset: 'DBT', amount: 2
      });
      rows[index * 3 + 1] = tx({
        ...common, id: `fill-a-${index}`, timestamp: timestamp + 1, type: 'transfer_in', asset: 'USDC', amount: 1
      });
      rows[index * 3 + 2] = tx({
        ...common, id: `fill-b-${index}`, timestamp: timestamp + 2, type: 'transfer_in', asset: 'USDC', amount: 1
      });
    }
    const metrics = { candidateVisits: 0 };
    const context = buildPortfolioDcaContext(rows, metrics);
    expect(context.internalDepositIds.size).toBe(groups);
    expect(context.dcaFillIds.size).toBe(groups * 2);
    expect(context.internalDepositIds.has('deposit-9999')).toBe(true);
    expect(context.dcaFillIds.has('fill-b-9999')).toBe(true);
    expect(metrics.candidateVisits).toBeLessThanOrEqual(rows.length);
  });

  it('bounds same-wallet deposit visits across many fill-only output groups', () => {
    const groups = 4_000;
    const firstFillTimestamp = groups * 1_000 + 1;
    const rows = new Array<Transaction>(groups * 3);
    for (let index = 0; index < groups; index++) {
      const common = {
        chain: 'solana', source: 'rpc:helius', walletAddress: 'shared-wallet'
      } as const;
      rows[index * 3] = tx({
        ...common, id: `fill-only-deposit-${index}`, timestamp: index * 1_000,
        type: 'transfer_out', asset: 'DBT', amount: 2
      });
      rows[index * 3 + 1] = tx({
        ...common, id: `fill-only-a-${index}`, timestamp: firstFillTimestamp + index * 10,
        type: 'transfer_in', asset: 'USDC', amount: 1,
        counterpartyAddress: `fill-only-vault-${index}`
      });
      rows[index * 3 + 2] = tx({
        ...common, id: `fill-only-b-${index}`, timestamp: firstFillTimestamp + index * 10 + 1,
        type: 'transfer_in', asset: 'USDC', amount: 1,
        counterpartyAddress: `fill-only-vault-${index}`
      });
    }

    const metrics = { candidateVisits: 0 };
    const context = buildPortfolioDcaContext(rows, metrics);
    // Every densely-overlapping group chooses the same nearest deposit.
    expect(context.internalDepositIds.size).toBe(1);
    expect(context.dcaFillIds.size).toBe(groups * 2);
    expect(context.internalDepositIds.has('fill-only-deposit-3999')).toBe(true);
    expect(metrics.candidateVisits).toBeLessThanOrEqual(rows.length);
  });

  it('assigns dense same-wallet trade fills once to the nearest deposit with linear visits', () => {
    const groups = 4_000;
    const firstFillTimestamp = groups * 1_000 + 1;
    const rows = new Array<Transaction>(groups * 3);
    for (let index = 0; index < groups; index++) {
      const common = {
        chain: 'solana', source: 'rpc:helius', walletAddress: 'shared-swap-wallet'
      } as const;
      rows[index * 3] = tx({
        ...common, id: `swap-deposit-${index}`, timestamp: index * 1_000,
        type: 'transfer_out', asset: 'DBT', amount: 2,
        counterpartyAddress: `swap-vault-${index}`
      });
      rows[index * 3 + 1] = tx({
        ...common, id: `swap-fill-a-${index}`, timestamp: firstFillTimestamp + index * 10,
        type: 'trade', asset: 'DBT', amount: 1,
        counterAsset: 'USDC', counterAmount: 1
      });
      rows[index * 3 + 2] = tx({
        ...common, id: `swap-fill-b-${index}`, timestamp: firstFillTimestamp + index * 10 + 1,
        type: 'trade', asset: 'DBT', amount: 1,
        counterAsset: 'USDC', counterAmount: 1,
        notes: index === 0 ? 'DCA fill: previously classified' : undefined
      });
    }

    const metrics = { candidateVisits: 0 };
    const detected = detectDcaGroups(rows, metrics);
    expect(detected).toHaveLength(1);
    expect(detected[0].depositTx.id).toBe('swap-deposit-3999');
    expect(detected[0].fillTxs).toHaveLength(groups * 2);
    expect(detected[0].fillTxs[0].id).toBe('swap-fill-a-0');
    expect(detected[0].fillTxs[groups * 2 - 1].id).toBe('swap-fill-b-3999');
    expect(detected[0].unclassifiedFillTxs).toHaveLength(groups * 2 - 1);
    expect(detected[0].unclassifiedFillTxs.some((fill) => fill.id === 'swap-fill-b-0')).toBe(false);
    expect(metrics.candidateVisits).toBeLessThanOrEqual(rows.length);
  });
});

describe('projectionSourceBreakdown', () => {
  it('uses projection quantities, joins labels, preserves Spot/Options, and agrees with the holding', () => {
    const verification = [
      { scopeId: 'exchange:c1', accountClass: 'spot' as const, quantity: 7, postingQuantity: 50,
        authorityQuantity: 7, verificationStatus: 'verified_authority' as const,
        authorityStatus: 'current' as const, coverageStatus: 'complete' as const, scopeStatus: 'resolved' as const },
      { scopeId: 'exchange:c1', accountClass: 'options' as const, quantity: 3, postingQuantity: 3,
        verificationStatus: 'posting_fallback' as const, fallbackReason: 'missing_authority' as const,
        authorityStatus: 'missing' as const, coverageStatus: 'missing' as const, scopeStatus: 'resolved' as const }
    ];
    const slices = projectionSourceBreakdown(verification, [], [{
      id: 'c1', exchange: 'binance', label: 'Primary Binance', createdAt: 1, cursors: {}, status: 'ok'
    }], []);
    expect(slices.map((slice) => [slice.name, slice.qty])).toEqual([
      ['Primary Binance Spot', 7], ['Primary Binance Options', 3]
    ]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBe(10);
  });

  it('labels wallet contracts and timestamp-less CSV postings without recalculating quantities', () => {
    const slices = projectionSourceBreakdown([
      { scopeId: 'wallet:solana:solana:Base58Wallet', accountClass: 'wallet', quantity: 2,
        postingQuantity: 2, verificationStatus: 'posting_fallback', fallbackReason: 'missing_authority',
        authorityStatus: 'missing', coverageStatus: 'missing', scopeStatus: 'resolved' },
      { scopeId: 'file:csv-no-time:manual', accountClass: 'manual', quantity: 4,
        postingQuantity: 4, verificationStatus: 'posting_fallback', fallbackReason: 'non_comparable_authority',
        authorityStatus: 'non_comparable', coverageStatus: 'complete', scopeStatus: 'resolved' }
    ], [{
      id: 'solana:Base58Wallet', chain: 'solana', address: 'Base58Wallet', label: 'Contract wallet',
      lastSyncedAt: 1, txCount: 1
    }], [], [{
      id: 'csv-no-time', fileName: 'balances-without-timestamp.csv', importedAt: 0,
      txCount: 1, parserId: null
    }]);
    expect(slices.map((slice) => slice.name)).toEqual([
      'balances-without-timestamp.csv', 'Contract wallet'
    ]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBe(6);
  });

  it('uses absolute quantities for mixed-sign visual shares without changing signed totals', () => {
    const slices = [
      { key: 'positive', name: 'Positive', qty: 10 },
      { key: 'deficit', name: 'Deficit source', qty: -4 }
    ];
    const visual = sourceVisualShares(slices);
    expect(visual.map((slice) => slice.sharePct)).toEqual([
      expect.closeTo((10 / 14) * 100), expect.closeTo((4 / 14) * 100)
    ]);
    expect(visual.map((slice) => slice.isDeficit)).toEqual([false, true]);
    expect(visual.reduce((sum, slice) => sum + slice.sharePct, 0)).toBeCloseTo(100);
    expect(visual.reduce((sum, slice) => sum + slice.qty, 0)).toBe(6);
  });

  it('gives all-negative holdings meaningful shares totaling 100%', () => {
    const visual = sourceVisualShares([
      { key: 'one', name: 'One', qty: -2 },
      { key: 'two', name: 'Two', qty: -3 }
    ]);
    expect(visual.map((slice) => slice.sharePct)).toEqual([40, 60]);
    expect(visual.every((slice) => slice.isDeficit)).toBe(true);
    expect(visual.reduce((sum, slice) => sum + slice.sharePct, 0)).toBe(100);
    expect(visual.reduce((sum, slice) => sum + slice.qty, 0)).toBe(-5);
  });
});

describe('moneyStrip', () => {
  it('counts only external deposits and withdrawals, excluding trades and confirmed internal transfers', () => {
    const start = day(2026, 4, 1);
    const end = day(2026, 7, 25);
    const txs = [
      tx({ id: 'deposit', timestamp: day(2026, 5, 1), type: 'transfer_in', fiatValue: 1000 }),
      tx({ id: 'withdrawal', timestamp: day(2026, 6, 1), type: 'transfer_out', fiatValue: 1500 }),
      tx({ id: 'internal-in', timestamp: day(2026, 6, 1), type: 'transfer_in', fiatValue: 700, isInternalTransfer: true }),
      tx({ id: 'internal-out', timestamp: day(2026, 6, 1), type: 'transfer_out', fiatValue: 700, internalTransferDecision: 'confirmed' }),
      tx({ id: 'buy', timestamp: day(2026, 6, 1), type: 'buy', fiatValue: 9000 }),
      tx({ id: 'sell', timestamp: day(2026, 6, 1), type: 'sell', fiatValue: 8000 }),
      tx({ id: 'trade', timestamp: day(2026, 6, 1), type: 'trade', fiatValue: 7000 }),
      tx({ id: 'inc', timestamp: day(2026, 6, 2), type: 'income', asset: 'ETH', fiatValue: 40 }),
      tx({ id: 'fee', timestamp: day(2026, 6, 3), type: 'fee', fiatValue: 5 }),
      tx({ id: 'old', timestamp: day(2025, 1, 1), type: 'transfer_in', fiatValue: 9999 }),
      tx({ id: 'spam', timestamp: day(2026, 6, 4), type: 'transfer_in', fiatValue: 777, isSpam: true })
    ];
    const { disposals } = calculateCostBasis(
      [
        tx({ id: 'cb-b', timestamp: day(2026, 4, 2), type: 'buy', amount: 1, fiatValue: 100 }),
        tx({ id: 'cb-s', timestamp: day(2026, 6, 5), type: 'sell', amount: 1, fiatValue: 160 })
      ],
      { method: 'FIFO', settings: TEST_TAX_SETTINGS }
    );
    const strip = moneyStrip(txs, disposals, start, end);
    expect(strip.moneyIn).toEqual({ amount: 1000, status: 'complete', contributorCount: 1, missingValuationCount: 0 });
    expect(strip.moneyOut.amount).toBe(1500);
    expect(strip.income.amount).toBe(40);
    expect(strip.fees.amount).toBe(5);
    expect(strip.realizedGains.amount).toBeCloseTo(60);
  });

  it('values an inline reporting-currency fee directly without using trade fiatValue', () => {
    const timestamp = day(2026, 5, 1);
    const strip = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'buy', fiatValue: 50_000, feeAsset: 'INR', feeAmount: 125 })
    ], [], timestamp, timestamp);
    expect(strip.fees).toEqual({ amount: 125, status: 'complete', contributorCount: 1, missingValuationCount: 0 });
  });

  it('values a crypto inline fee from the timestamped reporting-currency price cache', () => {
    const timestamp = day(2026, 5, 3);
    const index = buildPriceIndex([
      priceRow(`sym:BNB:${keyDate(timestamp)}:INR`, 50_000)
    ], 'INR');
    const strip = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'sell', feeAsset: 'BNB', feeAmount: 0.01, fiatValue: 100_000 })
    ], [], timestamp, timestamp, index);
    expect(strip.fees).toEqual({ amount: 500, status: 'complete', contributorCount: 1, missingValuationCount: 0 });
  });

  it('marks an unvalued crypto fee unavailable instead of returning zero', () => {
    const timestamp = day(2026, 5, 3);
    const strip = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'trade', feeAsset: 'BNB', feeAmount: 0.01, fiatValue: 100_000 })
    ], [], timestamp, timestamp);
    expect(strip.fees).toEqual({ amount: null, status: 'unavailable', contributorCount: 1, missingValuationCount: 1 });
  });

  it('counts an inline fee with no asset as unavailable instead of guessing its unit', () => {
    const timestamp = day(2026, 5, 3);
    const strip = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'buy', feeAmount: 25, feeAsset: undefined, fiatValue: 100_000 })
    ], [], timestamp, timestamp);
    expect(strip.fees).toEqual({ amount: null, status: 'unavailable', contributorCount: 1, missingValuationCount: 1 });
  });

  it('returns a partial known subtotal when only some fee contributors are valued', () => {
    const timestamp = day(2026, 5, 3);
    const strip = moneyStrip([
      tx({ id: 'inr', timestamp, type: 'buy', feeAsset: 'INR', feeAmount: 25 }),
      tx({ id: 'crypto', timestamp, type: 'sell', feeAsset: 'BNB', feeAmount: 0.01 })
    ], [], timestamp, timestamp);
    expect(strip.fees).toEqual({ amount: 25, status: 'partial', contributorCount: 2, missingValuationCount: 1 });
  });

  it('deduplicates standalone and inline representations only when immutable source evidence matches', () => {
    const timestamp = day(2026, 5, 3);
    const proven = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'buy', source: 'provider', sourceRef: 'immutable-fill-1', feeAsset: 'BNB', feeAmount: 0.01 }),
      tx({ id: 'fee', timestamp, type: 'fee', source: 'provider', sourceRef: 'immutable-fill-1', asset: 'BNB', amount: 0.01, fiatValue: 450 })
    ], [], timestamp, timestamp);
    expect(proven.fees).toEqual({ amount: 450, status: 'complete', contributorCount: 1, missingValuationCount: 0 });

    const unproven = moneyStrip([
      tx({ id: 'trade', timestamp, type: 'buy', feeAsset: 'INR', feeAmount: 450 }),
      tx({ id: 'fee', timestamp, type: 'fee', asset: 'INR', amount: 450 })
    ], [], timestamp, timestamp);
    expect(unproven.fees).toEqual({ amount: 900, status: 'complete', contributorCount: 2, missingValuationCount: 0 });
  });

  it('includes exact period boundaries and excludes adjacent instants', () => {
    const start = day(2026, 5, 1);
    const end = day(2026, 5, 31);
    const strip = moneyStrip([
      tx({ id: 'before', timestamp: start - 1, type: 'transfer_in', fiatValue: 1 }),
      tx({ id: 'start', timestamp: start, type: 'transfer_in', fiatValue: 2 }),
      tx({ id: 'end', timestamp: end, type: 'transfer_in', fiatValue: 3 }),
      tx({ id: 'after', timestamp: end + 1, type: 'transfer_in', fiatValue: 4 })
    ], [], start, end);
    expect(strip.moneyIn).toEqual({ amount: 5, status: 'complete', contributorCount: 2, missingValuationCount: 0 });
  });

  it('does not coerce a missing external-flow valuation to zero', () => {
    const timestamp = day(2026, 5, 1);
    const strip = moneyStrip([
      tx({ id: 'known', timestamp, type: 'transfer_in', fiatValue: 100 }),
      tx({ id: 'missing', timestamp, type: 'transfer_in', asset: 'BTC', fiatValue: undefined })
    ], [], timestamp, timestamp);
    expect(strip.moneyIn).toEqual({ amount: 100, status: 'partial', contributorCount: 2, missingValuationCount: 1 });
  });

  it('values crypto flows from exact-contract and symbol historical prices after persisted and direct values', () => {
    const timestamp = day(2026, 5, 1);
    const contract = '0x1111111111111111111111111111111111111111';
    const index = buildPriceIndex([
      priceRow(`ctr:ethereum:${contract}:${keyDate(timestamp)}:INR`, 25),
      priceRow(`sym:ETH:${keyDate(timestamp)}:INR`, 2_000),
      priceRow(`sym:BTC:${keyDate(timestamp)}:INR`, 5_000)
    ], 'INR');
    const strip = moneyStrip([
      tx({ id: 'exact', timestamp, type: 'transfer_in', asset: 'TOKEN', amount: 4, chain: 'ethereum', contractAddress: contract }),
      tx({ id: 'symbol', timestamp, type: 'transfer_out', asset: 'ETH', amount: 0.5 }),
      tx({ id: 'income', timestamp, type: 'income', asset: 'BTC', amount: 0.1 }),
      tx({ id: 'persisted', timestamp, type: 'transfer_in', asset: 'BTC', amount: 1, fiatValue: 7_500 }),
      tx({ id: 'direct', timestamp, type: 'income', asset: 'INR', amount: 75 })
    ], [], timestamp, timestamp, index);

    expect(strip.moneyIn).toEqual({ amount: 7_600, status: 'complete', contributorCount: 2, missingValuationCount: 0 });
    expect(strip.moneyOut).toEqual({ amount: 1_000, status: 'complete', contributorCount: 1, missingValuationCount: 0 });
    expect(strip.income).toEqual({ amount: 575, status: 'complete', contributorCount: 2, missingValuationCount: 0 });
  });

  it('preserves unavailable aggregate status when every external flow remains unpriced', () => {
    const timestamp = day(2026, 5, 1);
    const strip = moneyStrip([
      tx({ id: 'missing', timestamp, type: 'transfer_in', asset: 'UNKNOWN', amount: 3 })
    ], [], timestamp, timestamp, buildPriceIndex([], 'INR'));

    expect(strip.moneyIn).toEqual({ amount: null, status: 'unavailable', contributorCount: 1, missingValuationCount: 1 });
  });

  it('rejects a stale monthly close for transaction-date flow valuation', () => {
    const timestamp = day(2026, 5, 31);
    const stale = day(2026, 5, 1);
    const strip = moneyStrip([
      tx({ id: 'stale', timestamp, type: 'transfer_in', asset: 'BTC', amount: 2, safetyState: 'trusted' })
    ], [], timestamp, timestamp, buildPriceIndex([
      priceRow(`sym:BTC:${keyDate(stale)}:INR`, 5_000)
    ], 'INR'));

    expect(strip.moneyIn).toEqual({ amount: null, status: 'unavailable', contributorCount: 1, missingValuationCount: 1 });
  });

  it('does not value an unverified contract from a same-symbol lookalike price', () => {
    const timestamp = day(2026, 5, 1);
    const lookalike = '0x2222222222222222222222222222222222222222';
    const index = buildPriceIndex([
      priceRow(`sym:USDC:${keyDate(timestamp)}:INR`, 83)
    ], 'INR');
    const unverified = moneyStrip([
      tx({ id: 'lookalike', timestamp, type: 'transfer_in', asset: 'USDC', amount: 100, chain: 'ethereum', contractAddress: lookalike, safetyState: 'unverified' })
    ], [], timestamp, timestamp, index);
    const trusted = moneyStrip([
      tx({ id: 'trusted', timestamp, type: 'transfer_in', asset: 'USDC', amount: 100, chain: 'ethereum', contractAddress: lookalike, safetyState: 'trusted' })
    ], [], timestamp, timestamp, index);

    expect(unverified.moneyIn.status).toBe('unavailable');
    expect(trusted.moneyIn).toEqual({ amount: 8_300, status: 'complete', contributorCount: 1, missingValuationCount: 0 });
  });

  it('defers both sides of unmatched Options premiums from income and fees', () => {
    const start = day(2026, 4, 1);
    const end = day(2026, 7, 25);
    const strip = moneyStrip([
      tx({ id: 'paid', timestamp: day(2026, 5, 1), type: 'fee', category: 'options_premium', fiatValue: 100 }),
      tx({ id: 'received', timestamp: day(2026, 5, 2), type: 'income', category: 'options_premium', fiatValue: 100 })
    ], [], start, end);
    expect(strip.income.amount).toBe(0);
    expect(strip.fees.amount).toBe(0);
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

  it('does not subtract an unmatched internal Options boundary from source quantity', () => {
    const slices = sourceBreakdown([
      tx({ id: 'in', type: 'transfer_in', amount: 100, source: 'binance' }),
      tx({ id: 'options', type: 'transfer_out', amount: 90, source: 'binance', isInternalTransfer: true })
    ], { asset: 'BTC' }, []);
    expect(slices[0]).toMatchObject({ name: 'Binance', qty: 100 });
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

  it('removes phantom Binance Options funding using the same journal authority as holdings', () => {
    const importedAt = Date.UTC(2026, 0, 1);
    const transactions = [
      tx({
        id: 'gross-options-funding', type: 'transfer_in', asset: 'USDT', amount: 23_892.79,
        source: 'binance', importBatchId: 'history', sourceRef: 'history:funding'
      }),
      tx({
        id: 'options-net', type: 'transfer_in', asset: 'USDT', amount: 119.5193,
        source: 'binance_options', category: 'options_collateral', sourceRef: 'options:net'
      })
    ];
    const slices = sourceBreakdown(
      transactions,
      { asset: 'USDT' },
      [],
      [],
      [{
        id: 'history', fileName: 'binance.csv', parserId: 'binance',
        importedAt, txCount: 1, balanceSnapshot: { USDT: 0 }
      }]
    );

    expect(slices).toEqual([
      expect.objectContaining({
        key: 'source:binance_options', name: 'Binance Options', qty: 119.5193
      })
    ]);
    expect(slices.some((slice) => Math.abs(slice.qty - 23_892.79) < 1e-9)).toBe(false);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBeCloseTo(119.5193, 8);
  });

  it('replaces API historical network deposits with one current exchange slice', () => {
    const rows = [
      tx({
        id: 'eth-deposit', type: 'transfer_in', asset: 'USDT', amount: 544_193,
        source: 'binance_api', importBatchId: 'conn1', chain: 'ethereum',
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'bsc-deposit', type: 'transfer_in', asset: 'USDT', amount: 701.8764,
        source: 'binance_api', importBatchId: 'conn1', chain: 'bsc',
        walletAddress: '0x2222222222222222222222222222222222222222'
      })
    ];
    const slices = sourceBreakdown(
      rows,
      { asset: 'USDT' },
      [],
      [],
      [],
      [exchangeBalanceRow({ asset: 'USDT', amount: 119.5193 })]
    );
    expect(slices).toEqual([
      expect.objectContaining({
        key: 'exchange-api:binance', name: 'Binance API', qty: 119.5193
      })
    ]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBeCloseTo(119.5193, 8);
  });

  it('treats an asset omitted from an exchange snapshot as zero in the breakdown', () => {
    const slices = sourceBreakdown(
      [
        tx({ id: 'old-binance', type: 'transfer_in', asset: 'BTC', amount: 9, source: 'binance_api' }),
        tx({ id: 'manual', type: 'transfer_in', asset: 'BTC', amount: 2, source: 'manual' })
      ],
      { asset: 'BTC' },
      [],
      [],
      [],
      [exchangeBalanceRow({ asset: 'ETH', amount: 1 })]
    );
    expect(slices).toEqual([expect.objectContaining({ name: 'Manual entry', qty: 2 })]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBe(2);
  });

  it('preserves an outflow-first authoritative Binance slice beside unrelated holdings', () => {
    const importedAt = Date.UTC(2026, 0, 1);
    const slices = sourceBreakdown(
      [
        tx({
          id: 'out', type: 'transfer_out', asset: 'USDT', amount: 100,
          source: 'binance', importBatchId: 'history', sourceRef: 'history:out'
        }),
        tx({
          id: 'in', type: 'transfer_in', asset: 'USDT', amount: 105,
          source: 'binance', importBatchId: 'history', sourceRef: 'history:in'
        }),
        tx({ id: 'manual', type: 'transfer_in', asset: 'USDT', amount: 3, source: 'manual' })
      ],
      { asset: 'USDT' },
      [],
      [],
      [{
        id: 'history', fileName: 'binance.csv', parserId: 'binance', importedAt,
        txCount: 2, balanceSnapshot: { USDT: 5 }
      }]
    );

    expect(slices).toEqual([
      expect.objectContaining({ key: 'source:binance', qty: 5 }),
      expect.objectContaining({ key: 'source:manual', qty: 3 })
    ]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBe(8);
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
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 10, fiatValue: 100, source: 'binance_api', importBatchId: 'conn1' }),
      tx({ id: 's1', type: 'sell', asset: 'BTC', amount: 0.83, fiatValue: 8.3, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 9.17, costBasis: 91.7 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0.0000049 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].amount).toBeCloseTo(0.0000049, 8);
    expect(result.holdings[0].qtySource).toBe('exchange-api');
    expect(result.holdings[0].txDerivedAmount).toBeCloseTo(0.0000049, 8);
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

  it('an asset omitted by a successful exchange snapshot is treated as zero', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 2, source: 'binance_api', importBatchId: 'conn1' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    // Balance row is for a DIFFERENT asset — no authority for BTC.
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'ETH', amount: 5 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({ asset: 'ETH', amount: 5, qtySource: 'exchange-api' });
  });

  it('a same-exchange CSV custody row is superseded by API balance authority', () => {
    const txs = [
      // importBatchId is a CSV file hash, not a connectionId → no authority.
      tx({ id: 'c1', type: 'buy', asset: 'BTC', amount: 2, source: 'binance', importBatchId: 'csv-filehash-abc' })
    ];
    const holdings = [{ asset: 'BTC', amount: 2, costBasis: 20 }];
    const result = reconcileHoldings(holdings, txs, [], [
      exchangeBalanceRow({ connectionId: 'conn1', asset: 'BTC', amount: 0 })
    ]);
    expect(result.holdings).toHaveLength(0);
  });

  it('multiple connections of the same exchange sum their authority for a shared asset', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', asset: 'BTC', amount: 1, source: 'binance', importBatchId: 'conn1' }),
      tx({ id: 'b2', type: 'buy', asset: 'BTC', amount: 1, source: 'binance', importBatchId: 'conn2' })
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

  it('API-only network deposits collapse to chainless current balances', () => {
    const depositAddress = '0x1111111111111111111111111111111111111111';
    const txs = [
      tx({
        id: 'eth-deposit', type: 'transfer_in', asset: 'USDT', amount: 544_193,
        source: 'binance_api', importBatchId: 'conn1', chain: 'ethereum',
        walletAddress: depositAddress
      }),
      tx({
        id: 'bsc-deposit', type: 'transfer_in', asset: 'USDT', amount: 701.8764,
        source: 'binance_api', importBatchId: 'conn1', chain: 'bsc',
        walletAddress: '0x2222222222222222222222222222222222222222'
      })
    ];
    const result = reconcileHoldings(buildPortfolioHoldings(txs), txs, [], [
      exchangeBalanceRow({ id: 'conn1:USDT', asset: 'USDT', amount: 119.5193 })
    ]);
    expect(result.holdings).toEqual([
      expect.objectContaining({ asset: 'USDT', amount: 119.5193, qtySource: 'exchange-api' })
    ]);
    expect(result.holdings[0].chain).toBeUndefined();
  });

  it('Transaction History + Options + API produces API spot plus Options exactly once', () => {
    const txs = [
      tx({
        id: 'csv-gross', type: 'transfer_in', asset: 'USDT', amount: 23_892.79,
        source: 'binance', importBatchId: 'csv-history'
      }),
      tx({
        id: 'api-gross', type: 'transfer_in', asset: 'USDT', amount: 23_892.79,
        source: 'binance_api', importBatchId: 'conn1', chain: 'ethereum',
        walletAddress: '0x1111111111111111111111111111111111111111'
      }),
      tx({
        id: 'options-net', type: 'transfer_in', asset: 'USDT', amount: 119.5193,
        source: 'binance_options', category: 'options_collateral'
      })
    ];
    const result = reconcileHoldings(buildPortfolioHoldings(txs), txs, [], [
      exchangeBalanceRow({ id: 'conn1:USDT', asset: 'USDT', amount: 10 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({ asset: 'USDT', amount: 129.5193 });
    expect(result.holdings[0].chain).toBeUndefined();
  });

  it('does not borrow cost basis from unrelated sources for transfer-only Binance custody', () => {
    const txs = [
      tx({ id: 'binance-transfer', type: 'transfer_in', asset: 'BTC', amount: 1, source: 'binance_api', importBatchId: 'conn1' }),
      tx({ id: 'manual-buy', type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100, source: 'manual' })
    ];
    const result = reconcileHoldings(buildPortfolioHoldings(txs), txs, [], [
      exchangeBalanceRow({ asset: 'BTC', amount: 1 })
    ]);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({ asset: 'BTC', amount: 2, costBasis: 100 });
  });

  it('replaces exchange-wide Binance custody while preserving derivatives and Options', () => {
    const txs = [
      tx({ id: 'spot', type: 'buy', asset: 'USDT', amount: 100, source: 'binance', raw: { buy: { Account: 'Spot' } } }),
      tx({ id: 'funding', type: 'transfer_in', asset: 'USDT', amount: 4, source: 'binance', raw: { Account: 'Funding' } }),
      tx({ id: 'margin', type: 'buy', asset: 'USDT', amount: 5, source: 'binance', raw: { buy: { Account: 'Cross Margin' }, spend: { Account: 'Cross Margin' } } }),
      tx({ id: 'futures', type: 'income', asset: 'USDT', amount: 7, fiatValue: 7, source: 'binance', category: 'perp_profit', instrumentClass: 'derivative', raw: { Account: 'USD-M Futures' } }),
      tx({ id: 'options', type: 'transfer_in', asset: 'USDT', amount: 3, source: 'binance_options' })
    ];
    const result = reconcileHoldings(buildPortfolioHoldings(txs), txs, [], [
      exchangeBalanceRow({ asset: 'USDT', amount: 10 })
    ]);
    expect(result.holdings).toHaveLength(1);
    // Spot/Funding/Margin are one centralized-custody journal and are replaced
    // by the current API snapshot. Futures PnL and Options remain additive.
    expect(result.holdings[0]).toMatchObject({ asset: 'USDT', amount: 20 });
  });

  it('does not revive gross Transaction History account movements beside API authority', () => {
    const txs = [
      tx({ id: 'api-uni', type: 'buy', asset: 'UNI', amount: 120.0014, source: 'binance_api', importBatchId: 'conn1' }),
      tx({ id: 'history-usdt', type: 'transfer_in', asset: 'USDT', amount: 188_126.0707, source: 'binance', raw: { Account: 'Funding' } }),
      tx({ id: 'history-sol', type: 'transfer_in', asset: 'SOL', amount: 969.9634, source: 'binance', raw: { Account: 'Cross Margin' } }),
      tx({ id: 'history-busd', type: 'transfer_in', asset: 'BUSD', amount: 120_473.93, source: 'binance', raw: { Account: 'Spot' } }),
      tx({ id: 'options-usdt', type: 'transfer_in', asset: 'USDT', amount: 119.5193, source: 'binance_options' })
    ];
    const result = reconcileHoldings(buildPortfolioHoldings(txs), txs, [], [
      exchangeBalanceRow({ asset: 'UNI', amount: 120.0014 })
    ]);
    expect(result.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: 'UNI', amount: 120.0014, qtySource: 'exchange-api' }),
      expect.objectContaining({ asset: 'USDT', amount: 119.5193 })
    ]));
    expect(result.holdings.map((holding) => holding.asset)).not.toEqual(expect.arrayContaining(['SOL', 'BUSD']));
  });

  it('wallet and exchange slices reconcile independently within one holding', () => {
    // BTC on-chain (bitcoin) and BTC on Binance are SEPARATE holdings (chain
    // keying) — this test guards that an exchange balance row does NOT touch
    // the on-chain holding and vice versa.
    const txs = [
      tx({ id: 'w-in', type: 'transfer_in', asset: 'BTC', amount: 3, source: 'rpc:blockstream', chain: 'bitcoin', walletAddress: BTC_ADDR }),
      tx({ id: 'e-buy', type: 'buy', asset: 'BTC', amount: 1, source: 'binance', importBatchId: 'conn1' })
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

  it('explains chainless manual native SOL together with a same-chain wallet outflow', () => {
    const address = 'PhantomCase111111111111111111111111111';
    const transactions = [
      tx({ id: 'manual-sol', type: 'transfer_in', asset: 'SOL', amount: 10, source: 'manual' }),
      tx({
        id: 'wallet-send', type: 'transfer_out', asset: 'SOL', amount: 2.5,
        source: 'rpc:helius', chain: 'solana', walletAddress: address
      })
    ];
    const slices = sourceBreakdown(
      transactions,
      { asset: 'SOL', chain: 'solana' },
      [{ id: `solana:${address}`, chain: 'solana', address, label: 'Phantom', lastSyncedAt: 1, txCount: 1 }]
    );

    expect(slices).toEqual([
      expect.objectContaining({ key: 'source:manual', qty: 10 }),
      expect.objectContaining({ key: `wallet:solana:solana:${address}`, name: 'Phantom', qty: -2.5 })
    ]);
    expect(slices.reduce((sum, slice) => sum + slice.qty, 0)).toBe(7.5);
  });

  it('uses chain-scoped wallet authority for the same EVM address regardless of transaction order', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const transactions = [
      tx({ id: 'eth', type: 'transfer_in', asset: 'ETH', amount: 1, chain: 'ethereum', walletAddress: address, source: 'rpc:alchemy' }),
      tx({ id: 'base', type: 'transfer_in', asset: 'ETH', amount: 2, chain: 'base', walletAddress: address, source: 'rpc:alchemy' }),
      tx({ id: 'arb', type: 'transfer_in', asset: 'ETH', amount: 3, chain: 'arbitrum', walletAddress: address, source: 'rpc:alchemy' })
    ];
    const wallets = [
      { id: `ethereum:${address}`, chain: 'ethereum', address, label: 'Main', lastSyncedAt: 1, txCount: 1 },
      { id: `base:${address}`, chain: 'base', address, label: 'Main', lastSyncedAt: 1, txCount: 1 },
      { id: `arbitrum:${address}`, chain: 'arbitrum', address, label: 'Main', lastSyncedAt: 1, txCount: 1 }
    ];
    const balances = [
      balanceRow({ id: 'eth-balance', chain: 'ethereum', address, asset: 'ETH', amount: 10 }),
      balanceRow({ id: 'base-balance', chain: 'base', address, asset: 'ETH', amount: 20 }),
      balanceRow({ id: 'arb-balance', chain: 'arbitrum', address, asset: 'ETH', amount: 30 })
    ];
    for (const ordered of [transactions, [...transactions].reverse()]) {
      expect(sourceBreakdown(ordered, { asset: 'ETH', chain: 'ethereum' }, wallets, balances)).toEqual([
        expect.objectContaining({ key: `wallet:evm:1:${address}`, qty: 10 })
      ]);
      expect(sourceBreakdown(ordered, { asset: 'ETH', chain: 'base' }, wallets, balances)).toEqual([
        expect.objectContaining({ key: `wallet:evm:8453:${address}`, qty: 20 })
      ]);
      expect(sourceBreakdown(ordered, { asset: 'ETH', chain: 'arbitrum' }, wallets, balances)).toEqual([
        expect.objectContaining({ key: `wallet:evm:42161:${address}`, qty: 30 })
      ]);
    }
  });
});
