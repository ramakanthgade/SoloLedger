import { describe, it, expect } from 'vitest';
import { parseWithMapping, type ColumnMapping } from './generic';
import { contentHashRef } from './types';
import { transactionExchangeKey } from '@/lib/storage/db';

const MAPPING: ColumnMapping = {
  timestamp: 'Date',
  type: 'Type',
  asset: 'Asset',
  amount: 'Amount',
  totalValue: 'Total',
  typeValueMap: { buy: 'buy', sell: 'sell' },
  assetIsTradingPair: false
};

const ROWS: Record<string, string>[] = [
  { Date: '2025-05-01T10:00:00Z', Type: 'buy', Asset: 'BTC', Amount: '0.5', Total: '25000' },
  { Date: '2025-05-02T10:00:00Z', Type: 'sell', Asset: 'ETH', Amount: '2', Total: '6000' }
];

describe('Manual/AI mapping — stable content-hash sourceRef (C1)', () => {
  it('uses a content-hash ref, not a positional row index', () => {
    const { transactions } = parseWithMapping(ROWS, MAPPING, 'USD');
    for (const t of transactions) {
      expect(t.sourceRef?.startsWith('chash:')).toBe(true);
      expect(t.sourceRef).not.toMatch(/^row:\d+$/);
    }
  });

  it('produces identical refs on re-import (dedup-stable)', () => {
    const first = parseWithMapping(ROWS, MAPPING, 'USD').transactions;
    const second = parseWithMapping(ROWS, MAPPING, 'USD').transactions;
    expect(first.map((t) => t.sourceRef)).toEqual(second.map((t) => t.sourceRef));
  });

  it('is stable when rows are reordered (a positional ref would not be)', () => {
    const first = parseWithMapping(ROWS, MAPPING, 'USD').transactions;
    const reordered = parseWithMapping([...ROWS].reverse(), MAPPING, 'USD').transactions;
    const refsFor = (txs: typeof first) =>
      new Set(txs.map((t) => t.sourceRef));
    expect(refsFor(first)).toEqual(refsFor(reordered));
  });

  it('re-import yields the same transactionExchangeKey (dedup whitelists manual_mapping)', () => {
    const first = parseWithMapping(ROWS, MAPPING, 'USD').transactions;
    const second = parseWithMapping(ROWS, MAPPING, 'USD').transactions;
    const keyOf = (t: (typeof first)[number]) => transactionExchangeKey(t);
    for (let i = 0; i < first.length; i++) {
      expect(keyOf(first[i])).not.toBeNull();
      expect(keyOf(first[i])).toBe(keyOf(second[i]));
    }
  });

  it('ai_mapping source is whitelisted for exchange-key dedup', () => {
    const ref = contentHashRef({ timestamp: 1, type: 'buy', asset: 'BTC', amount: 1 });
    expect(transactionExchangeKey({ source: 'ai_mapping', sourceRef: ref })).toBe(`ex:${ref}`);
    expect(transactionExchangeKey({ source: 'manual_mapping', sourceRef: ref })).toBe(`ex:${ref}`);
  });
});
