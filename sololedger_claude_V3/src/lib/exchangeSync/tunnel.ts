/**
 * Exchange Auto-Sync — tunnel transport (contract C1, client side).
 *
 * ccxt runs in the browser and signs every request LOCALLY (the exchange
 * secret never leaves the device). This module overrides `exchange.fetch` so
 * the fully-signed request is relayed byte-verbatim through the SoloLedger
 * backend: the signed URL `https://api.binance.com/api/v3/account?…&signature=…`
 * becomes `${apiBase}/api/proxy/exchange/binance/api/v3/account?…&signature=…`
 * by stripping `^https?://[^/]+` with string ops only (no re-encoding — the
 * signature would break).
 *
 * Relay-error rule (v1.1 — HEADER-ONLY): the relay stamps
 * `x-sololedger-error: <kind>` on EVERY relay-origin error; exchange-origin
 * responses (including Coinbase `{error:string,…}` 401/403 bodies and Kraken
 * HTTP-200 `{error:[…]}` bodies) are NEVER stamped and must be fed to ccxt's
 * `handleRestResponse` verbatim so ccxt does its native error mapping.
 */
import { apiFetch, getAuthToken } from '@/lib/saas/api';
import { getBinanceGatewayUrl } from '@/lib/saas/effectiveSettings';
import { recordNetworkActivity } from '@/lib/networkActivity';
import { getBinanceGatewayTicket, __clearBinanceGatewayTicketCache } from './binanceGateway';
import type { SyncErrorKind } from './types';

export const EXCHANGE_TUNNEL_BASE = '/api/proxy/exchange';

/** A relay-origin (tunnel) failure — never an exchange-origin one. */
export class TunnelError extends Error {
  readonly kind: SyncErrorKind;

  constructor(kind: SyncErrorKind, message?: string) {
    super(message ?? `Tunnel error: ${kind}`);
    this.name = 'TunnelError';
    this.kind = kind;
  }
}

/** `x-sololedger-error` header value → SyncErrorKind (C1 kind map). */
export function tunnelKindFromHeader(header: string): SyncErrorKind {
  switch (header) {
    case 'auth':
      return 'relay_auth';
    case 'subscription':
      return 'relay_subscription';
    case 'disabled':
      return 'relay_disabled';
    case 'payload_too_large':
      return 'relay_payload';
    default:
      // unknown_exchange | bad_path | upstream_timeout | upstream_failed | anything unforeseen
      return 'relay_unavailable';
  }
}

/** Minimal shim ccxt's handleRestResponse needs: .status/.statusText/.headers/.text(). */
interface RestResponseShim {
  status: number;
  statusText: string;
  headers: Headers;
  text(): Promise<string>;
}

/** Structural shape of the ccxt exchange instance this module patches. */
export interface TunnelFetchTarget {
  fetch(url: string, method?: string, headers?: Record<string, string>, body?: string): Promise<unknown>;
  handleRestResponse(
    response: RestResponseShim,
    url: string,
    method?: string,
    requestHeaders?: Record<string, string>,
    requestBody?: string
  ): unknown;
}

/**
 * Install the tunnel transport on a ccxt exchange instance. After this, every
 * request ccxt makes (signed locally) is relayed through the SoloLedger
 * backend; exchange responses are handed back to ccxt untouched.
 */
export function installTunnelFetch(exchange: TunnelFetchTarget, exchangeId: string): void {
  exchange.fetch = async (
    url: string,
    method = 'GET',
    headers: Record<string, string> = {},
    body?: string
  ): Promise<unknown> => {
    // Hosted mode is guaranteed by createExchangeClient, but the JWT can
    // expire between syncs — fail with relay_auth (NOT not_hosted) so the UI
    // prompts sign-in rather than the mode explainer.
    if (!getAuthToken()) {
      throw new TunnelError('relay_auth', 'Your session has expired — please sign in again.');
    }

    // Rewrite the fully-signed exchange URL to the relay path: strip the
    // origin only — path + raw query stay byte-verbatim (C1).
    const pathAndQuery = url.replace(/^https?:\/\/[^/]+/, '');

    // Binance detour: api.binance.com 451s the relay's US egress, so when the
    // server advertises a gateway worker, Binance traffic goes through it
    // (edge PoP closest to the caller) with a relay-minted ticket. No silent
    // fallback on ticket failure — that would misreport as region-blocked.
    if (exchangeId === 'binance') {
      const gatewayUrl = await getBinanceGatewayUrl();
      if (gatewayUrl) {
        return fetchViaBinanceGateway(exchange, pathAndQuery, url, method, headers, body);
      }
    }

    const relayPath = `${EXCHANGE_TUNNEL_BASE}/${exchangeId}${pathAndQuery}`;

    // Exchange-bound headers are prefixed `x-exchange-<lowername>`; the real
    // content-type is passed as-is (C1).
    const relayHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === 'content-type') relayHeaders['Content-Type'] = value;
      else relayHeaders[`x-exchange-${name.toLowerCase()}`] = value;
    }

    let res: Response;
    try {
      res = await apiFetch(relayPath, {
        method,
        headers: relayHeaders,
        body: body ?? undefined
      });
    } catch (err) {
      // The relay itself is unreachable (apiFetch converts network failures to
      // a generic Error) — surface as relay_unavailable, not 'unknown'.
      throw new TunnelError(
        'relay_unavailable',
        err instanceof Error ? err.message : 'Could not reach the SoloLedger relay.'
      );
    }

    // Relay-origin errors are stamped with x-sololedger-error (header-only
    // rule). Everything else — ANY exchange status/body — goes to ccxt.
    const tunnelError = res.headers.get('x-sololedger-error');
    if (tunnelError) {
      throw new TunnelError(tunnelKindFromHeader(tunnelError));
    }
    if (res.status === 502 || res.status === 504) {
      // Bare 502/504 without the stamp: the relay (or an intermediate proxy)
      // failed before producing a relay response — treat as relay-unavailable.
      throw new TunnelError('relay_unavailable');
    }

    const shim: RestResponseShim = {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: () => res.text()
    };
    return exchange.handleRestResponse(shim, url, method, headers, body);
  };
}

/**
 * Binance-only transport through the gateway worker. The fully-signed request
 * (path + query byte-verbatim) is piped to api.binance.com from the edge PoP
 * closest to the user — India egress gets 200 where the relay's US egress
 * gets 451. A 451 still surfaces as region_blocked for users in genuinely
 * blocked regions: the worker never stamps `x-sololedger-error`, so exchange
 * responses reach ccxt untouched (same header-only rule as the relay path).
 *
 * Plain `fetch` on purpose: the JWT must NOT be attached to a third-party
 * origin (apiFetch would). The worker maps only `x-exchange-*` headers
 * upstream, so the JWT could never reach Binance either way.
 */
async function fetchViaBinanceGateway(
  exchange: TunnelFetchTarget,
  pathAndQuery: string,
  originalUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
  // Throws TunnelError (relay_auth / relay_subscription / relay_disabled /
  // relay_unavailable) when minting fails — deliberately no relay fallback.
  const ticket = await getBinanceGatewayTicket();

  const gatewayHeaders: Record<string, string> = {
    'x-gateway-exp': String(ticket.exp),
    'x-gateway-token': ticket.token
  };
  for (const [name, value] of Object.entries(headers ?? {})) {
    // The worker maps x-exchange-content-type → content-type; every other
    // header keeps the same x-exchange-<lowername> convention as the relay.
    gatewayHeaders[`x-exchange-${name.toLowerCase()}`] = value;
  }

  let res: Response;
  try {
    // Worker calls still count as relay traffic for the network indicator.
    recordNetworkActivity('relay');
    res = await fetch(`${ticket.url}${pathAndQuery}`, {
      method,
      headers: gatewayHeaders,
      body: body ?? undefined
    });
  } catch (err) {
    throw new TunnelError(
      'relay_unavailable',
      err instanceof Error ? err.message : 'Could not reach the Binance gateway.'
    );
  }

  // The worker's only self-origin response is 401 {"error":"invalid_gateway_ticket"}
  // (missing/expired/bad ticket — infra misconfig, since the relay just minted
  // it). Binance's own 401s (invalid API key) carry a {"code":…} body and MUST
  // reach ccxt for invalid_key classification — distinguish by the body.
  const text = await res.text();
  if (res.status === 401 && text.includes('invalid_gateway_ticket')) {
    __clearBinanceGatewayTicketCache();
    throw new TunnelError('relay_unavailable', 'The Binance gateway rejected the relay ticket.');
  }

  const shim: RestResponseShim = {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    text: async () => text
  };
  return exchange.handleRestResponse(shim, originalUrl, method, headers, body);
}
