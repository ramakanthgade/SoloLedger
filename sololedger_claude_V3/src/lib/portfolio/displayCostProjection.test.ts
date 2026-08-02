import { describe, expect, it } from 'vitest';
import { derivePostings, type OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { Transaction } from '@/types/transaction';
import {
  buildDisplayCostProjection,
  buildDisplayCostSamples,
  buildUnresolvedDisplayCostProjection,
  displayCostBalanceKey
} from './displayCostProjection';
import { buildHoldingsProjection } from './holdingsProjection';

const NOW = 1_800_000_000_000;

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', timestamp: NOW, type: 'buy', asset: 'BTC', amount: 1, fiatValue: 100,
    fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false,
    ...overrides
  };
}

describe('buildDisplayCostProjection', () => {
  it('provides one opening-aware result for table and chart instants', () => {
    const transactions = [
      transaction({ id: 'before', timestamp: NOW - 3_000, amount: 10, fiatValue: 1_000 }),
      transaction({ id: 'after', timestamp: NOW - 1_000, amount: 2, fiatValue: 200 })
    ];
    const opening: OpeningBalanceRow = {
      id: 'opening', logicalKey: 'logical', scopeId: 'manual', accountClass: 'manual',
      assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 10, effectiveAt: NOW - 2_000,
      provenance: 'user_confirmed', createdAt: NOW, updatedAt: NOW
    };
    const postings = derivePostings(transactions, { exchangeConnections: [], openingBalances: [opening] });
    const chartAtOpening = buildDisplayCostProjection({
      transactions, postings, asOf: opening.effectiveAt
    }).get(displayCostBalanceKey('manual', 'manual', 'asset:BTC'));
    const tableNow = buildDisplayCostProjection({ transactions, postings })
      .get(displayCostBalanceKey('manual', 'manual', 'asset:BTC'));
    const tableProjection = buildHoldingsProjection({
      transactions, exchangeConnections: [], openingBalances: [opening], snapshots: [], assets: [],
      coverage: [], now: NOW
    });

    expect(chartAtOpening).toMatchObject({ amount: 10, costBasis: 0 });
    expect(tableNow).toMatchObject({ amount: 12, costBasis: 200 });
    expect(tableProjection.holdings[0].costBasis).toBe(tableNow?.costBasis);
    expect(buildDisplayCostSamples({ transactions, postings }, [
      NOW - 3_000, opening.effectiveAt, NOW - 1_000
    ]).map((sample) => sample.cost)).toEqual([1_000, 0, 200]);
  });

  it('uses one canonical fallback balance across unresolved transaction scopes', () => {
    const transactions = [
      transaction({ id: 'buy', source: 'binance', amount: 0.5, fiatValue: 25_000 }),
      transaction({ id: 'sell', source: 'binance', timestamp: NOW + 1, type: 'sell', amount: 0.2, fiatValue: 12_000 })
    ];
    const postings = derivePostings(transactions, { exchangeConnections: [] });
    expect(buildUnresolvedDisplayCostProjection({ transactions, postings }).get('asset:BTC'))
      .toMatchObject({ amount: 0.3, costBasis: 15_000 });
    expect(buildDisplayCostSamples({ transactions, postings }, [NOW, NOW + 1]).map((row) => row.cost))
      .toEqual([25_000, 15_000]);
  });
});
