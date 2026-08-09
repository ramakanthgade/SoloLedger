/**
 * Historical price lookup via CoinGecko (free or Pro API), with Alchemy Prices
 * fallback for DEX-only tokens. Sends coin id + date — never wallet addresses.
 */
import { fetchAlchemyHistoricalPriceUsd } from './alchemyPrices';
import { fetchBirdeyeHistoricalPrice } from './birdeye';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import { getCachedPrice, setCachedPrice, buildPriceCacheKey } from '@/lib/storage/db';
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

const COINGECKO_PUBLIC = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO = 'https://pro-api.coingecko.com/api/v3';

function coingeckoBase(apiKey?: string): string {
  if (isSaasMode()) return `${getApiBase()}/api/proxy/coingecko`;
  return apiKey?.trim() ? COINGECKO_PRO : COINGECKO_PUBLIC;
}

function coingeckoHeaders(apiKey?: string): HeadersInit | undefined {
  if (isSaasMode()) return undefined;
  const key = apiKey?.trim();
  return key ? { 'x-cg-pro-api-key': key } : undefined;
}

const RETRYABLE_COINGECKO_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const fromHeader = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader, 10_000);
  }
  return Math.min(800 * (2 ** attempt), 5_000);
}

async function coingeckoFetch(url: string, headers?: HeadersInit, retries = 2): Promise<Response> {
  let last: Response | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      recordNetworkActivity(resolveMode(isSaasMode()));
      const res = isSaasMode()
        ? await saasProxyFetch(url.replace(getApiBase(), ''), headers ? { headers } : {})
        : await fetch(url, headers ? { headers } : undefined);
      last = res;
      if (!RETRYABLE_COINGECKO_STATUSES.has(res.status) || attempt === retries) return res;
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(last, attempt)));
  }
  if (last) return last;
  throw lastError;
}

// CoinGecko internal coin ids (not tickers). Extended set + dynamic search fallback.
const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  WBTC: 'wrapped-bitcoin',
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
  FIL: 'filecoin',
  LPT: 'livepeer',
  GRT: 'the-graph',
  FTT: 'ftx-token',
  DASH: 'dash',
  HNT: 'helium',
  ZEC: 'zcash',
  LINK: 'chainlink',
  UNI: 'uniswap',
  ROSE: 'oasis-network',
  RCN: 'ripio-credit-network',
  XPR: 'proton',
  ATOM: 'cosmos',
  NEAR: 'near',
  APT: 'aptos',
  ARB: 'arbitrum',
  OP: 'optimism',
  INJ: 'injective-protocol',
  SUI: 'sui',
  SEI: 'sei-network',
  TIA: 'celestia',
  RENDER: 'render-token',
  FET: 'fetch-ai',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AAVE: 'aave',
  MKR: 'maker',
  CRV: 'curve-dao-token',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  SUSHI: 'sushi',
  YFI: 'yearn-finance',
  BCH: 'bitcoin-cash',
  ETC: 'ethereum-classic',
  XLM: 'stellar',
  TRX: 'tron',
  XMR: 'monero',
  ALGO: 'algorand',
  VET: 'vechain',
  ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph',
  EOS: 'eos',
  XTZ: 'tezos',
  THETA: 'theta-token',
  EGLD: 'elrond-erd-2',
  FLOW: 'flow',
  KAVA: 'kava',
  RUNE: 'thorchain',
  KSM: 'kusama',
  ZIL: 'zilliqa',
  ENJ: 'enjincoin',
  CHZ: 'chiliz',
  BAT: 'basic-attention-token',
  ZRX: '0x',
  PUNDIX: 'pundi-x-2',
  KNC: 'kyber-network-crystal',
  KNCL: 'kyber-network',
  BTT: 'bittorrent',
  BTTOLD: 'bittorrent-old',
  BTTC: 'bittorrent',
  POWR: 'power-ledger',
  NPXS: 'pundi-x',
  // Native assets of the newer supported chains (see rpc/providers CHAINS).
  FTM: 'fantom',
  CELO: 'celo',
  GLMR: 'moonbeam',
  MOVR: 'moonriver',
  METIS: 'metis-token',
  CRO: 'crypto-com-chain',
  XDAI: 'xdai',
  MNT: 'mantle',
  STRK: 'starknet',
  // Plan v7.1 chains (ids verified against CoinGecko 2026-07-21). SEI is
  // already mapped above; ETH-native chains resolve via ETH.
  BERA: 'berachain-bera',
  HYPE: 'hyperliquid',
  MON: 'monad',
  APE: 'apecoin',
  ANIME: 'anime',
  GHO: 'gho',
  RON: 'ronin',
  ZETA: 'zetachain',
  MYTH: 'mythos',
  // Story (IP) rebranded to Data Network (DATA) on CoinGecko — same asset,
  // id 'story-2'; the on-chain native symbol stays IP.
  IP: 'story-2',
  RBTC: 'rootstock',
  // Fraxtal gas token: Frax (prev. FXS) after the North Star rebrand.
  FRAX: 'frax-share',
  S: 'sonic-3',
  XPL: 'plasma',
  USDT0: 'usdt0'
};

const COIN_ID_CACHE_KEY = 'sololedger_gecko_coin_ids';
const runtimeCoinIdCache = new Map<string, string>();

// Identity-free exchange symbols are unsafe while old/new assets coexisted.
// Binance kept old BTT activity through Jan 17 and started BTTC trading Jan 21.
const BTT_AMBIGUITY_START = Date.UTC(2022, 0, 12);
const BTT_AMBIGUITY_END = Date.UTC(2022, 0, 20);
// KNC migration began Apr 20; exchanges migrated on different schedules.
// Keep the overlap conservative through Kraken's new-contract reopening Jun 23.
const KNC_AMBIGUITY_START = Date.UTC(2021, 3, 20);
const KNC_AMBIGUITY_END = Date.UTC(2021, 5, 23);
const LEGACY_KNC_CONTRACT = '0xdd974d5c2e2928dea5f71b9825b8b646686bd200';
const CURRENT_KNC_CONTRACT = '0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202';
const LEGACY_BTT_IDENTITIES = new Set(['1002000']);
const CURRENT_BTT_IDENTITIES = new Set(['tafjulxivgt4qwk6uzwjqwzxtsagaqnvp4']);

/**
 * Return a migration-aware canonical id. `null` means the migration day is
 * genuinely ambiguous without token identity; `undefined` delegates to the
 * ordinary canonical/search resolver.
 */
function historicalCanonicalId(
  symbol: string,
  timestampMs: number,
  contractAddress?: string,
  source?: string
): string | null | undefined {
  const upper = symbol.trim().toUpperCase();
  if (upper === 'POWR') return 'power-ledger';
  if (upper === 'BTTOLD') return 'bittorrent-old';
  if (upper === 'BTTC') return 'bittorrent';
  if (upper === 'KNCL') return 'kyber-network';
  const identity = contractAddress?.trim().toLowerCase();
  const timestamp = new Date(timestampMs);
  const day = Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate());
  const binanceSource = source === 'binance' || source === 'binance_spot' ||
    source === 'binance_transfers' || source === 'binance_api';
  if (upper === 'BTT') {
    if (identity && LEGACY_BTT_IDENTITIES.has(identity)) return 'bittorrent-old';
    if (identity && CURRENT_BTT_IDENTITIES.has(identity)) return 'bittorrent';
    if (binanceSource && day <= Date.UTC(2022, 0, 17)) return 'bittorrent-old';
    if (day >= BTT_AMBIGUITY_START && day <= BTT_AMBIGUITY_END) return null;
    return day < BTT_AMBIGUITY_START ? 'bittorrent-old' : 'bittorrent';
  }
  if (upper === 'KNC') {
    if (identity === LEGACY_KNC_CONTRACT) return 'kyber-network';
    if (identity === CURRENT_KNC_CONTRACT) return 'kyber-network-crystal';
    if (day >= KNC_AMBIGUITY_START && day <= KNC_AMBIGUITY_END) return null;
    return day < KNC_AMBIGUITY_START ? 'kyber-network' : 'kyber-network-crystal';
  }
  return undefined;
}

function loadStoredCoinIds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(COIN_ID_CACHE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function saveStoredCoinId(symbol: string, coinId: string): void {
  const stored = loadStoredCoinIds();
  stored[symbol.toUpperCase()] = coinId;
  localStorage.setItem(COIN_ID_CACHE_KEY, JSON.stringify(stored));
}

/** Resolve ticker → CoinGecko coin id via built-in map, then /search fallback. */
async function resolveCoinGeckoId(symbol: string, coingeckoApiKey?: string): Promise<string | null> {
  const upper = symbol.toUpperCase();
  if (SYMBOL_TO_ID[upper]) return SYMBOL_TO_ID[upper];
  if (runtimeCoinIdCache.has(upper)) return runtimeCoinIdCache.get(upper)!;

  const stored = loadStoredCoinIds();
  if (stored[upper]) {
    runtimeCoinIdCache.set(upper, stored[upper]);
    SYMBOL_TO_ID[upper] = stored[upper];
    return stored[upper];
  }

  try {
    const base = coingeckoBase(coingeckoApiKey);
    const res = await fetchWithRetry(
      `${base}/search?query=${encodeURIComponent(symbol)}`,
      coingeckoHeaders(coingeckoApiKey)
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      coins?: { id: string; symbol: string; market_cap_rank?: number }[];
    };
    const exact = (data.coins ?? []).filter((c) => c.symbol.toUpperCase() === upper);
    if (exact.length === 0) return null;
    exact.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    const id = exact[0].id;
    SYMBOL_TO_ID[upper] = id;
    runtimeCoinIdCache.set(upper, id);
    saveStoredCoinId(upper, id);
    return id;
  } catch {
    return null;
  }
}

export interface CurrentPriceResult {
  asset: string;
  price: number | null;
  currency: string;
  error?: string;
  /** Present only for exact-contract current price responses. */
  platform?: string;
}

/** Batch current spot prices. This is valuation-only and never mutates tax rows. */
export async function fetchCurrentPrices(
  assets: string[],
  fiatCurrency: string,
  coingeckoApiKey?: string
): Promise<CurrentPriceResult[]> {
  const unique = [...new Set(assets.map((asset) => asset.toUpperCase()))];
  const resolved = await Promise.all(
    unique.map(async (asset) => ({ asset, id: await resolveCoinGeckoId(asset, coingeckoApiKey) }))
  );
  const ids = [...new Set(resolved.flatMap((row) => row.id ? [row.id] : []))];
  if (ids.length === 0) {
    return resolved.map(({ asset }) => ({ asset, price: null, currency: fiatCurrency, error: 'CoinGecko asset not found.' }));
  }
  try {
    const base = coingeckoBase(coingeckoApiKey);
    const currency = fiatCurrency.toLowerCase();
    const url = `${base}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=${encodeURIComponent(currency)}`;
    const res = await fetchWithRetry(url, coingeckoHeaders(coingeckoApiKey));
    if (!res.ok) {
      return resolved.map(({ asset }) => ({ asset, price: null, currency: fiatCurrency, error: `Price API returned ${res.status}` }));
    }
    const data = await res.json() as Record<string, Record<string, number | undefined> | undefined>;
    return resolved.map(({ asset, id }) => ({
      asset,
      price: id ? data[id]?.[currency] ?? null : null,
      currency: fiatCurrency,
      error: id ? undefined : 'CoinGecko asset not found.'
    }));
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Network request failed.';
    return resolved.map(({ asset }) => ({ asset, price: null, currency: fiatCurrency, error }));
  }
}

export interface CurrentContractPriceRequest {
  contractAddress: string;
  platform: string;
}

/** Current marks keyed by an exact contract address; never resolves by ticker. */
export async function fetchCurrentContractPrices(
  requests: CurrentContractPriceRequest[],
  fiatCurrency: string,
  coingeckoApiKey?: string
): Promise<CurrentPriceResult[]> {
  const currency = fiatCurrency.toLowerCase();
  const results: CurrentPriceResult[] = [];
  for (const { contractAddress, platform } of requests) {
    const address = contractAddress.trim().toLowerCase();
    try {
      const base = coingeckoBase(coingeckoApiKey);
      const url = `${base}/simple/token_price/${encodeURIComponent(platform)}?contract_addresses=${encodeURIComponent(address)}&vs_currencies=${encodeURIComponent(currency)}`;
      const res = await fetchWithRetry(url, coingeckoHeaders(coingeckoApiKey));
      if (!res.ok) {
        results.push({ asset: address, platform, price: null, currency: fiatCurrency, error: `Price API returned ${res.status} for contract lookup` });
        continue;
      }
      const data = await res.json() as Record<string, Record<string, number | undefined> | undefined>;
      results.push({ asset: address, platform, price: data[address]?.[currency] ?? null, currency: fiatCurrency });
    } catch (err) {
      results.push({
        asset: address, platform, price: null, currency: fiatCurrency,
        error: err instanceof Error ? err.message : 'Network request failed.'
      });
    }
  }
  return results;
}

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
  return coingeckoFetch(url, headers, retries);
}

/**
 * Historical fiat price for one asset on one date via /coins/{id}/history.
 * USDC, USDT, etc. return the price in your reporting currency (INR, USD, …) for that date.
 */
export async function fetchHistoricalPrice(
  assetSymbol: string,
  timestampMs: number,
  fiatCurrency: string,
  coingeckoApiKey?: string,
  contractAddress?: string,
  source?: string
): Promise<PriceLookupResult> {
  const date = toCoinGeckoDate(timestampMs);
  const canonical = historicalCanonicalId(assetSymbol, timestampMs, contractAddress, source);
  const coinId = canonical === undefined
    ? await resolveCoinGeckoId(assetSymbol, coingeckoApiKey)
    : canonical;

  if (!coinId) {
    return {
      asset: assetSymbol,
      date,
      price: null,
      currency: fiatCurrency,
      error: `Could not resolve CoinGecko id for "${assetSymbol}".`
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
  /** Import source used only to avoid guessing identity during exchange migration overlap. */
  source?: string;
  coingeckoApiKey?: string;
  alchemyApiKey?: string;
  alchemyNetwork?: string;
  /** Birdeye API key — fallback for Solana long-tail tokens after CoinGecko+Alchemy fail. */
  birdeyeApiKey?: string;
}

const usdRateCache = new Map<string, number>();

/** Historical USD → reporting currency on a specific date (via USDT price in that currency). */
export async function usdToCurrencyRate(
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
  const date = toCoinGeckoDate(r.timestampMs);
  const canonicalId = historicalCanonicalId(normalizedAsset, r.timestampMs, r.contractAddress, r.source);

  if (canonicalId === null) {
    return {
      asset: r.asset, date, price: null, currency: r.fiatCurrency,
      error: `Historical ${normalizedAsset.toUpperCase()} identity is ambiguous during its exchange migration window; explicit symbol or contract identity is required.`
    };
  }

  // --- Check persistent IndexedDB cache first (historical prices never change) ---
  const cacheKey = r.contractAddress && r.platform
    ? canonicalId != null
      ? `ctr:v2:${canonicalId}:${r.platform}:${r.contractAddress.toLowerCase()}:${date}:${r.fiatCurrency.toUpperCase()}`
      : buildPriceCacheKey('ctr', r.contractAddress, date, r.fiatCurrency, r.platform)
    : canonicalId != null
      ? `sym:v2:${canonicalId}:${date}:${r.fiatCurrency.toUpperCase()}`
      : buildPriceCacheKey('sym', normalizedAsset, date, r.fiatCurrency);
  const cached = await getCachedPrice(cacheKey);
  if (cached != null) {
    return { asset: r.asset, date, price: cached, currency: r.fiatCurrency };
  }

  let result = await fetchHistoricalPrice(
    normalizedAsset, r.timestampMs, r.fiatCurrency, r.coingeckoApiKey, r.contractAddress, r.source
  );

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

  // Store successful result in persistent cache for future imports.
  if (result.price != null) {
    void setCachedPrice(cacheKey, result.price);
    return result;
  }

  // Birdeye fallback: Solana tokens with a mint address and no price yet.
  if (r.birdeyeApiKey && r.chain === 'solana' && r.contractAddress) {
    const birdeyeResult = await fetchBirdeyeHistoricalPrice(r.birdeyeApiKey, r.contractAddress, r.timestampMs);
    if (birdeyeResult.priceUsd != null) {
      const rate = await usdToCurrencyRate(r.timestampMs, r.fiatCurrency, r.coingeckoApiKey);
      if (rate != null) {
        const birdeyePrice = birdeyeResult.priceUsd * rate;
        void setCachedPrice(cacheKey, birdeyePrice);
        result = { asset: r.asset, date, price: birdeyePrice, currency: r.fiatCurrency };
      }
    } else if (birdeyeResult.error) {
      result = { ...result, error: `${result.error ? result.error + '; ' : ''}${birdeyeResult.error}` };
    }
  }

  return result;
}

function priceLookupKey(r: PriceRequest): string {
  const date = toCoinGeckoDate(r.timestampMs);
  return `${r.asset}|${date}|${r.fiatCurrency}|${r.contractAddress ?? ''}|${r.platform ?? ''}|${r.alchemyNetwork ?? ''}|${r.source ?? ''}`;
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
