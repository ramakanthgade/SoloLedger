import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ensureAdminUser } from './auth.js';
import { getDataDirectory } from './store.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { configRouter } from './routes/config.js';
import { proxyRouter } from './routes/proxy.js';
import { exchangeTunnelRouter, tunnelBodyErrorHandler } from './routes/exchangeTunnel.js';
import { exchangeGatewayRouter } from './routes/exchangeGateway.js';
import { billingRouter, handleStripeWebhook } from './routes/billing.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

/** Browsers send Origin without a path (e.g. https://user.github.io, not …/SoloLedger). */
function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    if (trimmed.includes('://')) return new URL(trimmed).origin;
  } catch {
    // fall through — treat as host[:port] below
  }
  return trimmed.replace(/\/.*$/, '');
}

const allowedOrigins = [
  ...LOCAL_DEV_ORIGINS,
  ...(process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalized)) return true;
  if (LOCAL_DEV_ORIGINS.some((o) => normalized.startsWith(o.replace(/:\d+$/, '')))) return true;
  return false;
}

app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) {
        cb(null, origin ?? allowedOrigins[0]);
        return;
      }
      cb(new Error(`CORS blocked origin: ${origin ?? 'unknown'}`));
    },
    credentials: true,
    // Browsers can't read non-exposed headers — the exchange tunnel stamps
    // relay-origin errors with this header and the client branches on it.
    exposedHeaders: ['x-sololedger-error']
  })
);

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// Exchange auto-sync tunnel: mounted BEFORE express.json (like the Stripe
// webhook) so signed bodies/queries reach the exchange byte-verbatim.
// type: () => true captures bodies regardless of content-type; GET/HEAD
// without a body pass through untouched.
app.use(
  '/api/proxy/exchange',
  express.raw({ type: () => true, limit: '1mb' }),
  exchangeTunnelRouter,
  tunnelBodyErrorHandler
);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sololedger-api' });
});

/** Root path — Railway / uptime checks sometimes hit `/` instead of `/health`. */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'sololedger-api',
    health: '/health'
  });
});

/**
 * Public Solana JSON-RPC proxy (no auth).
 * Used by automatic Portfolio ledger repair on localhost so reconcile works without
 * SaaS login / Alchemy keys. Only allowlisted read methods.
 */
const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const SOLANA_ALLOWED_METHODS = new Set([
  'getTransaction',
  'getSignaturesForAddress',
  'getBalance',
  'getTokenAccountsByOwner'
]);

app.post('/api/public/solana-rpc', async (req, res) => {
  try {
    const method = String(req.body?.method ?? '');
    if (!SOLANA_ALLOWED_METHODS.has(method)) {
      res.status(400).json({ error: `Method not allowed: ${method || '(missing)'}` });
      return;
    }
    const upstream = await fetch(SOLANA_PUBLIC_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: req.body?.id ?? 1,
        method,
        params: req.body?.params ?? []
      })
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    // Log the real detail server-side only; never leak upstream URLs/messages to clients.
    console.error('[solana-rpc] upstream request failed:', err);
    res.status(502).json({ error: 'Upstream request failed' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/config', configRouter);
// Binance gateway tickets (JWT + subscription gated minting for the
// geo-friendly Cloudflare Worker; see routes/exchangeGateway.ts).
app.use('/api/exchange-gateway', exchangeGatewayRouter);
app.use('/api/admin', adminRouter);
app.use('/api/proxy', proxyRouter);
app.use('/api/billing', billingRouter);

void ensureAdminUser()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`SoloLedger API listening on 0.0.0.0:${port}`);
      console.log(`CORS origins: ${allowedOrigins.join(', ')}`);
      console.log('Health check: /health');
      console.log(`Data directory: ${getDataDirectory()}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start SoloLedger API:', err);
    process.exit(1);
  });
