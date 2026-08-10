import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeConnectionRow } from '@/lib/storage/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/saas/config', () => ({
  isSaasMode: vi.fn(() => true)
}));

import { isSaasMode } from '@/lib/saas/config';
import {
  loadCcxt,
  createExchangeClient,
  classifySyncError,
  syncErrorMessage
} from './ccxtLoader';
import { TunnelError } from './tunnel';
import type { SyncErrorKind } from './types';
import { normalizeTransfer } from './normalize';

const isSaasModeMock = vi.mocked(isSaasMode);

function row(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'exc_1',
    exchange: 'binance',
    apiKey: 'key',
    secret: 'secret',
    createdAt: 1_700_000_000_000,
    cursors: {},
    status: 'idle',
    ...over
  };
}

beforeEach(() => {
  isSaasModeMock.mockReset();
  isSaasModeMock.mockReturnValue(true);
});

describe('loadCcxt', () => {
  it('resolves the ccxt module under vitest (memoized)', async () => {
    const a = await loadCcxt();
    const b = await loadCcxt();
    expect(a).toBe(b);
    expect(typeof a.binance).toBe('function');
    expect(typeof a.coinbase).toBe('function');
    expect(typeof a.kraken).toBe('function');
    expect(typeof a.okx).toBe('function');
    expect(typeof a.kucoin).toBe('function');
    expect(typeof a.bybit).toBe('function');
    expect(typeof a.gate).toBe('function');
    expect(typeof a.htx).toBe('function');
    expect(typeof a.cryptocom).toBe('function');
    expect(typeof a.bitfinex).toBe('function');
    expect(typeof a.gemini).toBe('function');
    expect(typeof a.btcmarkets).toBe('function');
    expect(typeof a.mexc).toBe('function');
    expect(typeof a.bitvavo).toBe('function');
    expect(typeof a.bitget).toBe('function');
    expect(typeof a.bitmart).toBe('function');
    expect(typeof a.coinex).toBe('function');
    expect(typeof a.poloniex).toBe('function');
    expect(typeof a.woo).toBe('function');
    expect(typeof a.hitbtc).toBe('function');
    expect(typeof a.bingx).toBe('function');
    expect(typeof a.binanceus).toBe('function');
    expect(typeof a.backpack).toBe('function');
    expect(typeof a.whitebit).toBe('function');
    expect(typeof a.bitflyer).toBe('function');
    expect(typeof a.coincheck).toBe('function');
  });
});

describe('createExchangeClient', () => {
  it.each(['coinex', 'poloniex', 'woo', 'hitbtc', 'bingx', 'binanceus', 'backpack', 'whitebit', 'bitflyer', 'coincheck'] as const)(
    'configures %s with API key/secret, spot scope and raw-response capture',
    async (exchange) => {
      const client = await createExchangeClient(row({ exchange }));
      const raw = client as unknown as {
        options: Record<string, unknown>; requiredCredentials: Record<string, boolean>;
        enableLastJsonResponse: boolean;
      };
      expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
      expect(raw.options.defaultType).toBe('spot');
      expect(raw.enableLastJsonResponse).toBe(true);
    }
  );

  it('pinned Backpack serializes the connector spot scope as scalar marketType=SPOT', async () => {
    const ccxt = await loadCcxt();
    const Backpack = ccxt.backpack as new (config: Record<string, unknown>) => {
      sign(path: string, api: string, method: string, params: Record<string, unknown>): { url: string };
    };
    const client = new Backpack({ apiKey: 'key', secret: btoa('\0'.repeat(32)) });
    const signed = client.sign('wapi/v1/history/fills', 'private', 'GET', { marketType: 'SPOT' });
    expect(signed.url).toContain('/wapi/v1/history/fills?marketType=SPOT');
  });
  it('pins Poloniex loadMarkets to the spot transport only', async () => {
    const client = await createExchangeClient(row({ exchange: 'poloniex' }));
    const emitted: string[] = [];
    client.fetch = async (url) => { emitted.push(new URL(url).pathname); return []; };
    await client.loadMarkets(true);
    expect(emitted).toEqual(['/markets']);
    expect(emitted.some((path) => /future|swap/i.test(path))).toBe(false);
  });

  it('keeps BingX deposit/withdraw endpoint kind authoritative over pinned CCXT parsing', async () => {
    const client = await createExchangeClient(row({ exchange: 'bingx' }));
    client.markets = {};
    const emitted: string[] = [];
    client.fetch = async (url) => {
      const path = new URL(url).pathname;
      emitted.push(path);
      if (path.endsWith('/deposit/hisrec')) return [{
        id: 'bingx-deposit', amount: '1', coin: 'BTC', status: 1, insertTime: 1_700_000_000_000,
        transferType: 0
      }];
      return [{
        id: 'bingx-withdrawal', amount: '0.5', coin: 'BTC', status: 6,
        applyTime: '2023-11-14T22:13:21.000Z', transferType: 0, transactionFee: '0.01'
      }];
    };
    const [deposit] = await client.fetchDeposits(undefined, undefined, 1000);
    const [withdrawal] = await client.fetchWithdrawals(undefined, undefined, 1000);
    expect(deposit.type).toBe('deposit');
    expect(withdrawal.type).toBe('deposit'); // pinned CCXT bug: transferType=0 wins
    expect(normalizeTransfer('bingx', deposit, 'deposit')).toMatchObject({ type: 'transfer_in' });
    expect(normalizeTransfer('bingx', withdrawal, 'withdrawal')).toMatchObject({
      type: 'transfer_out', feeAmount: 0.01,
      raw: expect.objectContaining({ exchangeSyncKind: 'withdrawal', transferType: 'withdrawal' })
    });
    expect(emitted).toEqual([
      '/openApi/api/v3/capital/deposit/hisrec',
      '/openApi/api/v3/capital/withdraw/history'
    ]);
  });
  it('sets enableRateLimit + timeout, credentials, and spot defaultType (binance/okx)', async () => {
    const client = await createExchangeClient(row());
    const raw = client as unknown as Record<string, unknown>;
    expect(raw.enableRateLimit).toBe(true);
    expect(raw.timeout).toBe(30_000);
    expect(raw.apiKey).toBe('key');
    expect(raw.secret).toBe('secret');
    expect((raw.options as Record<string, unknown>).defaultType).toBe('spot');
    // Spot-only markets fetch: without this ccxt's loadMarkets also hits the
    // futures hosts (fapi/dapi), which the relay's spot-only host map rejects.
    expect((raw.options as Record<string, unknown>).fetchMarkets).toEqual(['spot']);
    // fetchCurrencies disabled: ccxt's binance fetchCurrencies would otherwise
    // hit signed SAPI endpoints (incl. /sapi/v1/margin/allPairs) we never use.
    expect((raw.options as Record<string, unknown>).fetchCurrencies).toBe(false);
    // fetchMargins disabled: binance defaults it to true, which makes
    // fetchMarkets pull margin pair lists from signed SAPI endpoints.
    expect((raw.options as Record<string, unknown>).fetchMargins).toBe(false);
    // Tunnel transport installed (fetch overridden from the prototype default).
    const fresh = new ((await loadCcxt()).binance as new (c: Record<string, unknown>) => Record<string, unknown>)({});
    expect(client.fetch).not.toBe(fresh.fetch);
  });

  it('maps passphrase → ccxt password for okx, kucoin and bitget', async () => {
    for (const exchange of ['okx', 'kucoin', 'bitget'] as const) {
      const client = await createExchangeClient(row({ exchange, passphrase: 'phrase' }));
      expect((client as unknown as Record<string, unknown>).password).toBe('phrase');
    }
  });

  it('maps BitMart Memo → ccxt uid and replaces mixed market loading with the spot method', async () => {
    const client = await createExchangeClient(row({ exchange: 'bitmart', passphrase: 'api-memo' }));
    const raw = client as unknown as {
      uid?: string; password?: string; options: Record<string, unknown>; has: Record<string, unknown>;
      fetchMarkets: unknown; fetchSpotMarkets: unknown; requiredCredentials: Record<string, boolean>;
    };
    expect(raw.uid).toBe('api-memo');
    expect(raw.password).toBeUndefined();
    expect(raw.options).toMatchObject({ defaultType: 'spot', fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.fetchMarkets).not.toBe(Object.getPrototypeOf(client).fetchMarkets);
    expect(typeof raw.fetchSpotMarkets).toBe('function');
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, uid: true });
  });

  it('configures Bybit as spot-only without signed currency discovery', async () => {
    const client = await createExchangeClient(row({ exchange: 'bybit' }));
    const options = (client as unknown as { options: Record<string, unknown> }).options;
    expect(options.defaultType).toBe('spot');
    expect(options.fetchMarkets).toMatchObject({ types: ['spot'] });
    expect(options.fetchCurrencies).toBe(false);
    expect((client as unknown as { has: Record<string, unknown> }).has.fetchCurrencies).toBe(false);
    expect(options).toMatchObject({
      enableUnifiedMargin: false,
      enableUnifiedAccount: true,
      unifiedMarginStatus: 6
    });
    expect((client as unknown as { requiredCredentials: Record<string, boolean> }).requiredCredentials)
      .toMatchObject({ apiKey: true, secret: true, password: false });
  });

  it('maps gateio to CCXT gate and avoids unified/currency/margin probes', async () => {
    const client = await createExchangeClient(row({ exchange: 'gateio' }));
    const raw = client as unknown as {
      id: string;
      options: Record<string, unknown>;
      has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>;
      publicMarginGetCurrencyPairs: () => Promise<unknown[]>;
    };
    expect(raw.id).toBe('gate');
    expect(raw.options).toMatchObject({
      defaultType: 'spot', fetchMarkets: { types: ['spot'] }, unifiedAccount: false, fetchCurrencies: false
    });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(await raw.publicMarginGetCurrencyPairs()).toEqual([]);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
  });

  it('configures HTX for spot-only markets and account discovery without currency probes', async () => {
    const client = await createExchangeClient(row({ exchange: 'htx' }));
    const raw = client as unknown as {
      options: Record<string, unknown>;
      has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>;
      enableLastJsonResponse: boolean;
      password?: string;
    };
    expect(raw.options).toMatchObject({
      defaultType: 'spot',
      fetchMarkets: { types: { spot: true, linear: false, inverse: false } },
      fetchCurrencies: false
    });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.enableLastJsonResponse).toBe(true);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
  });

  it('configures Crypto.com Exchange spot defaults without currency discovery or passphrase', async () => {
    const client = await createExchangeClient(row({ exchange: 'cryptocom' }));
    const raw = client as unknown as {
      options: Record<string, unknown>; has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>; password?: string;
    };
    expect(raw.options).toMatchObject({ defaultType: 'spot', skipFetchCurrencies: true, fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
  });

  it('pins Bitfinex to api.bitfinex.com with exchange-wallet spot scope and no currency/passphrase probe', async () => {
    const client = await createExchangeClient(row({ exchange: 'bitfinex' }));
    const raw = client as unknown as {
      options: Record<string, unknown>;
      has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>;
      urls: { api: Record<string, string> };
      password?: string;
      fetchDepositsWithdrawals?: unknown;
    };
    expect(raw.options).toMatchObject({ defaultType: 'spot', fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
    expect(raw.urls.api).toMatchObject({
      v1: 'https://api.bitfinex.com',
      public: 'https://api.bitfinex.com',
      private: 'https://api.bitfinex.com'
    });
    expect(typeof raw.fetchDepositsWithdrawals).toBe('function');
  });

  it('configures Gemini for API-only spot markets without currency discovery or passphrase', async () => {
    const client = await createExchangeClient(row({ exchange: 'gemini', apiKey: 'account-key' }));
    const raw = client as unknown as {
      options: Record<string, unknown>; has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>; password?: string;
      enableLastJsonResponse: boolean;
      fetchDepositsWithdrawals?: unknown;
    };
    expect(raw.options).toMatchObject({
      defaultType: 'spot', fetchCurrencies: false, fetchMarketsMethod: 'fetch_markets_from_api'
    });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
    expect(raw.enableLastJsonResponse).toBe(true);
    expect(typeof raw.fetchDepositsWithdrawals).toBe('function');
  });

  it('configures the pinned BTC Markets class and signs only the observed v3 GET shape', async () => {
    const secret = Buffer.from('fixture-secret').toString('base64');
    const client = await createExchangeClient(row({ exchange: 'btcmarkets', apiKey: 'BM_KEY', secret }));
    const raw = client as unknown as {
      id: string; options: Record<string, unknown>; has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>; password?: string;
      enableLastJsonResponse: boolean; enableLastResponseHeaders: boolean;
      fetchDepositsWithdrawals?: unknown;
      sign(path: string, api: string, method: string, params: Record<string, unknown>): {
        url: string; method: string; headers: Record<string, string>;
      };
    };
    expect(raw.id).toBe('btcmarkets');
    expect(raw.options).toMatchObject({ defaultType: 'spot', fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
    expect(raw.enableLastJsonResponse).toBe(true);
    expect(raw.enableLastResponseHeaders).toBe(true);
    expect(typeof raw.fetchDepositsWithdrawals).toBe('function');
    const signed = raw.sign('trades', 'private', 'GET', { limit: 200, before: '818047' });
    expect(signed.url).toBe('https://api.btcmarkets.net/v3/trades?before=818047&limit=200');
    expect(signed.method).toBe('GET');
    expect(signed.headers).toMatchObject({
      'BM-AUTH-APIKEY': 'BM_KEY',
      'BM-AUTH-TIMESTAMP': expect.stringMatching(/^\d+$/),
      'BM-AUTH-SIGNATURE': expect.any(String)
    });
  });

  it('pins MEXC loadMarkets to fetchSpotMarkets and records no contract path', async () => {
    const client = await createExchangeClient(row({ exchange: 'mexc', apiKey: 'D'.repeat(32), secret: 'E'.repeat(32) }));
    const raw = client as unknown as {
      options: Record<string, unknown>; has: Record<string, unknown>; requiredCredentials: Record<string, boolean>;
      password?: string; enableLastJsonResponse: boolean;
      fetch: (url: string, method?: string, headers?: Record<string, string>, body?: string) => Promise<unknown>;
      sign(path: string, api: unknown, method: string, params: Record<string, unknown>): { url: string; method: string; headers: Record<string, string> };
      loadMarkets(reload?: boolean): Promise<unknown>;
    };
    expect(raw.options).toMatchObject({ defaultType: 'spot', fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
    expect(raw.enableLastJsonResponse).toBe(true);

    const exchangeInfo = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/exchangeSync/__fixtures__/mexc/exchangeInfo.json'), 'utf8'));
    const emitted: string[] = [];
    raw.fetch = async (url) => { emitted.push(new URL(url).pathname); return exchangeInfo; };
    const loaded = await client.loadMarkets();
    expect(emitted).toEqual(['/api/v3/exchangeInfo']);
    expect(emitted).not.toContain('/api/v1/contract/detail');
    expect(loaded['OLD/USDT']).toMatchObject({ spot: true, active: false });

    const signed = raw.sign('account', ['spot', 'private'], 'GET', { timestamp: 1, recvWindow: 5000 });
    expect(new URL(signed.url).pathname).toBe('/api/v3/account');
    expect(signed.method).toBe('GET');
    expect(signed.headers).toMatchObject({ 'X-MEXC-APIKEY': 'D'.repeat(32), source: 'CCXT' });

    const signedTrades = raw.sign('myTrades', ['spot', 'private'], 'GET', { symbol: 'BTCUSDT', limit: 100 });
    expect(new URL(signedTrades.url).pathname).toBe('/api/v3/myTrades');
    expect(new URL(signedTrades.url).searchParams.get('limit')).toBe('100');
  });

  it('configures Bitvavo without passphrase/currencies and loadMarkets invokes only market discovery', async () => {
    const client = await createExchangeClient(row({ exchange: 'bitvavo', apiKey: 'A'.repeat(64), secret: 'B'.repeat(64) }));
    const raw = client as unknown as {
      options: Record<string, unknown>; has: Record<string, unknown>; password?: string;
      requiredCredentials: Record<string, boolean>; enableLastJsonResponse: boolean;
      fetchMarkets: ReturnType<typeof vi.fn>; fetchCurrencies: ReturnType<typeof vi.fn>;
      loadMarkets(reload?: boolean): Promise<unknown>;
    };
    expect(raw.options).toMatchObject({ defaultType: 'spot', fetchCurrencies: false });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: false });
    expect(raw.password).toBeUndefined();
    expect(raw.enableLastJsonResponse).toBe(true);
    raw.fetchMarkets = vi.fn(async () => []);
    raw.fetchCurrencies = vi.fn(async () => { throw new Error('must not fetch currencies'); });
    await raw.loadMarkets(true);
    expect(raw.fetchMarkets).toHaveBeenCalledTimes(1);
    expect(raw.fetchCurrencies).not.toHaveBeenCalled();
  });

  it('pins Bitget to classic spot v2 without UTA, swap, currency or margin transport', async () => {
    const client = await createExchangeClient(row({
      exchange: 'bitget', apiKey: 'BG_KEY', secret: 'BG_SECRET', passphrase: 'BG_PHRASE'
    }));
    const raw = client as unknown as {
      options: Record<string, unknown>; has: Record<string, unknown>;
      requiredCredentials: Record<string, boolean>; password?: string;
      enableLastJsonResponse: boolean;
      publicMarginGetV2MarginCurrencies: () => Promise<unknown>;
      sign(path: string, api: string[], method: string, params: Record<string, unknown>): {
        url: string; method: string; headers: Record<string, string | undefined>;
      };
    };
    expect(raw.options).toMatchObject({
      defaultType: 'spot', fetchMarkets: { types: ['spot'] }, fetchCurrencies: false, uta: false
    });
    expect(raw.has.fetchCurrencies).toBe(false);
    expect(raw.requiredCredentials).toMatchObject({ apiKey: true, secret: true, password: true });
    expect(raw.password).toBe('BG_PHRASE');
    expect(raw.enableLastJsonResponse).toBe(true);
    expect(await raw.publicMarginGetV2MarginCurrencies()).toEqual({ code: '00000', msg: 'success', data: [] });
    const signed = raw.sign('v2/spot/trade/fills', ['private', 'spot'], 'GET', {
      symbol: 'BTCUSDT', idLessThan: '1098394344974925824', limit: 100
    });
    expect(signed.url).toMatch(/^https:\/\/api\.bitget\.com\/api\/v2\/spot\/trade\/fills\?/);
    expect(signed.url).toContain('idLessThan=1098394344974925824');
    expect(signed.headers).toMatchObject({
      'ACCESS-KEY': 'BG_KEY', 'ACCESS-SIGN': expect.any(String),
      'ACCESS-TIMESTAMP': expect.stringMatching(/^\d+$/), 'ACCESS-PASSPHRASE': 'BG_PHRASE'
    });
  });

  it('does not set password for exchanges without a passphrase', async () => {
    const client = await createExchangeClient(row({ exchange: 'kraken' }));
    expect((client as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it('throws TunnelError(not_hosted) outside hosted mode', async () => {
    isSaasModeMock.mockReturnValue(false);
    const err = await createExchangeClient(row()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('not_hosted');
  });
});

describe('classifySyncError', () => {
  async function ccxtError(className: string): Promise<Error> {
    const ccxt = await loadCcxt();
    const Ctor = ccxt[className] as new (message: string) => Error;
    return new Ctor('boom');
  }

  it.each([
    ['AuthenticationError', 'invalid_key'],
    ['AccountSuspended', 'invalid_key'], // subclass of AuthenticationError
    ['PermissionDenied', 'permission'],
    ['AccountNotEnabled', 'permission'], // subclass of PermissionDenied
    ['RateLimitExceeded', 'rate_limit'],
    ['DDoSProtection', 'rate_limit'],
    ['NetworkError', 'network'],
    ['ExchangeNotAvailable', 'network'],
    ['RequestTimeout', 'network']
  ])('ccxt %s → %s', async (className, kind) => {
    expect(classifySyncError(await ccxtError(className))).toBe(kind);
  });

  it('recognizes native MEXC 10072 as a credential error', () => {
    expect(classifySyncError(new Error('mexc {"code":10072,"msg":"Api key info invalid"}'))).toBe('invalid_key');
    expect(syncErrorMessage('invalid_key', 'mexc')).toContain('API key or secret rejected by MEXC');
  });

  it('still classifies when class binding names are minified (BUG-1 regression)', async () => {
    // Production builds rename class bindings (`class D extends O`) while ccxt
    // keeps the semantic name only on instances. constructor.name matching
    // then silently fails — every ccxt error classified as 'unknown' on the
    // live site. Simulate by renaming the bindings; instanceof matching must
    // carry both the direct and the subclass→parent mapping.
    const ccxt = await loadCcxt();
    const Auth = ccxt['AuthenticationError'] as new (message: string) => Error;
    const Susp = ccxt['AccountSuspended'] as new (message: string) => Error;
    const authName = Object.getOwnPropertyDescriptor(Auth, 'name');
    const suspName = Object.getOwnPropertyDescriptor(Susp, 'name');
    Object.defineProperty(Auth, 'name', { value: 'D', configurable: true });
    Object.defineProperty(Susp, 'name', { value: 'be', configurable: true });
    try {
      expect(classifySyncError(new Auth('boom'))).toBe('invalid_key');
      expect(classifySyncError(new Susp('boom'))).toBe('invalid_key'); // subclass → parent
    } finally {
      if (authName) Object.defineProperty(Auth, 'name', authName);
      if (suspName) Object.defineProperty(Susp, 'name', suspName);
    }
  });

  it('ExchangeNotAvailable with a geo-block message → region_blocked (not network)', async () => {
    const ccxt = await loadCcxt();
    const ExchangeNotAvailable = ccxt['ExchangeNotAvailable'] as new (message: string) => Error;
    const geoBlocked = new ExchangeNotAvailable(
      'binance GET https://api.binance.com/api/v3/account 451 {"code":0,"msg":"Service unavailable from a restricted location. One or more of your API keys may be associated with an ineligible account."}'
    );
    expect(classifySyncError(geoBlocked)).toBe('region_blocked');
    // Case-insensitive, and checked before the generic network mapping.
    const upper = new ExchangeNotAvailable('Service unavailable from a RESTRICTED LOCATION');
    expect(classifySyncError(upper)).toBe('region_blocked');
    // An ordinary ExchangeNotAvailable still maps to network.
    expect(classifySyncError(new ExchangeNotAvailable('boom'))).toBe('network');
  });

  it('maps only BitMart known 30002 and missing X-BM-KEY responses to invalid_key', () => {
    const actual = new Error(
      'bitmart GET https://api-cloud.bitmart.com/account/v1/wallet 401 {"code":30002,"message":"Header X-BM-KEY not found"}'
    );
    expect(classifySyncError(actual, 'bitmart')).toBe('invalid_key');
    expect(classifySyncError(new Error('code=30002'), 'bitmart')).toBe('invalid_key');
    expect(classifySyncError(new Error('Header X-BM-KEY not found'), 'bitmart')).toBe('invalid_key');

    expect(classifySyncError(actual, 'binance')).toBe('unknown');
    expect(classifySyncError(new Error('HTTP 401 missing authorization header'), 'bitmart')).toBe('unknown');
    expect(classifySyncError(new Error('code=30003'), 'bitmart')).toBe('unknown');
  });

  it.each([
    'not_hosted',
    'relay_auth',
    'relay_subscription',
    'relay_disabled',
    'relay_payload',
    'relay_unavailable'
  ] as SyncErrorKind[])('TunnelError(%s) passes through', (kind) => {
    expect(classifySyncError(new TunnelError(kind))).toBe(kind);
  });

  it('generic Error → unknown', () => {
    expect(classifySyncError(new Error('weird'))).toBe('unknown');
    expect(classifySyncError('string failure')).toBe('unknown');
    expect(classifySyncError(undefined)).toBe('unknown');
  });
});

describe('syncErrorMessage', () => {
  it('produces plain-language copy mentioning the exchange label', () => {
    expect(syncErrorMessage('invalid_key', 'binance')).toContain('Binance');
    expect(syncErrorMessage('permission', 'okx')).toContain('OKX');
    expect(syncErrorMessage('network', 'kucoin')).toContain('KuCoin');
    expect(syncErrorMessage('relay_auth', 'kraken')).toContain('sign in');
    expect(syncErrorMessage('invalid_key', 'gateio')).toContain('Gate.io');
    expect(syncErrorMessage('invalid_key', 'htx')).toContain('HTX');
    expect(syncErrorMessage('invalid_key', 'bitmart')).toBe(
      'API key or secret rejected by BitMart — check the key and try again.'
    );
  });

  it('region_blocked copy points users at CSV import', () => {
    const msg = syncErrorMessage('region_blocked', 'binance');
    expect(msg).toContain('CSV import');
    expect(msg).toContain('blocks our hosting region');
  });

  it('region_blocked copy names the actual exchange, not hardcoded Binance', () => {
    const msg = syncErrorMessage('region_blocked', 'okx');
    expect(msg).toContain('OKX');
    expect(msg).not.toContain('Binance');
  });

  it('a malformed secret crashing signing locally (base64 decode) → invalid_key', () => {
    // Live finding: Kraken secrets that are not valid base64 crash ccxt's
    // sign() before any request — a plain Error, not a ccxt class.
    expect(
      classifySyncError(new Error('padding: invalid, string should have whole number of bytes'))
    ).toBe('invalid_key');
    expect(
      classifySyncError(new Error('The string to be decoded is not correctly encoded'))
    ).toBe('invalid_key');
  });
});
