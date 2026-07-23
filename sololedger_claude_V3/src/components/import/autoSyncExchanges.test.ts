import { describe, it, expect } from 'vitest';
import { SYNC_EXCHANGES } from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES, getAutoSyncExchange } from './autoSyncExchanges';

/**
 * The auto-sync catalog drives the AddConnectionForm picker — its ids must
 * stay exactly the ccxt exchange ids (contract C3 `SYNC_EXCHANGES`), and
 * `needsPassphrase` must be true ONLY for OKX and KuCoin (contract C5:
 * their `requiredCredentials` include `password`; the other three take
 * apiKey+secret only).
 */
describe('autoSyncExchanges catalog', () => {
  it('lists exactly the five supported exchanges', () => {
    expect(AUTO_SYNC_EXCHANGES).toHaveLength(5);
  });

  it('ids match the ccxt exchange ids (SYNC_EXCHANGES), in order', () => {
    expect(AUTO_SYNC_EXCHANGES.map((e) => e.id)).toEqual([...SYNC_EXCHANGES]);
  });

  it('needsPassphrase is true ONLY for okx and kucoin', () => {
    const withPassphrase = AUTO_SYNC_EXCHANGES.filter((e) => e.needsPassphrase).map((e) => e.id);
    expect(withPassphrase.sort()).toEqual(['kucoin', 'okx']);
  });

  it('monograms are two characters', () => {
    for (const e of AUTO_SYNC_EXCHANGES) {
      expect(e.monogram).toHaveLength(2);
    }
  });

  it('every entry has plain-language key instructions and a docs link', () => {
    for (const e of AUTO_SYNC_EXCHANGES) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.keyInstructions.length).toBeGreaterThanOrEqual(3);
      expect(e.docsUrl).toMatch(/^https:\/\//);
      expect(e.path.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every entry tells the user to keep the key read-only', () => {
    for (const e of AUTO_SYNC_EXCHANGES) {
      const copy = e.keyInstructions.join(' ').toLowerCase();
      expect(copy).toMatch(/never enable|never add/);
    }
  });

  it('getAutoSyncExchange resolves by id and tolerates null/unknown', () => {
    expect(getAutoSyncExchange('binance')?.label).toBe('Binance');
    expect(getAutoSyncExchange('kucoin')?.needsPassphrase).toBe(true);
    expect(getAutoSyncExchange(null)).toBeUndefined();
    expect(getAutoSyncExchange('nope')).toBeUndefined();
  });
});
