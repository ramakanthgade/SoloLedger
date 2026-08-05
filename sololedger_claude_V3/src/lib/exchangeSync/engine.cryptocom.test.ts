import { describe, expect, it } from 'vitest';
import {
  CRYPTOCOM_RETENTION_MS,
  CRYPTOCOM_TRADE_WINDOW_MS,
  cryptocomRetainedSince,
  paginateCryptocomTrades,
  paginateCryptocomTransfers
} from './engine';

describe('Crypto.com Exchange pagination', () => {
  it('clamps both initial and stale incremental starts to 180-day retention', () => {
    const now = 1_000_000_000_000;
    const floor = now - CRYPTOCOM_RETENTION_MS;
    expect(cryptocomRetainedSince(0, now)).toEqual({ since: floor, floor, truncated: true });
    expect(cryptocomRetainedSince(floor - 60_000, now)).toEqual({ since: floor, floor, truncated: true });
    expect(cryptocomRetainedSince(floor + 60_000, now)).toEqual({ since: floor + 60_000, floor, truncated: false });
  });
  it('walks newest-first full trade pages backward by oldest end_time and dedups the inclusive boundary', async () => {
    const calls: Array<[number, number]> = [];
    const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), timestamp: 10_000 - i * 10 }));
    const result = await paginateCryptocomTrades({
      since: 0, now: CRYPTOCOM_TRADE_WINDOW_MS,
      fetchPage: async (since, until) => {
        calls.push([since, until]);
        return calls.length === 1 ? first : [{ id: '100', timestamp: 9_010 }, { id: 'older', timestamp: 8_000 }];
      }
    });
    expect(calls[1][1]).toBe(9_010);
    expect(result.rows.filter((row) => row.id === '100')).toHaveLength(1);
    expect(result).toMatchObject({ partial: false, maxTs: CRYPTOCOM_TRADE_WINDOW_MS, termination: 'exhausted' });
  });

  it('returns partial/nonadvancing when a full page shares the oldest millisecond', async () => {
    const result = await paginateCryptocomTrades({
      since: 0, now: 1_000,
      fetchPage: async () => Array.from({ length: 100 }, (_, i) => ({ id: String(i), timestamp: 500 }))
    });
    expect(result).toMatchObject({ partial: true, maxTs: 0, termination: 'nonadvancing', pages: 1 });
  });

  it('uses independent zero-based transfer pages and advances the verified frontier on empty history', async () => {
    const pages: number[] = [];
    const result = await paginateCryptocomTransfers({
      since: 100, now: 200,
      fetchPage: async (_since, _until, page) => { pages.push(page); return []; }
    });
    expect(pages).toEqual([0]);
    expect(result).toMatchObject({ partial: false, maxTs: 200, termination: 'exhausted' });
  });

  it('counts retry attempts against the physical cap', async () => {
    const result = await paginateCryptocomTransfers({
      since: 0, now: 1, maxRequests: 2, sleep: async () => {},
      fetchPage: async () => { const err = new Error('network'); err.name = 'NetworkError'; throw err; }
    });
    expect(result).toMatchObject({ partial: true, pages: 2, maxTs: 0, termination: 'page_budget' });
  });
});
