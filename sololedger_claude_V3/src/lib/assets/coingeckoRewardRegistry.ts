export type RewardIncomeKind = 'staking_reward' | 'mining_reward' | 'defi_reward' | 'airdrop';

export interface CoinGeckoRewardEntry {
  contractAddress: string;
  chain: string;
  coinId: string;
  symbol: string;
  kind: RewardIncomeKind;
  confidence: 'high' | 'medium';
  label: string;
  createdAt: number;
}

export interface SyncResult {
  entriesCount: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  coinsChecked: number;
  coinsMatched: number;
  fromCache: boolean;
  message: string;
}

export const COINGECKO_REWARD_CACHE_KEY = 'sololedger_coingecko_reward_registry_v1';
export const COINGECKO_REWARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COINGECKO_PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
export const COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

const CHAIN_MAP: Record<string, string> = {
  ethereum: 'ethereum',
  'polygon-pos': 'polygon',
  'arbitrum-one': 'arbitrum',
  base: 'base',
  'optimistic-ethereum': 'optimism',
  'binance-smart-chain': 'bsc',
  avalanche: 'avalanche',
  solana: 'solana'
};

const CATEGORY_SIGNALS: Record<string, RewardIncomeKind> = {
  staking: 'staking_reward',
  'liquid-staking-tokens': 'staking_reward',
  depin: 'mining_reward',
  'proof-of-work-pow': 'mining_reward',
  'yield-farming': 'defi_reward',
  'yield-aggregator': 'defi_reward'
};
const REWARD_WORDS = /\b(reward|staking|staked|mine|mining|yield|airdrop|incentive|farming)\b/i;

interface CacheShape { fetchedAt: number; entries: CoinGeckoRewardEntry[] }
let memoryCache: CacheShape | null = null;
let inFlight: Promise<SyncResult> | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function validEntry(value: unknown): value is CoinGeckoRewardEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as CoinGeckoRewardEntry;
  return typeof entry.contractAddress === 'string' && typeof entry.chain === 'string' &&
    typeof entry.coinId === 'string' && typeof entry.symbol === 'string' &&
    ['staking_reward', 'mining_reward', 'defi_reward', 'airdrop'].includes(entry.kind) &&
    ['high', 'medium'].includes(entry.confidence);
}

function readCache(): CacheShape | null {
  if (memoryCache) return memoryCache;
  try {
    const raw = storage()?.getItem(COINGECKO_REWARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (!Number.isFinite(parsed?.fetchedAt) || !Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries.filter(validEntry);
    if (parsed.entries.length > 0 && entries.length === 0) return null;
    memoryCache = { fetchedAt: parsed.fetchedAt, entries };
    return memoryCache;
  } catch { return null; }
}

function writeCache(entries: CoinGeckoRewardEntry[]): void {
  memoryCache = { fetchedAt: Date.now(), entries };
  try { storage()?.setItem(COINGECKO_REWARD_CACHE_KEY, JSON.stringify(memoryCache)); } catch { /* non-fatal */ }
}

export function clearCoinGeckoRewardCache(): void {
  memoryCache = null;
  inFlight = null;
  try { storage()?.removeItem(COINGECKO_REWARD_CACHE_KEY); } catch { /* non-fatal */ }
}

/** Broad "DeFi" membership is intentionally not a reward signal. */
export function deriveRewardSignal(categories: string[], description = ''):
  { kind: RewardIncomeKind; confidence: 'high' | 'medium' } | null {
  for (const category of categories) {
    const kind = CATEGORY_SIGNALS[category.toLowerCase()];
    if (kind) return { kind, confidence: 'high' };
  }
  return REWARD_WORDS.test(description) ? { kind: 'defi_reward', confidence: 'medium' } : null;
}

function normalizeAddress(address: string, chain: string): string {
  return chain === 'solana' ? address : address.toLowerCase();
}

export function classifyCoinGeckoReward(contractAddress?: string, chain?: string) {
  if (!contractAddress || !chain) return null;
  const cache = readCache();
  if (!cache) return null;
  const match = cache.entries.find((entry) =>
    CHAIN_MAP[entry.chain] === chain &&
    entry.contractAddress === normalizeAddress(contractAddress, chain)
  );
  return match ? { kind: match.kind, confidence: match.confidence, label: match.label } : null;
}

export function getCoinGeckoRewardEntries(chain?: string): CoinGeckoRewardEntry[] {
  const entries = readCache()?.entries ?? [];
  return chain ? entries.filter((entry) => CHAIN_MAP[entry.chain] === chain) : entries;
}

export function getCoinGeckoRewardCount(): number { return readCache()?.entries.length ?? 0; }

function summary(entries: CoinGeckoRewardEntry[], fromCache: boolean, coinsChecked = 0, coinsMatched = 0): SyncResult {
  return {
    entriesCount: entries.length,
    highConfidenceCount: entries.filter((entry) => entry.confidence === 'high').length,
    mediumConfidenceCount: entries.filter((entry) => entry.confidence === 'medium').length,
    coinsChecked,
    coinsMatched,
    fromCache,
    message: `${fromCache ? 'Using cached' : 'Synced'} reward registry (${entries.length} token addresses)`
  };
}

async function fetchJson(url: string, apiKey?: string): Promise<unknown> {
  const headers = apiKey?.trim() ? { 'x-cg-pro-api-key': apiKey.trim() } : undefined;
  const response = await fetch(url, headers ? { headers } : undefined);
  if (!response.ok) throw new Error(`CoinGecko API returned ${response.status}`);
  return response.json();
}

export async function syncCoinGeckoRewardRegistry(
  apiKey?: string,
  options: { force?: boolean } = {}
): Promise<SyncResult> {
  const cached = readCache();
  if (!options.force && cached && Date.now() - cached.fetchedAt < COINGECKO_REWARD_CACHE_TTL_MS) {
    return summary(cached.entries, true);
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const base = apiKey?.trim() ? COINGECKO_PRO_BASE : COINGECKO_PUBLIC_BASE;
    const candidates = new Map<string, { id: string; symbol: string; name: string; categories: string[] }>();
    for (const category of Object.keys(CATEGORY_SIGNALS)) {
      const url = `${base}/coins/markets?vs_currency=usd&category=${encodeURIComponent(category)}&order=market_cap_desc&per_page=25&page=1`;
      const rows = await fetchJson(url, apiKey);
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Array<Record<string, unknown>>) {
        if (typeof row.id !== 'string') continue;
        const existing = candidates.get(row.id);
        candidates.set(row.id, {
          id: row.id,
          symbol: typeof row.symbol === 'string' ? row.symbol : '',
          name: typeof row.name === 'string' ? row.name : row.id,
          categories: [...(existing?.categories ?? []), category]
        });
      }
    }

    const entries: CoinGeckoRewardEntry[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates.values()) {
      try {
        const full = await fetchJson(`${base}/coins/${encodeURIComponent(candidate.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, apiKey) as Record<string, unknown>;
        const signal = deriveRewardSignal(candidate.categories, String((full.description as Record<string, unknown> | undefined)?.en ?? ''));
        const platforms = full.platforms;
        if (!signal || !platforms || typeof platforms !== 'object') continue;
        for (const [platform, rawAddress] of Object.entries(platforms as Record<string, unknown>)) {
          if (!CHAIN_MAP[platform] || typeof rawAddress !== 'string' || !rawAddress) continue;
          const address = normalizeAddress(rawAddress, CHAIN_MAP[platform]);
          const key = `${platform}:${address}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({
            contractAddress: address,
            chain: platform,
            coinId: candidate.id,
            symbol: candidate.symbol.toUpperCase(),
            kind: signal.kind,
            confidence: signal.confidence,
            label: `${candidate.name} possible reward`,
            createdAt: Date.now()
          });
        }
      } catch { /* individual coin failures are non-fatal */ }
    }
    writeCache(entries);
    return summary(entries, false, candidates.size, new Set(entries.map((entry) => entry.coinId)).size);
  })().catch((error) => {
    if (cached) return { ...summary(cached.entries, true), message: 'CoinGecko unavailable; using cached reward registry' };
    throw error;
  }).finally(() => { inFlight = null; });

  return inFlight;
}

export function syncCoinGeckoRewardRegistryInBackground(apiKey?: string): void {
  void syncCoinGeckoRewardRegistry(apiKey).catch(() => { /* wallet lookup must remain non-fatal */ });
}
