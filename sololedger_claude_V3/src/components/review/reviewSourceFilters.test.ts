import { describe, expect, it } from 'vitest';
import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { Transaction } from '@/types/transaction';
import { buildReviewSourceFilterOptions, transactionMatchesSourceFilter } from './reviewSourceFilters';

const transaction = (id: string): Transaction => ({
  id, timestamp: 1, type: 'buy', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
  source: 'binance', flags: [], isInternalTransfer: false
});

const presentation = (key: string, label: string): SourcePresentation => ({
  accountKey: `account:${key}`, sourceKey: key, primaryLabel: label, subtitle: 'Binance · API connection',
  filterLabel: label, iconId: 'binance', chain: null, address: null, status: 'resolved', account: null,
  sourceKind: 'exchange', linkedDeletedSourceEvidence: null
});

describe('review exact source filters', () => {
  it('uses collision-free exact keys and display text', () => {
    const rows = [transaction('one'), transaction('two'), transaction('three')];
    const presentations = new Map([
      ['one', presentation('exchange-source:one', 'Trading · Binance · one')],
      ['two', presentation('exchange-source:two', 'Trading · Binance · two')],
      ['three', presentation('exchange-source:one', 'Trading · Binance · one')]
    ]);
    const options = buildReviewSourceFilterOptions(rows, presentations);
    expect(options.map((option) => option.key)).toEqual(['exchange-source:one', 'exchange-source:two']);
    expect(new Set(options.map((option) => option.label)).size).toBe(options.length);
  });

  it('progressively appends full exact identity when shortened labels still collide', () => {
    const rows = [transaction('one'), transaction('two')];
    const one = presentation('wallet-source:one', 'Trading · Ethereum · 0xaaaa…0001');
    one.address = '0xaaaa111111111111111111111111111111110001';
    const two = presentation('wallet-source:two', 'Trading · Ethereum · 0xaaaa…0001');
    two.address = '0xaaaa222222222222222222222222222222220001';
    const options = buildReviewSourceFilterOptions(rows, new Map([['one', one], ['two', two]]));
    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining([
      expect.stringContaining(one.address), expect.stringContaining(two.address)
    ]));
    expect(new Set(options.map((option) => option.label)).size).toBe(2);
  });

  it('matches only the selected exact source key', () => {
    const one = transaction('one');
    const two = transaction('two');
    const presentations = new Map([
      ['one', presentation('exchange-source:one', 'Same brand · one')],
      ['two', presentation('exchange-source:two', 'Same brand · two')]
    ]);
    expect(transactionMatchesSourceFilter(one, 'exchange-source:one', presentations)).toBe(true);
    expect(transactionMatchesSourceFilter(two, 'exchange-source:one', presentations)).toBe(false);
    expect(transactionMatchesSourceFilter(two, 'all', presentations)).toBe(true);
  });
});
