import type { LookupConfig } from '@/lib/rpc/providers';
import type { ChainDef } from '@/lib/rpc/providers';
import type { TaxSettings } from '@/types/transaction';
import { isSaasMode } from './config';

/** Placeholder — RPC clients route through the server proxy when SaaS mode is on. */
export const SAAS_PROXY_KEY = 'saas-proxy';

export function buildLookupConfig(
  chain: ChainDef,
  settings: TaxSettings,
  extras: Partial<LookupConfig> = {}
): LookupConfig {
  const saas = isSaasMode();
  const proxy = saas ? SAAS_PROXY_KEY : undefined;
  return {
    chain,
    alchemyApiKey: settings.alchemyApiKey ?? proxy,
    heliusApiKey: settings.heliusApiKey ?? proxy,
    moralisApiKey: settings.moralisApiKey ?? proxy,
    customBaseUrl: extras.customBaseUrl ?? settings.customExplorerBaseUrl,
    customApiKey: extras.customApiKey ?? settings.customExplorerApiKey,
    customAsset: extras.customAsset,
    ...extras
  };
}
