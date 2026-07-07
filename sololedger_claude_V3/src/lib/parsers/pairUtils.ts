/** Common quote currencies in exchange trading pairs (longest first for matching). */
const QUOTE_SUFFIXES = [
  'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI', 'USD', 'EUR', 'GBP',
  'BTC', 'ETH', 'BNB', 'SOL', 'INR', 'TRY', 'AUD', 'BRL'
];

/**
 * Split a trading pair like SOLUSDT → { base: 'SOL', quote: 'USDT' }.
 * Returns the raw string as base if no known quote suffix matches.
 */
export function parseTradingPair(pair: string): { base: string; quote?: string } {
  const normalized = pair.replace(/[-_/.\s]/g, '').toUpperCase().trim();
  if (!normalized) return { base: '' };

  for (const quote of QUOTE_SUFFIXES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return { base: normalized.slice(0, -quote.length), quote };
    }
  }
  return { base: normalized };
}

/** Map stablecoin quotes to approximate fiat currency codes. */
export function quoteToFiatCurrency(quote?: string): string | undefined {
  if (!quote) return undefined;
  const q = quote.toUpperCase();
  if (['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI', 'USD'].includes(q)) return 'USD';
  if (q === 'EUR') return 'EUR';
  if (q === 'GBP') return 'GBP';
  if (q === 'INR') return 'INR';
  return undefined;
}
