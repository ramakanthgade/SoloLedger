import { getStore, saveStore, type ServerApiKeys } from './store.js';

const ENV_MAP: Record<keyof ServerApiKeys, string> = {
  alchemyApiKey: 'ALCHEMY_API_KEY',
  coingeckoApiKey: 'COINGECKO_API_KEY',
  heliusApiKey: 'HELIUS_API_KEY',
  moralisApiKey: 'MORALIS_API_KEY',
  birdeyeApiKey: 'BIRDEYE_API_KEY',
  novesApiKey: 'NOVES_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  etherscanApiKey: 'ETHERSCAN_API_KEY'
};

export type ApiKeyName = keyof ServerApiKeys;

export function getStoredApiKeys(): ServerApiKeys {
  return { ...(getStore().apiKeys ?? {}) };
}

/** UI-managed keys override .env when set in store. */
export function resolveApiKey(name: ApiKeyName): string | undefined {
  const stored = getStore().apiKeys?.[name]?.trim();
  if (stored) return stored;
  const env = process.env[ENV_MAP[name]]?.trim();
  return env || undefined;
}

export function updateStoredApiKeys(patch: Partial<ServerApiKeys>): ServerApiKeys {
  const store = getStore();
  const next: ServerApiKeys = { ...(store.apiKeys ?? {}) };
  for (const [k, v] of Object.entries(patch) as [ApiKeyName, string | undefined][]) {
    if (v === undefined || v === '') delete next[k];
    else next[k] = v.trim();
  }
  saveStore({ ...store, apiKeys: next });
  return next;
}

export function deleteStoredApiKey(name: ApiKeyName): ServerApiKeys {
  const store = getStore();
  const next = { ...(store.apiKeys ?? {}) };
  delete next[name];
  saveStore({ ...store, apiKeys: next });
  return next;
}

export function apiKeysStatus(): Record<ApiKeyName, boolean> {
  const names = Object.keys(ENV_MAP) as ApiKeyName[];
  return Object.fromEntries(names.map((n) => [n, Boolean(resolveApiKey(n))])) as Record<ApiKeyName, boolean>;
}
