/**
 * Exchange Auto-Sync — Binance gateway tickets.
 *
 * api.binance.com answers HTTP 451 to the relay's US egress, so Binance
 * traffic detours through a Cloudflare Worker that executes at the edge PoP
 * closest to the caller. To keep the worker from being an open proxy it
 * requires a short-lived ticket: `x-gateway-exp` + `x-gateway-token` where
 * token = base64url(HMAC_SHA256(sharedSecret, String(exp))). Only the relay
 * holds the secret — this module mints tickets via
 * GET /api/exchange-gateway/binance/ticket (same JWT + subscription + flag
 * gates as the tunnel) and caches them until just before expiry.
 *
 * NO silent fallback: when the gateway is configured but minting fails, the
 * stamped kind (relay_auth / relay_subscription / relay_disabled) or
 * relay_unavailable is thrown — falling back to the relay tunnel would just
 * misreport Binance's 451 as region-blocked.
 */
import { apiFetch, getAuthToken } from '@/lib/saas/api';
import { TunnelError, tunnelKindFromHeader } from './tunnel';

export interface BinanceGatewayTicket {
  /** Worker base URL (echoed by the relay; same value as public config). */
  url: string;
  /** Ticket expiry — unix seconds. */
  exp: number;
  /** base64url HMAC ticket. */
  token: string;
}

/** Re-mint this many seconds before `exp` (worker allows exp ≤ now + 11 min). */
const REFRESH_MARGIN_S = 60;

let cachedTicket: BinanceGatewayTicket | null = null;

/** Test hook — drop the cached ticket so each test mints fresh. */
export function __clearBinanceGatewayTicketCache(): void {
  cachedTicket = null;
}

/**
 * A valid gateway ticket, minting via the relay when the cache is empty or
 * within REFRESH_MARGIN_S of expiry. Throws TunnelError — never falls back.
 */
export async function getBinanceGatewayTicket(): Promise<BinanceGatewayTicket> {
  const nowS = Math.floor(Date.now() / 1000);
  if (cachedTicket && cachedTicket.exp - REFRESH_MARGIN_S > nowS) return cachedTicket;

  // Same session-expiry rule as the tunnel: prompt sign-in, not the explainer.
  if (!getAuthToken()) {
    throw new TunnelError('relay_auth', 'Your session has expired — please sign in again.');
  }

  let res: Response;
  try {
    res = await apiFetch('/api/exchange-gateway/binance/ticket');
  } catch (err) {
    // Relay itself unreachable (apiFetch converts network failures).
    throw new TunnelError(
      'relay_unavailable',
      err instanceof Error ? err.message : 'Could not reach the SoloLedger relay.'
    );
  }

  // Relay-origin gate failures are stamped (auth/subscription/disabled) —
  // surface that exact kind so the UI shows the right remedy.
  const stamped = res.headers.get('x-sololedger-error');
  if (stamped) throw new TunnelError(tunnelKindFromHeader(stamped));
  if (!res.ok) {
    throw new TunnelError('relay_unavailable', `Gateway ticket mint failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as Partial<BinanceGatewayTicket>;
  if (typeof data.url !== 'string' || typeof data.exp !== 'number' || typeof data.token !== 'string') {
    throw new TunnelError('relay_unavailable', 'Malformed gateway ticket from the relay.');
  }
  cachedTicket = { url: data.url, exp: data.exp, token: data.token };
  return cachedTicket;
}
