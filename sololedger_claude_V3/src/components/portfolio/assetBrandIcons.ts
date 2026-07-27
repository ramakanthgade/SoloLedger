/**
 * Real brand logos for well-known crypto assets (locked decision 25 Jul:
 * real logos everywhere, never hand-drawn approximations). Assets live under
 * `public/assets/brand-icons/` with provenance in SOURCES.md. Anything not
 * mapped falls back to a neutral two-letter chip (see AssetIcon).
 */
import { brandIconUrl } from '@/lib/brandAssets';

const BRAND_ICON_BY_SYMBOL: Record<string, string> = {
  BTC: brandIconUrl('bitcoin.svg'),
  XBT: brandIconUrl('bitcoin.svg'),
  ETH: brandIconUrl('ethereum.svg'),
  SOL: brandIconUrl('solana.svg'),
  MATIC: brandIconUrl('polygon.svg'),
  POL: brandIconUrl('polygon.svg'),
  USDT: brandIconUrl('tether.svg'),
  BNB: brandIconUrl('bnb.png'),
  USDC: brandIconUrl('usdc.png'),
  LPT: brandIconUrl('livepeer.svg')
};

/** Resolve a ticker (any case, e.g. "btc") to its brand-icon URL, if one exists. */
export function brandIconForSymbol(symbol: string): string | undefined {
  return BRAND_ICON_BY_SYMBOL[symbol.trim().toUpperCase()];
}
