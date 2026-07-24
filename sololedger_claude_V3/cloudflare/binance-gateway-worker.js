/**
 * SoloLedger Binance gateway (Cloudflare Worker).
 *
 * Why this exists: api.binance.com answers HTTP 451 to US egress, and the
 * SoloLedger relay is pinned to a US region. Workers execute at the edge PoP
 * closest to the CALLER, so a browser in a Binance-friendly country (e.g.
 * India) gets friendly egress. This worker is a byte-verbatim pipe to
 * api.binance.com — it never sees the API secret (the browser signs HMAC
 * locally) and only ever forwards the API KEY header.
 *
 * Abuse protection: callers must present a short-lived gateway ticket minted
 * by the SoloLedger relay (which enforces JWT + active subscription):
 *   x-gateway-exp:   unix seconds (minted <= 10 min ahead)
 *   x-gateway-token: base64url(HMAC_SHA256(GATEWAY_SECRET, String(exp)))
 *
 * Exchange headers arrive with the same `x-exchange-` prefix convention the
 * relay tunnel uses; the worker maps them onto the real Binance headers:
 *   x-exchange-x-mbx-apikey  -> x-mbx-apikey
 *   x-exchange-content-type  -> content-type
 */

const BINANCE_HOST = 'https://api.binance.com';
const MAX_FUTURE_SKEW_S = 660; // ticket must not be minted >11min in the future
const PAST_LEEWAY_S = 30; // clock-skew grace just past expiry

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, content-type, x-gateway-exp, x-gateway-token, x-exchange-x-mbx-apikey, x-exchange-content-type',
  'Access-Control-Max-Age': '86400'
};

function cors(extra = {}) {
  return { ...CORS_HEADERS, ...extra };
}

function base64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gatewayTokenValid(request, secret) {
  const expRaw = request.headers.get('x-gateway-exp');
  const token = request.headers.get('x-gateway-token');
  if (!expRaw || !token || !secret) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (exp < now - PAST_LEEWAY_S || exp > now + MAX_FUTURE_SKEW_S) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp)));
  const expected = base64url(sig);
  if (expected.length !== token.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (!(await gatewayTokenValid(request, env.GATEWAY_SECRET))) {
      return Response.json({ error: 'invalid_gateway_ticket' }, { status: 401, headers: cors() });
    }

    // Byte-verbatim forward: method, path+query, body; mapped headers only.
    const upstream = `${BINANCE_HOST}${url.pathname}${url.search}`;
    const headers = new Headers();
    const apiKey = request.headers.get('x-exchange-x-mbx-apikey');
    if (apiKey) headers.set('x-mbx-apikey', apiKey);
    const ctype = request.headers.get('x-exchange-content-type');
    if (ctype) headers.set('content-type', ctype);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await request.arrayBuffer() : undefined;

    let res;
    try {
      res = await fetch(upstream, { method: request.method, headers, body, redirect: 'manual' });
    } catch (e) {
      return Response.json({ error: 'upstream_failed' }, { status: 502, headers: cors() });
    }

    const respBody = await res.arrayBuffer();
    const out = new Headers(cors());
    const upCtype = res.headers.get('content-type');
    if (upCtype) out.set('content-type', upCtype);
    return new Response(respBody, { status: res.status, headers: out });
  }
};
