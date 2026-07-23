import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the saas api layer BEFORE importing the tunnel (it pulls apiFetch).
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt')
}));

import { apiFetch, getAuthToken } from '@/lib/saas/api';
import { installTunnelFetch, TunnelError, EXCHANGE_TUNNEL_BASE, type TunnelFetchTarget } from './tunnel';
import { loadCcxt, type ExchangeClient } from './ccxtLoader';

const apiFetchMock = vi.mocked(apiFetch);
const getAuthTokenMock = vi.mocked(getAuthToken);

/** Minimal Response stand-in (jsdom-safe): what apiFetch would resolve. */
function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    statusText: `Status ${status}`,
    headers: {
      get: (k: string) => lower[k.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      }
    },
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
