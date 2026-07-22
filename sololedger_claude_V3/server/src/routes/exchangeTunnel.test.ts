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
    ['kucoin', 'api.kucoin.com', '/api/v1/timestamp']
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
});

/* ------------------------------------------------------------------ *
 * 4. Unknown exchange → 404; space/# in path → 400; empty path → 400.
 * ------------------------------------------------------------------ */
describe('4. exchangeId and path validation', () => {
  it('unknown exchangeId → 404 unknown_exchange', async () => {
    const res = await client('/gemini/api/v3/time', { headers: AUTH });
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
  it('strips hop headers, forwards content-type + retry-after', async () => {
    upstreamMock.mockResolvedValue(
      upstreamJson('{"ok":true}', 200, {
        'content-encoding': 'gzip',
        'content-length': '999',
        'set-cookie': 'session=abc; HttpOnly',
        'retry-after': '7'
      })
    );

    const res = await client('/binance/api/v3/time', { headers: AUTH });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    // The upstream's bogus content-length (999) must not leak downstream.
    expect(res.headers.get('content-length')).toBe(String('{"ok":true}'.length));
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
