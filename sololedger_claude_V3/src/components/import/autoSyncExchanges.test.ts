import { describe, it, expect } from 'vitest';
import { SYNC_EXCHANGES } from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES, getAutoSyncExchange } from './autoSyncExchanges';

/**
 * The auto-sync catalog drives the AddConnectionForm picker — its ids must
 * stay exactly the ccxt exchange ids (contract C3 `SYNC_EXCHANGES`), and
 * `needsPassphrase` must track the exchanges whose CCXT credentials include
 * `password`/memo in addition to apiKey+secret.
 */
describe('autoSyncExchanges catalog', () => {
  it('lists exactly the supported exchanges', () => {
    expect(AUTO_SYNC_EXCHANGES).toHaveLength(17);
  });

  it('ids match the ccxt exchange ids (SYNC_EXCHANGES), in order', () => {
    expect(AUTO_SYNC_EXCHANGES.map((e) => e.id)).toEqual([...SYNC_EXCHANGES]);
  });

  it('needsPassphrase is true ONLY for okx, kucoin, bitget and bitmart', () => {
    const withPassphrase = AUTO_SYNC_EXCHANGES.filter((e) => e.needsPassphrase).map((e) => e.id);
    expect(withPassphrase.sort()).toEqual(['bitget', 'bitmart', 'kucoin', 'okx']);
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
    expect(getAutoSyncExchange('bybit')?.needsPassphrase).toBe(false);
    expect(getAutoSyncExchange('gateio')?.needsPassphrase).toBe(false);
    expect(getAutoSyncExchange('htx')?.needsPassphrase).toBe(false);
    expect(getAutoSyncExchange('cryptocom')?.label).toBe('Crypto.com Exchange');
    expect(getAutoSyncExchange('bitfinex')?.needsPassphrase).toBe(false);
    expect(getAutoSyncExchange('gemini')?.needsPassphrase).toBe(false);
    expect(getAutoSyncExchange(null)).toBeUndefined();
    expect(getAutoSyncExchange('nope')).toBeUndefined();
  });

  it('documents Bybit master-account withdrawal-history scope', () => {
    expect(getAutoSyncExchange('bybit')?.keyInstructions.join(' ')).toMatch(
      /master account.*master UID.*withdrawal history/i
    );
  });

  it('documents Gate.io read-only APIv4 setup and official key-management URL', () => {
    const gateio = getAutoSyncExchange('gateio')!;
    expect(gateio.docsUrl).toBe('https://www.gate.io/myaccount/api_key_manage');
    expect(gateio.keyInstructions.join(' ')).toMatch(/read-only.*never enable.*trading.*withdrawals.*margin.*futures/i);
    expect(gateio.keyInstructions.join(' ')).toMatch(/does not require a passphrase/i);
  });

  it('documents HTX read-only setup and official API URL', () => {
    const htx = getAutoSyncExchange('htx')!;
    expect(htx.docsUrl).toBe('https://www.htx.com/apikey');
    expect(htx.keyInstructions.join(' ')).toMatch(/read-only.*never enable.*trading.*withdrawals.*margin.*futures/i);
    expect(htx.keyInstructions.join(' ')).toMatch(/does not require a passphrase/i);
  });

  it('clearly separates Crypto.com Exchange API from Crypto.com App CSV', () => {
    const exchange = getAutoSyncExchange('cryptocom')!;
    expect(exchange.docsUrl).toBe('https://crypto.com/exchange/user/settings/api-management');
    expect(exchange.keyInstructions.join(' ')).toMatch(/Exchange.*not the Crypto\.com App.*read-only.*never enable.*App CSV.*separate/i);
    expect(exchange.keyInstructions.join(' ')).toMatch(/whole Exchange account.*not a complete spot-only subledger.*does not replace history-derived holdings/i);
    expect(exchange.needsPassphrase).toBe(false);
  });

  it('shows the complete Bitfinex retention and CSV beta limitations', () => {
    const bitfinex = getAutoSyncExchange('bitfinex')!;
    const copy = bitfinex.keyInstructions.join(' ');
    expect(copy).toMatch(/read-only.*never enable.*trading.*transfers.*withdrawals/i);
    expect(copy).toMatch(/approximately 7 days.*approximately 90 days/i);
    expect(copy).toMatch(/CSV beta supports the Trades schema only.*cannot backfill Movements/i);
    expect(copy).toMatch(/API↔CSV trade ID parity is unverified.*does not auto-deduplicate/i);
    expect(bitfinex.needsPassphrase).toBe(false);
  });

  it('documents Gemini account-level Auditor credentials without a passphrase', () => {
    const gemini = getAutoSyncExchange('gemini')!;
    expect(gemini.keyInstructions.join(' ')).toMatch(/account-level.*not a master key.*Auditor.*read-only.*never enable.*trading.*withdrawals/i);
    expect(gemini.keyInstructions.join(' ')).toMatch(/does not require a passphrase/i);
    expect(gemini.needsPassphrase).toBe(false);
  });

  it('documents BTC Markets read-only credentials and history limitations', () => {
    const btcmarkets = getAutoSyncExchange('btcmarkets')!;
    expect(btcmarkets.formatHint).toMatch(/base64 secret/i);
    expect(btcmarkets.keyInstructions.join(' ')).toMatch(/read permissions.*never enable.*order.*trading.*withdrawal/i);
    expect(btcmarkets.keyInstructions.join(' ')).toMatch(/retention is undocumented.*cannot verify account-lifetime.*no BTC Markets CSV parser.*deduplication is unavailable/i);
    expect(btcmarkets.needsPassphrase).toBe(false);
  });
});
