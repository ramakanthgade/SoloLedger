/**
 * Optional historical price lookup via CoinGecko's public API, with a
 * fallback to Alchemy's Prices API (see fetchHistoricalPricesBatch below)
 * for tokens CoinGecko doesn't track. The CoinGecko calls send only a coin
 * id and a date — never a wallet address, transaction hash, or amount.
 */
import { fetchAlchemyHistoricalPriceUsd } from './alchemyPrices';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';

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
  AVAX: 'avalanche-2',
  PUNDIX: 'pundi-x-2',
  KNC: 'kyber-network-crystal',
  NPXS: 'pundi-x'
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
    const res = await fetchWithRetry(url);
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
    const res = await fetchWithRetry(url);
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
  chain?: string;
  /** Last-resort fallback for tokens CoinGecko doesn't track (DEX-only tokens). */
  alchemyApiKey?: string;
  alchemyNetwork?: string; // Alchemy's network slug, e.g. "eth-mainnet", "solana-mainnet"
}

const usdRateCache = new Map<string, number>();

/** Approximate FX when CoinGecko is rate-limited (better than failing 100+ stablecoin rows). */
const FX_FALLBACK_USD: Record<string, number> = {
  INR: 83.5,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.36,
  AUD: 1.52,
  AED: 3.67,
  USD: 1
};

async function fetchLiveFxRate(currency: string): Promise<number | null> {
  const cur = currency.toLowerCase();
  if (cur === 'usd') return 1;
  try {
    const res = await fetch(`${COINGECKO_BASE}/simple/price?ids=tether&vs_currencies=${cur}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.tether?.[cur] ?? null;
  } catch {
    return null;
  }
}

/** Same-day USD -> target currency rate, approximated via CoinGecko's USDT price in that currency. */
async function usdToCurrencyRate(timestampMs: number, currency: string): Promise<number | null> {
  const cur = currency.toUpperCase();
  if (cur === 'USD') return 1;
  const key = `${toCoinGeckoDate(timestampMs)}:${cur}`;
  if (usdRateCache.has(key)) return usdRateCache.get(key)!;

  const liveKey = `live:${cur}`;
  if (!usdRateCache.has(liveKey)) {
    const live = await fetchLiveFxRate(cur);
    if (live != null) usdRateCache.set(liveKey, live);
  }
  if (usdRateCache.has(liveKey)) {
    const rate = usdRateCache.get(liveKey)!;
    usdRateCache.set(key, rate);
    return rate;
  }

  const fallback = FX_FALLBACK_USD[cur];
  if (fallback != null) {
    usdRateCache.set(key, fallback);
    return fallback;
  }

  const r = await fetchHistoricalPrice('USDT', timestampMs, currency);
  if (r.price != null) {
    usdRateCache.set(key, r.price);
    return r.price;
  }

  return null;
}

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'USDP', 'TUSD']);

function resolveStablecoinSymbol(asset: string, contractAddress?: string, chain?: string): string | null {
  const normalized = resolvePriceAsset(asset, contractAddress, chain);
  const u = normalized.trim().toUpperCase();
  return STABLECOIN_SYMBOLS.has(u) ? u : null;
}

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url);
    last = res;
    if (res.status !== 429 || attempt === retries) return res;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  return last!;
}

/** Stablecoins ≈ $1 — use FX rate for reporting currency instead of per-day CoinGecko history (avoids rate limits). */
async function fetchStablecoinPrice(timestampMs: number, fiatCurrency: string, asset: string): Promise<PriceLookupResult> {
  const date = toCoinGeckoDate(timestampMs);
  if (fiatCurrency.toUpperCase() === 'USD') {
    return { asset, date, price: 1, currency: fiatCurrency };
  }
  const rate = await usdToCurrencyRate(timestampMs, fiatCurrency);
  if (rate == null) {
    return { asset, date, price: null, currency: fiatCurrency, error: 'Could not convert USD stablecoin to reporting currency.' };
  }
  return { asset, date, price: rate, currency: fiatCurrency };
}

/** One historical price lookup (deduped before batching). */
async function fetchOneHistoricalPrice(r: PriceRequest): Promise<PriceLookupResult> {
  const stable = resolveStablecoinSymbol(r.asset, r.contractAddress, r.chain);
  if (stable) {
    return fetchStablecoinPrice(r.timestampMs, r.fiatCurrency, stable);
  }

  const normalizedAsset = resolvePriceAsset(r.asset, r.contractAddress, r.chain);
  let result = await fetchHistoricalPrice(normalizedAsset, r.timestampMs, r.fiatCurrency);

  if (result.price == null && r.contractAddress && r.platform && !resolveStablecoinSymbol(r.asset, r.contractAddress, r.chain)) {
    result = await fetchHistoricalPriceByContract(r.platform, r.contractAddress, r.timestampMs, r.fiatCurrency);
  }

  if (result.price == null && r.alchemyApiKey) {
    const alchemyResult = await fetchAlchemyHistoricalPriceUsd(
      r.alchemyApiKey,
      r.contractAddress && r.alchemyNetwork ? { network: r.alchemyNetwork, address: r.contractAddress } : { symbol: r.asset },
      r.timestampMs
    );
    if (alchemyResult.priceUsd != null) {
      const rate = await usdToCurrencyRate(r.timestampMs, r.fiatCurrency);
      if (rate != null) {
        result = {
          asset: r.asset,
          date: toCoinGeckoDate(r.timestampMs),
          price: alchemyResult.priceUsd * rate,
          currency: r.fiatCurrency
        };
      } else {
        result = {
          ...result,
          error: `${result.error ? result.error + '; ' : ''}Alchemy found a USD price but currency conversion failed.`
        };
      }
    } else if (alchemyResult.error) {
      result = { ...result, error: `${result.error ? result.error + '; ' : ''}${alchemyResult.error}` };
    }
  }

  return result;
}

function priceLookupKey(r: PriceRequest): string {
  const date = toCoinGeckoDate(r.timestampMs);
  return `${r.asset}|${date}|${r.fiatCurrency}|${r.contractAddress ?? ''}|${r.platform ?? ''}|${r.alchemyNetwork ?? ''}`;
}

/** Fetches unique asset/date pairs once, then maps results back — much faster for large imports. */
export async function fetchHistoricalPricesBatch(
  requests: PriceRequest[],
  onProgress?: (done: number, total: number) => void
): Promise<PriceLookupResult[]> {
  if (requests.length === 0) return [];

  // One live FX lookup up front so USDC/USDT rows succeed even when historical API is rate-limited.
  const currencies = [...new Set(requests.map((r) => r.fiatCurrency.toUpperCase()))];
  for (const currency of currencies) {
    if (currency === 'USD') continue;
    const sample = requests.find((r) => r.fiatCurrency.toUpperCase() === currency);
    if (sample) {
      // eslint-disable-next-line no-await-in-loop
      await usdToCurrencyRate(sample.timestampMs, currency);
    }
  }

  const uniqueKeys: string[] = [];
  const keyToRequest = new Map<string, PriceRequest>();
  const requestToKey = requests.map((r) => {
    const key = priceLookupKey(r);
    if (!keyToRequest.has(key)) {
      keyToRequest.set(key, r);
      uniqueKeys.push(key);
    }
    return key;
  });

  const keyResults = new Map<string, PriceLookupResult>();
  for (let i = 0; i < uniqueKeys.length; i++) {
    const key = uniqueKeys[i];
    // eslint-disable-next-line no-await-in-loop
    keyResults.set(key, await fetchOneHistoricalPrice(keyToRequest.get(key)!));
    onProgress?.(i + 1, uniqueKeys.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < uniqueKeys.length - 1) await new Promise((r2) => setTimeout(r2, 400));
  }

  return requestToKey.map((key) => keyResults.get(key)!);
}
