import { describe, expect, it } from 'vitest';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import {
  buildDerivativeBusinessExpenseRows,
  buildDerivativeBusinessIncomeRows,
  buildDerivativeCapitalGainRows,
  buildMatchedGainRows
} from '@/lib/costBasis/matchedGains';
import {
  buildHoldingsProjection,
  type HoldingsProjectionInput,
  type ProjectedPortfolioHolding as UnifiedHolding
} from '@/lib/portfolio/holdingsProjection';
import type { AuthoritySelection } from '@/lib/reconcile/authoritySelection';
import type {
  AuthorityAssetRow,
  AuthoritySnapshotRow,
  EndpointProof
} from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import { buildScheduleVdaReport, serializeScheduleVdaCsv } from '@/lib/reports/scheduleVDA';
import { summarizeYear } from '@/lib/tax/jurisdictions';
import type { Transaction } from '@/types/transaction';
import { deriveTransactionPostings, type DerivedPosting, type OpeningBalanceRow } from './derivedPostings';
import { normalizeImportedTransactionCategory } from '@/lib/taxonomy/categories';

const DAY = 86_400_000;
const START = Date.UTC(2024, 4, 1);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
}

function transactionHash(transactions: readonly Transaction[]): string {
  let hash = 2_166_136_261;
  for (const character of JSON.stringify(transactions)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function taxFixture(): Transaction[] {
  return deepFreeze([
    {
      id: 'btc-buy', timestamp: START, type: 'buy', asset: 'BTC', amount: 2,
      fiatCurrency: 'INR', fiatValue: 200, source: 'manual', flags: [], isInternalTransfer: false
    },
    {
      id: 'btc-gain', timestamp: START + 10 * DAY, type: 'sell', asset: 'BTC', amount: 1,
      fiatCurrency: 'INR', fiatValue: 180, source: 'manual', flags: [], isInternalTransfer: false
    },
    {
      id: 'btc-loss', timestamp: START + 11 * DAY, type: 'sell', asset: 'BTC', amount: 1,
      fiatCurrency: 'INR', fiatValue: 50, source: 'manual', flags: [], isInternalTransfer: false
    },
    {
      id: 'eth-unmatched', timestamp: START + 12 * DAY, type: 'sell', asset: 'ETH', amount: 2,
      fiatCurrency: 'INR', fiatValue: 60, source: 'manual', flags: [], isInternalTransfer: false
    },
    {
      id: 'perp-profit', timestamp: START + 20 * DAY, type: 'income', asset: 'USDC', amount: 40,
      fiatCurrency: 'INR', fiatValue: 40, source: 'hyperliquid_trades', category: 'perp_profit',
      instrumentClass: 'derivative', raw: { coin: 'ETH', ntl: '1000', closedPnl: '40', sz: '1' },
      flags: [], isInternalTransfer: false
    },
    {
      id: 'perp-loss', timestamp: START + 21 * DAY, type: 'fee', asset: 'USDC', amount: 10,
      feeAsset: 'USDC', feeAmount: 10, fiatCurrency: 'INR', fiatValue: 10,
      source: 'hyperliquid_trades', category: 'perp_loss', instrumentClass: 'derivative',
      raw: { coin: 'ETH', ntl: '900', closedPnl: '-10', sz: '1' }, flags: [], isInternalTransfer: false
    },
    {
      id: 'current-custody', timestamp: START + 25 * DAY, type: 'transfer_in', asset: 'ADA', amount: 2,
      fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'current', parserAccountClass: 'spot',
      flags: [], isInternalTransfer: false
    },
    {
      id: 'stale-custody', timestamp: START + 26 * DAY, type: 'transfer_in', asset: 'SOL', amount: 3,
      fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'stale', parserAccountClass: 'spot',
      flags: [], isInternalTransfer: false
    }
  ] satisfies Transaction[]);
}

function authorityProof(): EndpointProof {
  return {
    authorityKind: 'api',
    provider: 'binance',
    operation: 'ccxt.fetchBalance',
    parametersClass: 'defaultType=spot',
    requestedAccountClasses: ['spot'],
    provenAccountClasses: ['spot'],
    exhaustiveBalances: true
  };
}

function custodyProjectionEvidence(): Omit<HoldingsProjectionInput, 'transactions'> {
  const now = START + 30 * DAY;
  const snapshots: AuthoritySnapshotRow[] = [
    {
      snapshotId: 'current-snapshot', generation: 1, scopeId: 'exchange:current',
      authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
      coveredAccountClasses: ['spot'], asOf: now, capturedAt: now, sourceIdentityId: 'current',
      endpointProof: authorityProof(), status: 'complete'
    },
    {
      snapshotId: 'stale-snapshot', generation: 1, scopeId: 'exchange:stale',
      authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
      coveredAccountClasses: ['spot'], asOf: now - DAY - 1, capturedAt: now - DAY - 1,
      sourceIdentityId: 'stale', endpointProof: authorityProof(), status: 'complete'
    },
    {
      snapshotId: 'options-snapshot', generation: 1, scopeId: 'file:options-file:options',
      authorityKind: 'csv', authorityClass: 'journal_final_balance', accountClass: 'options',
      coveredAccountClasses: ['options'], capturedAt: now, sourceIdentityId: 'options-file',
      endpointProof: {
        ...authorityProof(), authorityKind: 'csv', provider: 'binance_options',
        operation: 'parser_final_balance', parametersClass: 'parser_final_balance_without_source_timestamp',
        requestedAccountClasses: ['options'], provenAccountClasses: ['options']
      }, status: 'complete'
    }
  ];
  const assets: AuthorityAssetRow[] = [
    {
      id: 'current-ada', snapshotId: 'current-snapshot', generation: 1, scopeId: 'exchange:current',
      accountClass: 'spot', assetKey: 'asset:ADA', asset: 'ADA', quantity: 9
    },
    {
      id: 'stale-sol', snapshotId: 'stale-snapshot', generation: 1, scopeId: 'exchange:stale',
      accountClass: 'spot', assetKey: 'asset:SOL', asset: 'SOL', quantity: 12
    },
    {
      id: 'options-usdt', snapshotId: 'options-snapshot', generation: 1,
      scopeId: 'file:options-file:options', accountClass: 'options',
      assetKey: 'asset:USDT', asset: 'USDT', quantity: 119.5193
    }
  ];
  const coverage = (source: 'current' | 'stale', snapshotId: string, authorityAsOf: number): SourceCoverageRow => ({
    id: `${source}-coverage`, generation: 1, scopeId: `exchange:${source}`,
    sourceIdentityId: source, evidenceId: `${source}-history`, kind: 'api', accountClasses: ['spot'],
    endpoints: ['history'], authoritySnapshotId: snapshotId, authorityAsOf,
    requestedHistoryStart: 0, requestedHistoryEnd: now, observedHistoryStart: 0,
    observedHistoryEnd: now, startedAt: 0, completedAt: now, status: 'complete',
    paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: 'history', accountClass: 'spot', required: true, status: 'complete',
      requestedStart: 0, requestedEnd: now, observedStart: 0, observedEnd: now,
      paginationRequired: true, paginationExhausted: true
    }]
  });
  const openingBalances: OpeningBalanceRow[] = [{
    id: 'current-ada-opening', logicalKey: 'exchange:current|spot|asset:ADA',
    scopeId: 'exchange:current', accountClass: 'spot', assetKey: 'asset:ADA', asset: 'ADA',
    absoluteQuantity: 5, effectiveAt: START + 24 * DAY, provenance: 'source_snapshot',
    evidenceRef: 'current-opening-evidence', createdAt: now, updatedAt: now
  }];

  return deepFreeze({
    exchangeConnections: [
      { id: 'current', exchange: 'binance', provenAccountClasses: ['spot'] },
      { id: 'stale', exchange: 'binance', provenAccountClasses: ['spot'] }
    ],
    openingBalances,
    snapshots,
    assets,
    coverage: [
      coverage('current', 'current-snapshot', now),
      coverage('stale', 'stale-snapshot', now - DAY - 1),
      {
        id: 'options-coverage', generation: 1, scopeId: 'file:options-file:options',
        sourceIdentityId: 'options-file', evidenceId: 'options-journal', kind: 'csv',
        accountClasses: ['options'], endpoints: ['history'], authoritySnapshotId: 'options-snapshot',
        startedAt: 0, completedAt: now, status: 'unknown', parserId: 'binance_options',
        supportedParser: true, requiredSheets: ['options'], presentSheets: ['options'],
        recognizedCount: 1, parsedCount: 1, dedupedCount: 0, excludedCount: 0,
        skippedCount: 0, failedCount: 0, endpointOutcomes: [{
          endpoint: 'history', parserId: 'binance_options', accountClass: 'options',
          required: true, status: 'complete'
        }]
      }
    ],
    now
  });
}

function canonicalTaxOutput(transactions: Transaction[]) {
  const engine = calculateCostBasis(transactions, { method: 'FIFO' });
  const matched = buildMatchedGainRows(engine.disposals, engine.lots, transactions);
  const derivativeIncome = buildDerivativeBusinessIncomeRows(transactions);
  const derivativeExpenses = buildDerivativeBusinessExpenseRows(transactions);
  const derivativeCapital = buildDerivativeCapitalGainRows(transactions);
  const derivativesIncome = derivativeIncome.reduce((sum, row) => sum + row.fiatValue, 0);
  const derivativesExpenses = derivativeExpenses.reduce((sum, row) => sum + row.fiatValue, 0);
  const scheduleVda = buildScheduleVdaReport(matched, 12, 2024, 'IN', 7);
  const scheduleVdaCsv = serializeScheduleVdaCsv(scheduleVda);

  return {
    costBasis: {
      lots: engine.lots.map(({ id: _id, ...lot }) => lot),
      disposals: engine.disposals.map(({ id: _id, lotConsumption, ...disposal }) => ({
        ...disposal,
        lotConsumption: lotConsumption.map(({ lotId: _lotId, ...consumption }) => consumption)
      })),
      shortfalls: engine.shortfalls,
      flags: engine.flags,
      disposalCandidates: Object.fromEntries(Object.entries(engine.disposalCandidates).map(([id, candidates]) => [
        id, candidates.map(({ lotId: _lotId, ...candidate }) => candidate)
      ]))
    },
    matched: matched.map(({ id: _id, ...row }) => row),
    jurisdictions: (['IN', 'US', 'CA', 'AE'] as const).map((jurisdiction) =>
      summarizeYear(engine.disposals, matched, [], 2024, jurisdiction, {
        derivativesIncome,
        derivativesExpenses
      })
    ),
    derivatives: {
      income: derivativeIncome,
      expenses: derivativeExpenses,
      capital: derivativeCapital
    },
    scheduleVda: {
      fy: scheduleVda.fy,
      jurisdiction: scheduleVda.jurisdiction,
      rows: scheduleVda.rows.map(({ id: _id, ...row }) => row),
      estimate: scheduleVda.estimate,
      vdaReceiptIncome: scheduleVda.vdaReceiptIncome,
      csvDataLines: scheduleVdaCsv.split('\n').filter((line) => line && !line.startsWith('#')),
      csvEstimateLines: scheduleVdaCsv.split('\n').filter((line) =>
        line.startsWith('# Taxable gains') || line.startsWith('# Disallowed losses') ||
        line.startsWith('# REVIEW REQUIRED') || line.startsWith('# Tax @') ||
        line.startsWith('# Cess') || line.startsWith('# Estimated liability') ||
        line.startsWith('# TDS offset') || line.startsWith('# Net after')
      )
    }
  };
}

describe('custody projection tax boundary', () => {
  it('keeps borrow and repay liquid/liability postings signed and policy-independent', () => {
    const base = {
      timestamp: START, asset: 'USDC', amount: 10, fiatCurrency: 'USD', source: 'rpc:moralis',
      walletAddress: `0x${'1'.repeat(40)}`, chain: 'ethereum', flags: [], isInternalTransfer: false,
      raw: { defiActionEvidence: {
        type: 'borrow', protocolId: 'aave-v3-ethereum', reserveKey: `0x${'2'.repeat(40)}`,
        chainId: 1, complete: true, confidence: 1, evidenceSource: 'ethereum_log',
        eventIds: [
          `event:1:0xabc:0x${'0'.repeat(40)}:1`, `event:1:0xabc:0x${'2'.repeat(40)}:2`
        ], postingAnchorEventId: `event:1:0xabc:0x${'2'.repeat(40)}:2`, postingAnchor: true
      } }
    };
    const borrow = deriveTransactionPostings({ ...base, id: 'borrow', type: 'transfer_in' }, { exchangeConnections: [] });
    const repay = deriveTransactionPostings({
      ...base, id: 'repay', type: 'transfer_out',
      raw: { defiActionEvidence: { ...base.raw.defiActionEvidence, type: 'repay' } }
    }, { exchangeConnections: [] });
    expect(borrow.map((row) => [row.role, row.signedQuantity])).toEqual([['principal', 10], ['liability', -10]]);
    expect(repay.map((row) => [row.role, row.signedQuantity])).toEqual([['principal', -10], ['liability', 10]]);
    expect([...borrow, ...repay].reduce((sum, row) => sum + row.signedQuantity, 0)).toBe(0);
  });

  it('rejects incomplete, provider-only, unsupported, low-confidence, or non-exact liability evidence', () => {
    const exact = {
      type: 'borrow', protocolId: 'aave-v3-ethereum', reserveKey: `0x${'2'.repeat(40)}`,
      chainId: 1, complete: true, confidence: 0.9, evidenceSource: 'ethereum_log',
      eventIds: [
        `event:1:0xabc:0x${'0'.repeat(40)}:1`, `event:1:0xabc:0x${'2'.repeat(40)}:2`
      ], postingAnchorEventId: `event:1:0xabc:0x${'2'.repeat(40)}:2`, postingAnchor: true
    };
    const variants = [
      { ...exact, complete: false },
      { ...exact, evidenceSource: 'moralis' },
      { ...exact, chainId: 137 },
      { ...exact, protocolId: 'unsupported' },
      { ...exact, confidence: 0.8999 },
      { ...exact, eventIds: [`event:1:0xabc:0x${'0'.repeat(40)}:1`] },
      { ...exact, postingAnchorEventId: undefined },
      { ...exact, eventIds: ['event:1:0xabc:missing-log-index', `event:1:0xabc:0x${'2'.repeat(40)}:2`] }
    ];
    for (const [index, evidence] of variants.entries()) {
      const postings = deriveTransactionPostings({
        id: `rejected-${index}`, timestamp: START, type: 'transfer_in', asset: 'USDC', amount: 10,
        fiatCurrency: 'USD', source: 'rpc:alchemy', walletAddress: `0x${'1'.repeat(40)}`,
        chain: 'ethereum', flags: [], isInternalTransfer: false,
        raw: { defiActionEvidence: evidence }
      }, { exchangeConnections: [] });
      expect(postings.some((row) => row.role === 'liability')).toBe(false);
    }
  });

  it('matches the canonical tax golden across every reporting boundary', () => {
    const transactions = taxFixture();
    const taxOutput = deepFreeze(canonicalTaxOutput(transactions));

    expect(taxOutput).toMatchInlineSnapshot(`
      {
        "costBasis": {
          "disposalCandidates": {
            "btc-gain": [
              {
                "acquiredAt": 1714521600000,
                "amountAvailable": 2,
                "costBasisPerUnit": 100,
              },
            ],
            "btc-loss": [
              {
                "acquiredAt": 1714521600000,
                "amountAvailable": 1,
                "costBasisPerUnit": 100,
              },
            ],
            "eth-unmatched": [],
          },
          "disposals": [
            {
              "amount": 1,
              "asset": "BTC",
              "costBasis": 100,
              "disposedAt": 1715385600000,
              "gain": 80,
              "holdingPeriodDays": 10,
              "lotConsumption": [
                {
                  "amount": 1,
                  "costBasis": 100,
                },
              ],
              "method": "FIFO",
              "proceeds": 180,
              "sourceTxId": "btc-gain",
            },
            {
              "amount": 1,
              "asset": "BTC",
              "costBasis": 100,
              "disposedAt": 1715472000000,
              "gain": -50,
              "holdingPeriodDays": 11,
              "lotConsumption": [
                {
                  "amount": 1,
                  "costBasis": 100,
                },
              ],
              "method": "FIFO",
              "proceeds": 50,
              "sourceTxId": "btc-loss",
            },
            {
              "amount": 2,
              "asset": "ETH",
              "costBasis": 0,
              "disposedAt": 1715558400000,
              "gain": 60,
              "holdingPeriodDays": 0,
              "lotConsumption": [],
              "method": "FIFO",
              "proceeds": 60,
              "sourceTxId": "eth-unmatched",
            },
          ],
          "flags": [],
          "lots": [
            {
              "acquiredAt": 1714521600000,
              "acquisitionType": "buy",
              "amountOriginal": 2,
              "amountRemaining": 0,
              "asset": "BTC",
              "costBasisPerUnit": 100,
              "costBasisTotal": 200,
              "sourceTxId": "btc-buy",
            },
          ],
          "shortfalls": [
            {
              "asset": "ETH",
              "transactionId": "eth-unmatched",
              "unmatchedAmount": 2,
            },
          ],
        },
        "derivatives": {
          "capital": [
            {
              "asset": "HL-PERP:ETH",
              "buyAmount": 1,
              "buyDate": 1716336000000,
              "buyTxId": "perp-loss",
              "chain": undefined,
              "costBasis": 910,
              "gain": -10,
              "holdingDays": 0,
              "id": "deriv-cg:perp-loss",
              "method": "FIFO",
              "proceeds": 900,
              "sellAmount": 1,
              "sellDate": 1716336000000,
              "sellTxId": "perp-loss",
            },
            {
              "asset": "HL-PERP:ETH",
              "buyAmount": 1,
              "buyDate": 1716249600000,
              "buyTxId": "perp-profit",
              "chain": undefined,
              "costBasis": 960,
              "gain": 40,
              "holdingDays": 0,
              "id": "deriv-cg:perp-profit",
              "method": "FIFO",
              "proceeds": 1000,
              "sellAmount": 1,
              "sellDate": 1716249600000,
              "sellTxId": "perp-profit",
            },
          ],
          "expenses": [
            {
              "amount": 10,
              "asset": "USDC",
              "date": 1716336000000,
              "fiatValue": 10,
              "id": "perp-loss",
              "kind": "realized_loss",
              "notes": undefined,
              "source": "hyperliquid_trades",
              "txId": "perp-loss",
            },
          ],
          "income": [
            {
              "amount": 40,
              "asset": "USDC",
              "date": 1716249600000,
              "fiatValue": 40,
              "id": "perp-profit",
              "notes": undefined,
              "source": "hyperliquid_trades",
              "txId": "perp-profit",
            },
          ],
        },
        "jurisdictions": [
          {
            "byAsset": {
              "BTC": {
                "costBasis": 200,
                "gain": 30,
                "proceeds": 230,
              },
              "ETH": {
                "costBasis": 0,
                "gain": 60,
                "proceeds": 60,
              },
            },
            "derivativesExpenses": 10,
            "derivativesIncome": 40,
            "disallowedLosses": 50,
            "disposalsCount": 3,
            "estimatedTax": 43.68,
            "inclusionRate": undefined,
            "incomeGiftTreatmentLimited": false,
            "jurisdiction": "IN",
            "longTermGain": undefined,
            "reviewRequiredCount": 1,
            "shortTermGain": undefined,
            "taxableGain": 140,
            "totalCostBasis": 200,
            "totalGain": 140,
            "totalGains": 140,
            "totalIncome": 0,
            "totalLosses": 50,
            "totalProceeds": 290,
            "vdaReceiptIncome": 0,
            "year": 2024,
          },
          {
            "byAsset": {
              "BTC": {
                "costBasis": 200,
                "gain": 30,
                "proceeds": 230,
              },
              "ETH": {
                "costBasis": 0,
                "gain": 60,
                "proceeds": 60,
              },
            },
            "derivativesExpenses": 10,
            "derivativesIncome": 40,
            "disallowedLosses": undefined,
            "disposalsCount": 3,
            "estimatedTax": undefined,
            "inclusionRate": undefined,
            "incomeGiftTreatmentLimited": false,
            "jurisdiction": "US",
            "longTermGain": 0,
            "reviewRequiredCount": 1,
            "shortTermGain": 90,
            "taxableGain": 90,
            "totalCostBasis": 200,
            "totalGain": 90,
            "totalGains": 140,
            "totalIncome": 0,
            "totalLosses": 50,
            "totalProceeds": 290,
            "vdaReceiptIncome": undefined,
            "year": 2024,
          },
          {
            "byAsset": {
              "BTC": {
                "costBasis": 200,
                "gain": 30,
                "proceeds": 230,
              },
              "ETH": {
                "costBasis": 0,
                "gain": 60,
                "proceeds": 60,
              },
            },
            "derivativesExpenses": 10,
            "derivativesIncome": 40,
            "disallowedLosses": undefined,
            "disposalsCount": 3,
            "estimatedTax": undefined,
            "inclusionRate": 0.5,
            "incomeGiftTreatmentLimited": false,
            "jurisdiction": "CA",
            "longTermGain": undefined,
            "reviewRequiredCount": 1,
            "shortTermGain": undefined,
            "taxableGain": 45,
            "totalCostBasis": 200,
            "totalGain": 90,
            "totalGains": 140,
            "totalIncome": 0,
            "totalLosses": 50,
            "totalProceeds": 290,
            "vdaReceiptIncome": undefined,
            "year": 2024,
          },
          {
            "byAsset": {
              "BTC": {
                "costBasis": 200,
                "gain": 30,
                "proceeds": 230,
              },
              "ETH": {
                "costBasis": 0,
                "gain": 60,
                "proceeds": 60,
              },
            },
            "derivativesExpenses": 10,
            "derivativesIncome": 40,
            "disallowedLosses": undefined,
            "disposalsCount": 3,
            "estimatedTax": undefined,
            "inclusionRate": undefined,
            "incomeGiftTreatmentLimited": false,
            "jurisdiction": "AE",
            "longTermGain": undefined,
            "reviewRequiredCount": 1,
            "shortTermGain": undefined,
            "taxableGain": 90,
            "totalCostBasis": 200,
            "totalGain": 90,
            "totalGains": 140,
            "totalIncome": 0,
            "totalLosses": 50,
            "totalProceeds": 290,
            "vdaReceiptIncome": undefined,
            "year": 2024,
          },
        ],
        "matched": [
          {
            "asset": "ETH",
            "buyAmount": 0,
            "buyDate": 1715558400000,
            "buyTxId": "",
            "chain": undefined,
            "costBasis": 0,
            "gain": 60,
            "holdingDays": 0,
            "method": "FIFO",
            "proceeds": 60,
            "sellAmount": 2,
            "sellDate": 1715558400000,
            "sellTxId": "eth-unmatched",
            "status": "missing_cost_basis",
          },
          {
            "asset": "BTC",
            "buyAmount": 1,
            "buyDate": 1714521600000,
            "buyTxId": "btc-buy",
            "chain": undefined,
            "costBasis": 100,
            "gain": -50,
            "holdingDays": 11,
            "method": "FIFO",
            "proceeds": 50,
            "sellAmount": 1,
            "sellDate": 1715472000000,
            "sellTxId": "btc-loss",
            "status": "matched",
          },
          {
            "asset": "BTC",
            "buyAmount": 1,
            "buyDate": 1714521600000,
            "buyTxId": "btc-buy",
            "chain": undefined,
            "costBasis": 100,
            "gain": 80,
            "holdingDays": 10,
            "method": "FIFO",
            "proceeds": 180,
            "sellAmount": 1,
            "sellDate": 1715385600000,
            "sellTxId": "btc-gain",
            "status": "matched",
          },
        ],
        "scheduleVda": {
          "csvDataLines": [
            "date_of_acquisition,date_of_transfer,asset,cost_of_acquisition_inr,consideration_received_inr,income_gain_inr",
            "2024-05-13,2024-05-13,ETH,0,60,60",
            "2024-05-01,2024-05-12,BTC,100,50,-50",
            "2024-05-01,2024-05-11,BTC,100,180,80",
          ],
          "csvEstimateLines": [
            "# Estimated liability (non-advice)",
            "# Taxable gains (positive transfers only): 140",
            "# Disallowed losses (excluded, Section 115BBH): 50",
            "# REVIEW REQUIRED — transfers with no matched acquisition (taxed at zero cost of acquisition): 1",
            "# Tax @ 30% (Section 115BBH): 42",
            "# Estimated liability (30% + cess): 43.68",
          ],
          "estimate": {
            "cess": 1.68,
            "disallowedLosses": 50,
            "estimatedLiability": 43.68,
            "netAfterTdsOffset": 31.68,
            "reviewRequiredCount": 1,
            "tax": 42,
            "taxableGains": 140,
            "tdsOffset": 12,
          },
          "fy": 2024,
          "jurisdiction": "IN",
          "rows": [
            {
              "acquisitionDate": 1715558400000,
              "asset": "ETH",
              "considerationReceived": 60,
              "costOfAcquisition": 0,
              "incomeGain": 60,
              "status": "missing_cost_basis",
              "transferDate": 1715558400000,
            },
            {
              "acquisitionDate": 1714521600000,
              "asset": "BTC",
              "considerationReceived": 50,
              "costOfAcquisition": 100,
              "incomeGain": -50,
              "status": "matched",
              "transferDate": 1715472000000,
            },
            {
              "acquisitionDate": 1714521600000,
              "asset": "BTC",
              "considerationReceived": 180,
              "costOfAcquisition": 100,
              "incomeGain": 80,
              "status": "matched",
              "transferDate": 1715385600000,
            },
          ],
          "vdaReceiptIncome": 7,
        },
      }
    `);
    expectDeepFrozen(transactions);
    expectDeepFrozen(taxOutput);
  });

  it('keeps the complete tax golden immutable through the actual unified holdings projection', () => {
    const transactions = taxFixture();
    const beforeTransactionHash = transactionHash(transactions);
    const taxOutput = deepFreeze(canonicalTaxOutput(transactions));
    const beforeTaxOutput = structuredClone(taxOutput);
    const evidence = custodyProjectionEvidence();

    const projection = buildHoldingsProjection({ transactions, ...evidence });
    const currentAda = projection.slices.find((slice) =>
      slice.scopeId === 'exchange:current' && slice.assetKey === 'asset:ADA'
    );
    const staleSol = projection.slices.find((slice) =>
      slice.scopeId === 'exchange:stale' && slice.assetKey === 'asset:SOL'
    );
    const reconstructedOptions = projection.slices.find((slice) =>
      slice.scopeId === 'file:options-file:options' && slice.assetKey === 'asset:USDT'
    );

    expect(currentAda).toMatchObject({
      postingQuantity: 7,
      authorityQuantity: 9,
      quantity: 9,
      verificationStatus: 'verified_authority',
      authorityStatus: 'current',
      coverageStatus: 'complete',
      selectedSnapshotId: 'current-snapshot'
    });
    expect(staleSol).toMatchObject({
      postingQuantity: 3,
      authorityQuantity: 12,
      quantity: 3,
      verificationStatus: 'posting_fallback',
      fallbackReason: 'stale_authority',
      authorityStatus: 'stale',
      coverageStatus: 'complete',
      selectedSnapshotId: 'stale-snapshot'
    });
    expect(reconstructedOptions).toMatchObject({
      postingQuantity: 0,
      authorityQuantity: 119.5193,
      quantity: 119.5193,
      verificationStatus: 'reconstructed_authority',
      authorityStatus: 'non_comparable',
      selectedSnapshotId: 'options-snapshot'
    });
    expect(projection.postings.some((posting) =>
      posting.role === 'opening_balance' && posting.evidence.some((row) => row.kind === 'opening_balance')
    )).toBe(true);
    expect(transactionHash(transactions)).toBe(beforeTransactionHash);
    expect(taxOutput).toEqual(beforeTaxOutput);
    expect(canonicalTaxOutput(transactions)).toEqual(taxOutput);
    expectDeepFrozen(transactions);
    expectDeepFrozen(taxOutput);
  });

  it('keeps Transaction[] as the only source evidence accepted by tax APIs', () => {
    const compileOnlyTaxBoundary = (
      transactions: Transaction[],
      holdings: UnifiedHolding[],
      authority: AuthoritySelection,
      postings: DerivedPosting[]
    ) => {
      calculateCostBasis(transactions, { method: 'FIFO' });
      buildMatchedGainRows([], [], transactions);
      buildDerivativeBusinessIncomeRows(transactions);

      // @ts-expect-error Unified holdings are custody output, never tax source evidence.
      calculateCostBasis(holdings, { method: 'FIFO' });
      // @ts-expect-error Authority selections are custody evidence, never tax source evidence.
      calculateCostBasis(authority, { method: 'FIFO' });
      // @ts-expect-error Derived postings are custody output, never tax source evidence.
      calculateCostBasis(postings, { method: 'FIFO' });

      // @ts-expect-error Matched gains require the original Transaction[] evidence.
      buildMatchedGainRows([], [], holdings);
      // @ts-expect-error Matched gains require the original Transaction[] evidence.
      buildMatchedGainRows([], [], authority);
      // @ts-expect-error Matched gains require the original Transaction[] evidence.
      buildMatchedGainRows([], [], postings);
    };

    expect(compileOnlyTaxBoundary).toBeTypeOf('function');
  });

  it('migrates legacy perp_funding to the same funding-fee tax result without changing evidence', () => {
    const legacy: Transaction = {
      id: 'legacy-funding', timestamp: START, type: 'fee', asset: 'USDC', amount: 3,
      fiatCurrency: 'INR', fiatValue: 250, source: 'binance', category: 'perp_funding' as never,
      instrumentClass: 'derivative', raw: { Operation: 'Perpetual funding fee', signed: '-3' },
      flags: [], isInternalTransfer: false
    };
    const migrated = normalizeImportedTransactionCategory(legacy);
    const canonical = { ...legacy, category: 'funding_fee' as const, categoryOrigin: 'legacy' as const };
    expect(buildDerivativeBusinessExpenseRows([migrated])).toEqual(buildDerivativeBusinessExpenseRows([canonical]));
    expect(migrated).toMatchObject({
      amount: 3, fiatValue: 250, source: 'binance', category: 'funding_fee',
      raw: legacy.raw, instrumentClass: 'derivative'
    });
  });
});
