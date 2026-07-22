import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeConnectionRow } from '@/lib/storage/db';

vi.mock('@/lib/saas/config', () => ({
  isSaasMode: vi.fn(() => true)
}));

import { isSaasMode } from '@/lib/saas/config';
import {
  loadCcxt,
  createExchangeClient,
  classifySyncError,
  syncErrorMessage
} from './ccxtLoader';
import { TunnelError } from './tunnel';
import type { SyncErrorKind } from './types';

const isSaasModeMock = vi.mocked(isSaasMode);

function row(over: Partial<ExchangeConnectionRow> = {}): ExchangeConnectionRow {
  return {
    id: 'exc_1',
    exchange: 'binance',
    apiKey: 'key',
    secret: 'secret',
    createdAt: 1_700_000_000_000,
    cursors: {},
    status: 'idle',
    ...over
  };
}

beforeEach(() => {
  isSaasModeMock.mockReset();
  isSaasModeMock.mockReturnValue(true);
});

describe('loadCcxt', () => {
  it('resolves the ccxt module under vitest (memoized)', async () => {
    const a = await loadCcxt();
    const b = await loadCcxt();
    expect(a).toBe(b);
    expect(typeof a.binance).toBe('function');
    expect(typeof a.coinbase).toBe('function');
    expect(typeof a.kraken).toBe('function');
    expect(typeof a.okx).toBe('function');
    expect(typeof a.kucoin).toBe('function');
  });
});

describe('createExchangeClient', () => {
  it('sets enableRateLimit + timeout, credentials, and spot defaultType (binance/okx)', async () => {
    const client = await createExchangeClient(row());
    const raw = client as unknown as Record<string, unknown>;
    expect(raw.enableRateLimit).toBe(true);
    expect(raw.timeout).toBe(30_000);
    expect(raw.apiKey).toBe('key');
    expect(raw.secret).toBe('secret');
    expect((raw.options as Record<string, unknown>).defaultType).toBe('spot');
    // Tunnel transport installed (fetch overridden from the prototype default).
    const fresh = new ((await loadCcxt()).binance as new (c: Record<string, unknown>) => Record<string, unknown>)({});
    expect(client.fetch).not.toBe(fresh.fetch);
  });

  it('maps passphrase → ccxt password for okx and kucoin', async () => {
    for (const exchange of ['okx', 'kucoin'] as const) {
      const client = await createExchangeClient(row({ exchange, passphrase: 'phrase' }));
      expect((client as unknown as Record<string, unknown>).password).toBe('phrase');
    }
  });

  it('does not set password for exchanges without a passphrase', async () => {
    const client = await createExchangeClient(row({ exchange: 'kraken' }));
    expect((client as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it('throws TunnelError(not_hosted) outside hosted mode', async () => {
    isSaasModeMock.mockReturnValue(false);
    const err = await createExchangeClient(row()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).kind).toBe('not_hosted');
  });
});

describe('classifySyncError', () => {
  async function ccxtError(className: string): Promise<Error> {
    const ccxt = await loadCcxt();
    const Ctor = ccxt[className] as new (message: string) => Error;
    return new Ctor('boom');
  }

  it.each([
    ['AuthenticationError', 'invalid_key'],
    ['AccountSuspended', 'invalid_key'], // subclass of AuthenticationError
    ['PermissionDenied', 'permission'],
    ['AccountNotEnabled', 'permission'], // subclass of PermissionDenied
    ['RateLimitExceeded', 'rate_limit'],
    ['DDoSProtection', 'rate_limit'],
    ['NetworkError', 'network'],
    ['ExchangeNotAvailable', 'network'],
    ['RequestTimeout', 'network']
  ])('ccxt %s → %s', async (className, kind) => {
    expect(classifySyncError(await ccxtError(className))).toBe(kind);
  });

  it.each([
    'not_hosted',
    'relay_auth',
    'relay_subscription',
    'relay_disabled',
    'relay_payload',
    'relay_unavailable'
  ] as SyncErrorKind[])('TunnelError(%s) passes through', (kind) => {
    expect(classifySyncError(new TunnelError(kind))).toBe(kind);
  });

  it('generic Error → unknown', () => {
    expect(classifySyncError(new Error('weird'))).toBe('unknown');
    expect(classifySyncError('string failure')).toBe('unknown');
    expect(classifySyncError(undefined)).toBe('unknown');
  });
});

describe('syncErrorMessage', () => {
  it('produces plain-language copy mentioning the exchange label', () => {
    expect(syncErrorMessage('invalid_key', 'binance')).toContain('Binance');
    expect(syncErrorMessage('permission', 'okx')).toContain('OKX');
    expect(syncErrorMessage('network', 'kucoin')).toContain('KuCoin');
    expect(syncErrorMessage('relay_auth', 'kraken')).toContain('sign in');
  });
});
