/**
 * Browser-safe Solana JSON-RPC helper.
 * - localhost / preview: Vite proxy `/solana-rpc` → public mainnet (no API key, no SaaS auth)
 * - SaaS production: Alchemy via authenticated proxy when available
 * - Fallback: public endpoint (may fail CORS outside Vite)
 */
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { getSettings } from '@/lib/storage/db';

export function solanaJsonRpcUrl(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '/solana-rpc';
  }
  if (isSaasMode()) return `${getApiBase()}/api/proxy/alchemy/solana-mainnet`;
  return 'https://api.mainnet-beta.solana.com';
}

async function rpcFetch(body: unknown, alchemyApiKey?: string): Promise<Response> {
  const url = solanaJsonRpcUrl();
  if (isSaasMode() && url.includes('/api/proxy/alchemy')) {
    return saasProxyFetch('/api/proxy/alchemy/solana-mainnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (alchemyApiKey && url.includes('alchemy')) {
    headers.Authorization = `Bearer ${alchemyApiKey}`;
  }
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function solanaRpc<T>(
  method: string,
  params: unknown[],
  alchemyApiKey?: string
): Promise<T | null> {
  try {
    let key = alchemyApiKey;
    if (!key && isSaasMode()) key = SAAS_PROXY_KEY;
    if (!key) {
      const settings = await getSettings();
      key = settings.alchemyApiKey;
    }
    const res = await rpcFetch({ jsonrpc: '2.0', id: 1, method, params }, key);
    if (!res.ok) {
      // Local Vite public proxy should work without a key — retry once on that path.
      if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        const retry = await fetch('/solana-rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (!retry.ok) return null;
        const j = await retry.json();
        return (j?.result as T) ?? null;
      }
      return null;
    }
    const json = await res.json();
    return (json?.result as T) ?? null;
  } catch {
    return null;
  }
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
