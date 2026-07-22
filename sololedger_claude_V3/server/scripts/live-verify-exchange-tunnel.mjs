#!/usr/bin/env node
/**
 * Live verification for the exchange auto-sync tunnel (post-deploy, NOT CI).
 *
 *   node server/scripts/live-verify-exchange-tunnel.mjs
 *
 * Env:
 *   RELAY       relay base URL (default: production)
 *   SL_TOKEN    existing JWT, or
 *   SL_EMAIL + SL_PASSWORD   subscriber credentials to log in with
 *
 * Tiers (validation tiers 2+3 from the exchange auto-sync plan):
 *   2 — public probes (no exchange auth) through the tunnel: HTTP 200 + shape.
 *   3 — signature-integrity probes with DUMMY keys: computes real HMACs
 *       exactly as the browser (ccxt) would and asserts each exchange's
 *       DISTINCTIVE auth error. Proves the signed request crossed the relay
 *       parsed-intact — a byte-mangling relay surfaces as Binance
 *       -1100/-1022 illegal-chars/signature errors instead of -2015.
 *       (Exchanges reject unknown keys before validating signatures, so this
 *       proves parse-integrity + auth round-trip, not key validity.)
 *
 * Every probe also asserts the response carries NO x-sololedger-error header
 * (exchange-piped responses must stay unstamped — header-first v1.1 design).
 *
 * Exits non-zero if any probe fails.
 */

import crypto from 'node:crypto';

const RELAY = (process.env.RELAY ?? 'https://sololedger-production.up.railway.app').replace(
  /\/+$/,
  ''
);

/* ---------------------------------------------------------------- helpers */

const hmacHex = (algo, secret, data) =>
  crypto.createHmac(algo, secret).update(data, 'utf8').digest('hex');
const hmacB64 = (algo, secret, data) =>
  crypto.createHmac(algo, secret).update(data, 'utf8').digest('base64');

const results = [];
function record(tier, exchange, probe, ok, detail) {
  results.push({ tier, exchange, probe, ok, detail });
}

async function getToken() {
  if (process.env.SL_TOKEN) return process.env.SL_TOKEN;
  const { SL_EMAIL, SL_PASSWORD } = process.env;
  if (!SL_EMAIL || !SL_PASSWORD) {
    console.error('Set SL_TOKEN, or SL_EMAIL + SL_PASSWORD.');
    process.exit(2);
  }
  const res = await fetch(`${RELAY}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: SL_EMAIL, password: SL_PASSWORD })
  });
  if (!res.ok) {
    console.error(`Login failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(2);
  }
  const json = await res.json();
  return json.token;
}

/** Call the tunnel: exchange-bound headers get the x-exchange- prefix. */
async function tunnel(token, exchangeId, path, { method = 'GET', exchangeHeaders = {}, body, contentType } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  for (const [name, value] of Object.entries(exchangeHeaders)) {
    headers[`x-exchange-${name.toLowerCase()}`] = value;
  }
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(`${RELAY}/api/proxy/exchange/${exchangeId}${path}`, {
    method,
    headers,
    body
  });
  return {
    status: res.status,
    text: await res.text(),
    relayError: res.headers.get('x-sololedger-error')
  };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------- tier 2: public probes */

const TIER2 = [
  {
    exchange: 'binance',
    probe: 'GET /api/v3/time',
    path: '/api/v3/time',
    check: (r, json) => r.status === 200 && typeof json?.serverTime === 'number'
  },
  {
    exchange: 'coinbase',
    probe: 'GET /api/v3/brokerage/market/products?limit=1',
    path: '/api/v3/brokerage/market/products?limit=1',
    check: (r, json) => r.status === 200 && Array.isArray(json?.products)
  },
  {
    exchange: 'kraken',
    probe: 'GET /0/public/Time',
    path: '/0/public/Time',
    check: (r, json) => r.status === 200 && typeof json?.result?.unixtime === 'number'
  },
  {
    exchange: 'okx',
    probe: 'GET /api/v5/public/time',
    path: '/api/v5/public/time',
    check: (r, json) => r.status === 200 && Boolean(json?.data?.[0]?.ts)
  },
  {
    exchange: 'kucoin',
    probe: 'GET /api/v1/timestamp',
    path: '/api/v1/timestamp',
    check: (r, json) => r.status === 200 && typeof json?.data === 'number'
  }
];

/* ------------------------------ tier 3: dummy-key signature-integrity ----
 * Each builder returns {path, method, exchangeHeaders, body, contentType}
 * signed EXACTLY as the browser (ccxt sign()) would, with a dummy key. The
 * checker asserts the exchange's distinctive auth error — proof the signed
 * request survived the relay byte-intact.
 */

const tier3 = [
  {
    exchange: 'binance',
    probe: 'GET /api/v3/account (HMAC-SHA256 query signature)',
    build() {
      const apiKey = 'D'.repeat(64); // 64-char dummy key
      const secret = 'E'.repeat(64);
      const query = `timestamp=${Date.now()}&recvWindow=5000`;
      const signature = hmacHex('sha256', secret, query);
      return {
        path: `/api/v3/account?${query}&signature=${signature}`,
        exchangeHeaders: { 'x-mbx-apikey': apiKey }
      };
    },
    check: (r) => r.status === 401 && r.text.includes('"code":-2015')
  },
  {
    exchange: 'coinbase',
    probe: 'GET /api/v3/brokerage/accounts (CB-ACCESS-SIGN)',
    build() {
      const apiKey = 'dummy-coinbase-key';
      const secret = 'dummy-coinbase-secret';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = '/api/v3/brokerage/accounts';
      const sign = hmacHex('sha256', secret, timestamp + 'GET' + requestPath);
      return {
        path: requestPath,
        exchangeHeaders: {
          'cb-access-key': apiKey,
          'cb-access-sign': sign,
          'cb-access-timestamp': timestamp
        }
      };
    },
    check: (r) => r.status === 401
  },
  {
    exchange: 'kraken',
    probe: 'POST /0/private/Balance (API-Sign HMAC-SHA512)',
    build() {
      const apiKey = 'dummy-kraken-key';
      const secret = Buffer.from('dummy-kraken-secret-32-byte-pad!!').toString('base64');
      const nonce = Date.now().toString();
      const body = `nonce=${nonce}`;
      const path = '/0/private/Balance';
      const digest = crypto.createHash('sha256').update(nonce + body, 'utf8').digest();
      const sign = crypto
        .createHmac('sha512', Buffer.from(secret, 'base64'))
        .update(Buffer.concat([Buffer.from(path, 'utf8'), digest]))
        .digest('base64');
      return {
        path,
        method: 'POST',
        body,
        contentType: 'application/x-www-form-urlencoded',
        exchangeHeaders: { 'api-key': apiKey, 'api-sign': sign }
      };
    },
    // Kraken often answers auth failures with HTTP 200 — assert the body.
    check: (r) => r.text.includes('EAPI:Invalid key')
  },
  {
    exchange: 'okx',
    probe: 'GET /api/v5/account/balance (OK-ACCESS-SIGN)',
    build() {
      const apiKey = 'dummy-okx-key';
      const secret = 'dummy-okx-secret';
      const passphrase = 'dummy-okx-passphrase';
      const timestamp = new Date().toISOString();
      const requestPath = '/api/v5/account/balance';
      const sign = hmacB64('sha256', secret, timestamp + 'GET' + requestPath);
      return {
        path: requestPath,
        exchangeHeaders: {
          'ok-access-key': apiKey,
          'ok-access-sign': sign,
          'ok-access-timestamp': timestamp,
          'ok-access-passphrase': passphrase
        }
      };
    },
    check: (r) => r.status === 401 && r.text.includes('"code":"50111"')
  },
  {
    exchange: 'kucoin',
    probe: 'GET /api/v1/accounts (KC-API-SIGN, key version 2)',
    build() {
      const apiKey = 'dummy-kucoin-key';
      const secret = 'dummy-kucoin-secret';
      const passphrase = 'dummy-kucoin-passphrase';
      const timestamp = Date.now().toString();
      const endpoint = '/api/v1/accounts';
      const sign = hmacB64('sha256', secret, timestamp + 'GET' + endpoint);
      const encryptedPassphrase = hmacB64('sha256', secret, passphrase);
      return {
        path: endpoint,
        exchangeHeaders: {
          'kc-api-key': apiKey,
          'kc-api-sign': sign,
          'kc-api-timestamp': timestamp,
          'kc-api-passphrase': encryptedPassphrase,
          'kc-api-key-version': '2'
        }
      };
    },
    check: (r) => r.status === 401 && r.text.includes('"code":"400003"')
  }
];

/* ------------------------------------------------------------------- run */

async function main() {
  console.log(`Relay: ${RELAY}`);
  const token = await getToken();

  // Relay-origin sanity: no JWT → 401 stamped x-sololedger-error: auth.
  const unauth = await fetch(`${RELAY}/api/proxy/exchange/binance/api/v3/time`);
  const unauthKind = unauth.headers.get('x-sololedger-error');
  record(
    1,
    '(relay)',
    'no JWT → 401 + x-sololedger-error: auth',
    unauth.status === 401 && unauthKind === 'auth',
    `HTTP ${unauth.status}, header=${unauthKind ?? '(missing)'}`
  );

  for (const t of TIER2) {
    try {
      const r = await tunnel(token, t.exchange, t.path);
      const json = tryJson(r.text);
      const ok = t.check(r, json) && r.relayError === null;
      record(
        2,
        t.exchange,
        t.probe,
        ok,
        `HTTP ${r.status}${r.relayError ? `, relay-error=${r.relayError}` : ''}, body=${r.text.slice(0, 120)}`
      );
    } catch (err) {
      record(2, t.exchange, t.probe, false, `request failed: ${err.message}`);
    }
  }

  for (const t of tier3) {
    try {
      const { path, method, exchangeHeaders, body, contentType } = t.build();
      const r = await tunnel(token, t.exchange, path, { method, exchangeHeaders, body, contentType });
      const ok = t.check(r) && r.relayError === null;
      record(
        3,
        t.exchange,
        t.probe,
        ok,
        `HTTP ${r.status}${r.relayError ? `, relay-error=${r.relayError}` : ''}, body=${r.text.slice(0, 160)}`
      );
    } catch (err) {
      record(3, t.exchange, t.probe, false, `request failed: ${err.message}`);
    }
  }

  console.log('\n tier | exchange  | result | probe');
  console.log(' -----+-----------+--------+---------------------------------------------');
  for (const r of results) {
    console.log(
      `   ${r.tier}  | ${r.exchange.padEnd(9)} | ${r.ok ? 'PASS' : 'FAIL'}   | ${r.probe}\n` +
        `      |           |        |   ${r.detail}`
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} probes passed.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('live-verify crashed:', err);
  process.exit(1);
});
