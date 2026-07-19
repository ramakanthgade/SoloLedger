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
export const COINGECKO_REWARD_DISCOVERY_LIMIT = 25;

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

const EXPLICIT_CATEGORY_SIGNALS: Array<{ pattern: RegExp; kind: RewardIncomeKind }> = [
  { pattern: /liquid staking|staking pool/i, kind: 'staking_reward' },
  { pattern: /proof of work|depin/i, kind: 'mining_reward' },
  { pattern: /yield farming|yield aggregator/i, kind: 'defi_reward' },
  { pattern: /airdrop/i, kind: 'airdrop' }
];
const DIRECT_REWARD_EVIDENCE = /\b(distribut(?:e[sd]?|ion)|paid|payouts?|claim(?:ed|able)?)\b.{0,80}\b(rewards?|incentives?|airdrop|yield)\b|\b(rewards?|incentives?|airdrop|yield)\b.{0,80}\b(distribut(?:e[sd]?|ion)|paid|payouts?|claim(?:ed|able)?)\b/i;

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

/** A category narrows candidates, but direct distribution language is required. */
export function deriveRewardSignal(categories: string[], description = ''):
  { kind: RewardIncomeKind; confidence: 'high' | 'medium' } | null {
  const categorySignal = EXPLICIT_CATEGORY_SIGNALS.find(({ pattern }) =>
    categories.some((category) => pattern.test(category))
  );
  if (!categorySignal || !DIRECT_REWARD_EVIDENCE.test(description)) return null;
  return { kind: categorySignal.kind, confidence: 'high' };
}

function normalizeAddress(address: string, chain: string): string {
  return chain === 'solana' ? address : address.toLowerCase();
}

export function classifyCoinGeckoReward(contractAddress?: string, chain?: string) {
  if (!contractAddress || !chain) return null;
  const match = readCache()?.entries.find((entry) =>
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
    // /coins/markets and /coins/{id} are documented public endpoints. We avoid
    // hard-coded category query values because CoinGecko category IDs change.
    const marketPayload = await fetchJson(
      `${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COINGECKO_REWARD_DISCOVERY_LIMIT}&page=1`,
      apiKey
    );
    if (!Array.isArray(marketPayload)) throw new Error('CoinGecko markets response had an unexpected schema');

    const candidates = marketPayload
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string'))
      .slice(0, COINGECKO_REWARD_DISCOVERY_LIMIT);
    const entries: CoinGeckoRewardEntry[] = [];
    const seen = new Set<string>();
    let metadataSucceeded = 0;

    for (const candidate of candidates) {
      try {
        const id = String(candidate.id);
        const full = await fetchJson(
          `${base}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
          apiKey
        ) as Record<string, unknown>;
        if (!full || typeof full !== 'object' || !Array.isArray(full.categories)) continue;
        metadataSucceeded++;
        const description = String((full.description as Record<string, unknown> | undefined)?.en ?? '');
        const signal = deriveRewardSignal(full.categories.filter((value): value is string => typeof value === 'string'), description);
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
            coinId: id,
            symbol: String(candidate.symbol ?? '').toUpperCase(),
            kind: signal.kind,
            confidence: signal.confidence,
            label: `${String(candidate.name ?? id)} possible reward token`,
            createdAt: Date.now()
          });
        }
      } catch { /* one coin must not abort the registry sync */ }
    }

    if (candidates.length > 0 && metadataSucceeded === 0) {
      throw new Error('CoinGecko coin metadata could not be read');
    }
    // A valid empty scan is deliberately not persisted for seven days; a later
    // lookup can retry as CoinGecko metadata evolves.
    if (entries.length > 0) writeCache(entries);
    return summary(entries, false, candidates.length, new Set(entries.map((entry) => entry.coinId)).size);
  })().catch((error) => {
    if (cached) return { ...summary(cached.entries, true), message: 'CoinGecko unavailable; using cached reward registry' };
    throw error;
  }).finally(() => { inFlight = null; });

  return inFlight;
}

export function syncCoinGeckoRewardRegistryInBackground(apiKey?: string): void {
  void syncCoinGeckoRewardRegistry(apiKey).catch(() => { /* wallet lookup must remain non-fatal */ });
}
