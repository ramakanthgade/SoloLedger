/**
 * Brand-mark lookup tables + pure resolvers for the Review ledger — which
 * exchange / wallet / chain / token logo (shipped in
 * `public/assets/brand-icons`, see SOURCES.md there) a `Transaction.source`
 * or asset symbol maps to. Component renderers live in `brandIcons.tsx`;
 * keeping this file component-free satisfies react-refresh and makes the
 * mapping unit-testable without a DOM.
 */

export const BRAND_ICON_FILES = {
  // Exchanges
  binance: 'binance.svg',
  coinbase: 'coinbase.svg',
  okx: 'okx.svg',
  kucoin: 'kucoin.svg',
  wazirx: 'wazirx.svg',
  zebpay: 'zebpay.svg',
  coindcx: 'coindcx.png',
  kraken: 'kraken.jpg',
  coinswitch: 'coinswitch.svg',
  // Wallets
  metamask: 'metamask.svg',
  trustwallet: 'trustwallet.svg',
  ledger: 'ledger.svg',
  trezor: 'trezor.png',
  phantom: 'phantom.svg',
  // Chains & tokens
  bitcoin: 'bitcoin.svg',
  ethereum: 'ethereum.svg',
  solana: 'solana.svg',
  polygon: 'polygon.svg',
  tether: 'tether.svg',
  bnb: 'bnb.png',
  usdc: 'usdc.png'
} as const;

export type BrandIconId = keyof typeof BRAND_ICON_FILES;

/** Marks whose glyph is dark on transparent — rendered on a white tile. */
export const NEEDS_LIGHT_TILE: ReadonlySet<BrandIconId> = new Set(['okx', 'ethereum', 'trezor']);

/** `Transaction.source` values that map straight to a brand mark. Exchange
 * sync/CSV variants (`wazirx_trades`, `binance_api`, …) collapse to the base
 * exchange mark; wallet/chain sources map to their own marks. */
const SOURCE_ALIASES: Record<string, BrandIconId> = {
  binance: 'binance',
  binance_api: 'binance',
  binance_spot: 'binance',
  binance_transfers: 'binance',
  coinbase: 'coinbase',
  okx: 'okx',
  kucoin: 'kucoin',
  wazirx: 'wazirx',
  wazirx_deposits: 'wazirx',
  wazirx_ledger: 'wazirx',
  wazirx_trades: 'wazirx',
  zebpay: 'zebpay',
  coindcx: 'coindcx',
  kraken: 'kraken',
  kraken_api: 'kraken',
  coinswitch: 'coinswitch',
  metamask: 'metamask',
  trustwallet: 'trustwallet',
  ledger: 'ledger',
  trezor: 'trezor',
  phantom: 'phantom'
};

/** Chain id (from `t.chain` or an `rpc:<chain>` source) → chain mark. */
const CHAIN_ICONS: Record<string, BrandIconId> = {
  bitcoin: 'bitcoin',
  ethereum: 'ethereum',
  solana: 'solana',
  polygon: 'polygon',
  bsc: 'bnb'
};

/** Asset symbol → token mark (uppercased lookup). */
const ASSET_ICONS: Record<string, BrandIconId> = {
  BTC: 'bitcoin',
  XBT: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  MATIC: 'polygon',
  POL: 'polygon',
  USDT: 'tether',
  BNB: 'bnb',
  USDC: 'usdc'
};

/** Display names where the raw source id isn't already user-friendly. */
const SOURCE_LABELS: Record<string, string> = {
  binance: 'Binance',
  binance_api: 'Binance',
  binance_spot: 'Binance spot',
  binance_transfers: 'Binance',
  coinbase: 'Coinbase',
  okx: 'OKX',
  kucoin: 'KuCoin',
  wazirx: 'WazirX',
  wazirx_deposits: 'WazirX',
  wazirx_ledger: 'WazirX',
  wazirx_trades: 'WazirX',
  zebpay: 'ZebPay',
  coindcx: 'CoinDCX',
  kraken: 'Kraken',
  kraken_api: 'Kraken',
  coinswitch: 'CoinSwitch',
  metamask: 'MetaMask',
  trustwallet: 'Trust Wallet',
  ledger: 'Ledger',
  trezor: 'Trezor',
  phantom: 'Phantom',
  bitfinex: 'Bitfinex',
  bybit: 'Bybit',
  coinspot: 'CoinSpot',
  cryptocom: 'Crypto.com',
  gateio: 'Gate.io',
  gemini: 'Gemini',
  htx: 'HTX',
  mudrex: 'Mudrex',
  hyperliquid_deposits: 'Hyperliquid',
  hyperliquid_trades: 'Hyperliquid'
};

export interface SourceBrand {
  /** Brand mark to render, if we have one for this source. */
  id?: BrandIconId;
  /** Human label for the source (always present). */
  label: string;
}

function prettify(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a `Transaction.source` to a brand mark + label.
 * `chainLabel` is the pretty chain name from `CHAINS` when the row carries a
 * chain (e.g. "Ethereum"), so `rpc:ethereum` reads "Ethereum" rather than
 * "Rpc ethereum".
 */
export function sourceBrandInfo(source: string, chainLabel?: string | null): SourceBrand {
  if (source.startsWith('rpc:')) {
    const chainId = source.slice(4);
    const id = CHAIN_ICONS[chainId];
    const label = chainLabel ?? (id ? prettify(chainId) : 'Wallet import');
    return { id, label };
  }
  if (source.startsWith('csv')) return { label: 'CSV import' };
  if (source === 'manual' || source === 'manual_mapping') return { label: 'Manual entry' };
  if (source === 'wallet') return { label: 'Wallet' };
  return { id: SOURCE_ALIASES[source], label: SOURCE_LABELS[source] ?? prettify(source) };
}

/** Brand mark for an asset symbol (BTC → bitcoin), if we ship one. */
export function assetIconId(symbol?: string): BrandIconId | undefined {
  if (!symbol) return undefined;
  return ASSET_ICONS[symbol.toUpperCase()];
}

/** Up-to-2-letter initials for the letter-chip fallback (mockup's "CX" style). */
export function chipInitials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
