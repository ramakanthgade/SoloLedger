export type BlockworksAllocationRole =
  | 'mining_allocation' | 'mining_distribution' | 'ecosystem_fund'
  | 'team_allocation' | 'investor_allocation' | 'treasury'
  | 'staking_contract' | 'airdrop_contract' | 'reserve_fund'
  | 'community_fund' | 'foundation' | 'advisor_allocation'
  | 'partners_allocation' | 'marketing_fund' | 'liquidity_fund' | 'other';

export interface BlockworksEntry {
  address: string;
  role: BlockworksAllocationRole;
  label: string;
  symbol: string;
  projectName: string;
  coinId?: string;
  chain: string;
  sourceUrl: string;
  addedAt: number;
}

const SOURCE_URL = 'https://blockworks.com/token-transparency/filing/geodnet';
const ADDED_AT = 0;
export const BLOCKWORKS_ENTRIES: readonly BlockworksEntry[] = [
  { address: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f', role: 'mining_allocation', label: 'GEODnet Mining Allocation', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'polygon', sourceUrl: SOURCE_URL, addedAt: ADDED_AT },
  { address: '0x8fb9dd00b9a3d893da96d444817d0b77330d5478', role: 'mining_distribution', label: 'GEODnet Mining Distribution Wallet', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'polygon', sourceUrl: SOURCE_URL, addedAt: ADDED_AT },
  { address: '0x3a6906e4239f9860c81035c54198df58d892653b', role: 'ecosystem_fund', label: 'GEODnet Ecosystem Fund', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'polygon', sourceUrl: SOURCE_URL, addedAt: ADDED_AT },
  { address: '0xca3e874bc4e830796d822f529c29df30302324b2', role: 'team_allocation', label: 'GEODnet Team Allocation', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'polygon', sourceUrl: SOURCE_URL, addedAt: ADDED_AT },
  { address: '0x486559899e96981dfe55c4e6ebf5101a76bfadfa', role: 'investor_allocation', label: 'GEODnet Investor Allocation', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'polygon', sourceUrl: SOURCE_URL, addedAt: ADDED_AT },
  { address: '8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE', role: 'mining_distribution', label: 'GEODnet Solana Mining Distributor', symbol: 'GEOD', projectName: 'GEODnet', coinId: 'geodnet', chain: 'solana', sourceUrl: 'https://docs.geodnet.com/geod-token/geod-token-introduction', addedAt: ADDED_AT }
];

const CACHE_KEY = 'sololedger_blockworks_registry_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
interface CacheShape { fetchedAt: number; entries: BlockworksEntry[] }
let memoryCache: CacheShape | null = null;
function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function readEntries(): BlockworksEntry[] {
  if (memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) return memoryCache.entries;
  memoryCache = null;
  try {
    const raw = storage()?.getItem(CACHE_KEY);
    if (!raw) return [...BLOCKWORKS_ENTRIES];
    const parsed = JSON.parse(raw) as CacheShape;
    if (!Array.isArray(parsed.entries) || Date.now() - parsed.fetchedAt >= CACHE_TTL_MS) {
      storage()?.removeItem(CACHE_KEY);
      return [...BLOCKWORKS_ENTRIES];
    }
    memoryCache = parsed;
    return parsed.entries;
  } catch { return [...BLOCKWORKS_ENTRIES]; }
}
function normalize(address: string, chain?: string): string {
  return chain === 'solana' || !/^0x[0-9a-fA-F]{40}$/.test(address) ? address : address.toLowerCase();
}
export function lookupBlockworksAddress(address?: string, chain?: string) {
  if (!address) return null;
  const match = readEntries().find((entry) =>
    (!chain || entry.chain === chain) && normalize(entry.address, entry.chain) === normalize(address, entry.chain)
  );
  return match ? { role: match.role, label: match.label, symbol: match.symbol, projectName: match.projectName } : null;
}
export function getBlockworksContracts(): Record<string, { label: string; role: string }> {
  return Object.fromEntries(readEntries().filter((entry) => entry.chain !== 'solana').map((entry) =>
    [entry.address.toLowerCase(), {
      label: entry.label,
      role: entry.role === 'mining_distribution' ? 'rewards_source' : 'allocation_source'
    }]
  ));
}
export function getBlockworksCount(): number { return readEntries().length; }
export async function syncBlockworksRegistry(): Promise<{ entriesCount: number; message: string }> {
  const entries = [...BLOCKWORKS_ENTRIES];
  memoryCache = { fetchedAt: Date.now(), entries };
  try { storage()?.setItem(CACHE_KEY, JSON.stringify(memoryCache)); } catch { /* non-fatal */ }
  return { entriesCount: entries.length, message: `Blockworks registry: ${entries.length} verified allocation addresses` };
}
