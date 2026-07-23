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

/**
 * Whether AI column-mapping can actually run right now.
 * - local/byok: true only when the user has pasted an AI key.
 * - hosted: true only when the server reports `aiAdvisorEnabled` (OpenRouter
 *   configured AND admin-enabled). Unlike `hasAiAdvisor`, this does NOT assume
 *   every hosted session has AI — it mirrors what AiAdvisor.tsx checks so the
 *   import flow doesn't offer a proxy call the server will reject (403/503).
 */
export async function isAiMappingAvailable(): Promise<boolean> {
  const local = await getSettings();
  if (!isSaasMode()) return Boolean(local.aiApiKey);
  const server = await getServerConfig();
  return Boolean(server?.aiAdvisorEnabled);
}

export function invalidateServerConfigCache(): void {
  cachedConfig = null;
  configFetchedAt = 0;
}

/**
 * Whether Exchange Auto-Sync is enabled server-side (admin flag). Local/BYOK
 * modes never auto-sync (the tunnel needs Hosted mode) so this is false
 * outside SaaS; when the config can't be fetched it defaults to false (the
 * tunnel itself is also gated server-side, so a stale false just hides the
 * form until the next config refresh).
 */
export async function isExchangeSyncEnabled(): Promise<boolean> {
  if (!isSaasMode()) return false;
  const server = await getServerConfig();
  return Boolean(server?.exchangeSyncEnabled);
}
