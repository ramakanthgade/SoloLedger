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
