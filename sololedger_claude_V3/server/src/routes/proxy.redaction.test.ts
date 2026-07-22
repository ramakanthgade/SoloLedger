import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Log-redaction coverage: forward() logs upstream errors / thrown errors that
 * can embed provider URLs carrying API keys (Alchemy path keys, Helius
 * `api-key=`, Etherscan `apikey=`, OpenRouter `Bearer`). Those logs must never
 * contain a key.
 */

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn<() => string | undefined>()
}));

vi.mock('../apiKeys.js', () => ({
  resolveApiKey: mocks.resolveApiKey
}));

import { redactForLog } from '../logRedact.js';
import { forward } from './proxy.js';

function makeReq(): Request {
  return { method: 'GET', path: '/alchemy/eth-mainnet', headers: {}, body: {} } as unknown as Request;
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

function loggedErrors(): string {
  return (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  mocks.resolveApiKey.mockReset();
  mocks.resolveApiKey.mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redactForLog', () => {
  it('redacts an Alchemy key embedded in the URL path', () => {
    const out = redactForLog('GET https://eth-mainnet.g.alchemy.com/v2/AbCdEf123456_-x failed');
    expect(out).toContain('g.alchemy.com/v2/[redacted]');
    expect(out).not.toContain('AbCdEf123456_-x');
  });

  it('redacts api-key= and apikey= query parameters', () => {
    const a = redactForLog('https://mainnet.helius-rpc.com/?api-key=HELIUSKEY123&x=1');
    expect(a).toContain('api-key=[redacted]');
    expect(a).not.toContain('HELIUSKEY123');

    const b = redactForLog('https://api.etherscan.io/v2/api?module=account&apikey=ETHERSCANKEY999');
    expect(b).toContain('apikey=[redacted]');
    expect(b).not.toContain('ETHERSCANKEY999');
  });

  it('redacts Bearer tokens', () => {
    const out = redactForLog('Authorization: Bearer sk-or-v1-abcdef.123/xyz= rejected');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('sk-or-v1-abcdef.123/xyz=');
  });

  it('redacts the exact resolved provider key value', () => {
    mocks.resolveApiKey.mockImplementation(() => 'RESOLVED_ALCHEMY_KEY_42');
    const out = redactForLog(new Error('upstream hit https://x.example/v2/RESOLVED_ALCHEMY_KEY_42'));
    expect(out).not.toContain('RESOLVED_ALCHEMY_KEY_42');
    expect(out).toContain('[redacted]');
  });

  it('ignores resolved keys shorter than 8 chars', () => {
    mocks.resolveApiKey.mockImplementation(() => 'short');
    const out = redactForLog('a short message stays readable');
    expect(out).toContain('a short message stays readable');
  });

  it('renders Error as "name: message" and includes the cause, redacting both', () => {
    const err = new Error('fetch failed for https://eth-mainnet.g.alchemy.com/v2/TOPKEY123456', {
      cause: new Error('connect ECONNREFUSED ?api-key=CAUSEKEY999')
    });
    const out = redactForLog(err);
    expect(out).toContain('Error: fetch failed');
    expect(out).toContain('cause:');
    expect(out).not.toContain('TOPKEY123456');
    expect(out).not.toContain('CAUSEKEY999');
  });

  it('stringifies non-error values', () => {
    expect(redactForLog('plain string')).toBe('plain string');
    expect(redactForLog(42)).toBe('42');
    expect(redactForLog({ a: 1 })).toBe('[object Object]');
  });

  it('truncates long output to 500 chars', () => {
    const out = redactForLog('x'.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(520);
    expect(out.startsWith('x'.repeat(500))).toBe(true);
    expect(out).toContain('[truncated]');
  });
});

describe('forward() log redaction', () => {
  it('redacts a keyed URL embedded in an upstream error body before logging', async () => {
    // The key in the Alchemy URL is the server's configured key — the exact-value
    // scrub covers occurrences the URL-shape regexes don't (e.g. echoed bare).
    mocks.resolveApiKey.mockImplementation(() => 'SUPER_SECRET_API_KEY');
    const upstreamBody =
      'error hitting https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET_API_KEY: invalid api key SUPER_SECRET_API_KEY';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(upstreamBody, { status: 500, headers: { 'content-type': 'application/json' } })
      )
    );

    const { res, state } = makeRes();
    await forward('https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET_API_KEY', makeReq(), res);

    expect(state.statusCode).toBe(500);
    expect(state.jsonBody).toEqual({ error: 'Upstream request failed' });
    expect(console.error).toHaveBeenCalled();
    const logs = loggedErrors();
    expect(logs).not.toContain('SUPER_SECRET_API_KEY');
    expect(logs).toContain('g.alchemy.com/v2/[redacted]');
  });

  it('redacts a keyed URL embedded in a thrown fetch error before logging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'connect ECONNREFUSED https://mainnet.helius-rpc.com/?api-key=HELIUS_SECRET_123'
        );
      })
    );

    const { res, state } = makeRes();
    await forward('https://mainnet.helius-rpc.com/?api-key=HELIUS_SECRET_123', makeReq(), res);

    expect(state.statusCode).toBe(502);
    expect(state.jsonBody).toEqual({ error: 'Upstream request failed' });
    expect(console.error).toHaveBeenCalled();
    const logs = loggedErrors();
    expect(logs).not.toContain('HELIUS_SECRET_123');
    expect(logs).toContain('api-key=[redacted]');
  });
});
