import { Router, type Response } from 'express';
import { createHmac } from 'node:crypto';
import { authMiddleware, type AuthedRequest } from '../auth.js';
import { getServerConfig } from '../store.js';
import { requireActiveSubscription } from './proxy.js';
import type { TunnelErrorKind } from './exchangeTunnel.js';

/**
 * Binance gateway ticket endpoint.
 *
 * api.binance.com answers HTTP 451 to US egress and the relay is pinned to a
 * US region, so Binance traffic cannot flow through the exchange tunnel.
 * The Binance gateway (a Cloudflare Worker) executes at the edge PoP closest
 * to the CALLER — a browser in a Binance-friendly country gets friendly
 * egress — but then the relay cannot be in the request path. To keep the
 * gateway from being an open proxy, it requires a short-lived ticket, and
 * THIS endpoint is where the JWT + active-subscription + feature-flag gates
 * live: the client fetches a ticket here (cached ~8 min), then calls the
 * worker directly with it. The worker recomputes the HMAC with the shared
 * secret and only then byte-forwards to api.binance.com.
 *
 * Ticket contract (shared with the worker — pinned by test vector):
 *   exp   = unix seconds, minted <= 11 min ahead, valid until exp (+30s leeway)
 *   token = base64url(HMAC_SHA256(BINANCE_GATEWAY_SECRET, String(exp)))
 *
 * Error contract: identical to the exchange tunnel — every relay-origin
 * error is stamped `x-sololedger-error: <kind>` so the client can apply the
 * same header-first classification it already uses for tunnel errors.
 */

const TICKET_TTL_S = 600;

export interface BinanceGatewayConfig {
  url: string;
  secret: string;
}

/** Gateway env config — null unless BOTH vars are set (url alone is useless). */
export function getBinanceGatewayConfig(): BinanceGatewayConfig | null {
  const url = process.env.BINANCE_GATEWAY_URL;
  const secret = process.env.BINANCE_GATEWAY_SECRET;
  if (!url || !secret) return null;
  return { url: url.replace(/\/+$/, ''), secret };
}

/** Shared-contract minting — keep byte-identical to the worker's validator. */
export function mintGatewayTicket(secret: string, exp: number): string {
  return createHmac('sha256', secret).update(String(exp)).digest('base64url');
}

export const exchangeGatewayRouter = Router();

// Same x-sololedger-error stamping as the tunnel (see exchangeTunnel.ts).
exchangeGatewayRouter.use((_req, res, next) => {
  const orig = res.json.bind(res);
  res.json = ((body: unknown) => {
    const kind = res.locals.tunnelErrorKind as TunnelErrorKind | undefined;
    if (kind) res.setHeader('x-sololedger-error', kind);
    return orig(body);
  }) as Response['json'];
  next();
});

exchangeGatewayRouter.use((req, res, next) => {
  res.locals.tunnelErrorKind = 'auth' satisfies TunnelErrorKind;
  authMiddleware(req as AuthedRequest, res, next);
});

exchangeGatewayRouter.use((req, res, next) => {
  res.locals.tunnelErrorKind = 'subscription' satisfies TunnelErrorKind;
  if (!requireActiveSubscription(req as AuthedRequest, res)) return;
  next();
});

exchangeGatewayRouter.use((_req, res, next) => {
  if (!getServerConfig().exchangeSyncEnabled) {
    res.locals.tunnelErrorKind = 'disabled' satisfies TunnelErrorKind;
    res.status(403).json({ error: 'Exchange sync is disabled by admin' });
    return;
  }
  next();
});

exchangeGatewayRouter.get('/binance/ticket', (_req, res) => {
  // Past the gates: success and gateway_not_configured responses are NOT
  // stamped (the kind set by the auth/subscription middleware is only for
  // their own failures).
  res.locals.tunnelErrorKind = undefined;
  const gateway = getBinanceGatewayConfig();
  if (!gateway) {
    // Not stamped: the client only calls this when the public config told it
    // a gateway exists, so reaching here means a deploy/config skew — surface
    // as relay_unavailable, not an exchange error.
    res.status(503).json({ error: 'gateway_not_configured' });
    return;
  }
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_S;
  res.json({ url: gateway.url, exp, token: mintGatewayTicket(gateway.secret, exp) });
});
