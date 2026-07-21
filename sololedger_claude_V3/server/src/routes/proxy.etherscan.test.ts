import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Item 5d — the relay's /api/proxy/etherscan route must forward to the
 * Etherscan multichain API V2 (`/v2/api`), preserving the full client query
 * (chainid, module, action, address, page, offset, sort) and injecting the
 * server-side key. V1 (`api.etherscan.io/api`) is deprecated.
 */

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn()
}));

vi.mock('../auth.js', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  getUserFromRequest: () => ({
    id: 'u1',
    email: 'u@example.com',
    role: 'subscriber',
    plan: 'pro',
    subscriptionStatus: 'active'
  }),
  isSubscriptionActive: () => true
}));

vi.mock('../apiKeys.js', () => ({
  resolveApiKey: mocks.resolveApiKey
}));

vi.mock('../store.js', () => ({
  getServerConfig: () => ({ rpcLookupEnabled: true, priceApiEnabled: true, aiAdvisorEnabled: false })
}));

import { etherscanProxyHandler } from './proxy.js';

const CLIENT_QUERY = {
  chainid: '42220',
  module: 'account',
  action: 'txlist',
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  page: '1',
  offset: '100',
  sort: 'desc'
};

function makeReq(query: Record<string, string> = CLIENT_QUERY): Request {
  return { method: 'GET', path: '/etherscan', headers: {}, body: {}, query } as unknown as Request;
}

function makeRes() {
  const state: { statusCode: number; body: unknown; jsonBody: unknown } = {
    statusCode: 200,
    body: undefined,
    jsonBody: undefined
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader() {},
    json(payload: unknown) {
      state.jsonBody = payload;
      state.body = payload;
      return this;
    },
    send(payload: unknown) {
      state.body = payload;
      return this;
    }
  } as unknown as Response;
  return { res, state };
}

beforeEach(() => {
  mocks.resolveApiKey.mockReset();
  mocks.resolveApiKey.mockReturnValue('relay-etherscan-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/proxy/etherscan — Etherscan V2 forward', () => {
  it('forwards to /v2/api with the full client query string and the injected server key', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: '1', result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    vi.stubGlobal('fetch', fetchStub);

    const { res, state } = makeRes();
    await etherscanProxyHandler(makeReq() as never, res);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [target] = fetchStub.mock.calls[0] as [string];
    const url = new URL(target);
    expect(url.origin).toBe('https://api.etherscan.io');
    expect(url.pathname).toBe('/v2/api');
    // Every client query param survives — including the multichain chainid.
    for (const [k, v] of Object.entries(CLIENT_QUERY)) {
      expect(url.searchParams.get(k)).toBe(v);
    }
    // The server-side key is injected.
    expect(url.searchParams.get('apikey')).toBe('relay-etherscan-key');
    expect(state.statusCode).toBe(200);
  });

  it('overrides a client-sent apikey with the server-side key', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: '1', result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    vi.stubGlobal('fetch', fetchStub);

    const { res } = makeRes();
    await etherscanProxyHandler(makeReq({ ...CLIENT_QUERY, apikey: 'client-attempt' }) as never, res);

    const [target] = fetchStub.mock.calls[0] as [string];
    const url = new URL(target);
    expect(url.searchParams.getAll('apikey')).toEqual(['relay-etherscan-key']);
  });

  it('returns 503 without calling upstream when no Etherscan key is configured', async () => {
    mocks.resolveApiKey.mockReturnValue(undefined);
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    const { res, state } = makeRes();
    await etherscanProxyHandler(makeReq() as never, res);

    expect(state.statusCode).toBe(503);
    expect(state.jsonBody).toEqual({ error: 'Etherscan API key not configured on server' });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
