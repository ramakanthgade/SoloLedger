import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the saas api layer BEFORE importing the tunnel (it pulls apiFetch).
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt')
}));

// Mock the server-config source so tests never touch Dexie; default = no
// gateway configured (existing relay-path tests unchanged).
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { apiFetch, getAuthToken } from '@/lib/saas/api';
import { getBinanceGatewayUrl } from '@/lib/saas/effectiveSettings';
import { installTunnelFetch, TunnelError, EXCHANGE_TUNNEL_BASE, type TunnelFetchTarget } from './tunnel';
import { __clearBinanceGatewayTicketCache } from './binanceGateway';
import { loadCcxt, type ExchangeClient } from './ccxtLoader';

const apiFetchMock = vi.mocked(apiFetch);
const getAuthTokenMock = vi.mocked(getAuthToken);
const gatewayUrlMock = vi.mocked(getBinanceGatewayUrl);

/** Minimal Response stand-in (jsdom-safe): what apiFetch would resolve. */
function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: {
      get: (k: string) => lower[k.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      }
    },
    json: async () => JSON.parse(body),
    text: async () => body
  } as unknown as Response;
}

function stubTarget(): TunnelFetchTarget & { handleRestResponse: ReturnType<typeof vi.fn> } {
  return {
    fetch: async () => undefined,
    handleRestResponse: vi.fn(() => 'parsed-by-ccxt')
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockReturnValue('test-jwt');
  gatewayUrlMock.mockReset();
  gatewayUrlMock.mockResolvedValue(null);
  __clearBinanceGatewayTicketCache();
  vi.unstubAllGlobals();
});

describe('installTunnelFetch — request rewriting (contract C1)', () => {
  it('rewrites the signed URL to the relay path byte-verbatim and prefixes headers', async () => {
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    apiFetchMock.mockResolvedValue(fakeResponse(200, '[]'));

    const url = 'https://api.binance.com/api/v3/account?timestamp=1700000000000&signature=Ab%2B%2F%3D';
    const result = await target.fetch(url, 'GET', { 'X-MBX-APIKEY': 'the-key' });

    expect(result).toBe('parsed-by-ccxt');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    // Query byte-verbatim — no decoding/re-encoding of %2B/%2F/%3D.
    expect(path).toBe(
      `${EXCHANGE_TUNNEL_BASE}/binance/api/v3/account?timestamp=1700000000000&signature=Ab%2B%2F%3D`
    );
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ 'x-exchange-x-mbx-apikey': 'the-key' });
    expect(init?.body).toBeUndefined();
  });

  it('passes method, raw body and real content-type verbatim (Kraken-shaped POST)', async () => {
    const target = stubTarget();
    installTunnelFetch(target, 'kraken');
    apiFetchMock.mockResolvedValue(fakeResponse(200, '{}'));

    const signedBody = 'nonce=1700000000000&signature=Ab%2B%2F%3D';
    await target.fetch('https://api.kraken.com/0/private/TradesHistory', 'POST', {
      'API-Key': 'k',
      'API-Sign': 's',
      'Content-Type': 'application/x-www-form-urlencoded'
    }, signedBody);

    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe(`${EXCHANGE_TUNNEL_BASE}/kraken/0/private/TradesHistory`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'x-exchange-api-key': 'k',
      'x-exchange-api-sign': 's',
      'Content-Type': 'application/x-www-form-urlencoded'
    });
    expect(init?.body).toBe(signedBody);
  });

  it('hands ccxt a shim exposing the ORIGINAL exchange url and the raw body', async () => {
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    apiFetchMock.mockResolvedValue(fakeResponse(200, '{"ok":true}', { 'content-type': 'application/json' }));

    const url = 'https://api.binance.com/api/v3/time';
    await target.fetch(url, 'GET', {});
    const [shim, shimUrl, shimMethod] = target.handleRestResponse.mock.calls[0];
    expect(shimUrl).toBe(url);
    expect(shimMethod).toBe('GET');
    expect(shim.status).toBe(200);
    expect(await shim.text()).toBe('{"ok":true}');
  });
});

describe('installTunnelFetch — relay-error rule (HEADER-ONLY)', () => {
  it.each([
    ['auth', 'relay_auth'],
    ['subscription', 'relay_subscription'],
    ['disabled', 'relay_disabled'],
    ['payload_too_large', 'relay_payload'],
    ['unknown_exchange', 'relay_unavailable'],
    ['bad_path', 'relay_unavailable'],
    ['upstream_timeout', 'relay_unavailable'],
    ['upstream_failed', 'relay_unavailable']
  ])('x-sololedger-error: %s → TunnelError(%s)', async (header, kind) => {
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    apiFetchMock.mockResolvedValue(fakeResponse(403, '{"error":"nope"}', { 'x-sololedger-error': header }));
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe(kind);
  });

  it.each([502, 504])('bare %i without the header → TunnelError(relay_unavailable)', async (status) => {
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    apiFetchMock.mockResolvedValue(fakeResponse(status, '<html>Bad Gateway</html>'));
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });

  it('no JWT → TunnelError(relay_auth) without calling apiFetch', async () => {
    getAuthTokenMock.mockReturnValue(null);
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_auth');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('relay unreachable (apiFetch throws) → TunnelError(relay_unavailable)', async () => {
    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    apiFetchMock.mockRejectedValue(new Error('Cannot reach API at https://relay'));
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });
});

describe('installTunnelFetch — exchange errors pass through to ccxt (never misclassified)', () => {
  async function realClient(exchangeId: 'binance' | 'coinbase' | 'kraken'): Promise<ExchangeClient> {
    const ccxt = await loadCcxt();
    const Ctor = ccxt[exchangeId] as new (config: Record<string, unknown>) => ExchangeClient;
    const client = new Ctor({ apiKey: 'k', secret: 'c2VjcmV0' });
    installTunnelFetch(client, exchangeId);
    return client;
  }

  it('Binance 401 {"code":-2015} (no header) → ccxt AuthenticationError', async () => {
    const client = await realClient('binance');
    apiFetchMock.mockResolvedValue(
      fakeResponse(401, '{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}')
    );
    const err = await client
      .fetch('https://api.binance.com/api/v3/account?timestamp=1&signature=x', 'GET', { 'X-MBX-APIKEY': 'k' })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('AuthenticationError');
  });

  it('Coinbase-shaped 401 {"error":"unknown api key",...} (no header) → passes to ccxt, NOT a TunnelError', async () => {
    const client = await realClient('coinbase');
    apiFetchMock.mockResolvedValue(
      fakeResponse(401, '{"error":"unknown api key","error_details":"bad key","message":"unknown api key"}')
    );
    const err = await client
      .fetch('https://api.coinbase.com/api/v3/brokerage/accounts', 'GET', {})
      .catch((e) => e);
    // The header-only rule: an unstamped exchange body must reach ccxt.
    // (Verify-at-build note: ccxt 4.5.68 maps this exact legacy shape to a
    // generic ExchangeError — only the v3 errors-array shape and exact-map
    // entries map to AuthenticationError. What matters for the contract is
    // that it is NOT misclassified as a relay error.)
    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('ExchangeError');
  });

  it('Coinbase v3 401 errors-array → ccxt AuthenticationError', async () => {
    const client = await realClient('coinbase');
    apiFetchMock.mockResolvedValue(
      fakeResponse(401, '{"errors":[{"id":"authentication_error","message":"Invalid signature"}]}')
    );
    const err = await client
      .fetch('https://api.coinbase.com/api/v3/brokerage/accounts', 'GET', {})
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('AuthenticationError');
  });

  it('Coinbase-shaped 403 {"error":"PERMISSION_DENIED",...} (no header) → ccxt PermissionDenied', async () => {
    const client = await realClient('coinbase');
    apiFetchMock.mockResolvedValue(
      fakeResponse(403, '{"error":"PERMISSION_DENIED","message":"Forbidden"}')
    );
    const err = await client
      .fetch('https://api.coinbase.com/api/v3/brokerage/accounts', 'GET', {})
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('PermissionDenied');
  });

  it('Kraken HTTP-200 {"error":["EAPI:Invalid key"]} (no header) → ccxt AuthenticationError', async () => {
    const client = await realClient('kraken');
    apiFetchMock.mockResolvedValue(fakeResponse(200, '{"error":["EAPI:Invalid key"]}'));
    const err = await client
      .fetch('https://api.kraken.com/0/private/Balance', 'POST', { 'API-Key': 'k', 'API-Sign': 's' }, 'nonce=1')
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('AuthenticationError');
  });
});

describe('installTunnelFetch — Binance gateway detour (worker + relay-minted ticket)', () => {
  const GW = 'https://gw.example.workers.dev';
  const TICKET_BODY = JSON.stringify({
    url: GW,
    exp: Math.floor(Date.now() / 1000) + 600,
    token: 'dG9rZW4tdGlja2V0'
  });

  function stubWorkerFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('binance + gateway configured → worker URL byte-verbatim, ticket + x-exchange headers, apiFetch used ONLY for the mint', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const url = 'https://api.binance.com/api/v3/account?timestamp=1700000000000&signature=Ab%2B%2F%3D';
    const result = await target.fetch(url, 'GET', { 'X-MBX-APIKEY': 'the-key' });

    expect(result).toBe('parsed-by-ccxt');
    // apiFetch minted the ticket and was NOT used for the exchange call.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/exchange-gateway/binance/ticket');
    // The worker got path + raw query byte-verbatim, plus ticket + exchange headers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [workerUrl, init] = fetchMock.mock.calls[0];
    expect(workerUrl).toBe(`${GW}/api/v3/account?timestamp=1700000000000&signature=Ab%2B%2F%3D`);
    const sentHeaders = init?.headers as Record<string, string>;
    expect(sentHeaders['x-gateway-exp']).toMatch(/^\d+$/);
    expect(sentHeaders['x-gateway-token']).toBe('dG9rZW4tdGlja2V0');
    expect(sentHeaders['x-exchange-x-mbx-apikey']).toBe('the-key');
    // handleRestResponse still sees the ORIGINAL binance url.
    expect(target.handleRestResponse.mock.calls[0][1]).toBe(url);
  });

  it('maps content-type as x-exchange-content-type (worker convention) and passes the body verbatim', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    await target.fetch('https://api.binance.com/sapi/v1/capital/withdraw/apply', 'POST', {
      'X-MBX-APIKEY': 'k',
      'Content-Type': 'application/x-www-form-urlencoded'
    }, 'amount=1&signature=x');

    const [, init] = fetchMock.mock.calls[0];
    const sentHeaders = init?.headers as Record<string, string>;
    expect(sentHeaders['x-exchange-content-type']).toBe('application/x-www-form-urlencoded');
    expect(sentHeaders['Content-Type']).toBeUndefined();
    expect(sentHeaders['x-exchange-x-mbx-apikey']).toBe('k');
    expect(init?.body).toBe('amount=1&signature=x');
  });

  it('caches the ticket across sync requests — one mint, many worker calls', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '[]'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    await target.fetch('https://api.binance.com/api/v3/myTrades?symbol=BTCUSDT', 'GET', { 'X-MBX-APIKEY': 'k' });
    await target.fetch('https://api.binance.com/api/v3/depositHistory', 'GET', { 'X-MBX-APIKEY': 'k' });

    expect(apiFetchMock).toHaveBeenCalledTimes(1); // single mint
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gateway configured but mint stamped 402 → TunnelError(relay_subscription), worker NEVER called (no silent fallback)', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(402, '{"error":"subscription"}', { 'x-sololedger-error': 'subscription' }));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);

    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_subscription');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no JWT + gateway configured → TunnelError(relay_auth), worker never called', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    getAuthTokenMock.mockReturnValue(null);
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);

    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_auth');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('gateway NOT configured (null) → existing relay path for binance', async () => {
    gatewayUrlMock.mockResolvedValue(null);
    apiFetchMock.mockResolvedValue(fakeResponse(200, '[]'));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    await target.fetch('https://api.binance.com/api/v3/myTrades?symbol=BTCUSDT', 'GET', { 'X-MBX-APIKEY': 'k' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe(
      `${EXCHANGE_TUNNEL_BASE}/binance/api/v3/myTrades?symbol=BTCUSDT`
    );
  });

  it('non-binance exchange ignores the gateway even when configured', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, '{}'));
    const fetchMock = stubWorkerFetch(async () => fakeResponse(200, '{}'));

    const target = stubTarget();
    installTunnelFetch(target, 'kraken');
    await target.fetch('https://api.kraken.com/0/private/Balance', 'POST', { 'API-Key': 'k' }, 'nonce=1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe(`${EXCHANGE_TUNNEL_BASE}/kraken/0/private/Balance`);
  });

  it('worker 401 {"error":"invalid_gateway_ticket"} → TunnelError(relay_unavailable), ticket cache dropped', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    stubWorkerFetch(async () => fakeResponse(401, '{"error":"invalid_gateway_ticket"}'));

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);

    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
    // Cache was dropped → a second attempt re-mints before hitting the worker.
    await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch(() => undefined);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('worker unreachable (fetch rejects) → TunnelError(relay_unavailable)', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    stubWorkerFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const target = stubTarget();
    installTunnelFetch(target, 'binance');
    const err = await target.fetch('https://api.binance.com/api/v3/account', 'GET', {}).catch((e) => e);

    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });

  it('Binance 451 through the gateway reaches ccxt (region-blocked path preserved — NOT a TunnelError)', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    stubWorkerFetch(async () =>
      fakeResponse(451, '{"code":0,"msg":"Service unavailable from a restricted location according to \'b. Eligibility\' in https://www.binance.com/en/terms."}')
    );

    const ccxt = await loadCcxt();
    const Ctor = ccxt.binance as new (config: Record<string, unknown>) => ExchangeClient;
    const client = new Ctor({ apiKey: 'k', secret: 'c2VjcmV0' });
    installTunnelFetch(client, 'binance');
    const err = await client
      .fetch('https://api.binance.com/api/v3/account?timestamp=1&signature=x', 'GET', { 'X-MBX-APIKEY': 'k' })
      .catch((e) => e);

    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('ExchangeNotAvailable');
  });

  it('Binance 401 invalid API key through the gateway → ccxt AuthenticationError (NOT relay_unavailable)', async () => {
    gatewayUrlMock.mockResolvedValue(GW);
    apiFetchMock.mockResolvedValue(fakeResponse(200, TICKET_BODY));
    stubWorkerFetch(async () =>
      fakeResponse(401, '{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}')
    );

    const ccxt = await loadCcxt();
    const Ctor = ccxt.binance as new (config: Record<string, unknown>) => ExchangeClient;
    const client = new Ctor({ apiKey: 'k', secret: 'c2VjcmV0' });
    installTunnelFetch(client, 'binance');
    const err = await client
      .fetch('https://api.binance.com/api/v3/account?timestamp=1&signature=x', 'GET', { 'X-MBX-APIKEY': 'k' })
      .catch((e) => e);

    expect(err).not.toBeInstanceOf(TunnelError);
    expect((err as Error).name).toBe('AuthenticationError');
  });
});
