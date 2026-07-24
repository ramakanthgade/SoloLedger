import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the saas api layer BEFORE importing the module under test.
vi.mock('@/lib/saas/api', () => ({
  apiFetch: vi.fn(),
  getAuthToken: vi.fn(() => 'test-jwt')
}));

import { apiFetch, getAuthToken } from '@/lib/saas/api';
import {
  getBinanceGatewayTicket,
  __clearBinanceGatewayTicketCache,
  type BinanceGatewayTicket
} from './binanceGateway';
import { TunnelError } from './tunnel';

const apiFetchMock = vi.mocked(apiFetch);
const getAuthTokenMock = vi.mocked(getAuthToken);

function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(body),
    text: async () => body
  } as unknown as Response;
}

const TICKET: BinanceGatewayTicket = {
  url: 'https://gw.example.workers.dev',
  exp: Math.floor(Date.now() / 1000) + 600,
  token: 'dG9rZW4'
};

beforeEach(() => {
  apiFetchMock.mockReset();
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockReturnValue('test-jwt');
  __clearBinanceGatewayTicketCache();
});

describe('getBinanceGatewayTicket', () => {
  it('mints via the relay and returns {url, exp, token}', async () => {
    apiFetchMock.mockResolvedValue(fakeResponse(200, JSON.stringify(TICKET)));
    const ticket = await getBinanceGatewayTicket();
    expect(ticket).toEqual(TICKET);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/exchange-gateway/binance/ticket');
  });

  it('caches the ticket — a second call does not re-mint', async () => {
    apiFetchMock.mockResolvedValue(fakeResponse(200, JSON.stringify(TICKET)));
    await getBinanceGatewayTicket();
    await getBinanceGatewayTicket();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the cached ticket is inside the refresh margin', async () => {
    const soon = { ...TICKET, exp: Math.floor(Date.now() / 1000) + 30 }; // < 60s margin
    apiFetchMock.mockResolvedValue(fakeResponse(200, JSON.stringify(soon)));
    await getBinanceGatewayTicket();
    await getBinanceGatewayTicket();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('no JWT → TunnelError(relay_auth) without calling the relay', async () => {
    getAuthTokenMock.mockReturnValue(null);
    const err = await getBinanceGatewayTicket().catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_auth');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['auth', 'relay_auth', 401],
    ['subscription', 'relay_subscription', 402],
    ['disabled', 'relay_disabled', 403]
  ])('stamped x-sololedger-error: %s → TunnelError(%s)', async (header, kind, status) => {
    apiFetchMock.mockResolvedValue(fakeResponse(status, '{"error":"nope"}', { 'x-sololedger-error': header }));
    const err = await getBinanceGatewayTicket().catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe(kind);
  });

  it('unstamped non-OK (e.g. 503 gateway_not_configured) → TunnelError(relay_unavailable)', async () => {
    apiFetchMock.mockResolvedValue(fakeResponse(503, '{"error":"gateway_not_configured"}'));
    const err = await getBinanceGatewayTicket().catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });

  it('relay unreachable (apiFetch throws) → TunnelError(relay_unavailable)', async () => {
    apiFetchMock.mockRejectedValue(new Error('Cannot reach API at https://relay'));
    const err = await getBinanceGatewayTicket().catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });

  it('malformed 200 body → TunnelError(relay_unavailable)', async () => {
    apiFetchMock.mockResolvedValue(fakeResponse(200, '{"url":"https://gw"}'));
    const err = await getBinanceGatewayTicket().catch((e) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('relay_unavailable');
  });

  it('a failed mint does not poison the cache — next call retries', async () => {
    apiFetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(fakeResponse(200, JSON.stringify(TICKET)));
    await getBinanceGatewayTicket().catch(() => undefined);
    const ticket = await getBinanceGatewayTicket();
    expect(ticket).toEqual(TICKET);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
