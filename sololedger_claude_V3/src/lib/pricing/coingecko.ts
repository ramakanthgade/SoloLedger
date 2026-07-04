/**
 * Optional historical price lookup via CoinGecko's public API, with a
 * fallback to Alchemy's Prices API (see fetchHistoricalPricesBatch below)
 * for tokens CoinGecko doesn't track. The CoinGecko calls send only a coin
 * id and a date — never a wallet address, transaction hash, or amount.
 */
import { fetchAlchemyHistoricalPriceUsd } from './alchemyPrices';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// Small manual map for common tickers; CoinGecko needs its internal "id"
// rather than the ticker symbol. Extend as needed.
const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  SOL: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LTC: 'litecoin',
  AVAX: 'avalanche-2'
};

export interface PriceLookupResult {
  asset: string;
  date: string;       // dd-mm-yyyy, CoinGecko's expected format
  price: number | null;
  currency: string;
  error?: string;
}

function toCoinGeckoDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Fetches the historical fiat price for one asset on one date, by symbol.
 * Caller is responsible for checking `settings.priceApiEnabled` before
 * calling this — this module does not check settings itself.
 */
export async function fetchHistoricalPrice(
  assetSymbol: string,
  timestampMs: number,
  fiatCurrency: string
): Promise<PriceLookupResult> {
  const date = toCoinGeckoDate(timestampMs);
  const coinId = SYMBOL_TO_ID[assetSymbol.toUpperCase()];

  if (!coinId) {
    return {
      asset: assetSymbol,
      date,
      price: null,
      currency: fiatCurrency,
      error: `"${assetSymbol}" isn't in the built-in symbol map.`
    };
  }

  try {
    const url = `${COINGECKO_BASE}/coins/${coinId}/history?date=${date}&localization=false`;
    const res = await fetch(url);
    if (!res.ok) {
      return { asset: assetSymbol, date, price: null, currency: fiatCurrency, error: `Price API returned ${res.status}` };
    }
    const data = await res.json();
    const currencyKey = fiatCurrency.toLowerCase();
    const price = data?.market_data?.current_price?.[currencyKey] ?? null;
    if (price == null) {
      return {
        asset: assetSymbol,
        date,
        price: null,
        currency: fiatCurrency,
        error: `No price data for ${fiatCurrency} on ${date}.`
      };
    }
    return { asset: assetSymbol, date, price, currency: fiatCurrency };
  } catch (err) {
    return {
      asset: assetSymbol,
      date,
      price: null,
      currency: fiatCurrency,
      error: err instanceof Error ? err.message : 'Network request failed.'
    };
  }
}

/**
 * Fallback for tokens not in the symbol map: look up by contract/mint address
 * on a given CoinGecko "asset platform" (see COINGECKO_PLATFORM in
 * lib/rpc/providers.ts), using the market_chart/range endpoint and picking
 * the closest price point to the transaction's timestamp. Covers arbitrary
 * ERC-20s and SPL tokens that CoinGecko tracks but that aren't in our small
 * hand-maintained symbol map.
 */
export async function fetchHistoricalPriceByContract(
  platform: string,
  contractAddress: string,
  timestampMs: number,
  fiatCurrency: string
): Promise<PriceLookupResult> {
  const date = toCoinGeckoDate(timestampMs);
  const fromSec = Math.floor(timestampMs / 1000) - 2 * 86400;
  const toSec = Math.floor(timestampMs / 1000) + 2 * 86400;

  try {
    const url = `${COINGECKO_BASE}/coins/${platform}/contract/${contractAddress}/market_chart/range?vs_currency=${fiatCurrency.toLowerCase()}&from=${fromSec}&to=${toSec}`;
    const res = await fetch(url);
    if (!res.ok) {
      return { asset: contractAddress, date, price: null, currency: fiatCurrency, error: `Price API returned ${res.status} for contract lookup` };
    }
    const data = await res.json();
    const prices: [number, number][] = data?.prices ?? [];
    if (prices.length === 0) {
      return { asset: contractAddress, date, price: null, currency: fiatCurrency, error: 'No price history for this contract/mint on CoinGecko.' };
    }
    // Pick the point closest to the transaction timestamp.
    let closest = prices[0];
    let closestDiff = Math.abs(prices[0][0] - timestampMs);
    for (const p of prices) {
      const diff = Math.abs(p[0] - timestampMs);
      if (diff < closestDiff) {
        closest = p;
        closestDiff = diff;
      }
    }
    return { asset: contractAddress, date, price: closest[1], currency: fiatCurrency };
  } catch (err) {
    return {
      asset: contractAddress,
      date,
      price: null,
      currency: fiatCurrency,
      error: err instanceof Error ? err.message : 'Network request failed.'
    };
  }
}

export interface PriceRequest {
  asset: string;
  timestampMs: number;
  fiatCurrency: string;
  /** If the symbol lookup fails, retry by contract/mint address on this platform. */
  contractAddress?: string;
  platform?: string;
  /** Last-resort fallback for tokens CoinGecko doesn't track (DEX-only tokens). */
  alchemyApiKey?: string;
  alchemyNetwork?: string; // Alchemy's network slug, e.g. "eth-mainnet", "solana-mainnet"
}

const usdRateCache = new Map<string, number>();

/** Same-day USD -> target currency rate, approximated via CoinGecko's USDT price in that currency. */
async function usdToCurrencyRate(timestampMs: number, currency: string): Promise<number | null> {
  if (currency.toUpperCase() === 'USD') return 1;
  const key = `${toCoinGeckoDate(timestampMs)}:${currency.toUpperCase()}`;
  if (usdRateCache.has(key)) return usdRateCache.get(key)!;
  const r = await fetchHistoricalPrice('USDT', timestampMs, currency);
  if (r.price != null) usdRateCache.set(key, r.price);
  return r.price;
}

/** Sequential fetch with a small delay to stay well under CoinGecko's free-tier rate limit. */
export async function fetchHistoricalPricesBatch(
  requests: PriceRequest[],
  onProgress?: (done: number, total: number) => void
): Promise<PriceLookupResult[]> {
  const results: PriceLookupResult[] = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    // eslint-disable-next-line no-await-in-loop
    let result = await fetchHistoricalPrice(r.asset, r.timestampMs, r.fiatCurrency);

    if (result.price == null && r.contractAddress && r.platform) {
      // eslint-disable-next-line no-await-in-loop
      result = await fetchHistoricalPriceByContract(r.platform, r.contractAddress, r.timestampMs, r.fiatCurrency);
    }

    if (result.price == null && r.alchemyApiKey) {
      // eslint-disable-next-line no-await-in-loop
      const alchemyResult = await fetchAlchemyHistoricalPriceUsd(
        r.alchemyApiKey,
        r.contractAddress && r.alchemyNetwork ? { network: r.alchemyNetwork, address: r.contractAddress } : { symbol: r.asset },
        r.timestampMs
      );
      if (alchemyResult.priceUsd != null) {
        // eslint-disable-next-line no-await-in-loop
        const rate = await usdToCurrencyRate(r.timestampMs, r.fiatCurrency);
        if (rate != null) {
          result = { asset: r.asset, date: toCoinGeckoDate(r.timestampMs), price: alchemyResult.priceUsd * rate, currency: r.fiatCurrency };
        } else {
          result = { ...result, error: `${result.error ? result.error + '; ' : ''}Alchemy found a USD price but currency conversion failed.` };
        }
      } else if (alchemyResult.error) {
        result = { ...result, error: `${result.error ? result.error + '; ' : ''}${alchemyResult.error}` };
      }
    }

    results.push(result);
    onProgress?.(i + 1, requests.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < requests.length - 1) await new Promise((r2) => setTimeout(r2, 1500));
  }
  return results;
}
