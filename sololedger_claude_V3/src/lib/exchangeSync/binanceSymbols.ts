/**
 * Exchange Auto-Sync — Binance spot symbol discovery (plan §B-4).
 *
 * Binance's `fetchMyTrades` requires a symbol, so the engine must discover
 * which spot markets the account has actually traded. Discovery sources:
 * current balances + deposit/withdrawal currencies + persisted knownAssets,
 * crossed with the live market list (bases × candidate quotes), unioned with
 * persisted knownSymbols (symbols that already returned trades before).
 *
 * PURE module (no ccxt/db/saas imports).
 */
import type { UnifiedBalance, UnifiedMarket } from './ccxtLoader';

/** Candidate quote currencies, most common first (§B-1 pinned list). */
export const QUOTE_CANDIDATES = [
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'TUSD',
  'DAI',
  'USD',
  'EUR',
  'GBP',
  'TRY',
  'BRL',
  'AUD',
  'INR',
  'BTC',
  'ETH',
  'BNB'
] as const;

/** Assets with a non-zero total balance (ccxt Balances structure). */
export function assetsFromBalance(balance: UnifiedBalance): string[] {
  const out = new Set<string>();
  const total = balance?.total;
  if (total && typeof total === 'object') {
    for (const [asset, amount] of Object.entries(total)) {
      if (typeof amount === 'number' && amount > 0) out.add(asset.toUpperCase());
    }
    return [...out];
  }
  // Fallback: scan per-asset {free, used, total} buckets.
  for (const [key, value] of Object.entries(balance ?? {})) {
    if (key === 'info' || key === 'free' || key === 'used' || key === 'total' || key === 'debt') continue;
    const bucket = value as { total?: number; free?: number; used?: number } | undefined;
    if (bucket && typeof bucket === 'object') {
      const t = bucket.total ?? (bucket.free ?? 0) + (bucket.used ?? 0);
      if ((t ?? 0) > 0) out.add(key.toUpperCase());
    }
  }
  return [...out];
}

function isLiveSpot(market: UnifiedMarket | undefined): market is UnifiedMarket {
  return !!market && market.spot === true && market.active !== false;
}

/**
 * Candidate spot symbols to scan for trades: bases × QUOTE_CANDIDATES
 * intersected with live spot+active markets (self-pairs dropped), unioned
 * with persisted knownSymbols that are still live. Sorted for determinism.
 */
export function candidateSpotSymbols(
  assets: string[],
  markets: Record<string, UnifiedMarket>,
  knownSymbols: string[] = []
): string[] {
  const symbols = new Set<string>();
  const bases = new Set(assets.map((a) => a.toUpperCase()));
  for (const market of Object.values(markets)) {
    if (!isLiveSpot(market)) continue;
    const base = market.base.toUpperCase();
    const quote = market.quote.toUpperCase();
    if (base === quote) continue; // drop self-pairs
    if (bases.has(base) && (QUOTE_CANDIDATES as readonly string[]).includes(quote)) {
      symbols.add(market.symbol);
    }
  }
  // Union knownSymbols ∩ live spot markets (a zero-balance asset that traded
  // before stays covered across syncs).
  for (const symbol of knownSymbols) {
    if (isLiveSpot(markets[symbol])) symbols.add(symbol);
  }
  return [...symbols].sort();
}
