import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { forward } from './proxy.js';

/** Minimal Express Response stub capturing what the handler sends. */
function makeRes() {
  const state: {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    jsonBody: unknown;
  } = { statusCode: 200, headers: {}, body: undefined, jsonBody: undefined };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
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

function makeReq(): Request {
  return { method: 'GET', path: '/alchemy/eth-mainnet', headers: {}, body: {} } as unknown as Request;
}

const SECRET_URL = 'https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET_API_KEY';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxy forward() error scrubbing', () => {
  it('returns a generic message (never the upstream body/URL) on a non-OK upstream', async () => {
    const upstreamBody = `error hitting ${SECRET_URL}: invalid api key SUPER_SECRET_API_KEY`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(upstreamBody, {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    const { res, state } = makeRes();
    await forward(SECRET_URL, makeReq(), res);

    expect(state.statusCode).toBe(500);
    expect(state.jsonBody).toEqual({ error: 'Upstream request failed' });
    const serialized = JSON.stringify(state.body);
    expect(serialized).not.toContain('SUPER_SECRET_API_KEY');
    expect(serialized).not.toContain('g.alchemy.com');

    vi.unstubAllGlobals();
  });

  it('returns a generic 502 (never the URL/error) when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`ECONNREFUSED ${SECRET_URL}`);
      })
    );

    const { res, state } = makeRes();
    await forward(SECRET_URL, makeReq(), res);

    expect(state.statusCode).toBe(502);
    expect(state.jsonBody).toEqual({ error: 'Upstream request failed' });
    expect(JSON.stringify(state.body)).not.toContain('SUPER_SECRET_API_KEY');

    vi.unstubAllGlobals();
  });

  it('passes the body through unchanged on a successful upstream', async () => {
    const okBody = JSON.stringify({ jsonrpc: '2.0', result: '0x1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } })
      )
    );

    const { res, state } = makeRes();
    await forward(SECRET_URL, makeReq(), res);

    expect(state.statusCode).toBe(200);
    expect(state.body).toBe(okBody);

    vi.unstubAllGlobals();
  });
});
