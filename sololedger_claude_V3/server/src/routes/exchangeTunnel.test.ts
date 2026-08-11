import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'events';
import http from 'http';
import { readFileSync } from 'fs';
import type { AddressInfo } from 'net';
import type { Request, Response } from 'express';

/**
 * Exchange tunnel (contract C1/C2/C4) — tier-2 CI against a mocked upstream.
 * A real loopback app (app.listen(0)) mirrors index.ts mount order; a routed
 * global fetch stub sends only upstream (relay → exchange) calls to the mock
 * while client → relay calls hit the loopback server for real.
 */

const mocks = vi.hoisted(() => ({
  subscriptionActive: true,
  exchangeSyncEnabled: true
}));

const USER = {
  id: 'u1',
  email: 'u@example.com',
  role: 'subscriber',
  plan: 'pro',
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  createdAt: ''
};

vi.mock('../auth.js', () => ({
  authMiddleware: (
    req: { headers: Record<string, string | undefined>; user?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void
  ) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { sub: USER.id };
    next();
  },
  getUserFromRequest: (req: { user?: unknown }) => (req.user ? USER : undefined),
  isSubscriptionActive: () => mocks.subscriptionActive
}));

vi.mock('../store.js', () => ({
  getServerConfig: () => ({
    priceApiEnabled: true,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: false,
    exchangeSyncEnabled: mocks.exchangeSyncEnabled
  })
}));

vi.mock('../apiKeys.js', () => ({
  resolveApiKey: () => undefined
}));

import express from 'express';
import cors from 'cors';
import { exchangeTunnelHandler, exchangeTunnelRouter, tunnelBodyErrorHandler } from './exchangeTunnel.js';

/** Loopback app mirroring index.ts: cors(exposedHeaders) → raw mount → express.json. */
function buildApp() {
  const app = express();
  app.use(
    cors({
      origin(origin, cb) {
        cb(null, origin ?? 'http://localhost:5173');
      },
      credentials: true,
      exposedHeaders: ['x-sololedger-error']
    })
  );
  app.use(
    '/api/proxy/exchange',
    express.raw({ type: () => true, limit: '1mb' }),
    exchangeTunnelRouter,
    tunnelBodyErrorHandler
  );
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

const realFetch = globalThis.fetch;
const upstreamMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

let server: http.Server;
let base: string;

const AUTH = { authorization: 'Bearer test-token' };
const bitvavo305Fixture = JSON.parse(
  readFileSync(
    new URL('../../../src/lib/exchangeSync/__fixtures__/bitvavo/dummy-balance-305.recorded.json', import.meta.url),
    'utf8'
  )
) as {
  httpStatus: number;
  response: { errorCode: number; error: string };
};

function client(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/api/proxy/exchange${path}`, init);
}

/** Raw node:http client — full header control (undici fetch can filter some). */
function rawRequest(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      base,
      { method: opts.method ?? 'GET', path: `/api/proxy/exchange${opts.path}`, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function upstreamJson(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function lastUpstreamCall(): [string, RequestInit] {
  expect(upstreamMock).toHaveBeenCalledTimes(1);
  return upstreamMock.mock.calls[0];
}

function errorLogs(): string {
  return (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(' ')).join('\n');
}

function makeStubRes() {
  const state: { statusCode: number; jsonBody: unknown } = { statusCode: 200, jsonBody: undefined };
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader() {},
    json(payload: unknown) {
      state.jsonBody = payload;
      return this;
    },
    send(payload: unknown) {
      state.jsonBody = payload;
      return this;
    }
  } as unknown as Response;
  return { res, state };
}

beforeAll(async () => {
  server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  mocks.subscriptionActive = true;
  mocks.exchangeSyncEnabled = true;
  upstreamMock.mockReset();
  // Routed fetch stub: loopback (client → relay) real, upstream → mock.
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    return upstreamMock(String(url), init);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 1. Per exchange: encoded query forwarded byte-exact; method/body
 *    correct; downstream status/content-type/body identical to upstream.
 * ------------------------------------------------------------------ */
describe('1. byte-exact forwarding per exchange', () => {
  const CASES: [string, string, string][] = [
    ['binance', 'api.binance.com', '/api/v3/time'],
    ['coinbase', 'api.coinbase.com', '/api/v3/brokerage/market/products'],
    ['kraken', 'api.kraken.com', '/0/public/Time'],
    ['okx', 'www.okx.com', '/api/v5/public/time'],
    ['kucoin', 'api.kucoin.com', '/api/v1/timestamp'],
    ['bybit', 'api.bybit.com', '/v5/market/time'],
    ['gateio', 'api.gateio.ws', '/api/v4/spot/time'],
    ['htx', 'api.huobi.pro', '/v1/common/timestamp'],
    ['cryptocom', 'api.crypto.com', '/exchange/v1/public/get-instruments'],
    ['bitfinex', 'api.bitfinex.com', '/v2/platform/status'],
    ['btcmarkets', 'api.btcmarkets.net', '/v3/time'],
    ['mexc', 'api.mexc.com', '/api/v3/time'],
    ['bitvavo', 'api.bitvavo.com', '/v2/time'],
    ['bitstamp', 'www.bitstamp.net', '/api/v2/markets/'],
    ['bitget', 'api.bitget.com', '/api/v2/public/time'],
    ['bitmart', 'api-cloud.bitmart.com', '/system/time'],
    ['coinex', 'api.coinex.com', '/v2/time'],
    ['poloniex', 'api.poloniex.com', '/markets'],
    ['woo', 'api.woox.io', '/v3/systemInfo'],
    ['hitbtc', 'api.hitbtc.com', '/api/3/public/symbol'],
    ['bingx', 'open-api.bingx.com', '/openApi/spot/v1/server/time'],
    ['binanceus', 'api.binance.us', '/api/v3/time'],
    ['backpack', 'api.backpack.exchange', '/api/v1/time'],
    ['whitebit', 'whitebit.com', '/api/v4/public/time'],
    ['bitflyer', 'api.bitflyer.com', '/v1/getmarkets'],
    ['coincheck', 'coincheck.com', '/api/ticker'],
    ['bitrue', 'www.bitrue.com', '/api/v1/ping'],
    ['xt', 'sapi.xt.com', '/v4/public/time'],
    ['coinspot', 'www.coinspot.com.au', '/pubapi/latest'],
    ['phemex', 'api.phemex.com', '/public/products'],
    ['lbank', 'api.lbank.info', '/v2/timestamp.do']
  ];
  const QUERY = 'pair=BTC%2CETH&sig=Ab%2B%2F%3D';

  it.each(CASES)('%s → https://%s%s (byte-exact query)', async (exchangeId, host, path) => {
    upstreamMock.mockResolvedValue(upstreamJson('{"ok":true}'));

    const res = await client(`/${exchangeId}${path}?${QUERY}`, { headers: AUTH });

    const [url, init] = lastUpstreamCall();
    expect(url).toBe(`https://${host}${path}?${QUERY}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. Raw body byte-integrity (express.raw ordering beats express.json).
 * ------------------------------------------------------------------ */
describe('2. raw body byte-integrity', () => {
  it('POST form body with encoded signature reaches upstream byte-identical', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"error":[]}'));
    const body = 'nonce=1700000000000&signature=Ab%2B%2F%3D%2Bxyz%3D';

    const res = await client('/kraken/0/private/AddOrder', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      body
    });

    expect(res.status).toBe(200);
    const [, init] = lastUpstreamCall();
    expect(init.method).toBe('POST');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(Buffer.compare(init.body as Buffer, Buffer.from(body, 'utf8'))).toBe(0);
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
  });

  it('POST JSON body reaches upstream byte-identical', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"result":"ok"}'));
    const body = '{"json":true,"sig":"Ab+/="}';

    const res = await client('/binance/api/v3/order/test', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body
    });

    expect(res.status).toBe(200);
    const [, init] = lastUpstreamCall();
    expect(Buffer.compare(init.body as Buffer, Buffer.from(body, 'utf8'))).toBe(0);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Header allowlist: only x-exchange-<allowlisted> + content-type go
 *    upstream; cookies/origin/etc. never leak.
 * ------------------------------------------------------------------ */
describe('3. header allowlist', () => {
  it('binance: forwards only x-mbx-apikey + content-type', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"ok":true}'));

    const res = await rawRequest({
      path: '/binance/api/v3/account?timestamp=1&signature=abc',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-exchange-x-mbx-apikey': 'BINANCE_KEY_123',
        'x-exchange-cookie': 'session=evil',
        cookie: 'session=evil',
        origin: 'http://evil.example'
      }
    });

    expect(res.status).toBe(200);
    const [, init] = lastUpstreamCall();
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-mbx-apikey': 'BINANCE_KEY_123'
    });
  });

  it('coinbase: x-exchange-authorization maps to upstream authorization', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"ok":true}'));

    await rawRequest({
      path: '/coinbase/api/v3/brokerage/accounts',
      headers: {
        ...AUTH,
        'x-exchange-authorization': 'Bearer CDP_TOKEN',
        'x-exchange-cb-access-key': 'CB_KEY',
        'user-agent': 'evil-agent'
      }
    });

    const [, init] = lastUpstreamCall();
    expect(init.headers).toEqual({
      authorization: 'Bearer CDP_TOKEN',
      'cb-access-key': 'CB_KEY'
    });
  });

  it('bybit: forwards only the four V5 auth headers', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"retCode":0}'));
    await rawRequest({
      path: '/bybit/v5/execution/list?category=spot',
      headers: {
        ...AUTH,
        'x-exchange-x-bapi-api-key': 'BYBIT_KEY',
        'x-exchange-x-bapi-sign': 'signature',
        'x-exchange-x-bapi-timestamp': '1700000000000',
        'x-exchange-x-bapi-recv-window': '5000',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [, init] = lastUpstreamCall();
    expect(init.headers).toEqual({
      'x-bapi-api-key': 'BYBIT_KEY',
      'x-bapi-sign': 'signature',
      'x-bapi-timestamp': '1700000000000',
      'x-bapi-recv-window': '5000'
    });
  });

  it('gateio: forwards only KEY, Timestamp and SIGN', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"label":"INVALID_KEY"}', 401));
    await rawRequest({
      path: '/gateio/api/v4/spot/accounts',
      headers: {
        ...AUTH,
        'x-exchange-key': 'GATE_KEY',
        'x-exchange-timestamp': '1700000000',
        'x-exchange-sign': 'signature',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [, init] = lastUpstreamCall();
    expect(init.headers).toEqual({ key: 'GATE_KEY', timestamp: '1700000000', sign: 'signature' });
  });

  it('poloniex: lowercase prefixed inbound auth headers reach the private boundary with native names', async () => {
    upstreamMock.mockImplementation(async (url, init) => {
      expect(url).toBe('https://api.poloniex.com/accounts/balances');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({
        key: 'POLO_KEY', signature: 'signature',
        signTimestamp: '1700000000000', recvWindow: '5000'
      });
      return upstreamJson('{"success":true}');
    });

    const res = await rawRequest({
      path: '/poloniex/accounts/balances',
      headers: {
        ...AUTH,
        'x-exchange-key': 'POLO_KEY',
        'x-exchange-signature': 'signature',
        'x-exchange-signtimestamp': '1700000000000',
        'x-exchange-recvwindow': '5000',
        'x-exchange-cookie': 'never-forward'
      }
    });

    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('{"success":true}');
    expect(upstreamMock).toHaveBeenCalledTimes(1);
  });

  it('htx: preserves signed raw query and forwards no private auth headers', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"status":"error","err-code":"api-signature-not-valid"}'));
    const query = 'AccessKeyId=dummy&Signature=Ab%2B%2F%3D&Timestamp=2026-08-04T00%3A00%3A00';
    await rawRequest({
      path: `/htx/v1/account/accounts?${query}`,
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded', 'x-exchange-cookie': 'never' }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe(`https://api.huobi.pro/v1/account/accounts?${query}`);
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
  });

  it('cryptocom: preserves signed JSON body byte-exact and forwards no private auth headers', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"code":40101,"message":"Authentication failure"}', 401));
    const body = '{"id":1,"method":"private/user-balance","api_key":"dummy","sig":"Ab+/=","nonce":1}';
    await rawRequest({
      method: 'POST', path: '/cryptocom/exchange/v1/private/user-balance',
      headers: { ...AUTH, 'content-type': 'application/json', 'x-exchange-api-key': 'never-forward' }, body
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.crypto.com/exchange/v1/private/user-balance');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(Buffer.from(init.body as Buffer).toString()).toBe(body);
  });

  it('bitfinex: forwards only bfx auth headers and preserves the raw JSON POST body', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('["error",10100,"apikey: digest invalid"]', 500));
    const body = '{"end":1785888000000,"sort":1,"limit":1000}';
    await rawRequest({
      method: 'POST', path: '/bitfinex/v2/auth/r/trades/hist',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-exchange-bfx-nonce': '1785888000000',
        'x-exchange-bfx-apikey': 'BFX_KEY',
        'x-exchange-bfx-signature': 'signature',
        'x-exchange-cookie': 'never-forward'
      }, body
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.bitfinex.com/v2/auth/r/trades/hist');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'bfx-nonce': '1785888000000',
      'bfx-apikey': 'BFX_KEY',
      'bfx-signature': 'signature'
    });
    expect(Buffer.from(init.body as Buffer).toString()).toBe(body);
  });

  it('gemini: forwards only Gemini auth headers and preserves the signed POST body', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"result":"error","reason":"InvalidSignature","message":"Invalid API key"}', 400));
    const body = '{}';
    await rawRequest({
      method: 'POST', path: '/gemini/v1/balances', body,
      headers: {
        ...AUTH,
        'content-type': 'text/plain',
        'x-exchange-x-gemini-apikey': 'account-key',
        'x-exchange-x-gemini-payload': 'payload',
        'x-exchange-x-gemini-signature': 'signature',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.gemini.com/v1/balances');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'text/plain',
      'x-gemini-apikey': 'account-key',
      'x-gemini-payload': 'payload',
      'x-gemini-signature': 'signature'
    });
    expect(Buffer.from(init.body as Buffer).toString()).toBe(body);
  });

  it('bitmart: forwards exact X-BM auth headers and signed JSON body', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"code":30002,"message":"Header X-BM-KEY not found"}', 401));
    const body = '{"startTime":1780000000000,"endTime":1781000000000,"limit":200}';
    await rawRequest({
      method: 'POST', path: '/bitmart/spot/v4/query/trades', body,
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-exchange-x-bm-key': 'BITMART_KEY',
        'x-exchange-x-bm-timestamp': '1781000000000',
        'x-exchange-x-bm-sign': 'signature',
        'x-exchange-x-bm-broker-id': 'CCXTxBitmart000',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api-cloud.bitmart.com/spot/v4/query/trades');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-bm-key': 'BITMART_KEY',
      'x-bm-timestamp': '1781000000000',
      'x-bm-sign': 'signature',
      'x-bm-broker-id': 'CCXTxBitmart000'
    });
    expect(Buffer.from(init.body as Buffer).toString()).toBe(body);
  });

  it('btcmarkets: forwards only the three BM-AUTH headers on signed GET requests', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    await rawRequest({
      path: '/btcmarkets/v3/trades?limit=200&before=818047',
      headers: {
        ...AUTH,
        'x-exchange-bm-auth-apikey': 'BM_KEY',
        'x-exchange-bm-auth-timestamp': '1785888000000',
        'x-exchange-bm-auth-signature': 'signature',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.btcmarkets.net/v3/trades?limit=200&before=818047');
    expect(init.headers).toEqual({
      'bm-auth-apikey': 'BM_KEY',
      'bm-auth-timestamp': '1785888000000',
      'bm-auth-signature': 'signature'
    });
  });

  it('mexc: preserves signed query bytes and forwards only X-MEXC-APIKEY/source', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"code":10072,"msg":"Api key info invalid"}', 400));
    const query = 'symbol=BTCUSDT&limit=100&timestamp=1&signature=Ab%2B%2F%3D';
    await rawRequest({
      path: `/mexc/api/v3/myTrades?${query}`,
      headers: {
        ...AUTH,
        'x-exchange-x-mexc-apikey': 'MEXC_KEY',
        'x-exchange-source': 'CCXT',
        'x-exchange-cookie': 'never-forward',
        origin: 'https://evil.example'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe(`https://api.mexc.com/api/v3/myTrades?${query}`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'x-mexc-apikey': 'MEXC_KEY', source: 'CCXT' });
  });

  it('bitvavo: forwards the exact four auth headers and signed query bytes', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    await rawRequest({
      path: '/bitvavo/v2/trades?market=BTC-EUR&start=1&end=2&limit=1000&tradeIdTo=abc%2Fdef',
      headers: {
        ...AUTH,
        'x-exchange-bitvavo-access-key': 'A'.repeat(64),
        'x-exchange-bitvavo-access-signature': 'b'.repeat(64),
        'x-exchange-bitvavo-access-timestamp': '1786235200000',
        'x-exchange-bitvavo-access-window': '10000',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.bitvavo.com/v2/trades?market=BTC-EUR&start=1&end=2&limit=1000&tradeIdTo=abc%2Fdef');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({
      'bitvavo-access-key': 'A'.repeat(64),
      'bitvavo-access-signature': 'b'.repeat(64),
      'bitvavo-access-timestamp': '1786235200000',
      'bitvavo-access-window': '10000'
    });
  });

  it('bitstamp: forwards all X-Auth v2 headers and the signed form body byte-exact', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    const body = 'limit=1000&since_id=123456789&sort=asc';
    await rawRequest({
      method: 'POST', path: '/bitstamp/api/v2/user_transactions/', body,
      headers: {
        ...AUTH,
        'content-type': 'application/x-www-form-urlencoded',
        'x-exchange-x-auth': 'BITSTAMP API_KEY',
        'x-exchange-x-auth-signature': 'signature',
        'x-exchange-x-auth-nonce': 'nonce',
        'x-exchange-x-auth-timestamp': '1785888000000',
        'x-exchange-x-auth-version': 'v2',
        'x-exchange-cookie': 'never-forward'
      }
    });
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://www.bitstamp.net/api/v2/user_transactions/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
      'x-auth': 'BITSTAMP API_KEY',
      'x-auth-signature': 'signature',
      'x-auth-nonce': 'nonce',
      'x-auth-timestamp': '1785888000000',
      'x-auth-version': 'v2'
    });
    expect(Buffer.from(init.body as Buffer).toString()).toBe(body);
  });

  it('bitget: forwards only the four ACCESS auth headers', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"code":"00000","data":[]}'));
    const res = await client('/bitget/api/v2/spot/account/assets', {
      headers: {
        ...AUTH,
        'x-exchange-access-key': 'BG_KEY',
        'x-exchange-access-sign': 'signature',
        'x-exchange-access-timestamp': '1700000000000',
        'x-exchange-access-passphrase': 'phrase',
        'x-exchange-x-channel-api-code': 'must-not-forward',
        'x-exchange-cookie': 'must-not-forward'
      }
    });
    expect(res.status).toBe(200);
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.bitget.com/api/v2/spot/account/assets');
    expect(init.headers).toEqual({
      'access-key': 'BG_KEY',
      'access-sign': 'signature',
      'access-timestamp': '1700000000000',
      'access-passphrase': 'phrase'
    });
  });
});

/* ------------------------------------------------------------------ *
 * 4. Unknown exchange → 404; space/# in path → 400; empty path → 400.
 * ------------------------------------------------------------------ */
describe('4. exchangeId and path validation', () => {
  it('unknown exchangeId → 404 unknown_exchange', async () => {
    const res = await client('/unknown/api/v3/time', { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-sololedger-error')).toBe('unknown_exchange');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('path containing a space → 400 bad_path (direct handler call)', async () => {
    const { res, state } = makeStubRes();
    await exchangeTunnelHandler(
      { method: 'GET', url: '/binance/api/v3/a b', headers: {} } as unknown as Request,
      res
    );
    expect(state.statusCode).toBe(400);
    expect(state.jsonBody).toEqual({ error: expect.any(String) });
    expect(res.locals.tunnelErrorKind).toBe('bad_path');
  });

  it('path containing # → 400 bad_path (direct handler call)', async () => {
    const { res, state } = makeStubRes();
    await exchangeTunnelHandler(
      { method: 'GET', url: '/binance/api/v3/a#b', headers: {} } as unknown as Request,
      res
    );
    expect(state.statusCode).toBe(400);
    expect(res.locals.tunnelErrorKind).toBe('bad_path');
  });

  it('empty upstream path → 400 bad_path', async () => {
    for (const suffix of ['/binance', '/binance/']) {
      const res = await client(suffix, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it.each([
    '/binance/api/v3//time',
    '/binance//api/v3/time'
  ])('repeated slash path %s → 400 bad_path before fetch (direct handler)', async (url) => {
    const { res, state } = makeStubRes();
    await exchangeTunnelHandler({ method: 'GET', url, headers: {} } as unknown as Request, res);
    expect(state.statusCode).toBe(400);
    expect(res.locals.tunnelErrorKind).toBe('bad_path');
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/mexc/api/v3/order', 'GET'],
    ['/mexc/api/v3/capital/withdraw/apply', 'GET'],
    ['/mexc/api/v1/contract/detail', 'GET'],
    ['/mexc/api/v3/account', 'POST'],
    ['/btcmarkets/api/v3/symbol/offline', 'GET']
  ])('contains MEXC to exact read-only paths: %s %s', async (path, method) => {
    const res = await client(path, { method, headers: AUTH });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('keeps one legitimate leading slash and the raw query in a direct handler call', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"ok":true}'));
    const { res, state } = makeStubRes();
    await exchangeTunnelHandler({
      method: 'GET', url: '/binance/api/v3/time?signature=Ab%2B%2F%3D', headers: {}
    } as unknown as Request, res);
    const [url] = lastUpstreamCall();
    expect(url).toBe('https://api.binance.com/api/v3/time?signature=Ab%2B%2F%3D');
    expect(state.statusCode).toBe(200);
  });

  it.each([
    '/cryptocom/exchange/v1/private/../create-order',
    '/cryptocom/exchange/v1/private/%2e%2e/create-order',
    '/cryptocom/exchange/v1/private/%2E%2e/create-order',
    '/cryptocom/exchange/v1/private/%252e%252e/create-order',
    '/cryptocom/exchange/v1/private/%2f..%2fcreate-order',
    '/cryptocom/exchange/v1/private/\\..\\create-order',
    '/cryptocom/exchange/v1/private/%5c..%5Ccreate-order'
  ])('rejects non-canonical traversal path %s before fetch', async (url) => {
    const { res, state } = makeStubRes();
    await exchangeTunnelHandler({ method: 'POST', url, headers: {} } as unknown as Request, res);
    expect(state.statusCode).toBe(400);
    expect(res.locals.tunnelErrorKind).toBe('bad_path');
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('keeps allowlisted paths and per-path methods exact', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    const allowed = await client('/cryptocom/exchange/v1/public/get-instruments', { headers: AUTH });
    expect(allowed.status).toBe(200);

    upstreamMock.mockClear();
    for (const [path, method] of [
      ['/cryptocom/exchange/v1/public/get-instruments/extra', 'GET'],
      ['/cryptocom/exchange/v1/public/Get-Instruments', 'GET'],
      ['/cryptocom/exchange/v1/public/get-instruments', 'POST']
    ] as const) {
      const rejected = await client(path, { method, headers: AUTH });
      expect(rejected.status).toBe(400);
      expect(rejected.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('keeps HTX numeric account-id paths available without generic prefix matching', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"status":"ok","data":{}}'));
    const res = await client('/htx/v1/account/accounts/123/balance', { headers: AUTH });
    expect(res.status).toBe(200);
    const [url, init] = lastUpstreamCall();
    expect(url).toBe('https://api.huobi.pro/v1/account/accounts/123/balance');
    expect(init.method).toBe('GET');
  });

  it('Bybit rejects non-sync and derivatives REST paths before fetch', async () => {
    for (const path of [
      '/bybit/v5/order/create',
      '/bybit/v5/position/list',
      '/bybit/v5/asset/withdraw/create'
    ]) {
      const res = await client(path, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('Gate.io allows only exact read-only spot/wallet GET endpoints', async () => {
    for (const path of [
      '/gateio/api/v4/spot/orders',
      '/gateio/api/v4/margin/accounts',
      '/gateio/api/v4/futures/usdt/accounts',
      '/gateio/api/v4/wallet/transfers',
      '/gateio/api/v4/withdrawals'
    ]) {
      const res = await client(path, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    const post = await client('/gateio/api/v4/spot/my_trades', { method: 'POST', headers: AUTH });
    expect(post.status).toBe(400);
    expect(post.headers.get('x-sololedger-error')).toBe('bad_path');
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it.each([
    ['coinex', '/v2/spot/user-deals', '/v2/spot/order'],
    ['poloniex', '/trades', '/orders'],
    ['woo', '/v3/trade/transactionHistory', '/v3/trade/order'],
    ['hitbtc', '/api/3/spot/history/trade', '/api/3/spot/order'],
    ['bingx', '/openApi/spot/v1/trade/myTrades', '/openApi/spot/v1/trade/order']
  ])('%s is exact-path and GET-only', async (exchange, allowed, blocked) => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    const ok = await client(`/${exchange}${allowed}`, { headers: AUTH });
    expect(ok.status).toBe(200);
    upstreamMock.mockClear();
    const mutation = await client(`/${exchange}${allowed}`, { method: 'POST', headers: AUTH });
    expect(mutation.status).toBe(400);
    const outside = await client(`/${exchange}${blocked}`, { headers: AUTH });
    expect(outside.status).toBe(400);
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it.each([
    '/openApi/api/v3/capital/deposit/hisrec',
    '/openApi/api/v3/capital/withdraw/history'
  ])('allows pinned BingX wallet GET path %s but no mutation', async (path) => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    expect((await client(`/bingx${path}`, { headers: AUTH })).status).toBe(200);
    upstreamMock.mockClear();
    expect((await client(`/bingx${path}`, { method: 'POST', headers: AUTH })).status).toBe(400);
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('HTX allows only exact read-only spot/account/history GET endpoints', async () => {
    for (const path of [
      '/htx/v1/order/orders/place',
      '/htx/v1/dw/withdraw/api/create',
      '/htx/v1/margin/accounts/balance',
      '/htx/swap-api/v1/swap_account_info',
      '/htx/v1/account/accounts/123/balance/extra'
    ]) {
      const res = await client(path, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    const post = await client('/htx/v1/order/matchresults', { method: 'POST', headers: AUTH });
    expect(post.status).toBe(400);
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it.each([
    ['binanceus', '/api/v3/myTrades'],
    ['backpack', '/wapi/v1/history/fills?marketType=SPOT'],
    ['bitflyer', '/v1/me/getexecutions?product_code=BTC_JPY'],
    ['coincheck', '/api/exchange/orders/transactions_pagination']
  ] as const)('%s contains history to exact GET-only paths', async (exchange, path) => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    expect((await client(`/${exchange}${path}`, { headers: AUTH })).status).toBe(200);
    expect((await client(`/${exchange}${path}`, { method: 'POST', headers: AUTH })).status).toBe(400);
    expect((await client(`/${exchange}${path}/extra`, { headers: AUTH })).status).toBe(400);
  });

  it.each([
    ['bitrue', '/api/v2/myTrades', '/api/v1/order'],
    ['xt', '/v4/trade', '/v4/order'],
    ['phemex', '/exchange/spot/order/trades', '/orders'],
    ['lbank', '/v2/timestamp.do', '/v2/create_order.do']
  ] as const)('%s exposes only the pinned read path and method', async (exchange, allowed, blocked) => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    expect((await client(`/${exchange}${allowed}`, { headers: AUTH })).status).toBe(200);
    expect((await client(`/${exchange}${allowed}`, { method: 'PUT', headers: AUTH })).status).toBe(400);
    expect((await client(`/${exchange}${blocked}`, { headers: AUTH })).status).toBe(400);
  });

  it('CoinSpot permits only public GET and exact read-only POST routes', async () => {
    upstreamMock.mockImplementation(async () => upstreamJson('{}'));
    expect((await client('/coinspot/pubapi/latest', { headers: AUTH })).status).toBe(200);
    expect((await client('/coinspot/pubapi/latest', { method: 'POST', headers: AUTH })).status).toBe(400);
    for (const path of ['/api/ro/my/balances', '/api/ro/my/transactions', '/api/ro/my/deposits', '/api/ro/my/withdrawals']) {
      expect((await client(`/coinspot${path}`, { method: 'POST', headers: AUTH, body: '{}' })).status).toBe(200);
      expect((await client(`/coinspot${path}`, { headers: AUTH })).status).toBe(400);
    }
    expect((await client('/coinspot/api/my/coin/send', { method: 'POST', headers: AUTH })).status).toBe(400);
  });

  it('WhiteBIT allows signed POST only on the exact read-only private history paths', async () => {
    upstreamMock.mockImplementation(async () => upstreamJson('{}'));
    for (const path of ['/api/v4/trade-account/balance', '/api/v4/trade-account/executed-history', '/api/v4/main-account/history']) {
      expect((await client(`/whitebit${path}`, {
        method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: '{}'
      })).status).toBe(200);
      expect((await client(`/whitebit${path}`, { headers: AUTH })).status).toBe(400);
    }
    expect((await client('/whitebit/api/v4/trade-account/order/new', {
      method: 'POST', headers: AUTH
    })).status).toBe(400);
  });

  it('Backpack forwards exactly the pinned CCXT signing headers', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    const res = await client('/backpack/wapi/v1/history/fills?marketType=SPOT', { headers: {
      ...AUTH,
      'x-exchange-x-api-key': 'key',
      'x-exchange-x-signature': 'sig',
      'x-exchange-x-timestamp': '123',
      'x-exchange-x-window': '5000',
      'x-exchange-x-broker-id': '1400',
      'x-exchange-surprise': 'blocked'
    }});
    expect(res.status).toBe(200);
    const [, init] = lastUpstreamCall();
    expect(init.headers).toEqual({
      'x-api-key': 'key', 'x-signature': 'sig', 'x-timestamp': '123',
      'x-window': '5000', 'x-broker-id': '1400'
    });
  });

  it('contains Backpack fills to one explicit SPOT scope and preserves signed query bytes', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    for (const query of ['', '?marketType=PERP', '?marketType=spot', '?marketType=SPOT&marketType=PERP']) {
      expect((await client(`/backpack/wapi/v1/history/fills${query}`, { headers: AUTH })).status).toBe(400);
    }
    expect(upstreamMock).not.toHaveBeenCalled();

    const raw = 'from=1&limit=1000&marketType%5B%5D=SPOT&to=2&signature=Ab%2B%2F%3D';
    expect((await client(`/backpack/wapi/v1/history/fills?${raw}`, { headers: AUTH })).status).toBe(200);
    expect(lastUpstreamCall()[0]).toBe(`https://api.backpack.exchange/wapi/v1/history/fills?${raw}`);
  });

  it('allows Coincheck crypto sending history but blocks JPY bank withdrawals', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"success":true,"sends":[]}'));
    expect((await client('/coincheck/api/send_money?limit=100&order=desc', { headers: AUTH })).status).toBe(200);
    expect(lastUpstreamCall()[0]).toBe('https://coincheck.com/api/send_money?limit=100&order=desc');
    upstreamMock.mockClear();
    expect((await client('/coincheck/api/withdraws', { headers: AUTH })).status).toBe(400);
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('positively permits bitFlyer spot executions and rejects derivative or absent product codes', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]'));
    for (const query of ['', '?product_code=FX_BTC_JPY', '?product_code=BTCJPY_MAT1WK', '?product_code=BTC_JPY&product_code=FX_BTC_JPY']) {
      expect((await client(`/bitflyer/v1/me/getexecutions${query}`, { headers: AUTH })).status).toBe(400);
    }
    expect(upstreamMock).not.toHaveBeenCalled();

    const raw = 'product_code=BTC_JPY&count=100&before=123&sig=Ab%2B%2F%3D';
    expect((await client(`/bitflyer/v1/me/getexecutions?${raw}`, { headers: AUTH })).status).toBe(200);
    expect(lastUpstreamCall()[0]).toBe(`https://api.bitflyer.com/v1/me/getexecutions?${raw}`);
  });

  it('forwards WhiteBIT noncanonical signed JSON and signing headers byte-exact', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{}'));
    const body = Buffer.from('{ "nonce" : 7, "request":"/api/v4/trade-account/executed-history", "nonceWindow":true }');
    const headers = {
      ...AUTH,
      'content-type': 'application/json',
      'x-exchange-x-txc-apikey': 'key',
      'x-exchange-x-txc-payload': 'ZXhhY3Q=',
      'x-exchange-x-txc-signature': 'aabbcc'
    };
    const res = await rawRequest({ method: 'POST', path: '/whitebit/api/v4/trade-account/executed-history', headers, body });
    expect(res.status).toBe(200);
    const [, init] = lastUpstreamCall();
    expect(Buffer.compare(init.body as Buffer, body)).toBe(0);
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-txc-apikey': 'key',
      'x-txc-payload': 'ZXhhY3Q=',
      'x-txc-signature': 'aabbcc'
    });
  });

  it('Crypto.com enforces exact read-only paths with per-path GET/POST methods', async () => {
    for (const [path, method] of [
      ['/cryptocom/exchange/v1/private/create-order', 'POST'],
      ['/cryptocom/exchange/v1/private/create-withdrawal', 'POST'],
      ['/cryptocom/exchange/v1/private/user-balance', 'GET'],
      ['/cryptocom/exchange/v1/public/get-instruments', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('Bitfinex allows only exact read-only methods and paths', async () => {
    for (const [path, method] of [
      ['/bitfinex/v2/auth/w/order/submit', 'POST'],
      ['/bitfinex/v2/auth/w/withdraw', 'POST'],
      ['/bitfinex/v2/auth/r/wallets', 'GET'],
      ['/bitfinex/v2/platform/status', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('Gemini allows only exact read-only methods and paths', async () => {
    for (const [path, method] of [
      ['/gemini/v1/order/new', 'POST'],
      ['/gemini/v1/withdraw/btc', 'POST'],
      ['/gemini/v1/balances', 'GET'],
      ['/gemini/v1/symbols', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('BTC Markets allows only exact read-only GET paths', async () => {
    for (const [path, method] of [
      ['/btcmarkets/v3/orders', 'GET'],
      ['/btcmarkets/v3/withdrawals', 'POST'],
      ['/btcmarkets/v3/trades/123', 'GET'],
      ['/btcmarkets/v3/accounts/me/balances', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  describe('Bitvavo exact GET-only containment', () => {
    const ALLOWED_PATHS = [
      '/v2/time',
      '/v2/markets',
      '/v2/balance',
      '/v2/account/history',
      '/v2/trades',
      '/v2/depositHistory',
      '/v2/withdrawalHistory'
    ] as const;

    it.each(ALLOWED_PATHS)('allows GET %s', async (path) => {
      upstreamMock.mockResolvedValue(upstreamJson('[]'));
      const res = await client(`/bitvavo${path}`, { method: 'GET', headers: AUTH });
      expect(res.status).toBe(200);
      const [url, init] = lastUpstreamCall();
      expect(url).toBe(`https://api.bitvavo.com${path}`);
      expect(init.method).toBe('GET');
    });

    it.each(ALLOWED_PATHS.flatMap((path) => [
      [path, 'POST'],
      [path, 'PUT'],
      [path, 'PATCH'],
      [path, 'DELETE']
    ] as const))('rejects %s %s', async (path, method) => {
      const res = await client(`/bitvavo${path}`, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
      expect(upstreamMock).not.toHaveBeenCalled();
    });

    it.each([
      ['/v2/order', 'GET', 'order read'],
      ['/v2/order', 'POST', 'order placement'],
      ['/v2/order', 'DELETE', 'single-order cancellation'],
      ['/v2/orders', 'DELETE', 'bulk-order cancellation'],
      ['/v2/cancelOrdersAfter', 'POST', 'cancel-after mutation'],
      ['/v2/withdrawal', 'POST', 'withdrawal mutation'],
      ['/v2/trades/abc', 'GET', 'arbitrary trade subpath'],
      ['/v2/assets', 'GET', 'assets'],
      ['/v2/staking/assets', 'GET', 'staking'],
      ['/v2/staking/history', 'GET', 'staking history'],
      ['/v2/subaccounts', 'GET', 'subaccounts'],
      ['/v2/institutional/transactions', 'GET', 'institutional'],
      ['/v2/rfq/markets', 'GET', 'RFQ'],
      ['/v2/rfq/quote', 'POST', 'RFQ mutation'],
      ['/v2/derivatives/positions', 'GET', 'derivatives'],
      ['/v2/futures/markets', 'GET', 'futures']
    ] as const)('rejects %s %s (%s)', async (path, method) => {
      const res = await client(`/bitvavo${path}`, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
      expect(upstreamMock).not.toHaveBeenCalled();
    });
  });

  it('Bitstamp allows only exact read-only paths and methods, including trailing slashes', async () => {
    upstreamMock.mockImplementation(async () => upstreamJson('[]'));
    for (const [path, method] of [
      ['/bitstamp/api/v2/markets/', 'GET'],
      ['/bitstamp/api/v2/account_balances/', 'POST'],
      ['/bitstamp/api/v2/user_transactions/', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(200);
    }
    upstreamMock.mockClear();
    for (const [path, method] of [
      ['/bitstamp/api/v2/markets', 'GET'],
      ['/bitstamp/api/v2/markets/', 'POST'],
      ['/bitstamp/api/v2/account_balances/', 'GET'],
      ['/bitstamp/api/v2/user_transactions/', 'GET'],
      ['/bitstamp/api/v2/buy/btcusd/', 'POST'],
      ['/bitstamp/api/v2/withdrawal-requests/', 'POST'],
      ['/bitstamp/api/v2/open_orders/all/', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('Bitget allows only exact classic spot-v2 read-only GET paths', async () => {
    for (const [path, method] of [
      ['/bitget/api/v2/mix/market/contracts', 'GET'],
      ['/bitget/api/v2/margin/currencies', 'GET'],
      ['/bitget/api/v3/account/settings', 'GET'],
      ['/bitget/api/v2/spot/trade/place-order', 'POST'],
      ['/bitget/api/v2/spot/wallet/withdrawal', 'POST'],
      ['/bitget/api/v2/spot/trade/fills/123', 'GET'],
      ['/bitget/api/v2/spot/trade/fills', 'POST']
    ] as const) {
      const res = await client(path, { method, headers: AUTH });
      expect(res.status).toBe(400);
      expect(res.headers.get('x-sololedger-error')).toBe('bad_path');
    }
    expect(upstreamMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 5. Native exchange error passthrough: Binance 400 -2015 byte-identical.
 * ------------------------------------------------------------------ */
describe('5. native error passthrough', () => {
  it('upstream 400 {"code":-2015} → downstream 400 byte-identical, unstamped', async () => {
    const binanceError = '{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}';
    upstreamMock.mockResolvedValue(upstreamJson(binanceError, 400));

    const res = await client('/binance/api/v3/account?timestamp=1&signature=abc', { headers: AUTH });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(binanceError);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });

  it('pins the recorded Bitvavo 305 response as JSON, byte-identical and unstamped', async () => {
    const body = JSON.stringify(bitvavo305Fixture.response);
    upstreamMock.mockResolvedValue(upstreamJson(body, bitvavo305Fixture.httpStatus));

    const res = await client('/bitvavo/v2/balance', { headers: AUTH });

    const responseText = await res.text();
    expect(res.status).toBe(403);
    expect(responseText).toBe(body);
    expect(JSON.parse(responseText)).toEqual({ errorCode: 305, error: 'No active API key found.' });
  });

  it('passes Bitstamp API0001 through byte-identical and unstamped', async () => {
    const body = '{"status":"error","reason":"API key not found","code":"API0001"}';
    upstreamMock.mockResolvedValue(upstreamJson(body, 403));
    const res = await client('/bitstamp/api/v2/account_balances/', {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' }, body: 'foo=bar'
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 6. Response header hygiene: strip content-encoding/content-length/
 *    set-cookie; keep content-type + retry-after.
 * ------------------------------------------------------------------ */
describe('6. response header hygiene', () => {
  it('does not forward or expose BTC Markets pagination headers on another exchange', async () => {
    upstreamMock.mockResolvedValue(
      upstreamJson('{"ok":true}', 200, {
        'content-encoding': 'gzip',
        'content-length': '999',
        'set-cookie': 'session=abc; HttpOnly',
        'retry-after': '7',
        'bm-before': '818047',
        'bm-after': '818075'
      })
    );

    const res = await client('/binance/api/v3/time', { headers: AUTH });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('bm-before')).toBeNull();
    expect(res.headers.get('bm-after')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).not.toMatch(/bm-before|bm-after/i);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    // The upstream's bogus content-length (999) must not leak downstream.
    expect(res.headers.get('content-length')).toBe(String('{"ok":true}'.length));
  });

  it('forwards and exposes pagination headers only on the BTC Markets tunnel', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('[]', 200, {
      'bm-before': '818047', 'bm-after': '818075'
    }));
    const res = await client('/btcmarkets/v3/trades?limit=200', {
      headers: { ...AUTH, origin: 'http://localhost:5173' }
    });
    expect(res.headers.get('bm-before')).toBe('818047');
    expect(res.headers.get('bm-after')).toBe('818075');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/bm-before.*bm-after/i);

    const unrelated = await fetch(`${base}/health`, {
      headers: { origin: 'http://localhost:5173' }
    });
    expect(unrelated.headers.get('bm-before')).toBeNull();
    expect(unrelated.headers.get('access-control-expose-headers')).not.toMatch(/bm-before|bm-after/i);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Relay-origin gates: 401 auth / 402 subscription / 403 disabled —
 *    all stamped; upstream never called.
 * ------------------------------------------------------------------ */
describe('7. relay-origin gates', () => {
  it('no JWT → 401 + x-sololedger-error: auth', async () => {
    const res = await client('/binance/api/v3/time');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-sololedger-error')).toBe('auth');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('subscription inactive → 402 + x-sololedger-error: subscription', async () => {
    mocks.subscriptionActive = false;
    const res = await client('/binance/api/v3/time', { headers: AUTH });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-sololedger-error')).toBe('subscription');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('exchangeSyncEnabled off → 403 + x-sololedger-error: disabled', async () => {
    mocks.exchangeSyncEnabled = false;
    const res = await client('/binance/api/v3/time', { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-sololedger-error')).toBe('disabled');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(upstreamMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 8. Body > 1mb → 413 JSON + payload_too_large (NOT Express's HTML page).
 * ------------------------------------------------------------------ */
describe('8. body limit', () => {
  it('oversized body → 413 JSON + x-sololedger-error: payload_too_large', async () => {
    const res = await client('/kraken/0/private/AddOrder', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.alloc(1024 * 1024 + 1, 'a')
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('x-sololedger-error')).toBe('payload_too_large');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(upstreamMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 9. Timeout → 504 upstream_timeout; generic throw → 502 upstream_failed.
 * ------------------------------------------------------------------ */
describe('9. upstream failure mapping', () => {
  it('timeout → 504 + upstream_timeout', async () => {
    upstreamMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const res = await client('/binance/api/v3/time', { headers: AUTH });
    expect(res.status).toBe(504);
    expect(res.headers.get('x-sololedger-error')).toBe('upstream_timeout');
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('generic fetch throw → 502 + upstream_failed', async () => {
    upstreamMock.mockRejectedValue(new Error('socket hang up'));
    const res = await client('/binance/api/v3/time', { headers: AUTH });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-sololedger-error')).toBe('upstream_failed');
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

/* ------------------------------------------------------------------ *
 * 10. Log hygiene: thrown errors embedding the signed URL must not leak
 *     the signature (or any query) into console.error.
 * ------------------------------------------------------------------ */
describe('10. log hygiene', () => {
  it('console.error never contains the signature or query', async () => {
    upstreamMock.mockRejectedValue(
      new Error('connect ECONNREFUSED https://api.binance.com/api/v3/account?signature=SECRETSIG')
    );
    const res = await client('/binance/api/v3/account?timestamp=1&signature=SECRETSIG', {
      headers: AUTH
    });
    expect(res.status).toBe(502);
    expect(console.error).toHaveBeenCalled();
    const logs = errorLogs();
    expect(logs).not.toContain('SECRETSIG');
    expect(logs).not.toContain('signature=');
    expect(logs).not.toContain('timestamp=1');
  });
});

/* ------------------------------------------------------------------ *
 * 11. CORS: preflight reflects x-exchange- headers; simple responses
 *     expose x-sololedger-error.
 * ------------------------------------------------------------------ */
describe('11. CORS', () => {
  it('OPTIONS preflight → 204 with x-exchange header in allow-headers', async () => {
    const res = await rawRequest({
      method: 'OPTIONS',
      path: '/binance/api/v3/account',
      headers: {
        origin: 'https://ramakanthgade.github.io',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, x-exchange-x-mbx-apikey, content-type'
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('x-exchange-x-mbx-apikey');
    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('simple GET response exposes x-sololedger-error', async () => {
    upstreamMock.mockResolvedValue(upstreamJson('{"ok":true}'));
    const res = await rawRequest({
      path: '/binance/api/v3/time',
      headers: { ...AUTH, origin: 'https://ramakanthgade.github.io' }
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-expose-headers']).toContain('x-sololedger-error');
  });
});

/* ------------------------------------------------------------------ *
 * 12. Exchange error-body passthrough (v1.1): Coinbase/Kraken error
 *     shapes pipe through byte-identical and NEVER get stamped.
 * ------------------------------------------------------------------ */
describe('12. exchange error-body passthrough', () => {
  it('Coinbase-shaped 401 {"error":"unknown api key"} → byte-identical, unstamped', async () => {
    const body = '{"error":"unknown api key","error_details":"CB key rejected","message":"api key not found"}';
    upstreamMock.mockResolvedValue(upstreamJson(body, 401));
    const res = await client('/coinbase/api/v3/brokerage/accounts', { headers: AUTH });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });

  it('Coinbase-shaped 403 {"error":"PERMISSION_DENIED"} → byte-identical, unstamped', async () => {
    const body = '{"error":"PERMISSION_DENIED","error_details":"Missing required scopes","message":"forbidden"}';
    upstreamMock.mockResolvedValue(upstreamJson(body, 403));
    const res = await client('/coinbase/api/v3/brokerage/orders', { headers: AUTH });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });

  it('Kraken-shaped HTTP-200 {"error":["EAPI:Invalid key"]} → passthrough, unstamped', async () => {
    const body = '{"error":["EAPI:Invalid key"]}';
    upstreamMock.mockResolvedValue(upstreamJson(body, 200));
    const res = await client('/kraken/0/private/Balance', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'nonce=1700000000000'
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
  });
});
