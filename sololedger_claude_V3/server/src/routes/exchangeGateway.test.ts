import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'events';
import type { AddressInfo } from 'net';

/**
 * Binance gateway ticket endpoint — auth/subscription/flag gates, ticket
 * shape, the shared HMAC contract with the Cloudflare worker (pinned test
 * vector), and the public-config exposure of binanceGatewayUrl.
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
import { exchangeGatewayRouter, mintGatewayTicket } from './exchangeGateway.js';
import { configRouter } from './config.js';

const GATEWAY_URL = 'https://sololedger-binance-gateway.sololedger.workers.dev';
const GATEWAY_SECRET = 'test-gateway-secret-0123456789abcdef';

let server: ReturnType<express.Express['listen']>;
let base: string;

beforeEach(async () => {
  mocks.subscriptionActive = true;
  mocks.exchangeSyncEnabled = true;
  process.env.BINANCE_GATEWAY_URL = GATEWAY_URL;
  process.env.BINANCE_GATEWAY_SECRET = GATEWAY_SECRET;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/config', configRouter);
  app.use('/api/exchange-gateway', exchangeGatewayRouter);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.BINANCE_GATEWAY_URL;
  delete process.env.BINANCE_GATEWAY_SECRET;
  server.close();
});

const AUTH = { authorization: 'Bearer test.jwt' };

describe('exchange-gateway /binance/ticket', () => {
  it('401 without JWT, stamped x-sololedger-error: auth', async () => {
    const res = await fetch(`${base}/api/exchange-gateway/binance/ticket`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-sololedger-error')).toBe('auth');
  });

  it('402 with inactive subscription, stamped subscription', async () => {
    mocks.subscriptionActive = false;
    const res = await fetch(`${base}/api/exchange-gateway/binance/ticket`, { headers: AUTH });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-sololedger-error')).toBe('subscription');
  });

  it('403 when the admin flag is off, stamped disabled', async () => {
    mocks.exchangeSyncEnabled = false;
    const res = await fetch(`${base}/api/exchange-gateway/binance/ticket`, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-sololedger-error')).toBe('disabled');
  });

  it('503 gateway_not_configured (unstamped) when env is missing', async () => {
    delete process.env.BINANCE_GATEWAY_URL;
    const res = await fetch(`${base}/api/exchange-gateway/binance/ticket`, { headers: AUTH });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
    expect((await res.json()).error).toBe('gateway_not_configured');
  });

  it('200: ticket shape — url, exp ~now+600, token = HMAC(secret, exp)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/api/exchange-gateway/binance/ticket`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sololedger-error')).toBeNull();
    const body = await res.json();
    expect(body.url).toBe(GATEWAY_URL);
    expect(body.exp).toBeGreaterThanOrEqual(before + 599);
    expect(body.exp).toBeLessThanOrEqual(before + 601);
    expect(body.token).toBe(mintGatewayTicket(GATEWAY_SECRET, body.exp));
  });
});

describe('mintGatewayTicket — shared contract with the Cloudflare worker', () => {
  it('pinned test vector (verified byte-identical in Python hmac and against the live worker algorithm)', () => {
    // secret = 64 hex chars of "0123...ef", exp = 1800000000 → this exact token.
    // Cross-checked 2026-07-24: python hmac+base64url == node digest('base64url')
    // == worker btoa()-based base64url for the same inputs.
    expect(
      mintGatewayTicket(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        1800000000
      )
    ).toBe('Y_woGB9EdPh4GGoRU_oNzly-9Eix2C86VLp9zld0gtM');
  });
});

describe('public config — binanceGatewayUrl', () => {
  it('exposes the gateway URL (never the secret) when configured', async () => {
    const res = await fetch(`${base}/api/config/public`);
    const body = await res.json();
    expect(body.binanceGatewayUrl).toBe(GATEWAY_URL);
    expect(JSON.stringify(body)).not.toContain(GATEWAY_SECRET);
  });

  it('is null when the gateway is not configured', async () => {
    delete process.env.BINANCE_GATEWAY_URL;
    delete process.env.BINANCE_GATEWAY_SECRET;
    const res = await fetch(`${base}/api/config/public`);
    expect((await res.json()).binanceGatewayUrl).toBeNull();
  });
});
