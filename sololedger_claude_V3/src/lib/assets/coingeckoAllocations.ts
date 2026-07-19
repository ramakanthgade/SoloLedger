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

const CACHE_KEY = 'sololedger_coingecko_allocations_v1';
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
    const raw = storage()?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (!Number.isFinite(parsed?.fetchedAt) || !parsed.addresses || typeof parsed.addresses !== 'object') return null;
    memoryCache = parsed;
    return parsed;
  } catch { return null; }
}
function writeCache(addresses: Record<string, AllocationWallet>): void {
  memoryCache = { fetchedAt: Date.now(), addresses };
  try { storage()?.setItem(CACHE_KEY, JSON.stringify(memoryCache)); } catch { /* non-fatal */ }
}
export function clearAllocationCache(): void {
  memoryCache = null;
  try { storage()?.removeItem(CACHE_KEY); } catch { /* non-fatal */ }
}
export function lookupAllocationWallet(address?: string) {
  if (!address) return null;
  const entry = readCache()?.addresses[address.toLowerCase()];
  return entry ? { coinId: entry.coinId, label: entry.label, symbol: entry.symbol } : null;
}
export function getAllocationContracts(): Record<string, { label: string; role: string }> {
  return Object.fromEntries(Object.entries(readCache()?.addresses ?? {}).map(([address, entry]) =>
    [address, { label: `${entry.label} (${entry.symbol})`, role: 'rewards_source' }]
  ));
}
export function getAllocationCount(): number { return Object.keys(readCache()?.addresses ?? {}).length; }

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
  for (let page = 1; page <= 8; page++) {
    const response = await fetch(`${COINGECKO_PRO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, { headers });
    if (!response.ok) throw new Error(`CoinGecko API returned ${response.status}`);
    const marketRows = await response.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(marketRows) || marketRows.length === 0) break;
    for (const coin of marketRows.filter((row) => row.has_supply_breakdown === true)) {
      if (typeof coin.id !== 'string') continue;
      try {
        const detail = await fetch(`${COINGECKO_PRO_BASE}/coins/${encodeURIComponent(coin.id)}/supply_breakdown`, { headers });
        if (!detail.ok) continue;
        const payload = await detail.json() as { non_circulating_wallets?: Array<Record<string, unknown>> };
        for (const wallet of payload.non_circulating_wallets ?? []) {
          if (typeof wallet.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) continue;
          const address = wallet.address.toLowerCase();
          addresses[address] = {
            address,
            label: typeof wallet.label === 'string' ? wallet.label : `${String(coin.symbol ?? '').toUpperCase()} allocation`,
            coinId: coin.id,
            chain: 'ethereum',
            balance: Number(wallet.balance) || 0,
            percentageOfTotalSupply: Number(wallet.percentage_of_total_supply) || 0,
            symbol: String(coin.symbol ?? '').toUpperCase(),
            anomaly: wallet.anomaly === true,
            fetchedAt: Date.now()
          };
          coins.add(coin.id);
        }
      } catch { /* individual coin failures are non-fatal */ }
    }
  }
  writeCache(addresses);
  return { addresses, totalWallets: Object.keys(addresses).length, totalCoins: coins.size, message: `Synced ${Object.keys(addresses).length} allocation wallets from ${coins.size} coins`, fromCache: false };
}
