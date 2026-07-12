/**
 * Browser-safe Solana JSON-RPC helper.
 *
 * Localhost priority (no SaaS login required):
 *   1. http://localhost:3001/api/public/solana-rpc  (Express API — most reliable)
 *   2. /solana-rpc                                  (Vite proxy)
 * SaaS production: Alchemy via authenticated proxy.
 */
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { getSettings } from '@/lib/storage/db';

function localApiSolanaProxy(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  // Prefer same-host API; fall back to classic local port.
  const apiBase = getApiBase();
  if (apiBase.includes('localhost') || apiBase.includes('127.0.0.1')) {
    return `${apiBase}/api/public/solana-rpc`;
  }
  return 'http://localhost:3001/api/public/solana-rpc';
}

export function solanaJsonRpcUrl(): string {
  const local = localApiSolanaProxy();
  if (local) return local;
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '/solana-rpc';
  }
  if (isSaasMode()) return `${getApiBase()}/api/proxy/alchemy/solana-mainnet`;
  return 'https://api.mainnet-beta.solana.com';
}

export async function solanaRpc<T>(
  method: string,
  params: unknown[],
  alchemyApiKey?: string
): Promise<T | null> {
  const payload = { jsonrpc: '2.0', id: 1, method, params };
  const tryUrls: string[] = [];
  const primary = solanaJsonRpcUrl();
  tryUrls.push(primary);
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    for (const u of ['http://localhost:3001/api/public/solana-rpc', '/solana-rpc']) {
      if (!tryUrls.includes(u)) tryUrls.push(u);
    }
  }

  for (const url of tryUrls) {
    try {
      let res: Response;
      if (isSaasMode() && url.includes('/api/proxy/alchemy')) {
        res = await saasProxyFetch('/api/proxy/alchemy/solana-mainnet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        let key = alchemyApiKey;
        if (!key && isSaasMode()) key = SAAS_PROXY_KEY;
        if (!key) {
          const settings = await getSettings();
          key = settings.alchemyApiKey;
        }
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (key && url.includes('alchemy')) headers.Authorization = `Bearer ${key}`;
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      }
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.error) continue;
      return (json?.result as T) ?? null;
    } catch {
      // try next URL
    }
  }
  return null;
}

export interface SolanaTxResult {
  meta?: {
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: any[];
    postTokenBalances?: any[];
  };
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
}

export async function getSolanaTransaction(
  signature: string,
  alchemyApiKey?: string
): Promise<SolanaTxResult | null> {
  return solanaRpc<SolanaTxResult>(
    'getTransaction',
    [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    alchemyApiKey
  );
}

export async function getSignaturesForAddress(
  address: string,
  alchemyApiKey?: string
): Promise<Array<{ signature: string; blockTime?: number | null }>> {
  const result = await solanaRpc<Array<{ signature: string; blockTime?: number | null }>>(
    'getSignaturesForAddress',
    [address, { limit: 1000 }],
    alchemyApiKey
  );
  return result ?? [];
}

/** Native SOL delta for wallet (lamports→SOL), fee-inclusive as on-chain. */
export function walletSolDelta(tx: SolanaTxResult, wallet: string): number | null {
  if (!tx.meta?.preBalances || !tx.meta.postBalances) return null;
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === 'string' ? k : k.pubkey
  );
  const idx = keys.findIndex((k) => k === wallet);
  if (idx < 0) return null;
  return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
}

/** Swap-associated SOL (add fee back so trade+fee rows net to on-chain delta). */
export function swapAssociatedSol(tx: SolanaTxResult, wallet: string): number | null {
  const delta = walletSolDelta(tx, wallet);
  if (delta == null) return null;
  return delta + (tx.meta?.fee ?? 0) / 1e9;
}

export function tokenMintDelta(tx: SolanaTxResult, wallet: string, mint: string): number {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const sum = (arr: any[]) =>
    arr
      .filter((b) => b.mint === mint && b.owner === wallet)
      .reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);
  return sum(post) - sum(pre);
}
