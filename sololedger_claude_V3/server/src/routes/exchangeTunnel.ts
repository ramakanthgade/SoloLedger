import { Router, type Request, type Response, type NextFunction } from 'express';
import { authMiddleware, type AuthedRequest } from '../auth.js';
import { getServerConfig } from '../store.js';
import { requireActiveSubscription } from './proxy.js';

/**
 * Exchange auto-sync tunnel (contract C1 — relay raw-replay).
 *
 * ccxt runs in the browser and signs requests locally; the exchange secret
 * NEVER leaves the user's device. This router receives the fully-signed
 * request and replays it byte-verbatim to the exchange: stateless, no
 * storage, no body logging. It is mounted BEFORE express.json() with
 * express.raw() (see index.ts) so the signed body/query survive untouched.
 *
 * Relay-origin vs exchange-origin errors: status codes alone cannot
 * distinguish them (a Binance 401 vs our JWT 401), so EVERY relay-origin
 * error is stamped `x-sololedger-error: <kind>` via the res.json interceptor
 * below. Exchange-piped responses never go through res.json and stay
 * unstamped; the client branches on the header only.
 */

export type TunnelErrorKind =
  | 'auth'
  | 'subscription'
  | 'disabled'
  | 'unknown_exchange'
  | 'bad_path'
  | 'payload_too_large'
  | 'upstream_timeout'
  | 'upstream_failed';

interface ExchangeSpec {
  host: string;
  /** Headers the client may forward, sent as `x-exchange-<name>` (contract C2). */
  headers: readonly string[];
  /** Optional endpoint allowlist. Entries are exact unless they contain a typed placeholder. */
  paths?: readonly string[];
  /** Optional HTTP-method allowlist (used when a connector is read-only). */
  methods?: readonly string[];
  /** Optional exact per-path methods for exchanges mixing public GET/private POST. */
  pathMethods?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Contract C2 — spot-only hosts + per-exchange forwardable headers. Futures
 * hosts are deliberately excluded. Extend by adding a row (and a live-verify
 * probe in scripts/live-verify-exchange-tunnel.mjs).
 */
const EXCHANGES: Record<string, ExchangeSpec> = {
  binance: { host: 'api.binance.com', headers: ['x-mbx-apikey'] },
  coinbase: {
    host: 'api.coinbase.com',
    headers: ['cb-access-key', 'cb-access-sign', 'cb-access-timestamp', 'authorization']
  },
  kraken: { host: 'api.kraken.com', headers: ['api-key', 'api-sign'] },
  okx: {
    host: 'www.okx.com',
    headers: ['ok-access-key', 'ok-access-sign', 'ok-access-timestamp', 'ok-access-passphrase']
  },
  kucoin: {
    host: 'api.kucoin.com',
    headers: [
      'kc-api-key',
      'kc-api-sign',
      'kc-api-timestamp',
      'kc-api-passphrase',
      'kc-api-key-version',
      'kc-api-partner',
      'kc-api-partner-sign',
      'kc-api-partner-verify'
    ]
  },
  bybit: {
    host: 'api.bybit.com',
    headers: ['x-bapi-api-key', 'x-bapi-sign', 'x-bapi-timestamp', 'x-bapi-recv-window'],
    // Only the V5 spot-sync endpoints exercised by ccxt. No order mutation,
    // derivatives position, margin, lending, transfer or withdrawal-mutation paths.
    paths: [
      '/v5/market/time',
      '/v5/market/instruments-info',
      '/v5/account/wallet-balance',
      '/v5/execution/list',
      '/v5/asset/deposit/query-record',
      '/v5/asset/withdraw/query-record'
    ]
  },
  gateio: {
    host: 'api.gateio.ws',
    headers: ['key', 'timestamp', 'sign'],
    methods: ['GET'],
    // Exact read-only endpoints used by CCXT 4.5.68's `gate` class. No order
    // mutation, withdrawal mutation, margin, unified, futures or delivery APIs.
    paths: [
      '/api/v4/spot/time',
      '/api/v4/spot/currency_pairs',
      '/api/v4/spot/accounts',
      '/api/v4/spot/my_trades',
      '/api/v4/wallet/deposits',
      '/api/v4/wallet/withdrawals'
    ]
  },
  htx: {
    host: 'api.huobi.pro',
    // HTX v1 authentication is entirely in the signed raw query. CCXT sends
    // no private auth header; content-type is handled by the common tunnel.
    headers: [],
    methods: ['GET'],
    paths: [
      '/v1/common/timestamp',
      '/v1/common/symbols',
      '/v1/account/accounts',
      '/v1/account/accounts/{account-id}/balance',
      '/v1/order/matchresults',
      '/v1/query/deposit-withdraw'
    ]
  },
  cryptocom: {
    host: 'api.crypto.com',
    // Crypto.com signs the exact JSON body; no private auth headers exist.
    headers: [],
    paths: [
      '/exchange/v1/public/get-instruments',
      '/exchange/v1/private/user-balance',
      '/exchange/v1/private/get-trades',
      '/exchange/v1/private/get-deposit-history',
      '/exchange/v1/private/get-withdrawal-history'
    ],
    pathMethods: {
      '/exchange/v1/public/get-instruments': ['GET'],
      '/exchange/v1/private/user-balance': ['POST'],
      '/exchange/v1/private/get-trades': ['POST'],
      '/exchange/v1/private/get-deposit-history': ['POST'],
      '/exchange/v1/private/get-withdrawal-history': ['POST']
    }
  },
  bitfinex: {
    host: 'api.bitfinex.com',
    headers: ['bfx-nonce', 'bfx-apikey', 'bfx-signature'],
    paths: [
      '/v2/platform/status',
      '/v2/conf/pub:info:pair,pub:info:pair:futures,pub:list:pair:securities,pub:list:pair:margin',
      '/v2/auth/r/wallets',
      '/v2/auth/r/trades/hist',
      '/v2/auth/r/movements/hist'
    ],
    methods: ['GET', 'POST'],
    pathMethods: {
      '/v2/platform/status': ['GET'],
      '/v2/conf/pub:info:pair,pub:info:pair:futures,pub:list:pair:securities,pub:list:pair:margin': ['GET'],
      '/v2/auth/r/wallets': ['POST'],
      '/v2/auth/r/trades/hist': ['POST'],
      '/v2/auth/r/movements/hist': ['POST']
    }
  },
  gemini: {
    host: 'api.gemini.com',
    headers: ['x-gemini-apikey', 'x-gemini-payload', 'x-gemini-signature'],
    paths: ['/v1/symbols', '/v1/balances', '/v1/mytrades', '/v1/transfers'],
    pathMethods: {
      '/v1/symbols': ['GET'],
      '/v1/balances': ['POST'],
      '/v1/mytrades': ['POST'],
      '/v1/transfers': ['POST']
    }
  },
  btcmarkets: {
    host: 'api.btcmarkets.net',
    headers: ['bm-auth-apikey', 'bm-auth-timestamp', 'bm-auth-signature'],
    methods: ['GET'],
    // Exact pinned-CCXT 4.5.68 read surface. Order, report, address and
    // withdrawal mutation paths are deliberately unreachable.
    paths: [
      '/v3/time',
      '/v3/markets',
      '/v3/accounts/me/balances',
      '/v3/trades',
      '/v3/transfers'
    ]
  },
  bitstamp: {
    host: 'www.bitstamp.net',
    headers: ['x-auth', 'x-auth-signature', 'x-auth-nonce', 'x-auth-timestamp', 'x-auth-version'],
    paths: [
      '/api/v2/markets/',
      '/api/v2/account_balances/',
      '/api/v2/user_transactions/',
      '/api/v2/withdrawal-requests/'
    ],
    pathMethods: {
      '/api/v2/markets/': ['GET'],
      '/api/v2/account_balances/': ['POST'],
      '/api/v2/user_transactions/': ['POST'],
      '/api/v2/withdrawal-requests/': ['POST']
    }
  }
};

/** RFC-3986 unreserved + sub-delims + ':' '@' '/' '?' '%' — no space, '#', '"', … */
const RAW_URL_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

const UPSTREAM_TIMEOUT_MS = 30_000;
/** Defensive cap on piped upstream bodies (nothing legit comes close). */
const MAX_UPSTREAM_BODY_BYTES = 25 * 1024 * 1024;

export const exchangeTunnelRouter = Router();

// CORS cursor visibility is route-scoped: no non-BTC exchange or unrelated
// API response should advertise BTC Markets' pagination headers.
exchangeTunnelRouter.use((req, res, next) => {
  if (req.url === '/btcmarkets' || req.url.startsWith('/btcmarkets/')) {
    res.append('Access-Control-Expose-Headers', 'bm-before, bm-after');
  }
  next();
});

function pathAllowed(path: string, allowed: string): boolean {
  if (!allowed.includes('{account-id}')) return path === allowed;
  const [prefix, suffix] = allowed.split('{account-id}');
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  const accountId = path.slice(prefix.length, path.length - suffix.length);
  return /^[0-9]+$/.test(accountId);
}

/** Set the error kind for this failure site, then send the JSON error. */
function fail(res: Response, kind: TunnelErrorKind, status: number, message: string): void {
  res.locals.tunnelErrorKind = kind;
  res.status(status).json({ error: message });
}

// (0) res.json interceptor — FIRST middleware. Every relay-origin error below
// (auth 401, subscription 402, disabled 403, handler 400/404/502/504) responds
// via res.json → gets stamped x-sololedger-error from res.locals.tunnelErrorKind.
// Exchange-piped responses use res.send(buffer), never res.json → unstamped.
exchangeTunnelRouter.use((_req, res, next) => {
  const orig = res.json.bind(res);
  res.json = ((body: unknown) => {
    const kind = res.locals.tunnelErrorKind as TunnelErrorKind | undefined;
    if (kind) res.setHeader('x-sololedger-error', kind);
    return orig(body);
  }) as Response['json'];
  next();
});

// (1) JWT auth — its 401s must be stamped 'auth', so set the kind BEFORE it runs.
exchangeTunnelRouter.use((req, res, next) => {
  res.locals.tunnelErrorKind = 'auth' satisfies TunnelErrorKind;
  authMiddleware(req as AuthedRequest, res, next);
});

// (2) Active subscription — its 402s (and 401 user-not-found) stamp 'subscription'.
exchangeTunnelRouter.use((req, res, next) => {
  res.locals.tunnelErrorKind = 'subscription' satisfies TunnelErrorKind;
  if (!requireActiveSubscription(req as AuthedRequest, res)) return;
  next();
});

// (3) exchangeSyncEnabled flag gate (contract C4).
exchangeTunnelRouter.use((_req, res, next) => {
  if (!getServerConfig().exchangeSyncEnabled) {
    fail(res, 'disabled', 403, 'Exchange sync is disabled by admin');
    return;
  }
  next();
});

/**
 * Exported for direct unit testing (same pattern as etherscanProxyHandler).
 * Expects to run behind the router middleware above inside an express.raw()
 * mount: req.body is a Buffer (or undefined for bodiless requests).
 */
export async function exchangeTunnelHandler(req: Request, res: Response): Promise<void> {
  const method = req.method.toUpperCase();

  // RAW req.url only — never req.params/query. Express decoding corrupts
  // %2B/%2F in signatures; the signed query must reach the exchange byte-exact.
  // Inside this router req.url is '/<exchangeId>/<upstream-path>?<raw-query>'.
  const rawUrl = req.url;
  if (!RAW_URL_RE.test(rawUrl)) {
    fail(res, 'bad_path', 400, 'Invalid upstream path');
    return;
  }
  const qIndex = rawUrl.indexOf('?');
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);

  const firstSlash = rawPath.indexOf('/', 1);
  const exchangeId = firstSlash === -1 ? rawPath.slice(1) : rawPath.slice(1, firstSlash);
  const upstreamPath = firstSlash === -1 ? '' : rawPath.slice(firstSlash);

  const spec = EXCHANGES[exchangeId];
  if (!spec) {
    fail(res, 'unknown_exchange', 404, 'Unknown exchange');
    return;
  }
  if (upstreamPath.length < 2) {
    fail(res, 'bad_path', 400, 'Missing upstream path');
    return;
  }
  // Fail closed before URL construction. No connector needs path escapes, and
  // accepting them creates multiple interpretations between Express, WHATWG
  // URL, fetch and the upstream proxy. Queries remain raw and may contain `%`.
  // Path percent-encoding is rejected wholesale, covering encoded/mixed-case
  // dot segments, encoded slashes and encoded backslashes without relying on
  // one decoder's normalization behavior.
  const pathSegments = upstreamPath.split('/');
  if (
    upstreamPath.includes('%') ||
    upstreamPath.includes('\\') ||
    pathSegments.some((segment) => segment === '.' || segment === '..')
  ) {
    fail(res, 'bad_path', 400, 'Non-canonical upstream path');
    return;
  }
  const canonicalUrl = new URL(`https://${spec.host}${upstreamPath}`);
  if (canonicalUrl.host !== spec.host || canonicalUrl.pathname !== upstreamPath) {
    fail(res, 'bad_path', 400, 'Non-canonical upstream path');
    return;
  }
  if (spec.paths && !spec.paths.some((allowed) => pathAllowed(upstreamPath, allowed))) {
    fail(res, 'bad_path', 400, 'Upstream path is not allowed for this exchange');
    return;
  }
  if (spec.methods && !spec.methods.includes(method)) {
    fail(res, 'bad_path', 400, 'Upstream method is not allowed for this exchange');
    return;
  }
  const allowedPathMethods = spec.pathMethods?.[upstreamPath];
  if (spec.pathMethods && (!allowedPathMethods || !allowedPathMethods.includes(method))) {
    fail(res, 'bad_path', 400, 'Upstream method is not allowed for this exchange path');
    return;
  }

  // Host comes from the server-side map only — the client can never steer it.
  const url = `https://${spec.host}${upstreamPath}${rawQuery ? `?${rawQuery}` : ''}`;

  // De-prefix allowlisted exchange headers; content-type passes as-is.
  // Everything else (cookies, origin, user-agent, …) can never leak upstream.
  const headers: Record<string, string> = {};
  if (req.headers['content-type']) {
    headers['content-type'] = String(req.headers['content-type']);
  }
  for (const name of spec.headers) {
    const value = req.headers[`x-exchange-${name}`];
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value) && value.length > 0) headers[name] = value[0];
  }

  // Copy into a standalone Buffer<ArrayBuffer> — undici's BodyInit typing
  // rejects Buffer<ArrayBufferLike> (and the copy detaches from the parser's
  // shared pool). Byte content is unchanged.
  let body: Buffer<ArrayBuffer> | undefined;
  if (method !== 'GET' && method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    body = Buffer.from(req.body);
  }

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // Never follow redirects — a 3xx could bounce the signed request to a
      // host outside the allowlist.
      redirect: 'manual'
    });
  } catch (err) {
    // Log hygiene: NEVER log bodies, the upstream path, or the query (it
    // carries signatures) — and no err.message: undici messages can embed the
    // full signed URL.
    const name = err instanceof Error ? err.name : 'Error';
    console.error(`[exchange-tunnel] upstream request failed [${method} ${exchangeId}]: ${name}`);
    if (name === 'TimeoutError' || name === 'AbortError') {
      fail(res, 'upstream_timeout', 504, 'Upstream request timed out');
    } else {
      fail(res, 'upstream_failed', 502, 'Upstream request failed');
    }
    return;
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.error(`[exchange-tunnel] upstream request failed [${method} ${exchangeId}]: ${name}`);
    fail(res, 'upstream_failed', 502, 'Upstream request failed');
    return;
  }

  console.log(`[exchange-tunnel] upstream ${upstream.status} [${method} ${exchangeId}]`);

  if (buffer.byteLength > MAX_UPSTREAM_BODY_BYTES) {
    fail(res, 'upstream_failed', 502, 'Upstream response too large');
    return;
  }
  // 'manual' redirects surface as opaque status-0 responses; nothing pipeable.
  if (!Number.isInteger(upstream.status) || upstream.status < 100 || upstream.status > 599) {
    fail(res, 'upstream_failed', 502, 'Upstream request failed');
    return;
  }

  // Pipe the exchange response verbatim (ccxt must see native codes/bodies).
  // Forward only content-type + retry-after and BTC Markets' two pagination
  // cursors; content-encoding (undici already
  // decompressed), content-length, transfer-encoding, connection and set-cookie
  // are stripped simply by never being re-set. NEVER res.json here.
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('retry-after', retryAfter);
  if (exchangeId === 'btcmarkets') {
    for (const name of ['bm-before', 'bm-after']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
  }
  res.send(buffer);
}

exchangeTunnelRouter.all('*', (req, res) => {
  void exchangeTunnelHandler(req, res);
});

/**
 * Error middleware for the mount chain (after the router — see index.ts).
 * express.raw body-limit failures bypass the router entirely (Express's
 * default handler would render an HTML error page), so convert them here to
 * JSON + x-sololedger-error: payload_too_large. Anything else passes through.
 */
export function tunnelBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const e = err as { type?: string; status?: number; statusCode?: number } | null | undefined;
  if (e && (e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413)) {
    res.locals.tunnelErrorKind = 'payload_too_large' satisfies TunnelErrorKind;
    res.setHeader('x-sololedger-error', 'payload_too_large');
    res.status(413).json({ error: 'Request body too large' });
    return;
  }
  next(err);
}
