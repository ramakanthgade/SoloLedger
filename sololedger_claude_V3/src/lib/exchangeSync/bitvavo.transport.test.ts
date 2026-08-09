import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExchangeConnectionRow } from '@/lib/storage/db';

vi.mock('@/lib/saas/config', () => ({
  AUTH_TOKEN_KEY: 'sololedger_auth_token',
  getApiBase: () => 'https://relay.test',
  isSaasMode: () => true
}));

import { createExchangeClient } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const START = 1_785_888_000_000;
const END = 1_785_972_600_000;
const EXCHANGE_HEADERS = [
  'x-exchange-bitvavo-access-key',
  'x-exchange-bitvavo-access-signature',
  'x-exchange-bitvavo-access-timestamp',
  'x-exchange-bitvavo-access-window'
];

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

interface NativeCcxtRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fixture(name: 'trades' | 'deposits' | 'withdrawals'): unknown[] {
  return (JSON.parse(readFileSync(
    join(HERE, '__fixtures__', 'bitvavo', `${name}.json`), 'utf8'
  )) as { response: unknown[] }).response;
}

function connection(): ExchangeConnectionRow {
  return {
    id: 'exc_bitvavo_transport',
    exchange: 'bitvavo',
    apiKey: 'D'.repeat(64),
    secret: 'E'.repeat(64),
    createdAt: START,
    cursors: {},
    status: 'idle'
  };
}

beforeEach(() => {
  localStorage.setItem('sololedger_auth_token', 'fixture-jwt');
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Bitvavo pinned CCXT transport fixture', () => {
  it('signs the exact GET query and emits only the four allow-listed auth headers', async () => {
    const fixture = JSON.parse(readFileSync(
      join(HERE, '__fixtures__', 'bitvavo', 'transport.json'), 'utf8'
    )) as {
      request: { path: string; api: string; method: string; params: Record<string, unknown> };
    };
    const ccxt = await import('ccxt') as unknown as {
      bitvavo: new (config: object) => {
        sign(path: string, api: string, method: string, params: Record<string, unknown>): {
          url: string; method: string; headers: Record<string, string>;
        };
      };
    };
    const client = new ccxt.bitvavo({ apiKey: 'D'.repeat(64), secret: 'E'.repeat(64) });
    const signed = client.sign(
      fixture.request.path, fixture.request.api, fixture.request.method, fixture.request.params
    );
    expect(signed.method).toBe('GET');
    expect(signed.url).toBe(
      'https://api.bitvavo.com/v2/trades?market=BTC-EUR&start=1785888000000&end=1785972600000&limit=1000&tradeIdFrom=11111111-1111-4111-8111-111111111111&tradeIdTo=22222222-2222-4222-8222-222222222222'
    );
    expect(Object.keys(signed.headers).sort()).toEqual([
      'BITVAVO-ACCESS-KEY',
      'BITVAVO-ACCESS-SIGNATURE',
      'BITVAVO-ACCESS-TIMESTAMP',
      'BITVAVO-ACCESS-WINDOW'
    ]);
  });

  it('runs every sync method through the tunnel with pinned real request bytes', async () => {
    const captured: CapturedRequest[] = [];
    const nativeRequests: NativeCcxtRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      captured.push({ url, init });
      const body = url.includes('/v2/markets')
        ? [{
            market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', tickSize: '1.00',
            quantityDecimals: '8', notionalDecimals: '2', minOrderInBaseAsset: '0.0001',
            maxOrderInBaseAsset: '100', minOrderInQuoteAsset: '5', maxOrderInQuoteAsset: '100000'
          }]
        : url.includes('/v2/balance')
          ? [{ symbol: 'BTC', available: '1.25', inOrder: '0.25' }]
          : url.includes('/v2/trades')
            ? fixture('trades')
            : url.includes('/v2/depositHistory')
              ? fixture('deposits')
              : fixture('withdrawals');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));

    const client = await createExchangeClient(connection());
    const tunnelFetch = client.fetch.bind(client);
    client.fetch = async (url, method, headers, body) => {
      nativeRequests.push({ url, method, headers, body });
      return tunnelFetch(url, method, headers, body);
    };
    // Transport bytes, not throttling, are under test. Keep the real pinned
    // CCXT methods while avoiding five sequential rate-limit sleeps in CI.
    (client as unknown as { enableRateLimit: boolean }).enableRateLimit = false;

    await client.loadMarkets(true);
    await client.fetchBalance({ symbol: 'BTC' });
    await client.fetchMyTrades('BTC/EUR', START, 1000, {
      end: END,
      tradeIdFrom: '11111111-1111-4111-8111-111111111111',
      tradeIdTo: '22222222-2222-4222-8222-222222222222'
    });
    await client.fetchDeposits(undefined, undefined, 1000, { start: START, end: END });
    await client.fetchWithdrawals('BTC', undefined, 1000, { start: START, end: END });

    const relayUrls = [
      'https://relay.test/api/proxy/exchange/bitvavo/v2/markets',
      'https://relay.test/api/proxy/exchange/bitvavo/v2/balance?symbol=BTC',
      'https://relay.test/api/proxy/exchange/bitvavo/v2/trades?market=BTC-EUR&start=1785888000000&limit=1000&end=1785972600000&tradeIdFrom=11111111-1111-4111-8111-111111111111&tradeIdTo=22222222-2222-4222-8222-222222222222',
      'https://relay.test/api/proxy/exchange/bitvavo/v2/depositHistory?limit=1000&start=1785888000000&end=1785972600000',
      'https://relay.test/api/proxy/exchange/bitvavo/v2/withdrawalHistory?symbol=BTC&limit=1000&start=1785888000000&end=1785972600000'
    ];
    expect(captured.map(({ url }) => url)).toEqual(relayUrls);
    expect(nativeRequests.map(({ url }) => url)).toEqual(relayUrls.map((url) =>
      url.replace('https://relay.test/api/proxy/exchange/bitvavo', 'https://api.bitvavo.com')
    ));

    for (const [index, request] of nativeRequests.entries()) {
      expect(request.method, `native request ${index}`).toBe('GET');
      expect(request.body, `native request ${index}`).toBeUndefined();
      expect(Object.keys(request.headers ?? {}).sort(), `native request ${index}`).toEqual(
        index === 0 ? [] : EXCHANGE_HEADERS.map((name) =>
          name.replace('x-exchange-bitvavo-access-', 'BITVAVO-ACCESS-').toUpperCase()
        ).sort()
      );
    }

    for (const [index, { init }] of captured.entries()) {
      expect(init.method, `request ${index}`).toBe('GET');
      expect(init.body, `request ${index}`).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get('authorization'), `request ${index}`).toBe('Bearer fixture-jwt');
      const forwarded = Array.from(headers.keys()).filter((name) => name.startsWith('x-exchange-')).sort();
      expect(forwarded, `request ${index}`).toEqual(index === 0 ? [] : EXCHANGE_HEADERS);
      expect(Array.from(headers.keys()).sort(), `request ${index}`).toEqual(
        index === 0 ? ['authorization'] : ['authorization', ...EXCHANGE_HEADERS].sort()
      );
    }
  });
});
