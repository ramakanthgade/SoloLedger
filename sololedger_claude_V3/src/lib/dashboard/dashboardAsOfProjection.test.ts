import { describe, expect, it } from 'vitest';
import type { TaxSettings, Transaction } from '@/types/transaction';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow, EndpointProof } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { projectDashboardAsOf } from './dashboardAsOfProjection';

const DAY = 86_400_000;
const START = Date.UTC(2026, 3, 1);
const END = Date.UTC(2026, 3, 3);
const NOW = Date.UTC(2026, 3, 10);

const settings = {
  jurisdiction: 'IN', reportingCurrency: 'INR', defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false, rpcLookupEnabled: false
} as TaxSettings;

function tx(id: string, overrides: Partial<Transaction>): Transaction {
  return {
    id, timestamp: START, type: 'other', asset: 'INR', amount: 0,
    fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false,
    ...overrides
  };
}

function opening(id: string, assetKey: string, asset: string, quantity: number): OpeningBalanceRow {
  return {
    id, logicalKey: id, scopeId: 'manual', accountClass: 'manual', assetKey, asset,
    absoluteQuantity: quantity, effectiveAt: START - DAY, provenance: 'user_confirmed',
    createdAt: 1, updatedAt: 1
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const transactions: Transaction[] = [
    tx('buy', { timestamp: START - DAY, type: 'buy', asset: 'BTC', amount: 2, fiatValue: 100 }),
    tx('sell', { timestamp: START + 1, type: 'sell', asset: 'BTC', amount: 1, fiatValue: 100, tdsInr: 1 }),
    tx('in', { timestamp: START + 2, type: 'transfer_in', amount: 30, fiatValue: 30 }),
    tx('out', { timestamp: START + 3, type: 'transfer_out', amount: 10, fiatValue: 10 }),
    tx('income', { timestamp: START + 4, type: 'income', amount: 20, fiatValue: 20, category: 'staking_reward' }),
    tx('expense', { timestamp: START + 5, type: 'other', fiatValue: 7, category: 'margin_fee' }),
    tx('fee', { timestamp: START + 6, type: 'fee', amount: 2, fiatValue: 2 }),
    tx('internal-in', { timestamp: START + 7, type: 'transfer_in', amount: 5, fiatValue: 5, isInternalTransfer: true }),
    tx('internal-out', { timestamp: START + 7, type: 'transfer_out', amount: 5, fiatValue: 5, isInternalTransfer: true }),
    tx('future', { timestamp: END + 1, type: 'transfer_in', amount: 999, fiatValue: 999 })
  ];
  return {
    transactions, exchangeConnections: [],
    openingBalances: [opening('debt', 'liability:aave-v3-ethereum:USDT', 'USDT', 10)],
    authoritySnapshots: [], authorityAssets: [], sourceCoverage: [],
    priceCache: [
      { key: 'sym:BTC:03-04-2026:INR', price: 80, fetchedAt: 1 },
      { key: 'sym:USDT:03-04-2026:INR', price: 1, fetchedAt: 1 }
    ],
    settings, nominalStart: START, nominalEnd: END, effectiveEnd: END, nowMs: NOW,
    specIdHints: {}, safetyDecisions: [], chartSamples: [START - DAY, END, END + 1],
    ...overrides
  };
}

describe('dashboard as-of projection', () => {
  // Ledger-history direction reference; these tests assert SoloLedger's own
  // authority, India tax, fee, ROI, and partial-valuation contracts:
  // https://support.koinly.io/en/articles/9490040-my-graph-is-incorrect
  it('replays pre-period inventory/liability through cutoff but scopes period activity', () => {
    const result = projectDashboardAsOf(baseInput());
    expect(result.contributors.find((row) => row.asset === 'BTC')).toMatchObject({
      signedQuantity: 1, costBasis: 50, marketValue: 80, roi: 0.6
    });
    expect(result.contributors.find((row) => row.kind === 'liability')).toMatchObject({
      signedQuantity: -10, marketValue: -10
    });
    expect(result.contributors.some((row) => row.signedQuantity === 999)).toBe(false);
    expect(result.period.in.transactionIds).toEqual(['in']);
    expect(result.period.out.transactionIds).toEqual(['out']);
    expect(result.period.income.transactionIds).toEqual(['income']);
    expect(result.period.expenses.transactionIds).toEqual(['expense']);
    expect(result.period.tradingFees.transactionIds).toEqual(['fee']);
    expect(result.period.realizedCapitalGains).toMatchObject({ value: 50, transactionIds: ['sell'] });
    expect(result.estimatedTax).toBe(15.6);
    expect(result.tds).toBe(1);
    expect(result.chart.map((point) => point.timestamp)).toEqual([START - DAY, END]);
    expect(result.chart.map((point) => point.costBasis)).toEqual([100, 70]);
  });

  it.each([
    ['US', 'USD'], ['CA', 'CAD'], ['AE', 'AED']
  ] as const)('does not expose India tax or INR TDS totals for %s', (jurisdiction, reportingCurrency) => {
    const result = projectDashboardAsOf(baseInput({
      settings: { ...settings, jurisdiction, reportingCurrency },
      priceCache: []
    }));
    expect(result.estimatedTax).toBe(0);
    expect(result.tds).toBe(0);
  });

  it('keeps an unpriced asset and liability as missing contributors without zero filling', () => {
    const result = projectDashboardAsOf(baseInput({ priceCache: [] }));
    expect(result.totalNetWorth.value).toBe(38); // direct-INR ledger quantity only
    expect(result.totalNetWorth).toMatchObject({
      valuationStatus: 'estimated', valuationCompleteness: 'partial',
      missingAssetCount: 1, missingLiabilityCount: 1
    });
    expect(result.contributors.filter((row) => row.marketValue == null).map((row) => row.asset).sort())
      .toEqual(['BTC', 'USDT']);
  });

  it('keeps unexplained negative custody unavailable and never treats it as debt', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [tx('out-without-history', {
        timestamp: START, type: 'transfer_out', asset: 'BTC', amount: 2, fiatValue: 200
      })],
      openingBalances: [],
      priceCache: [{ key: 'sym:BTC:03-04-2026:INR', price: 100, fetchedAt: 1 }]
    }));
    const row = result.contributors.find((candidate) => candidate.asset === 'BTC');
    expect(row).toMatchObject({ kind: 'asset', signedQuantity: -2, marketValue: undefined, quantityStatus: 'unavailable' });
    expect(row?.reasons).toContain('missing_opening_balance');
    expect(result.totalNetWorth.value).toBe(0);
    expect(result.totalNetWorth.missingAssetCount).toBe(1);
  });

  it('marks remaining cost and unrealized results partial when positive custody lacks lot basis', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [tx('deposit', {
        timestamp: START, type: 'transfer_in', asset: 'BTC', amount: 2, fiatValue: 200
      })],
      openingBalances: [],
      priceCache: [{ key: 'sym:BTC:03-04-2026:INR', price: 100, fetchedAt: 1 }]
    }));
    expect(result.contributors.find((row) => row.asset === 'BTC')).toMatchObject({ marketValue: 200, costBasis: undefined });
    expect(result.costBasis).toMatchObject({ value: 0, valuationCompleteness: 'partial', missingAssetCount: 1 });
    expect(result.unrealizedPnl.valuationCompleteness).toBe('partial');
  });

  it('does not publish row ROI or P&L when only part of a quantity has basis', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [
        tx('known-buy', { timestamp: START - DAY, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 50 }),
        tx('unknown-deposit', { timestamp: START, type: 'transfer_in', asset: 'BTC', amount: 1, fiatValue: 100 })
      ],
      openingBalances: [],
      priceCache: [{ key: 'sym:BTC:03-04-2026:INR', price: 100, fetchedAt: 1 }]
    }));
    expect(result.contributors.find((row) => row.asset === 'BTC')).toMatchObject({
      signedQuantity: 2, marketValue: 200, costBasis: undefined, roi: undefined
    });
    expect(result.costBasis).toMatchObject({ value: 50, valuationCompleteness: 'partial' });
    expect(result.unrealizedPnl).toMatchObject({ value: 0, valuationCompleteness: 'partial' });
    expect(result.unrealizedPnl.contributorIds).not.toContain('asset:BTC');
  });

  it('classifies fee-typed financing costs as Expenses and execution fees as Trading Fees', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [
        tx('funding', { type: 'fee', category: 'funding_fee', fiatValue: 3 }),
        tx('loan', { type: 'fee', category: 'loan_fee', fiatValue: 4 }),
        tx('margin', { type: 'fee', category: 'margin_fee', fiatValue: 5 }),
        tx('execution', { type: 'fee', category: 'other_fee', fiatValue: 6 }),
        tx('embedded-execution', { type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100,
          feeAmount: 2, feeAsset: 'INR' })
      ], openingBalances: [], priceCache: []
    }));
    expect(result.period.expenses.transactionIds).toEqual(['funding', 'loan', 'margin']);
    expect(result.period.expenses.value).toBe(12);
    expect(result.period.tradingFees.transactionIds).toEqual(['execution', 'embedded-execution']);
    expect(result.period.tradingFees.value).toBe(8);
  });

  it('keeps same-symbol contracts separate for remaining basis and historical marks', () => {
    const contractA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const contractB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = projectDashboardAsOf(baseInput({
      transactions: [
        tx('buy-a', { timestamp: START - DAY, type: 'buy', asset: 'TOK', chain: 'ethereum',
          contractAddress: contractA, amount: 1, fiatValue: 50 }),
        tx('buy-b', { timestamp: START - DAY, type: 'buy', asset: 'TOK', chain: 'ethereum',
          contractAddress: contractB, amount: 1, fiatValue: 150 })
      ], openingBalances: [], priceCache: [
        { key: `ctr:ethereum:${contractA}:03-04-2026:INR`, price: 100, fetchedAt: 1 },
        { key: `ctr:ethereum:${contractB}:03-04-2026:INR`, price: 300, fetchedAt: 1 }
      ]
    }));
    expect(result.contributors.filter((row) => row.asset === 'TOK').map((row) => ({
      assetKey: row.assetKey, marketValue: row.marketValue, costBasis: row.costBasis
    }))).toEqual([
      { assetKey: `evm:1:${contractA}`, marketValue: 100, costBasis: 50 },
      { assetKey: `evm:1:${contractB}`, marketValue: 300, costBasis: 150 }
    ]);
  });

  it('applies India positive matched-lot gains without offsetting loss lots', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [
        tx('buy-loss', { timestamp: START - 2, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100 }),
        tx('sell-loss', { timestamp: START + 1, type: 'sell', asset: 'BTC', amount: 1, fiatValue: 50 }),
        tx('buy-gain', { timestamp: START + 2, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100 }),
        tx('sell-gain', { timestamp: START + 3, type: 'sell', asset: 'BTC', amount: 1, fiatValue: 200 })
      ],
      openingBalances: []
    }));
    expect(result.period.realizedCapitalGains).toMatchObject({ value: 100, transactionIds: ['sell-gain'] });
    expect(result.estimatedTax).toBe(31.2);
  });

  it('keeps the winning matched row when one disposal also consumes a losing lot', () => {
    const result = projectDashboardAsOf(baseInput({
      transactions: [
        tx('buy-win', { timestamp: START - 2, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 50 }),
        tx('buy-loss', { timestamp: START - 1, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 300 }),
        tx('sell-mixed', { timestamp: START + 1, type: 'sell', asset: 'BTC', amount: 2, fiatValue: 300 })
      ],
      openingBalances: []
    }));
    expect(result.period.realizedCapitalGains).toMatchObject({
      value: 100,
      transactionIds: ['sell-mixed']
    });
  });

  it('recomputes historical totals after opening/price remediation', () => {
    const initial = projectDashboardAsOf(baseInput());
    const changed = projectDashboardAsOf(baseInput({
      openingBalances: [opening('debt', 'liability:aave-v3-ethereum:USDT', 'USDT', 20)],
      priceCache: [
        { key: 'sym:BTC:03-04-2026:INR', price: 100, fetchedAt: 2 },
        { key: 'sym:USDT:03-04-2026:INR', price: 1, fetchedAt: 2 }
      ]
    }));
    expect(changed.totalNetWorth.value).toBe(initial.totalNetWorth.value + 10);
  });

  it('recomputes cost, gains, and tax for append, backfill, prefix edit, cutoff, method, and SpecID changes', () => {
    const cheap = tx('cheap-recalc', {
      timestamp: START - 2 * DAY, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100
    });
    const expensive = tx('expensive-recalc', {
      timestamp: START - DAY, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 300
    });
    const sale = tx('sale-recalc', {
      timestamp: START + 1, type: 'sell', asset: 'BTC', amount: 1, fiatValue: 500
    });
    const input = (transactions: Transaction[], overrides: Record<string, unknown> = {}) => baseInput({
      transactions, openingBalances: [], priceCache: [], chartSamples: [END], ...overrides
    });

    const beforeBackfill = projectDashboardAsOf(input([expensive, sale]));
    expect(beforeBackfill).toMatchObject({
      costBasis: { value: 0 },
      period: { realizedCapitalGains: { value: 200 } },
      estimatedTax: 62.4
    });

    const backfilled = projectDashboardAsOf(input([cheap, expensive, sale]));
    expect(backfilled).toMatchObject({
      costBasis: { value: 300 },
      period: { realizedCapitalGains: { value: 400 } },
      estimatedTax: 124.8
    });

    const editedPrefix = projectDashboardAsOf(input([
      cheap, { ...expensive, fiatValue: 700 }, sale
    ]));
    expect(editedPrefix.costBasis.value).toBe(700);

    const beforeSale = projectDashboardAsOf(input([cheap, expensive, sale], {
      nominalStart: START - 3 * DAY, nominalEnd: START, effectiveEnd: START,
      chartSamples: [START]
    }));
    expect(beforeSale.costBasis.value).toBe(400);
    expect(beforeSale.period.realizedCapitalGains.value).toBe(0);

    const lifo = projectDashboardAsOf(input([cheap, expensive, sale], {
      settings: { ...settings, defaultCostBasisMethod: 'LIFO' }
    }));
    expect(lifo).toMatchObject({
      costBasis: { value: 100 }, period: { realizedCapitalGains: { value: 200 } }
    });

    const specId = projectDashboardAsOf(input([cheap, expensive, sale], {
      settings: { ...settings, defaultCostBasisMethod: 'SpecID' },
      specIdHints: { [sale.id]: [`lot:${expensive.id}`] }
    }));
    expect(specId).toMatchObject({
      costBasis: { value: 100 }, period: { realizedCapitalGains: { value: 200 } }
    });

    const appended = projectDashboardAsOf(input([
      cheap, expensive, sale,
      tx('chronological-append', {
        timestamp: START + 2, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 50
      })
    ]));
    expect(appended.costBasis.value).toBe(350);
  });

  it('recomputes projection when exact-asset safety policy changes', () => {
    const contract = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenBuy = tx('safety-buy', {
      timestamp: START - DAY, type: 'buy', asset: 'TOK', chain: 'ethereum',
      contractAddress: contract, amount: 2, fiatValue: 200
    });
    const visible = projectDashboardAsOf(baseInput({
      transactions: [tokenBuy], openingBalances: [], priceCache: []
    }));
    expect(visible.costBasis.value).toBe(200);

    const hidden = projectDashboardAsOf(baseInput({
      transactions: [tokenBuy], openingBalances: [], priceCache: [],
      safetyDecisions: [{
        subjectKey: `asset:ethereum:${contract}`, state: 'user_hidden',
        updatedAt: NOW, origin: 'user'
      }]
    }));
    expect(hidden.costBasis.value).toBe(0);
    expect(hidden.contributors).toEqual([]);
  });

  it('prices a debt-only DeFi underlying and subtracts the explicit liability', () => {
    const scope = `wallet:evm:0x${'1'.repeat(40)}`;
    const custodySnapshot: AuthoritySnapshotRow = {
      snapshotId: 'custody', generation: 1, scopeId: scope, authorityKind: 'rpc',
      authorityClass: 'wallet_balance', accountClass: 'wallet', coveredAccountClasses: ['wallet'],
      asOf: NOW, capturedAt: NOW, sourceIdentityId: 'wallet', status: 'complete',
      endpointProof: {
        authorityKind: 'rpc', provider: 'fixture', operation: 'balances', parametersClass: 'full',
        requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
      }
    };
    const protocols = ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'] as const;
    const snapshots = protocols.map((protocolId) => ({
      snapshotId: `position:${protocolId}`, generation: 1, accountIdentityScope: scope,
      protocolId, chainId: 1, status: 'complete' as const, capturedAt: NOW, blockNumber: 99,
      evidence: [{ provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: 99, detail: 'fixture' }]
    }));
    const contract = '0x1111111111111111111111111111111111111112';
    const debtToken = '0x1111111111111111111111111111111111111113';
    const result = projectDashboardAsOf(baseInput({
      transactions: [], openingBalances: [], nominalEnd: NOW, effectiveEnd: NOW,
      authoritySnapshots: [custodySnapshot], authorityAssets: [], sourceCoverage: [],
      defiPositionSnapshots: snapshots,
      defiPositionRows: [{
        id: 'debt-only', snapshotId: 'position:aave-v3-ethereum', protocolId: 'aave-v3-ethereum',
        reserveKey: contract, role: 'debt', quantity: 2, rawQuantity: '2000000', debtRateMode: 'variable',
        underlying: { chainId: 1, contractAddress: contract, symbol: 'USDC', decimals: 6 },
        protocolToken: { chainId: 1, contractAddress: debtToken, symbol: 'variableDebtUSDC', decimals: 6 }
      }],
      walletDefiRefreshManifests: [{
        accountIdentityScope: scope, custodyScopeId: scope, custodySnapshotId: 'custody', custodyGeneration: 1,
        custodyAsOf: NOW, blockNumber: 99, capturedAt: NOW,
        protocolSnapshotIds: Object.fromEntries(snapshots.map((row) => [row.protocolId, row.snapshotId]))
      }],
      priceCache: [{ key: `spot:ctr:ethereum:${contract}:INR`, price: 100, fetchedAt: NOW }]
    }));
    expect(result.currentAuthority).toMatchObject({ status: 'authoritative', comparable: true });
    expect(result.contributors.find((row) => row.kind === 'liability')).toMatchObject({
      asset: 'USDC', signedQuantity: -2, marketValue: -200
    });
    expect(result.totalNetWorth.value).toBe(-200);

    const supplyContract = '0x2222222222222222222222222222222222222222';
    const partial = projectDashboardAsOf(baseInput({
      transactions: [], openingBalances: [], nominalEnd: NOW, effectiveEnd: NOW,
      authoritySnapshots: [custodySnapshot], authorityAssets: [], sourceCoverage: [],
      defiPositionSnapshots: snapshots,
      defiPositionRows: [
        {
          id: 'valid-supply', snapshotId: 'position:aave-v3-ethereum', protocolId: 'aave-v3-ethereum',
          reserveKey: supplyContract, role: 'supply', quantity: 1, rawQuantity: '1000000', isCollateral: true,
          underlying: { chainId: 1, contractAddress: supplyContract, symbol: 'SUP', decimals: 6 },
          protocolToken: { chainId: 1, contractAddress: `${supplyContract.slice(0, -1)}3`, symbol: 'aSUP', decimals: 6 }
        },
        {
          id: 'missing-debt', snapshotId: 'position:aave-v3-ethereum', protocolId: 'aave-v3-ethereum',
          reserveKey: contract, role: 'debt', quantity: 2, rawQuantity: '2000000', debtRateMode: 'variable',
          underlying: { chainId: 1, contractAddress: contract, symbol: 'DEBT', decimals: 6 },
          protocolToken: { chainId: 1, contractAddress: debtToken, symbol: 'variableDebt', decimals: 6 }
        }
      ],
      walletDefiRefreshManifests: [{
        accountIdentityScope: scope, custodyScopeId: scope, custodySnapshotId: 'custody', custodyGeneration: 1,
        custodyAsOf: NOW, blockNumber: 99, capturedAt: NOW,
        protocolSnapshotIds: Object.fromEntries(snapshots.map((row) => [row.protocolId, row.snapshotId]))
      }],
      priceCache: [{ key: `spot:ctr:ethereum:${supplyContract}:INR`, price: 100, fetchedAt: NOW }]
    }));
    expect(partial.currentAuthority).toMatchObject({ status: 'unavailable', comparable: false });
    expect(partial.contributors.find((row) => row.asset === 'SUP')).toMatchObject({ marketValue: 100 });
    expect(partial.contributors.find((row) => row.asset === 'DEBT')).toMatchObject({ marketValue: undefined });
    expect(partial.totalNetWorth).toMatchObject({ value: 100, valuationCompleteness: 'partial', missingLiabilityCount: 1 });
  });

  it('uses current authority at now but never rewinds it into a historical point', () => {
    const proof: EndpointProof = {
      authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot',
      requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
    };
    const snapshot: AuthoritySnapshotRow = {
      snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', authorityKind: 'api',
      authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
      asOf: NOW, capturedAt: NOW, sourceIdentityId: 'c1', endpointProof: proof, status: 'complete'
    };
    const asset: AuthorityAssetRow = {
      id: 'a1', snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', accountClass: 'spot',
      assetKey: 'asset:BTC', asset: 'BTC', quantity: 7
    };
    const coverage: SourceCoverageRow = {
      id: 'c', generation: 1, scopeId: 'exchange:c1', sourceIdentityId: 'c1', evidenceId: 'e',
      kind: 'api', accountClasses: ['spot'], endpoints: ['history'], authoritySnapshotId: 's1',
      authorityAsOf: NOW, requestedHistoryStart: 0, requestedHistoryEnd: NOW,
      observedHistoryStart: 0, observedHistoryEnd: NOW, startedAt: 0, completedAt: NOW,
      status: 'complete', paginationExhausted: true,
      endpointOutcomes: [{
        endpoint: 'history', accountClass: 'spot', required: true, status: 'complete',
        requestedStart: 0, requestedEnd: NOW, observedStart: 0, observedEnd: NOW,
        paginationRequired: true, paginationExhausted: true
      }]
    };
    const apiBuy = tx('api-buy', {
      timestamp: START - DAY, type: 'buy', asset: 'BTC', amount: 2, fiatValue: 100,
      source: 'binance_api', importBatchId: 'c1', parserAccountClass: 'spot'
    });
    const shared = {
      ...baseInput(), transactions: [apiBuy], exchangeConnections: [{ id: 'c1', exchange: 'binance' }],
      openingBalances: [], authoritySnapshots: [snapshot], authorityAssets: [asset], sourceCoverage: [coverage]
    };
    const historical = projectDashboardAsOf({ ...shared, effectiveEnd: END });
    expect(historical.contributors.find((row) => row.asset === 'BTC')?.signedQuantity).toBe(2);
    const current = projectDashboardAsOf({
      ...shared, nominalEnd: NOW, effectiveEnd: NOW,
      priceCache: [{ key: 'spot:sym:BTC:INR', price: 100, fetchedAt: NOW }]
    });
    expect(current.contributors.find((row) => row.asset === 'BTC')?.signedQuantity).toBe(7);
    expect(current.currentAuthority).toMatchObject({ status: 'authoritative', comparable: true });

    const methodTransactions = [
      tx('cheap', { timestamp: START - 2 * DAY, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100,
        source: 'binance_api', importBatchId: 'c1', parserAccountClass: 'spot' }),
      tx('expensive', { timestamp: START - DAY, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 300,
        source: 'binance_api', importBatchId: 'c1', parserAccountClass: 'spot' }),
      tx('method-sale', { timestamp: START, type: 'sell', asset: 'BTC', amount: 1, fiatValue: 500,
        source: 'binance_api', importBatchId: 'c1', parserAccountClass: 'spot' })
    ];
    const methodBase = {
      ...shared, transactions: methodTransactions, nominalEnd: NOW, effectiveEnd: NOW,
      authorityAssets: [{ ...asset, quantity: 1 }],
      priceCache: [{ key: 'spot:sym:BTC:INR', price: 500, fetchedAt: NOW }]
    };
    const fifoHolding = projectDashboardAsOf(methodBase).contributors.find((row) => row.asset === 'BTC');
    const lifoHolding = projectDashboardAsOf({
      ...methodBase, settings: { ...settings, defaultCostBasisMethod: 'LIFO' }
    }).contributors.find((row) => row.asset === 'BTC');
    expect(fifoHolding).toMatchObject({ costBasis: 300, roi: (500 - 300) / 300 });
    expect(lifoHolding).toMatchObject({ costBasis: 100, roi: 4 });

    const restored = projectDashboardAsOf({
      ...shared, nominalEnd: NOW, effectiveEnd: NOW,
      authoritySnapshots: [{ ...snapshot, restoredAt: NOW }],
      priceCache: [{ key: 'spot:sym:BTC:INR', price: 100, fetchedAt: NOW }]
    });
    expect(restored.currentAuthority).toMatchObject({ status: 'unavailable', comparable: false });
    expect(restored.contributors.find((row) => row.asset === 'BTC')).toMatchObject({ marketValue: undefined });

    const csvSnapshot: AuthoritySnapshotRow = {
      ...snapshot, authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: undefined,
      endpointProof: { ...proof, authorityKind: 'csv', operation: 'journal', parametersClass: 'untimestamped' }
    };
    const nonComparableCsv = projectDashboardAsOf({
      ...shared, nominalEnd: NOW, effectiveEnd: NOW,
      authoritySnapshots: [csvSnapshot],
      sourceCoverage: [{
        ...coverage, kind: 'csv', status: 'unknown', parserId: 'binance', supportedParser: true,
        declaredCompleteHistory: undefined, requiredSheets: ['journal'], presentSheets: ['journal'],
        recognizedCount: 1, parsedCount: 1, dedupedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
        endpointOutcomes: [{ endpoint: 'history', parserId: 'binance', accountClass: 'spot', required: true, status: 'complete' }]
      } as SourceCoverageRow],
      priceCache: [{ key: 'spot:sym:BTC:INR', price: 100, fetchedAt: NOW }]
    });
    expect(nonComparableCsv.currentAuthority).toMatchObject({ status: 'unavailable', comparable: false });
    expect(nonComparableCsv.contributors.find((row) => row.asset === 'BTC')?.marketValue).toBeUndefined();
  });
});
