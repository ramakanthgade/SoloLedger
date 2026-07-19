export interface AllocationWallet {
  address: string;
  label: string;
  coinId: string;
  chain: string;
  balance: number;
  percentageOfTotalSupply: number;
  symbol: string;
  anomaly: boolean;
  fetchedAt: number;
}

export interface AllocationsResult {
  addresses: Record<string, AllocationWallet>;
  totalWallets: number;
  totalCoins: number;
  message: string;
  fromCache: boolean;
}

export const COINGECKO_ALLOCATION_CACHE_KEY = 'sololedger_coingecko_allocations_v1';
export const COINGECKO_ALLOCATION_DISCOVERY_LIMIT = 20;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
interface CacheShape { fetchedAt: number; addresses: Record<string, AllocationWallet> }
let memoryCache: CacheShape | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function readCache(): CacheShape | null {
  if (memoryCache) return memoryCache;
  try {
    const raw = storage()?.getItem(COINGECKO_ALLOCATION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (!Number.isFinite(parsed?.fetchedAt) || !parsed.addresses || typeof parsed.addresses !== 'object') return null;
    memoryCache = parsed;
    return parsed;
  } catch { return null; }
}
function writeCache(addresses: Record<string, AllocationWallet>): void {
  memoryCache = { fetchedAt: Date.now(), addresses };
  try { storage()?.setItem(COINGECKO_ALLOCATION_CACHE_KEY, JSON.stringify(memoryCache)); } catch { /* non-fatal */ }
}
export function clearAllocationCache(): void {
  memoryCache = null;
  try { storage()?.removeItem(COINGECKO_ALLOCATION_CACHE_KEY); } catch { /* non-fatal */ }
}
export function lookupAllocationWallet(address?: string) {
  if (!address) return null;
  const entry = readCache()?.addresses[address.toLowerCase()];
  return entry ? { coinId: entry.coinId, label: entry.label, symbol: entry.symbol } : null;
}
export function getAllocationContracts(): Record<string, { label: string; role: string }> {
  return Object.fromEntries(Object.entries(readCache()?.addresses ?? {}).map(([address, entry]) =>
    [address, { label: `${entry.label} (${entry.symbol})`, role: 'allocation_source' }]
  ));
}
export function getAllocationCount(): number { return Object.keys(readCache()?.addresses ?? {}).length; }

async function fetchJson(url: string, headers: HeadersInit): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, { headers });
  if (response.status === 404) return { status: 404, payload: null };
  if (!response.ok) throw new Error(`CoinGecko API returned ${response.status}`);
  return { status: response.status, payload: await response.json() };
}

export async function syncCoinGeckoAllocations(apiKey: string, options: { force?: boolean } = {}): Promise<AllocationsResult> {
  const cached = readCache();
  if (!options.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    const entries = Object.values(cached.addresses);
    return { addresses: cached.addresses, totalWallets: entries.length, totalCoins: new Set(entries.map((e) => e.coinId)).size, message: `Using cached allocation data (${entries.length} wallets)`, fromCache: true };
  }
  if (!apiKey.trim()) throw new Error('CoinGecko Pro API key required');
  const headers = { 'x-cg-pro-api-key': apiKey.trim() };
  const addresses: Record<string, AllocationWallet> = {};
  const coins = new Set<string>();

  // Discover a bounded set of coin IDs from the documented markets endpoint,
  // then inspect documented /coins/{id} metadata for has_supply_breakdown.
  const markets = await fetchJson(
    `${COINGECKO_PRO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COINGECKO_ALLOCATION_DISCOVERY_LIMIT}&page=1`,
    headers
  );
  if (!Array.isArray(markets.payload)) throw new Error('CoinGecko markets response had an unexpected schema');
  const candidates = markets.payload
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string'))
    .slice(0, COINGECKO_ALLOCATION_DISCOVERY_LIMIT);
  let metadataSucceeded = 0;
  let breakdownCandidates = 0;
  let breakdownSchemasRead = 0;

  for (const coin of candidates) {
    const id = String(coin.id);
    try {
      const metadata = await fetchJson(
        `${COINGECKO_PRO_BASE}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
        headers
      );
      if (!metadata.payload || typeof metadata.payload !== 'object') continue;
      metadataSucceeded++;
      const detail = metadata.payload as Record<string, unknown>;
      if (detail.has_supply_breakdown !== true) continue;
      breakdownCandidates++;

      const breakdown = await fetchJson(`${COINGECKO_PRO_BASE}/coins/${encodeURIComponent(id)}/supply_breakdown`, headers);
      if (breakdown.status === 404) continue;
      if (!breakdown.payload || typeof breakdown.payload !== 'object') continue;
      const wallets = (breakdown.payload as { non_circulating_wallets?: unknown }).non_circulating_wallets;
      if (!Array.isArray(wallets)) continue;
      breakdownSchemasRead++;

      for (const value of wallets) {
        if (!value || typeof value !== 'object') continue;
        const wallet = value as Record<string, unknown>;
        if (typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) continue;
        const address = wallet.address.toLowerCase();
        addresses[address] = {
          address,
          label: typeof wallet.label === 'string' ? wallet.label : `${String(coin.symbol ?? '').toUpperCase()} allocation`,
          coinId: id,
          chain: 'ethereum',
          balance: Number(wallet.balance) || 0,
          percentageOfTotalSupply: Number(wallet.percentage_of_total_supply) || 0,
          symbol: String(coin.symbol ?? '').toUpperCase(),
          anomaly: wallet.anomaly === true,
          fetchedAt: Date.now()
        };
        coins.add(id);
      }
    } catch { /* one coin must not abort bounded discovery */ }
  }

  if (candidates.length > 0 && metadataSucceeded === 0) {
    throw new Error('CoinGecko coin metadata could not be read');
  }
  if (breakdownCandidates > 0 && breakdownSchemasRead === 0) {
    throw new Error('CoinGecko supply breakdown responses could not be read');
  }
  // Never turn an empty or inconclusive discovery into a fresh seven-day cache.
  if (Object.keys(addresses).length > 0) writeCache(addresses);
  return { addresses, totalWallets: Object.keys(addresses).length, totalCoins: coins.size, message: `Synced ${Object.keys(addresses).length} allocation wallets from ${coins.size} coins`, fromCache: false };
}
