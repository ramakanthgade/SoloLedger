/**
 * Real brand logos for well-known crypto assets (locked decision 25 Jul:
 * real logos everywhere, never hand-drawn approximations). Assets live under
 * `public/assets/brand-icons/` with provenance in SOURCES.md. Anything not
 * mapped falls back to a neutral two-letter chip (see AssetIcon).
 */
const BRAND_ICON_BY_SYMBOL: Record<string, string> = {
  BTC: '/assets/brand-icons/bitcoin.svg',
  XBT: '/assets/brand-icons/bitcoin.svg',
  ETH: '/assets/brand-icons/ethereum.svg',
  SOL: '/assets/brand-icons/solana.svg',
  MATIC: '/assets/brand-icons/polygon.svg',
  POL: '/assets/brand-icons/polygon.svg',
  USDT: '/assets/brand-icons/tether.svg',
  BNB: '/assets/brand-icons/bnb.png',
  USDC: '/assets/brand-icons/usdc.png'
};

/** Resolve a ticker (any case, e.g. "btc") to its brand-icon URL, if one exists. */
export function brandIconForSymbol(symbol: string): string | undefined {
  return BRAND_ICON_BY_SYMBOL[symbol.trim().toUpperCase()];
}
