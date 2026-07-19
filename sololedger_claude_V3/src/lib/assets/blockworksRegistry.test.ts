import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBlockworksCount, syncBlockworksRegistry } from './blockworksRegistry';

const CACHE_KEY = 'sololedger_blockworks_registry_v1';

describe('Blockworks registry cache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('keeps cached data for less than 24 hours and expires it at the exact boundary', async () => {
    const start = new Date('2026-07-19T00:00:00.000Z');
    vi.setSystemTime(start);
    await syncBlockworksRegistry();
    expect(getBlockworksCount()).toBe(6);

    vi.setSystemTime(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    expect(getBlockworksCount()).toBe(6);
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();

    vi.setSystemTime(start.getTime() + 24 * 60 * 60 * 1000);
    expect(getBlockworksCount()).toBe(6);
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
    vi.useRealTimers();
  });

  it('recovers from malformed cache data with the bundled verified registry', () => {
    localStorage.setItem(CACHE_KEY, '{not-json');
    expect(getBlockworksCount()).toBe(6);
    vi.useRealTimers();
  });
});
