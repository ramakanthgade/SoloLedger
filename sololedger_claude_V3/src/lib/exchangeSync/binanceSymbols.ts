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

/**
 * Flatten ccxt Balances → per-asset {asset, amount} TOTAL rows (free + used),
 * for persisting as the exchange balance truth anchor. Only assets with a
 * non-zero total are returned; the persistence layer (replaceExchangeBalances)
 * collapses previously-seen-but-now-absent assets to explicit zero rows.
 */
export function flattenBalanceTotals(balance: UnifiedBalance): { asset: string; amount: number }[] {
  const out = new Map<string, number>();
  const total = balance?.total;
  if (total && typeof total === 'object' && Object.keys(total).length > 0) {
    for (const [asset, amount] of Object.entries(total)) {
      if (typeof amount === 'number' && amount > 0) out.set(asset.toUpperCase(), amount);
    }
    return [...out.entries()].map(([asset, amount]) => ({ asset, amount }));
  }
  // Fallback: per-asset {free, used, total} buckets.
  for (const [key, value] of Object.entries(balance ?? {})) {
    if (key === 'info' || key === 'free' || key === 'used' || key === 'total' || key === 'debt') continue;
    const bucket = value as { total?: number; free?: number; used?: number } | undefined;
    if (bucket && typeof bucket === 'object') {
      const t = bucket.total ?? (bucket.free ?? 0) + (bucket.used ?? 0);
      if ((t ?? 0) > 0) out.set(key.toUpperCase(), t ?? 0);
    }
  }
  return [...out.entries()].map(([asset, amount]) => ({ asset, amount }));
}

function isLiveSpot(market: UnifiedMarket | undefined): market is UnifiedMarket {
  return !!market && market.spot === true && market.active !== false;
}

/**
 * Candidate spot symbols to scan for trades: bases × QUOTE_CANDIDATES
 * intersected with live spot+active markets (self-pairs dropped), unioned
 * with persisted knownSymbols that are still live. Sorted for determinism.
 *
 * NOTE: this is the INCREMENTAL-sync discovery (cheap). It is BLIND to
 * fully-divested assets — an asset bought AND sold to zero with no
 * deposit/withdrawal trace leaves no balance/transfer signal, so its symbols
 * never appear here. The INITIAL sync must use allSpotSymbols instead (see
 * engine) or those trades are silently never fetched (the HNT/NPXS/BUSD
 * blind spot — measured 7% trade coverage on a real account).
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

/**
 * ALL live spot symbols — the INITIAL-sync discovery set. The only way to
 * guarantee complete trade history: Binance's myTrades requires a symbol and
 * there is no "all my trades" endpoint, so the initial (cursorless) sync must
 * probe every live spot market. A never-traded symbol costs exactly one empty
 * myTrades call (the fromId scan short-circuits), so this is bounded — heavy
 * accounts hit ~50-100 symbols with fills, the rest are single empty probes.
 * Traded symbols are persisted to knownSymbols, so incremental syncs fall
 * back to the cheap candidateSpotSymbols path.
 */
export function allSpotSymbols(markets: Record<string, UnifiedMarket>): string[] {
  const symbols = new Set<string>();
  for (const market of Object.values(markets)) {
    if (!isLiveSpot(market)) continue;
    if (market.base.toUpperCase() === market.quote.toUpperCase()) continue;
    symbols.add(market.symbol);
  }
  return [...symbols].sort();
}

/** Every catalogued spot symbol, including inactive/delisted metadata. */
export function allCataloguedSpotSymbols(markets: Record<string, UnifiedMarket>): string[] {
  const symbols = new Set<string>();
  for (const market of Object.values(markets)) {
    if (market.spot !== true) continue;
    if (market.base.toUpperCase() === market.quote.toUpperCase()) continue;
    symbols.add(market.symbol);
  }
  return [...symbols].sort();
}
