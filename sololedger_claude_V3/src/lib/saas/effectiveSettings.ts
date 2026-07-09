import { getSettings } from '@/lib/storage/db';
import type { TaxSettings } from '@/types/transaction';
import { isSaasMode } from './config';
import { fetchPublicConfig, type PublicServerConfig } from './api';

let cachedConfig: PublicServerConfig | null = null;
let configFetchedAt = 0;
const CONFIG_TTL_MS = 60_000;

async function getServerConfig(): Promise<PublicServerConfig | null> {
  if (!isSaasMode()) return null;
  const now = Date.now();
  if (cachedConfig && now - configFetchedAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    cachedConfig = await fetchPublicConfig();
    configFetchedAt = now;
    return cachedConfig;
  } catch {
    return cachedConfig;
  }
}

/** Settings merged with admin-controlled network features in SaaS mode. API keys never returned. */
export async function getEffectiveSettings(): Promise<TaxSettings> {
  const local = await getSettings();
  if (!isSaasMode()) return local;

  const server = await getServerConfig();
  return {
    jurisdiction: local.jurisdiction,
    reportingCurrency: local.reportingCurrency,
    defaultCostBasisMethod: local.defaultCostBasisMethod,
    priceApiEnabled: server?.priceApiEnabled ?? true,
    rpcLookupEnabled: server?.rpcLookupEnabled ?? true,
    aiModel: local.aiModel
    // API keys intentionally omitted — server proxy injects them
  };
}

export function hasWalletLookupKeys(settings: TaxSettings): boolean {
  if (isSaasMode()) return true;
  return Boolean(settings.heliusApiKey || settings.moralisApiKey || settings.alchemyApiKey);
}

export function hasPriceLookupKeys(settings: TaxSettings): boolean {
  if (isSaasMode()) return true;
  return Boolean(settings.coingeckoApiKey || settings.alchemyApiKey || settings.birdeyeApiKey);
}

export function hasAiAdvisor(settings: TaxSettings): boolean {
  if (isSaasMode()) return true;
  return Boolean(settings.aiApiKey);
}

export function invalidateServerConfigCache(): void {
  cachedConfig = null;
  configFetchedAt = 0;
}
