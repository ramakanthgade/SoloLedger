/**
 * Exchange Auto-Sync — ccxt lazy-loading root.
 *
 * This is the ONLY module that does `await import('ccxt')` (memoized), which
 * keeps the ~MB vendor-ccxt chunk out of the app's entry graph — every other
 * module uses `import type` from here only.
 */
import type { ExchangeConnectionRow } from '@/lib/storage/db';
import { isSaasMode } from '@/lib/saas/config';
import { installTunnelFetch, TunnelError } from './tunnel';
import type { ExchangeId, SyncErrorKind } from './types';

// ---- ccxt module handle (structural — avoids pulling ccxt types in eagerly) ----

interface CcxtExchangeCtor {
  new (config: Record<string, unknown>): unknown;
}

interface CcxtModule {
  [exchangeId: string]: CcxtExchangeCtor | unknown;
}

let ccxtPromise: Promise<CcxtModule> | null = null;

/** Lazily load (and memoize) the ccxt ESM bundle. */
export function loadCcxt(): Promise<CcxtModule> {
  if (!ccxtPromise) {
    ccxtPromise = import('ccxt') as unknown as Promise<CcxtModule>;
  }
  return ccxtPromise;
}

// ---- Structural shapes (subset of ccxt's unified structures we consume) ----

export interface UnifiedMarket {
  symbol: string;
  /** Exchange-native market id (e.g. 'BTCUSDT', 'BTC-USDT', 'XXBTZUSD'). */
  id?: string;
  base: string;
  quote: string;
  spot?: boolean;
  active?: boolean;
}

export interface UnifiedTrade {
  id?: string;
  order?: string;
  timestamp?: number;
  symbol?: string;
  side?: string;
  price?: number;
  amount?: number;
  cost?: number;
  fee?: { cost?: number; currency?: string };
  info?: Record<string, unknown>;
}

export interface UnifiedTransfer {
  id?: string;
  txid?: string;
  timestamp?: number;
  currency?: string;
  amount?: number;
  status?: string;
  type?: string;
  address?: string;
  addressTo?: string;
  addressFrom?: string;
  network?: string;
  fee?: { cost?: number; currency?: string };
  info?: Record<string, unknown>;
}

/** ccxt Balances structure (subset): per-asset {free, used, total} + 'total' dict. */
export interface UnifiedBalance {
  free?: Record<string, number | undefined>;
  used?: Record<string, number | undefined>;
  total?: Record<string, number | undefined>;
  info?: unknown;
  [asset: string]: unknown;
}

/** The subset of a ccxt exchange instance the engine drives. */
export interface ExchangeClient {
  id: string;
  markets?: Record<string, UnifiedMarket>;
  loadMarkets(reload?: boolean): Promise<Record<string, UnifiedMarket>>;
  fetchBalance(params?: Record<string, unknown>): Promise<UnifiedBalance>;
  fetchMyTrades(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<UnifiedTrade[]>;
  fetchDeposits(
    code?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<UnifiedTransfer[]>;
  fetchWithdrawals(
    code?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<UnifiedTransfer[]>;
  handleRestResponse(...args: unknown[]): unknown;
  fetch(url: string, method?: string, headers?: Record<string, string>, body?: string): Promise<unknown>;
}

/** Display labels for plain-language error copy. */
const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  coinbase: 'Coinbase',
  kraken: 'Kraken',
  okx: 'OKX',
  kucoin: 'KuCoin'
};

export function exchangeLabel(exchange: ExchangeId): string {
  return EXCHANGE_LABELS[exchange];
}

/**
 * Create a ccxt client for a saved connection row, with the tunnel transport
 * installed. Constructor config per contract C5:
 * `enableRateLimit: true, timeout: 30000`; binance/okx also
 * `options: { defaultType: 'spot' }`; passphrase maps to ccxt `password`.
 * Throws TunnelError('not_hosted') outside hosted mode.
 */
export async function createExchangeClient(row: ExchangeConnectionRow): Promise<ExchangeClient> {
  if (!isSaasMode()) {
    throw new TunnelError('not_hosted');
  }
  const exchangeId = row.exchange as ExchangeId;
  const ccxt = await loadCcxt();
  const Ctor = ccxt[exchangeId] as CcxtExchangeCtor | undefined;
  if (!Ctor) {
    throw new TunnelError('relay_unavailable', `ccxt has no exchange implementation for '${exchangeId}'.`);
  }
  const config: Record<string, unknown> = {
    apiKey: row.apiKey,
    secret: row.secret,
    enableRateLimit: true,
    timeout: 30_000
  };
  if (row.passphrase) config.password = row.passphrase;
  if (exchangeId === 'binance' || exchangeId === 'okx') {
    config.options = { defaultType: 'spot' };
  }
  const exchange = new Ctor(config) as ExchangeClient;
  installTunnelFetch(exchange, exchangeId);
  return exchange;
}

// ---- Error classification ----

/** All ccxt error-class names up an error's prototype chain. */
function errorClassNames(err: unknown): Set<string> {
  const names = new Set<string>();
  let proto: object | null = err as object;
  while (proto && proto !== Object.prototype) {
    const ctor = (proto as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) names.add(ctor.name);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return names;
}

/** True when the error is (a subclass of) one of the named ccxt error classes. */
export function hasErrorName(err: unknown, ...names: string[]): boolean {
  const all = errorClassNames(err);
  return names.some((n) => all.has(n));
}

/**
 * Map any sync failure to a SyncErrorKind. TunnelError kinds pass through;
 * ccxt error classes map to their bucket (subclass-aware, so e.g.
 * AccountSuspended → invalid_key via its AuthenticationError parent).
 */
export function classifySyncError(err: unknown): SyncErrorKind {
  if (err instanceof TunnelError) return err.kind;
  if (hasErrorName(err, 'AccountNotEnabled', 'PermissionDenied')) return 'permission';
  if (hasErrorName(err, 'AuthenticationError')) return 'invalid_key';
  if (hasErrorName(err, 'RateLimitExceeded', 'DDoSProtection')) return 'rate_limit';
  // Geo-block (Binance HTTP 451 'Service unavailable from a restricted
  // location') surfaces as ExchangeNotAvailable — a NetworkError — but it is
  // NOT a transient network issue: it is non-retryable and needs its own
  // copy, so check for it before the generic network mapping.
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/restricted location/i.test(message)) return 'region_blocked';
  if (hasErrorName(err, 'NetworkError', 'ExchangeNotAvailable', 'RequestTimeout')) return 'network';
  return 'unknown';
}

/** Plain-language message for a classified sync error. */
export function syncErrorMessage(kind: SyncErrorKind, exchange: ExchangeId): string {
  const label = exchangeLabel(exchange);
  switch (kind) {
    case 'not_hosted':
      return 'Auto-sync needs Hosted mode — switch modes or use CSV import.';
    case 'relay_auth':
      return 'Your session has expired — please sign in again.';
    case 'relay_subscription':
      return 'Auto-sync needs an active SoloLedger subscription.';
    case 'relay_disabled':
      return 'Auto-sync is temporarily unavailable — please use CSV import.';
    case 'relay_payload':
      return 'The request was too large for the relay — please try again.';
    case 'relay_unavailable':
      return 'The SoloLedger relay could not reach the exchange — please try again in a moment.';
    case 'invalid_key':
      return `API key or secret rejected by ${label} — check the key and try again.`;
    case 'permission':
      return `${label} says this key lacks read permission — create a read-only key (disable trading and withdrawals).`;
    case 'rate_limit':
      return `${label} rate-limited the sync — it will pick up where it left off on the next try.`;
    case 'network':
      return `Network error talking to ${label} — check your connection and try again.`;
    case 'region_blocked':
      return "Binance currently can't be reached from SoloLedger's servers — Binance blocks our hosting region. We're fixing this. Please use CSV import for Binance for now.";
    case 'unknown':
      return `Something went wrong while syncing ${label} — please try again.`;
  }
}
