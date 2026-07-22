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
  }
};

/** RFC-3986 unreserved + sub-delims + ':' '@' '/' '?' '%' — no space, '#', '"', … */
const RAW_URL_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

const UPSTREAM_TIMEOUT_MS = 30_000;
/** Defensive cap on piped upstream bodies (nothing legit comes close). */
const MAX_UPSTREAM_BODY_BYTES = 25 * 1024 * 1024;

export const exchangeTunnelRouter = Router();

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
  // Forward only content-type + retry-after; content-encoding (undici already
  // decompressed), content-length, transfer-encoding, connection and set-cookie
  // are stripped simply by never being re-set. NEVER res.json here.
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('retry-after', retryAfter);
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
