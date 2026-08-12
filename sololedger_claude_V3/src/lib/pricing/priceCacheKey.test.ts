import { describe, expect, it } from 'vitest';
import type { PriceCacheRow } from '@/lib/storage/db';
import { parsePriceCacheKey, resolvePriceCacheRows } from './priceCacheKey';

const row = (key: string, price = 1): PriceCacheRow => ({ key, price, fetchedAt: 1 });

describe('price cache keys', () => {
  it('parses both legacy and canonical-v2 symbol/contract grammars', () => {
    expect(parsePriceCacheKey('sym:BTC:01-04-2026:INR')).toMatchObject({ symbol: 'BTC', currency: 'INR' });
    expect(parsePriceCacheKey('ctr:ethereum:0xabc:01-04-2026:INR')).toMatchObject({ platform: 'ethereum', contractAddress: '0xabc' });
    expect(parsePriceCacheKey('sym:v2:bitcoin:01-04-2026:INR')).toMatchObject({ canonicalId: 'bitcoin' });
    expect(parsePriceCacheKey('ctr:v2:usd-coin:ethereum:0xabc:01-04-2026:INR'))
      .toMatchObject({ canonicalId: 'usd-coin', platform: 'ethereum', contractAddress: '0xabc' });
  });

  it('rejects malformed dates, missing fields, and extra fields', () => {
    expect(parsePriceCacheKey('sym:BTC:31-02-2026:INR')).toBeUndefined();
    expect(parsePriceCacheKey('sym:v2::01-04-2026:INR')).toBeUndefined();
    expect(parsePriceCacheKey('ctr:v2:id:ethereum:0xabc:01-04-2026:INR:extra')).toBeUndefined();
  });

  it('selects migration identities immediately before, during, and after boundaries', () => {
    const rows = [
      row('sym:v2:bittorrent-old:11-01-2022:USD'),
      row('sym:v2:bittorrent:21-01-2022:USD')
    ];
    expect(resolvePriceCacheRows(rows, { symbol: 'BTT', timestampMs: Date.UTC(2022, 0, 11), currency: 'USD' }).symbol[0].key)
      .toContain('bittorrent-old');
    expect(resolvePriceCacheRows(rows, { symbol: 'BTT', timestampMs: Date.UTC(2022, 0, 12), currency: 'USD' }).rejectedReason)
      .toBe('ambiguous-canonical-identity');
    expect(resolvePriceCacheRows(rows, { symbol: 'BTT', timestampMs: Date.UTC(2022, 0, 21), currency: 'USD' }).symbol[0].key)
      .toContain('bittorrent:');
  });

  it('prefers exact contracts and rejects unsafe symbol fallback', () => {
    const rows = [
      row('sym:USDC:01-04-2026:USD'),
      row('ctr:ethereum:0xabc:01-04-2026:USD', 2)
    ];
    const exact = resolvePriceCacheRows(rows, {
      symbol: 'USDC', contractAddress: '0xabc', platform: 'ethereum', safetyState: 'trusted',
      timestampMs: Date.UTC(2026, 3, 1), currency: 'USD'
    });
    expect(exact.exactContract.map((item) => item.price)).toEqual([2]);
    expect(exact.symbol).toEqual([]);
    expect(resolvePriceCacheRows([rows[0]], {
      symbol: 'USDC', contractAddress: '0xdef', platform: 'ethereum', safetyState: 'unverified',
      timestampMs: Date.UTC(2026, 3, 1), currency: 'USD'
    }).rejectedReason).toBe('unsafe-symbol-fallback');
  });
});
