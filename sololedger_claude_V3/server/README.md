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

`ALL /api/proxy/exchange/<exchangeId>/<upstream-path>?<raw-query>` (binance, coinbase, kraken, okx, kucoin — spot only).

For exchange auto-sync, ccxt runs **in the subscriber's browser** and signs each request locally — the exchange API secret never leaves the user's device. This route receives the fully-signed request and replays it **byte-verbatim** to the exchange:

- Mounted before `express.json()` with `express.raw()` (like the Stripe webhook); the upstream URL is taken from the raw `req.url` so `%2B`/`%2F` in signatures are never corrupted by decoding.
- **Stateless:** nothing is stored; request/response bodies are never logged (only `[exchange-tunnel] upstream <status> [<METHOD> <exchangeId>]`).
- Upstream host comes from a server-side map (the client can never steer it); only allowlisted `x-exchange-*` headers are forwarded — cookies/origin/user-agent never leak upstream.
- Exchange responses are piped back verbatim (status + raw body; only `content-type`/`retry-after` forwarded). Relay-origin errors are JSON stamped `x-sololedger-error: auth | subscription | disabled | unknown_exchange | bad_path | payload_too_large | upstream_timeout | upstream_failed` — the client distinguishes relay errors from native exchange errors by that header alone.
- Gated by JWT + active subscription + the `exchangeSyncEnabled` admin flag (`EXCHANGE_SYNC_ENABLED`, default on; admin `PUT /api/admin/config`).

### Binance gateway (geo unblock)

`api.binance.com` answers HTTP 451 to US egress and the relay is region-pinned, so Binance traffic is routed through a Cloudflare Worker (`cloudflare/binance-gateway-worker.js`, deployed outside this repo's CI) that executes at the edge PoP closest to the caller — a browser in a Binance-friendly country gets friendly egress. The worker is not an open proxy: it requires a short-lived HMAC ticket minted by `GET /api/exchange-gateway/binance/ticket` (same JWT + subscription + flag gates as the tunnel, same `x-sololedger-error` stamping). Ticket = `base64url(HMAC_SHA256($BINANCE_GATEWAY_SECRET, String(exp)))`, 10-minute TTL; the client caches it and calls the worker directly with the usual `x-exchange-` prefixed headers. Env: `BINANCE_GATEWAY_URL` + `BINANCE_GATEWAY_SECRET` (both or neither; unset = relay-tunnel fallback). Rotation: regenerate the secret, update the worker binding and this env together.

**Live verification (post-deploy):**

```bash
# against production (default) or RELAY=https://your-relay
SL_EMAIL=you@example.com SL_PASSWORD=secret node scripts/live-verify-exchange-tunnel.mjs
# or reuse an existing token:
SL_TOKEN=<jwt> node scripts/live-verify-exchange-tunnel.mjs
```

Probes all five exchanges through the tunnel — tier 2: public endpoints (no exchange auth, HTTP 200 + shape); tier 3: dummy-key signed requests asserting each exchange's distinctive auth error (Binance `-2015`, Kraken `EAPI:Invalid key`, Coinbase 401, OKX `50111`, KuCoin `400003`), proving signed requests survive the relay byte-intact. Exits non-zero on any failure.
