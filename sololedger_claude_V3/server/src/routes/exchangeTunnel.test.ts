import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'events';
import http from 'http';
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
    ['btcmarkets', 'api.btcmarkets.net', '/v3/time']
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
