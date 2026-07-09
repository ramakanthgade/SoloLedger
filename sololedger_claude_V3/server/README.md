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
| Trial | Free (14 days) | 25 |
| Starter | $50/yr | 100 |
| Standard | $100/yr | 500 |
| Pro | $500/yr | 1,000 |

Wire Stripe price IDs in `.env` for live checkout, or use `POST /api/billing/activate-dev` in development.

## Deploy API

Deploy `server/` to Railway, Render, Fly.io, or any Node host. Set all env vars from `.env.example`. Point `VITE_API_URL` at your API URL when building the frontend.

## Privacy model

- **Local:** CSV, calculations, reports — 100% in browser IndexedDB
- **Server:** login, subscription status, proxied price/RPC/AI calls (no transaction storage)
