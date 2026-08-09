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
 *   3 — auth-path probes with DUMMY keys: computes browser-shaped HMACs and
 *       asserts each exchange's distinctive auth response. What this proves
 *       is exchange-dependent because some exchanges reject unknown keys
 *       before validating signatures. In particular, Bitfinex 10100
 *       "digest invalid" proves bfx auth-header/key reachability only; it does
 *       NOT prove signature or body-byte integrity. Byte-exact relay
 *       integration tests cover Bitfinex signed-body forwarding.
 *
 * Every probe also asserts the response carries NO x-sololedger-error header
 * (exchange-piped responses must stay unstamped — header-first v1.1 design).
 *
 * Exits non-zero if any probe fails.
 */

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

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

export function isBitgetPublicTimeResponse(response, json) {
  return response.status === 200 && json?.code === '00000' &&
    typeof json?.data?.serverTime === 'string' && /^\d+$/.test(json.data.serverTime);
}

export function isBitgetInvalidAccessKeyResponse(response) {
  if (response.status !== 400) return false;
  try {
    const json = JSON.parse(response.text);
    return (json?.code === '40006' && json?.msg === 'Invalid ACCESS_KEY') ||
      (json?.code === '40037' && json?.msg === 'Apikey does not exist');
  } catch {
    return false;
  }
}
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
  },
  {
    exchange: 'bybit',
    probe: 'GET /v5/market/time',
    path: '/v5/market/time',
    check: (r, json) => r.status === 200 && json?.retCode === 0 && Boolean(json?.result?.timeSecond)
  },
  {
    exchange: 'gateio',
    probe: 'GET /api/v4/spot/time',
    path: '/api/v4/spot/time',
    check: (r, json) => r.status === 200 && typeof json?.server_time === 'number'
  },
  {
    exchange: 'htx',
    probe: 'GET /v1/common/timestamp',
    path: '/v1/common/timestamp',
    check: (r, json) => r.status === 200 && json?.status === 'ok' && typeof json?.data === 'number'
  },
  {
    exchange: 'cryptocom',
    probe: 'GET /exchange/v1/public/get-instruments',
    path: '/exchange/v1/public/get-instruments',
    check: (r, json) => r.status === 200 && json?.code === 0 && Array.isArray(json?.result?.data)
  },
  {
    exchange: 'bitfinex',
    probe: 'GET /v2/platform/status',
    path: '/v2/platform/status',
    check: (r, json) => r.status === 200 && Array.isArray(json) && (json[0] === 0 || json[0] === 1)
  },
  {
    exchange: 'gemini',
    probe: 'GET /v1/symbols',
    path: '/v1/symbols',
    check: (r, json) => r.status === 200 && Array.isArray(json) && json.every((symbol) => typeof symbol === 'string')
  },
  {
    exchange: 'btcmarkets',
    probe: 'GET /v3/time',
    path: '/v3/time',
    check: (r, json) => r.status === 200 && typeof json?.timestamp === 'string' && Number.isFinite(Date.parse(json.timestamp))
  },
  {
    exchange: 'mexc',
    probe: 'GET /api/v3/time',
    path: '/api/v3/time',
    check: (r, json) => r.status === 200 && typeof json?.serverTime === 'number'
  },
  {
    exchange: 'bitvavo',
    probe: 'GET /v2/time',
    path: '/v2/time',
    check: (r, json) => r.status === 200 && typeof json?.time === 'number'
  },
  {
    exchange: 'bitstamp',
    probe: 'GET /api/v2/markets/',
    path: '/api/v2/markets/',
    check: (r, json) => r.status === 200 && Array.isArray(json) &&
      json.some((market) => market?.market_type === 'SPOT')
  },
  {
    exchange: 'bitget',
    probe: 'GET /api/v2/public/time',
    path: '/api/v2/public/time',
    check: isBitgetPublicTimeResponse
  },
  {
    exchange: 'bitmart',
    probe: 'GET /system/time',
    path: '/system/time',
    check: (r, json) => r.status === 200 && json?.code === 1000 && Number.isFinite(Number(json?.data?.server_time))
  },
  {
    exchange: 'coinex', probe: 'GET /v2/time', path: '/v2/time',
    check: (r, json) => r.status === 200 && json?.code === 0 && Number.isFinite(Number(json?.data?.timestamp ?? json?.data))
  },
  {
    exchange: 'poloniex', probe: 'GET /markets', path: '/markets',
    check: (r, json) => r.status === 200 && Array.isArray(json)
  },
  {
    exchange: 'woo', probe: 'GET /v3/systemInfo', path: '/v3/systemInfo',
    check: (r, json) => r.status === 200 && json?.success === true
  },
  {
    exchange: 'hitbtc', probe: 'GET /api/3/public/symbol', path: '/api/3/public/symbol',
    check: (r, json) => r.status === 200 && (Array.isArray(json) || (json && typeof json === 'object'))
  },
  {
    exchange: 'bingx', probe: 'GET /openApi/spot/v1/server/time', path: '/openApi/spot/v1/server/time',
    check: (r, json) => r.status === 200 && json?.code === 0 && Number.isFinite(Number(json?.serverTime ?? json?.data?.serverTime))
  }
];

/* ------------------------------------ tier 3: dummy-key auth-path probes --
 * Each builder returns {path, method, exchangeHeaders, body, contentType}
 * shaped like the browser (ccxt sign()) request, with a dummy key. The checker
 * asserts an exchange-origin auth response. Do not infer more than that
 * response establishes; Bitfinex's 10100 only establishes auth-header/key
 * reachability. Its byte-exact body/header integrity is proved in
 * server/src/routes/exchangeTunnel.test.ts.
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
  },
  {
    exchange: 'bybit',
    probe: 'GET /v5/execution/list?category=spot (X-BAPI-SIGN)',
    build() {
      const apiKey = 'dummy-bybit-key';
      const secret = 'dummy-bybit-secret';
      const timestamp = Date.now().toString();
      const recvWindow = '5000';
      const query = 'category=spot&limit=1';
      const sign = hmacHex('sha256', secret, timestamp + apiKey + recvWindow + query);
      return {
        path: `/v5/execution/list?${query}`,
        exchangeHeaders: {
          'x-bapi-api-key': apiKey,
          'x-bapi-sign': sign,
          'x-bapi-timestamp': timestamp,
          'x-bapi-recv-window': recvWindow
        }
      };
    },
    // Bybit's distinctive unknown-key response (signature errors are 10004).
    check: (r) => r.status === 401 && r.text.includes('"retCode":10003') && /api key/i.test(r.text)
  },
  {
    exchange: 'gateio',
    probe: 'GET /api/v4/spot/accounts (KEY/Timestamp/SIGN)',
    build() {
      const apiKey = 'dummy-gateio-key';
      const secret = 'dummy-gateio-secret';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = '/api/v4/spot/accounts';
      const bodyHash = crypto.createHash('sha512').update('', 'utf8').digest('hex');
      const payload = ['GET', requestPath, '', bodyHash, timestamp].join('\n');
      const sign = hmacHex('sha512', secret, payload);
      return {
        path: requestPath,
        exchangeHeaders: { key: apiKey, timestamp, sign }
      };
    },
    // Gate's exchange-origin unknown-key label. SIGNATURE_ERROR would mean
    // the signed bytes changed, while relay errors carry x-sololedger-error.
    check: (r) => (r.status === 401 || r.status === 400) && r.text.includes('"label":"INVALID_KEY"')
  },
  {
    exchange: 'htx',
    probe: 'GET /v1/account/accounts (query HmacSHA256 signature)',
    build() {
      const apiKey = 'dummy-htx-key';
      const secret = 'dummy-htx-secret';
      const requestPath = '/v1/account/accounts';
      const request = {
        AccessKeyId: apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: new Date().toISOString().slice(0, 19)
      };
      const query = Object.entries(request).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
      const signature = hmacB64('sha256', secret, `GET\napi.huobi.pro\n${requestPath}\n${query}`);
      return { path: `${requestPath}?${query}&Signature=${encodeURIComponent(signature)}` };
    },
    check: (r) => r.text.includes('"err-code":"api-signature-not-valid"')
  },
  {
    exchange: 'cryptocom',
    probe: 'POST /exchange/v1/private/user-balance (JSON HMAC-SHA256)',
    build() {
      const apiKey = 'dummy-cryptocom-key';
      const secret = 'dummy-cryptocom-secret';
      const id = Date.now();
      const nonce = id;
      const method = 'private/user-balance';
      const sig = hmacHex('sha256', secret, method + id + apiKey + '' + nonce);
      const body = JSON.stringify({ id, method, api_key: apiKey, sig, nonce });
      return { path: '/exchange/v1/private/user-balance', method: 'POST', body, contentType: 'application/json' };
    },
    check: (r) => r.status === 401 && r.text.includes('"code":40101') && /Authentication failure/i.test(r.text)
  },
  {
    exchange: 'bitfinex',
    probe: 'POST /v2/auth/r/wallets (bfx auth-header/key reachability)',
    build() {
      const apiKey = 'dummy-bitfinex-key';
      const secret = 'dummy-bitfinex-secret';
      const nonce = Date.now().toString();
      const path = '/v2/auth/r/wallets';
      const body = '{}';
      const signature = hmacHex('sha384', secret, `/api${path}${nonce}${body}`);
      return {
        path,
        method: 'POST',
        body,
        contentType: 'application/json',
        exchangeHeaders: {
          'bfx-nonce': nonce,
          'bfx-apikey': apiKey,
          'bfx-signature': signature
        }
      };
    },
    // Useful exchange-origin evidence that the bfx auth headers and dummy key
    // reached Bitfinex. This response does not validate the signature/body.
    check: (r) => r.text.includes('10100') && /digest invalid/i.test(r.text)
  },
  {
    exchange: 'gemini',
    probe: 'POST /v1/balances (dummy Auditor/account-key HMAC-SHA384 payload)',
    build() {
      const apiKey = `account-${'D'.repeat(32)}`;
      const secret = 'dummy-gemini-secret';
      const path = '/v1/balances';
      const payload = Buffer.from(JSON.stringify({ request: path, nonce: Date.now().toString() }), 'utf8').toString('base64');
      const signature = hmacHex('sha384', secret, payload);
      return {
        path,
        method: 'POST',
        body: '{}',
        contentType: 'text/plain',
        exchangeHeaders: {
          'x-gemini-apikey': apiKey,
          'x-gemini-payload': payload,
          'x-gemini-signature': signature
        }
      };
    },
    // Distinctive exchange-origin evidence only. A dummy key cannot validate
    // real credentials, role permissions, signature correctness or history access.
    check: (r) => r.status === 400 && /"result"\s*:\s*"error"/i.test(r.text) && /InvalidSignature/i.test(r.text)
  },
  {
    exchange: 'btcmarkets',
    probe: 'GET /v3/accounts/me/balances (BM-AUTH HMAC-SHA512)',
    build() {
      const apiKey = 'dummy-btcmarkets-key';
      const secret = Buffer.from('dummy-btcmarkets-secret').toString('base64');
      const timestamp = Date.now().toString();
      const path = '/v3/accounts/me/balances';
      const signature = crypto.createHmac('sha512', Buffer.from(secret, 'base64'))
        .update(`GET${path}${timestamp}`, 'utf8').digest('base64');
      return {
        path,
        exchangeHeaders: {
          'bm-auth-apikey': apiKey,
          'bm-auth-timestamp': timestamp,
          'bm-auth-signature': signature
        }
      };
    },
    check: (r) => r.status === 401 && r.text.includes('"code":"InvalidAPIKey"') && /invalid api key/i.test(r.text)
  },
  {
    exchange: 'mexc',
    probe: 'GET /api/v3/account (X-MEXC-APIKEY + HMAC-SHA256 query)',
    build() {
      const apiKey = 'D'.repeat(32);
      const secret = 'E'.repeat(32);
      const query = `timestamp=${Date.now()}&recvWindow=5000`;
      const signature = hmacHex('sha256', secret, query);
      return {
        path: `/api/v3/account?${query}&signature=${signature}`,
        exchangeHeaders: { 'x-mexc-apikey': apiKey }
      };
    },
    // Distinctive MEXC exchange-origin auth evidence. This validates relay
    // routing/header reachability, not real-key permissions or history scope.
    check: (r) => r.status === 401 && r.text.includes('"code":700002') && /signature[^\n]*not valid/i.test(r.text)
  },
  {
    exchange: 'bitvavo',
    probe: 'GET /v2/balance (four Bitvavo headers, HMAC-SHA256)',
    build() {
      const apiKey = 'A'.repeat(64);
      const secret = 'B'.repeat(64);
      const timestamp = Date.now().toString();
      const path = '/v2/balance';
      const signature = hmacHex('sha256', secret, timestamp + 'GET' + path);
      return {
        path,
        exchangeHeaders: {
          'bitvavo-access-key': apiKey,
          'bitvavo-access-signature': signature,
          'bitvavo-access-timestamp': timestamp,
          'bitvavo-access-window': '10000'
        }
      };
    },
    // Bitvavo validates the format-valid 64-char key before a real secret:
    // HTTP 403 errorCode 305 proves only unknown-key/header reachability.
    check: (r, json) =>
      r.status === 403 &&
      json?.errorCode === 305 &&
      json?.error === 'No active API key found.' &&
      r.relayError === null
  },
  {
    exchange: 'bitstamp',
    probe: 'POST /api/v2/account_balances/ (X-Auth v2 HMAC-SHA256)',
    build() {
      const apiKey = 'D'.repeat(32);
      const secret = 'dummy-bitstamp-secret';
      const method = 'POST';
      const path = '/api/v2/account_balances/';
      const body = 'foo=bar';
      const contentType = 'application/x-www-form-urlencoded';
      const xAuth = `BITSTAMP ${apiKey}`;
      const nonce = crypto.randomUUID();
      const timestamp = Date.now().toString();
      const version = 'v2';
      const hostAndPath = `www.bitstamp.net${path}`;
      const signature = hmacHex(
        'sha256', secret,
        xAuth + method + hostAndPath + contentType + nonce + timestamp + version + body
      );
      return {
        path,
        method,
        body,
        contentType,
        exchangeHeaders: {
          'x-auth': xAuth,
          'x-auth-signature': signature,
          'x-auth-nonce': nonce,
          'x-auth-timestamp': timestamp,
          'x-auth-version': version
        }
      };
    },
    check: (r) => r.status === 403 && r.text.includes('"code":"API0001"') && /API key not found/i.test(r.text)
  },
  {
    exchange: 'bitget',
    probe: 'GET /api/v2/spot/account/assets (ACCESS-SIGN HMAC-SHA256)',
    build() {
      const apiKey = 'dummy-bitget-key';
      const secret = 'dummy-bitget-secret';
      const passphrase = 'dummy-bitget-passphrase';
      const timestamp = Date.now().toString();
      const path = '/api/v2/spot/account/assets';
      const signature = hmacB64('sha256', secret, timestamp + 'GET' + path);
      return {
        path,
        exchangeHeaders: {
          'access-key': apiKey,
          'access-sign': signature,
          'access-timestamp': timestamp,
          'access-passphrase': passphrase
        }
      };
    },
    check: isBitgetInvalidAccessKeyResponse
  },
  {
    exchange: 'bitmart',
    probe: 'POST /spot/v4/query/trades (X-BM-SIGN with API Memo)',
    build() {
      const apiKey = 'dummy-bitmart-key';
      const secret = 'dummy-bitmart-secret';
      const memo = 'dummy-bitmart-memo';
      const timestamp = Date.now().toString();
      const body = JSON.stringify({ limit: 1 });
      const signature = hmacHex('sha256', secret, `${timestamp}#${memo}#${body}`);
      return {
        path: '/spot/v4/query/trades', method: 'POST', body, contentType: 'application/json',
        exchangeHeaders: {
          'x-bm-key': apiKey,
          'x-bm-timestamp': timestamp,
          'x-bm-sign': signature,
          'x-bm-broker-id': 'CCXTxBitmart000'
        }
      };
    },
    // Unknown-key is distinctive and proves the signed POST/auth headers
    // reached BitMart. Fixture transport tests prove exact body preservation.
    check: (r) => r.status === 401 && /"code"\s*:\s*30002/.test(r.text) && /X-BM-KEY not found/i.test(r.text)
  },
  {
    exchange: 'coinex', probe: 'GET /v2/assets/spot/balance (CoinEx v2 HMAC)',
    build() {
      const timestamp = Date.now().toString();
      const path = '/v2/assets/spot/balance';
      return { path, exchangeHeaders: {
        'x-coinex-key': 'dummy-coinex-key', 'x-coinex-timestamp': timestamp,
        'x-coinex-sign': hmacHex('sha256', 'dummy-coinex-secret', `GET${path}${timestamp}`)
      } };
    },
    check: (r) => r.relayError === null && r.status >= 400 && /key|signature|auth/i.test(r.text)
  },
  {
    exchange: 'poloniex', probe: 'GET /accounts/balances (Key/Signature)',
    build() {
      const signTimestamp = Date.now().toString();
      const path = '/accounts/balances';
      const payload = `GET\n${path}\nsignTimestamp=${signTimestamp}`;
      return { path: `${path}?signTimestamp=${signTimestamp}`, exchangeHeaders: {
        key: 'dummy-poloniex-key', signature: hmacB64('sha256', 'dummy-poloniex-secret', payload), signTimestamp
      } };
    },
    check: (r) => r.relayError === null && r.status >= 400 && /key|signature|auth/i.test(r.text)
  },
  {
    exchange: 'woo', probe: 'GET /v3/asset/balances (WOO HMAC)',
    build() {
      const timestamp = Date.now().toString();
      const path = '/v3/asset/balances';
      return { path, exchangeHeaders: {
        'x-api-key': 'dummy-woo-key', 'x-api-timestamp': timestamp,
        'x-api-signature': hmacHex('sha256', 'dummy-woo-secret', timestamp)
      } };
    },
    check: (r) => r.relayError === null && r.status >= 400 && /key|signature|auth|unauthorized/i.test(r.text)
  },
  {
    exchange: 'hitbtc', probe: 'GET /api/3/spot/balance (HTTP Basic)',
    build() {
      return { path: '/api/3/spot/balance', exchangeHeaders: {
        authorization: `Basic ${Buffer.from('dummy-hitbtc-key:dummy-hitbtc-secret').toString('base64')}`
      } };
    },
    check: (r) => r.relayError === null && r.status === 401 && /auth|credential|unauthorized/i.test(r.text)
  },
  {
    exchange: 'bingx', probe: 'GET /openApi/spot/v1/account/balance (HMAC query)',
    build() {
      const query = `timestamp=${Date.now()}`;
      return {
        path: `/openApi/spot/v1/account/balance?${query}&signature=${hmacHex('sha256', 'dummy-bingx-secret', query)}`,
        exchangeHeaders: { 'x-bx-apikey': 'dummy-bingx-key' }
      };
    },
    check: (r) => r.relayError === null && r.status >= 400 && /key|signature|auth/i.test(r.text)
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
      const json = tryJson(r.text);
      const ok = t.check(r, json) && r.relayError === null;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('live-verify crashed:', err);
    process.exit(1);
  });
}
