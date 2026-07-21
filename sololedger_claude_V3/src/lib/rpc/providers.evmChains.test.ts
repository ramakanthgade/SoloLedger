import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHAINS, lookupManyAddresses, type ChainId } from '@/lib/rpc/providers';
import { setMode } from '@/lib/saas/mode';

/**
 * Item 5 (a–d, f) — new-chain import plumbing:
 *  a. Moralis-dropped chains skip the Moralis attempt entirely.
 *  b/c. Etherscan V2 fallback fires on ANY Alchemy failure, only for chains
 *       with a (free-tier-working) V2 id.
 *  d. Hosted mode routes Etherscan calls through /api/proxy/etherscan.
 *  f. Hosted users never see "check your API key"; chains with no working
 *     provider get a calm "not available yet" message.
 */

const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn() }));

vi.mock('@/lib/saas/api', () => ({ saasProxyFetch: mocks.proxyFetch }));

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** One incoming native tx as an Etherscan txlist row. */
const NATIVE_ROW = {
  from: OTHER,
  to: WALLET,
  value: '1000000000000000000',
  timeStamp: '1700000000',
  hash: '0xdeadbeef'
};

const chainDef = (id: ChainId) => CHAINS.find((c) => c.id === id)!;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

/** URLs the global fetch mock saw, filtered to one fragment. */
const callsTo = (fragment: string) =>
  fetchMock()
    .mock.calls.map(([u]) => String(u))
    .filter((u) => u.includes(fragment));

/** Relay paths the saasProxyFetch mock saw, filtered to one fragment. */
const proxyCallsTo = (fragment: string) =>
  mocks.proxyFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(fragment));

/**
 * Local-mode provider routing: Moralis always 400s (mirrors the dropped
 * chains — and lets served chains fall through to Alchemy like the live
 * failure did); Alchemy answers empty transfers or `alchemyStatus`;
 * Etherscan serves `etherscanTxlist` rows for action=txlist and an empty
 * page for action=tokentx, or an HTTP error for 'http-error'.
 */
function mockLocalProviders(
  opts: {
    alchemyStatus?: number;
    etherscanTxlist?: Record<string, unknown>[] | 'http-error';
  } = {}
) {
  const { alchemyStatus = 200, etherscanTxlist = [] } = opts;
  fetchMock().mockImplementation(async (rawUrl: string) => {
    const url = String(rawUrl);
    if (url.includes('deep-index.moralis.io')) return jsonResponse({}, false, 400);
    if (url.includes('/alchemy-rpc/')) {
      if (alchemyStatus !== 200) {
        return jsonResponse({ error: { message: 'network not enabled' } }, false, alchemyStatus);
      }
      return jsonResponse({ result: { transfers: [] } });
    }
    if (url.includes('etherscan')) {
      if (etherscanTxlist === 'http-error') return jsonResponse('oops', false, 500);
      const action = new URL(url, 'http://localhost').searchParams.get('action');
      return jsonResponse({ status: '1', result: action === 'txlist' ? etherscanTxlist : [] });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  mocks.proxyFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMode('local');
});

describe('Item 5a — Moralis-dropped chains skip Moralis', () => {
  it.each(['celo', 'zksync', 'scroll', 'blast', 'mantle'] as const)(
    'goes straight to Alchemy for Moralis-dropped %s (no Moralis round-trip)',
    async (id) => {
      mockLocalProviders();
      const def = chainDef(id);
      await lookupManyAddresses([WALLET], { chain: def, moralisApiKey: 'mk', alchemyApiKey: 'ak' });
      expect(callsTo('deep-index.moralis.io')).toHaveLength(0);
      expect(callsTo(`/alchemy-rpc/${def.alchemyNetwork}`)).toHaveLength(2); // from + to
    }
  );

  it('still tries Moralis first for a chain Moralis serves (ethereum control)', async () => {
    fetchMock().mockImplementation(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('deep-index.moralis.io')) return jsonResponse({ result: [] });
      throw new Error(`unexpected url ${url}`);
    });
    const result = await lookupManyAddresses([WALLET], { chain: chainDef('ethereum'), moralisApiKey: 'mk' });
    expect(callsTo('deep-index.moralis.io')).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });
});

describe('Item 5b/c — Etherscan V2 fallback on ANY Alchemy failure', () => {
  it.each([
    ['celo', '42220'],
    ['gnosis', '100'],
    ['linea', '59144'],
    ['blast', '81457'],
    ['mantle', '5000']
  ] as const)('falls back to Etherscan V2 (chainid=%s) when Alchemy 403s on %s', async (id, chainid) => {
    mockLocalProviders({ alchemyStatus: 403, etherscanTxlist: [NATIVE_ROW] });
    const result = await lookupManyAddresses([WALLET], {
      chain: chainDef(id),
      moralisApiKey: 'mk',
      alchemyApiKey: 'ak',
      customApiKey: 'ek'
    });
    expect(result.failed).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ type: 'transfer_in', sourceRef: '0xdeadbeef' });
    const v2Calls = callsTo('etherscan');
    expect(v2Calls.length).toBeGreaterThan(0);
    expect(v2Calls[0]).toContain(`chainid=${chainid}`);
    expect(v2Calls[0]).toContain('apikey=ek'); // BYOK: the user's own key
    expect(result.warnings.some((w) => w.message.includes('fetched via Etherscan instead'))).toBe(true);
  });

  it('falls back on an Alchemy NETWORK error too, not only HTTP errors', async () => {
    fetchMock().mockImplementation(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('deep-index.moralis.io')) return jsonResponse({}, false, 400);
      if (url.includes('/alchemy-rpc/')) throw new Error('Failed to fetch');
      if (url.includes('etherscan')) {
        const action = new URL(url, 'http://localhost').searchParams.get('action');
        return jsonResponse({ status: '1', result: action === 'txlist' ? [NATIVE_ROW] : [] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const result = await lookupManyAddresses([WALLET], {
      chain: chainDef('mantle'),
      moralisApiKey: 'mk',
      alchemyApiKey: 'ak',
      customApiKey: 'ek'
    });
    expect(result.failed).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    expect(callsTo('etherscan')[0]).toContain('chainid=5000');
  });

  it.each(['base', 'avalanche'] as const)(
    'does NOT fall back for %s — paid-gated on Etherscan V2, so no V2 id is wired',
    async (id) => {
      mockLocalProviders({ alchemyStatus: 403, etherscanTxlist: [NATIVE_ROW] });
      const result = await lookupManyAddresses([WALLET], {
        chain: chainDef(id),
        moralisApiKey: 'mk',
        alchemyApiKey: 'ak',
        customApiKey: 'ek'
      });
      expect(callsTo('etherscan')).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].message).toContain('network not enabled');
      expect(result.failed[0].message).not.toMatch(/check your API key/i);
    }
  );

  it.each(['zksync', 'scroll'] as const)(
    'has no Etherscan V2 fallback for %s (unsupported chainid on V2)',
    async (id) => {
      mockLocalProviders({ alchemyStatus: 403 });
      const result = await lookupManyAddresses([WALLET], {
        chain: chainDef(id),
        moralisApiKey: 'mk',
        alchemyApiKey: 'ak',
        customApiKey: 'ek'
      });
      expect(callsTo('etherscan')).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].message).toContain('network not enabled');
    }
  );

  it('surfaces the error calmly when the Etherscan V2 fallback also fails', async () => {
    mockLocalProviders({ alchemyStatus: 403, etherscanTxlist: 'http-error' });
    const result = await lookupManyAddresses([WALLET], {
      chain: chainDef('celo'),
      moralisApiKey: 'mk',
      alchemyApiKey: 'ak',
      customApiKey: 'ek'
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toContain('Explorer API returned 500');
    expect(result.failed[0].message).not.toMatch(/check your API key/i);
  });
});

describe('Item 5d — hosted relay routing', () => {
  it('routes Etherscan requests through /api/proxy/etherscan in hosted mode, preserving chainid', async () => {
    setMode('hosted');
    mocks.proxyFetch.mockImplementation(async (rawPath: string) => {
      const path = String(rawPath);
      if (path.startsWith('/api/proxy/alchemy/')) {
        return jsonResponse({ error: { message: 'network not enabled' } }, false, 403);
      }
      if (path.startsWith('/api/proxy/etherscan?')) {
        const action = new URL(path, 'http://localhost').searchParams.get('action');
        return jsonResponse({ status: '1', result: action === 'txlist' ? [NATIVE_ROW] : [] });
      }
      throw new Error(`unexpected relay path ${path}`);
    });

    // No user keys at all — the relay injects the server-side keys.
    const result = await lookupManyAddresses([WALLET], { chain: chainDef('celo') });

    expect(result.failed).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    const relayCalls = proxyCallsTo('/api/proxy/etherscan?');
    expect(relayCalls.length).toBeGreaterThan(0);
    expect(relayCalls[0]).toContain('chainid=42220');
    expect(relayCalls[0]).toContain('module=account');
    expect(relayCalls[0]).toContain('action=txlist');
    expect(relayCalls[0]).not.toContain('apikey'); // the relay injects the key
    // Nothing bypassed the relay.
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('shows the calm hosted message (never "check your API key") when a chain has no fallback', async () => {
    setMode('hosted');
    mocks.proxyFetch.mockImplementation(async (rawPath: string) => {
      const path = String(rawPath);
      if (path.includes('/api/proxy/moralis/')) return jsonResponse({ result: [] });
      if (path.startsWith('/api/proxy/alchemy/')) {
        return jsonResponse({ error: { message: 'upstream exploded' } }, false, 403);
      }
      throw new Error(`unexpected relay path ${path}`);
    });

    // Base is paid-gated on Etherscan V2 → no V2 id → no fallback.
    const result = await lookupManyAddresses([WALLET], { chain: chainDef('base') });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toBe(
      'This chain is temporarily unavailable on the hosted service — please try again later.'
    );
    expect(result.failed[0].message).not.toMatch(/API key/i);
    expect(proxyCallsTo('/api/proxy/etherscan')).toHaveLength(0);
  });
});

describe('Item 5f — calm wording for chains with no working provider', () => {
  it('gives a calm "not available" message for a legacy Fantom sync (local) — no API-key error, no network', async () => {
    mockLocalProviders();
    const result = await lookupManyAddresses([WALLET], {
      chain: chainDef('fantom'),
      moralisApiKey: 'mk',
      alchemyApiKey: 'ak'
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toBe(
      'This chain is not available from any wallet-data provider right now — please use a CSV export instead.'
    );
    expect(result.failed[0].message).not.toMatch(/API key/i);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('gives the hosted "not available yet" message for a legacy Fantom sync', async () => {
    setMode('hosted');
    const result = await lookupManyAddresses([WALLET], { chain: chainDef('fantom') });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toBe(
      'This chain is not available on the hosted service yet — please use a CSV export instead.'
    );
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('gives the hosted "not available yet" message for Aurora instead of hitting a dead chainid', async () => {
    setMode('hosted');
    const result = await lookupManyAddresses([WALLET], {
      chain: chainDef('aurora'),
      customBaseUrl: 'https://api.etherscan.io/v2/api?chainid=1313161554'
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toBe(
      'This chain is not available on the hosted service yet — please use a CSV export instead.'
    );
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('keeps the BYOK Aurora custom-explorer path untouched', async () => {
    // No custom base URL → the pre-existing "enter a base URL" guidance.
    const result = await lookupManyAddresses([WALLET], { chain: chainDef('aurora') });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toContain('Enter an explorer base URL');
  });
});
