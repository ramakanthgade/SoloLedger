# SoloLedger API (SaaS backend)

Express server that holds **your** API keys and proxies authenticated subscriber requests. Transaction data never touches this server — only auth, billing, and third-party API calls.

## Quick start

```bash
cd server
cp .env.example .env
# Edit .env — set ADMIN_EMAIL, ADMIN_PASSWORD, and your API keys
npm install
npm run dev
```

API runs at `http://localhost:3001`.

## Frontend (SaaS mode)

```bash
cd ..
VITE_SAAS_MODE=true VITE_API_URL=http://localhost:3001 npm run dev
```

Subscribers see **Tax defaults** + **Your data** only. Admin sees an extra **Admin** tab.

## Subscription tiers

| Plan | Price | Transaction limit |
|------|-------|-------------------|
| Starter | Free | 100 |
| Standard | $100/yr | 1,000 |
| Pro | $200/yr | 3,000 |
| Investor | $500/yr | 30,000 |
| Enterprise | $3,000/yr | Unlimited |

Wire Stripe price IDs in `.env` for live checkout, or use `POST /api/billing/activate-dev` in development.

## Deploy API

Deploy **`server/`** to Railway (or Render / Fly.io). Set env vars from `.env.example`. Point `VITE_API_URL` at your API URL when building the frontend.

### Railway (required settings)

| Setting | Value |
|--------|--------|
| **Root Directory** | `sololedger_claude_V3/server` (no leading slash) |
| **Branch** | The branch that contains `server/` (e.g. `cursor/saas-architecture-7be7` until merged to `main`) |
| **Health check path** | `/health` |
| **Start** | `npm start` (from `railway.toml`) |

**Why you get crash emails on frontend pushes:** if Railway’s Root Directory is the repo root or `sololedger_claude_V3` (the Vite app), every GitHub Pages / frontend deploy tries to start a Node API from the wrong folder and fails → Railway emails you. Fix the Root Directory to `sololedger_claude_V3/server` only.

**Persistence:** attach a Volume mounted at `/data` and set `DATA_DIR=/data`. Without this, user accounts in `store.json` are lost on every redeploy.

Smoke test after deploy: open `https://YOUR-APP.up.railway.app/health` — should return `{"ok":true,...}`.

## Privacy model

- **Local:** CSV, calculations, reports — 100% in browser IndexedDB
- **Server:** login, subscription status, proxied price/RPC/AI calls (no transaction storage)
- **Exchange tunnel:** byte-pipe only — no storage, no body logging (see below)

## Exchange auto-sync tunnel

`ALL /api/proxy/exchange/<exchangeId>/<upstream-path>?<raw-query>` (supported exchange connectors, including Bitfinex, Gemini, BTC Markets and Bitvavo — spot/read-only paths only).

Bitrue, XT.COM, CoinSpot, Phemex and LBank are likewise restricted to the exact
read-only spot hosts, methods, paths and signing headers emitted by pinned CCXT
4.5.68. Futures, margin, order mutation and withdrawal mutation routes are not
exposed. CoinSpot is Australia-only, Bitrue/XT.COM/Phemex carry high geo-block
risk, and LBank region and lifetime-retention coverage remain unverified.

Round five adds exact host/header/path allowlists for Binance.US, Backpack,
WhiteBIT, bitFlyer and Coincheck. They are GET-only except WhiteBIT's signed
POST balance, executed-spot-history and deposit/withdrawal-history reads. No
order, transfer or withdrawal mutation path is reachable. The live verifier
includes tier-2 public shape and tier-3 dummy-auth probes; no real keys are
required.

Backpack fills must carry exactly one `marketType=SPOT` scope (the pinned
client emits the scalar form; the relay also recognizes its array-key form
without reserializing signed bytes). bitFlyer executions require one explicitly
allowlisted active spot `product_code`; derivative and absent codes fail closed.
Coincheck exposes GET `/api/send_money` for cryptocurrency sending history and
does not expose `/api/withdraws`, which is JPY bank-withdrawal history.

For exchange auto-sync, ccxt runs **in the subscriber's browser** and signs each request locally — the exchange API secret never leaves the user's device. This route receives the fully-signed request and replays it **byte-verbatim** to the exchange:

- Mounted before `express.json()` with `express.raw()` (like the Stripe webhook); the upstream URL is taken from the raw `req.url` so `%2B`/`%2F` in signatures are never corrupted by decoding.
- **Stateless:** nothing is stored; request/response bodies are never logged (only `[exchange-tunnel] upstream <status> [<METHOD> <exchangeId>]`).
- Upstream host comes from a server-side map (the client can never steer it); only allowlisted `x-exchange-*` headers are forwarded — cookies/origin/user-agent never leak upstream.
- Exchange responses are piped back verbatim (status + raw body; only `content-type`/`retry-after` forwarded). Relay-origin errors are JSON stamped `x-sololedger-error: auth | subscription | disabled | unknown_exchange | bad_path | payload_too_large | upstream_timeout | upstream_failed` — the client distinguishes relay errors from native exchange errors by that header alone.
- Gated by JWT + active subscription + the `exchangeSyncEnabled` admin flag (`EXCHANGE_SYNC_ENABLED`, default on; admin `PUT /api/admin/config`).
- Gemini is pinned to `api.gemini.com`: only `GET /v1/symbols` and `POST /v1/balances`, `/v1/mytrades`, `/v1/transfers` are accepted, forwarding only `x-gemini-apikey`, `x-gemini-payload`, and `x-gemini-signature`.
- BTC Markets is pinned to `api.btcmarkets.net`: only `GET /v3/time`, `/v3/markets`, `/v3/accounts/me/balances`, `/v3/trades`, and `/v3/transfers` are accepted. Only `bm-auth-apikey`, `bm-auth-timestamp`, and `bm-auth-signature` are forwarded; `bm-before`/`bm-after` response cursors are forwarded and CORS-exposed only on the BTC Markets tunnel.
- MEXC is pinned to `api.mexc.com` and GET-only: `/api/v3/time`, `/api/v3/exchangeInfo`, `/api/v3/symbol/offline`, `/api/v3/account`, `/api/v3/myTrades`, `/api/v3/capital/deposit/hisrec`, and `/api/v3/capital/withdraw/history`. Only `x-mexc-apikey` and CCXT's `source` header are forwarded. Orders, withdrawal mutations, internal transfers, margin, broker, futures/contract, and `config/getall` routes are not exposed.
- Bitvavo is pinned to `api.bitvavo.com` and GET-only: `/v2/time`, `/v2/markets`, `/v2/balance`, `/v2/account/history`, `/v2/trades`, `/v2/depositHistory`, and `/v2/withdrawalHistory`. The four `bitvavo-access-key`, `bitvavo-access-signature`, `bitvavo-access-timestamp`, and `bitvavo-access-window` headers are the only forwarded exchange headers. Order, cancel, asset, withdrawal mutation, RFQ and futures paths are unreachable.

### Binance gateway (geo unblock)

`api.binance.com` answers HTTP 451 to US egress and the relay is region-pinned, so Binance traffic is routed through a Cloudflare Worker (`cloudflare/binance-gateway-worker.js`, deployed outside this repo's CI) that executes at the edge PoP closest to the caller — a browser in a Binance-friendly country gets friendly egress. The worker is not an open proxy: it requires a short-lived HMAC ticket minted by `GET /api/exchange-gateway/binance/ticket` (same JWT + subscription + flag gates as the tunnel, same `x-sololedger-error` stamping). Ticket = `base64url(HMAC_SHA256($BINANCE_GATEWAY_SECRET, String(exp)))`, 10-minute TTL; the client caches it and calls the worker directly with the usual `x-exchange-` prefixed headers. Env: `BINANCE_GATEWAY_URL` + `BINANCE_GATEWAY_SECRET` (both or neither; unset = relay-tunnel fallback). Rotation: regenerate the secret, update the worker binding and this env together.

**Live verification (post-deploy):**

```bash
# against production (default) or RELAY=https://your-relay
SL_EMAIL=you@example.com SL_PASSWORD=secret node scripts/live-verify-exchange-tunnel.mjs
# or reuse an existing token:
SL_TOKEN=<jwt> node scripts/live-verify-exchange-tunnel.mjs
```

Probes every supported connector through the tunnel — tier 2 checks public endpoint reachability and response shape; tier 3 sends browser-shaped dummy-key auth requests and accepts exchange-origin auth-shaped rejections. Several predicates are deliberately broad and prove authenticated-endpoint reachability only, not a distinctive exact response, valid signing, permissions, or history access. Gemini has the same limitation. MEXC's expected HTTP 400/code `10072` probe proves only its exact relay route/auth boundary because MEXC may reject an unknown key before validating the signature. Bitvavo's format-valid 64-character dummy signed balance request is expected to return exact HTTP 403 / errorCode 305; unknown-key validation precedes real-secret validation, so it proves only route/header reachability. Byte-exact signed header/body forwarding is covered by `src/routes/exchangeTunnel.test.ts`. Exits non-zero on any failure.

### Five GET-only spot connectors

CoinEx, Poloniex, WOO X, HitBTC and BingX are constrained to exact GET-only
spot market, balance, fill and wallet-history paths in `exchangeTunnel.ts`.
Mutation, margin, futures and swap routes are intentionally absent.
