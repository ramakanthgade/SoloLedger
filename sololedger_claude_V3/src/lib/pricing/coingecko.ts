/**
 * Historical price lookup via CoinGecko (free or Pro API), with Alchemy Prices
 * fallback for DEX-only tokens. Sends coin id + date — never wallet addresses.
 */
import { fetchAlchemyHistoricalPriceUsd } from './alchemyPrices';
import { fetchBirdeyeHistoricalPrice } from './birdeye';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';

const COINGECKO_PUBLIC = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO = 'https://pro-api.coingecko.com/api/v3';

function coingeckoBase(apiKey?: string): string {
  return apiKey?.trim() ? COINGECKO_PRO : COINGECKO_PUBLIC;
}

function coingeckoHeaders(apiKey?: string): HeadersInit | undefined {
  const key = apiKey?.trim();
  return key ? { 'x-cg-pro-api-key': key } : undefined;
}

// CoinGecko internal coin ids (not tickers).
const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  BNB: 'binancecoin',
  SOL: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LTC: 'litecoin',
  AVAX: 'avalanche-2',
  BUSD: 'binance-usd',
  PUNDIX: 'pundi-x-2',
  KNC: 'kyber-network-crystal',
  NPXS: 'pundi-x'
};

export interface PriceLookupResult {
  asset: string;
  date: string;
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

async function fetchWithRetry(url: string, headers?: HeadersInit, retries = 2): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, headers ? { headers } : undefined);
    last = res;
    if (res.status !== 429 || attempt === retries) return res;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  return last!;
}

/**
 * Historical fiat price for one asset on one date via /coins/{id}/history.
 * USDC, USDT, etc. return the price in your reporting currency (INR, USD, …) for that date.
 */
export async function fetchHistoricalPrice(
  assetSymbol: string,
  timestampMs: number,
  fiatCurrency: string,
  coingeckoApiKey?: string
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
    const base = coingeckoBase(coingeckoApiKey);
    const url = `${base}/coins/${coinId}/history?date=${date}&localization=false`;
    const res = await fetchWithRetry(url, coingeckoHeaders(coingeckoApiKey));
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

export async function fetchHistoricalPriceByContract(
  platform: string,
  contractAddress: string,
  timestampMs: number,
  fiatCurrency: string,
  coingeckoApiKey?: string
): Promise<PriceLookupResult> {
  const date = toCoinGeckoDate(timestampMs);
  const fromSec = Math.floor(timestampMs / 1000) - 2 * 86400;
  const toSec = Math.floor(timestampMs / 1000) + 2 * 86400;

  try {
    const base = coingeckoBase(coingeckoApiKey);
    const url = `${base}/coins/${platform}/contract/${contractAddress}/market_chart/range?vs_currency=${fiatCurrency.toLowerCase()}&from=${fromSec}&to=${toSec}`;
    const res = await fetchWithRetry(url, coingeckoHeaders(coingeckoApiKey));
    if (!res.ok) {
      return { asset: contractAddress, date, price: null, currency: fiatCurrency, error: `Price API returned ${res.status} for contract lookup` };
    }
    const data = await res.json();
    const prices: [number, number][] = data?.prices ?? [];
    if (prices.length === 0) {
      return { asset: contractAddress, date, price: null, currency: fiatCurrency, error: 'No price history for this contract/mint on CoinGecko.' };
    }
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
  contractAddress?: string;
  platform?: string;
  chain?: string;
  coingeckoApiKey?: string;
  alchemyApiKey?: string;
  alchemyNetwork?: string;
  /** Birdeye API key — fallback for Solana long-tail tokens after CoinGecko+Alchemy fail. */
  birdeyeApiKey?: string;
}

const usdRateCache = new Map<string, number>();

/** Historical USD → reporting currency on a specific date (via USDT price in that currency). */
async function usdToCurrencyRate(
  timestampMs: number,
  currency: string,
  coingeckoApiKey?: string
): Promise<number | null> {
  const cur = currency.toUpperCase();
  if (cur === 'USD') return 1;
  const key = `${toCoinGeckoDate(timestampMs)}:${cur}`;
  if (usdRateCache.has(key)) return usdRateCache.get(key)!;

  const r = await fetchHistoricalPrice('USDT', timestampMs, currency, coingeckoApiKey);
  if (r.price != null) {
    usdRateCache.set(key, r.price);
    return r.price;
  }
  return null;
}

async function fetchOneHistoricalPrice(r: PriceRequest): Promise<PriceLookupResult> {
  const normalizedAsset = resolvePriceAsset(r.asset, r.contractAddress, r.chain);
  let result = await fetchHistoricalPrice(normalizedAsset, r.timestampMs, r.fiatCurrency, r.coingeckoApiKey);

  if (result.price == null && r.contractAddress && r.platform) {
    result = await fetchHistoricalPriceByContract(
      r.platform,
      r.contractAddress,
      r.timestampMs,
      r.fiatCurrency,
      r.coingeckoApiKey
    );
  }

  if (result.price == null && r.alchemyApiKey) {
    const alchemyResult = await fetchAlchemyHistoricalPriceUsd(
      r.alchemyApiKey,
      r.contractAddress && r.alchemyNetwork ? { network: r.alchemyNetwork, address: r.contractAddress } : { symbol: r.asset },
      r.timestampMs
    );
    if (alchemyResult.priceUsd != null) {
      const rate = await usdToCurrencyRate(r.timestampMs, r.fiatCurrency, r.coingeckoApiKey);
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
          error: `${result.error ? result.error + '; ' : ''}Alchemy found a USD price but historical FX conversion failed.`
        };
      }
    } else if (alchemyResult.error) {
      result = { ...result, error: `${result.error ? result.error + '; ' : ''}${alchemyResult.error}` };
    }
  }

  // Birdeye fallback: Solana tokens with a mint address and no price yet.
  if (result.price == null && r.birdeyeApiKey && r.chain === 'solana' && r.contractAddress) {
    const birdeyeResult = await fetchBirdeyeHistoricalPrice(r.birdeyeApiKey, r.contractAddress, r.timestampMs);
    if (birdeyeResult.priceUsd != null) {
      const rate = await usdToCurrencyRate(r.timestampMs, r.fiatCurrency, r.coingeckoApiKey);
      if (rate != null) {
        result = {
          asset: r.asset,
          date: toCoinGeckoDate(r.timestampMs),
          price: birdeyeResult.priceUsd * rate,
          currency: r.fiatCurrency
        };
      }
    } else if (birdeyeResult.error) {
      result = { ...result, error: `${result.error ? result.error + '; ' : ''}${birdeyeResult.error}` };
    }
  }

  return result;
}

function priceLookupKey(r: PriceRequest): string {
  const date = toCoinGeckoDate(r.timestampMs);
  return `${r.asset}|${date}|${r.fiatCurrency}|${r.contractAddress ?? ''}|${r.platform ?? ''}|${r.alchemyNetwork ?? ''}`;
}

/** Fetches unique asset/date pairs once, then maps results back. */
export async function fetchHistoricalPricesBatch(
  requests: PriceRequest[],
  onProgress?: (done: number, total: number) => void
): Promise<PriceLookupResult[]> {
  if (requests.length === 0) return [];

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

  const delayMs = requests[0]?.coingeckoApiKey ? 150 : 400;

  const keyResults = new Map<string, PriceLookupResult>();
  for (let i = 0; i < uniqueKeys.length; i++) {
    const key = uniqueKeys[i];
    // eslint-disable-next-line no-await-in-loop
    keyResults.set(key, await fetchOneHistoricalPrice(keyToRequest.get(key)!));
    onProgress?.(i + 1, uniqueKeys.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < uniqueKeys.length - 1) await new Promise((r2) => setTimeout(r2, delayMs));
  }

  return requestToKey.map((key) => keyResults.get(key)!);
}
