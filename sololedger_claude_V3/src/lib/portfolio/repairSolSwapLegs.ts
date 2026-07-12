/**
 * Repair incomplete swaps that never recorded a native SOL leg (common for USDC→SOL).
 * Uses Alchemy (Vite proxy / SaaS proxy) — public Solana RPC is blocked by browser CORS.
 */
import { db, getSettings } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { makeId } from '@/lib/parsers/types';

function tradeTouchesSolFully(t: Transaction): boolean {
  if (t.asset === 'SOL' && t.amount > 0) return true;
  return t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) > 0;
}

function alchemyRpcUrl(): string {
  if (isSaasMode()) return `${getApiBase()}/api/proxy/alchemy/solana-mainnet`;
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '/alchemy-rpc/solana-mainnet';
  }
  return 'https://solana-mainnet.g.alchemy.com/v2';
}

function alchemyHeaders(apiKey: string): HeadersInit {
  if (isSaasMode()) return { 'Content-Type': 'application/json' };
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

async function alchemyFetch(url: string, init: RequestInit): Promise<Response> {
  if (isSaasMode()) {
    const path = url.replace(getApiBase(), '');
    return saasProxyFetch(path, init);
  }
  return fetch(url, init);
}

async function getTransaction(
  sig: string,
  apiKey: string
): Promise<{
  meta?: { fee?: number; preBalances?: number[]; postBalances?: number[] };
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
} | null> {
  try {
    const res = await alchemyFetch(alchemyRpcUrl(), {
      method: 'POST',
      headers: alchemyHeaders(apiKey),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
      })
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.result ?? null;
  } catch {
    return null;
  }
}

function nativeSolFromSwap(
  tx: NonNullable<Awaited<ReturnType<typeof getTransaction>>>,
  wallet: string
): number | null {
  if (!tx.meta?.preBalances || !tx.meta.postBalances) return null;
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === 'string' ? k : k.pubkey
  );
  const idx = keys.findIndex((k) => k === wallet);
  if (idx < 0) return null;
  const solDelta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
  const feeSol = (tx.meta.fee ?? 0) / 1e9;
  // Native delta already includes −fee; add fee back for swap-associated SOL.
  return solDelta + feeSol;
}

/**
 * Patch missing SOL legs on Solana swap rows. Also converts lone token transfer_out
 * rows into trades when on-chain shows a large native SOL credit.
 */
export async function repairMissingSolSwapLegs(alchemyApiKey?: string): Promise<number> {
  const settings = alchemyApiKey ? null : await getSettings();
  const apiKey =
    alchemyApiKey ??
    settings?.alchemyApiKey ??
    (isSaasMode() ? SAAS_PROXY_KEY : undefined);
  if (!apiKey) return 0;

  const candidates = await db.transactions
    .filter(
      (t) =>
        t.chain === 'solana' &&
        !!t.sourceRef &&
        !!t.walletAddress &&
        !t.isSpam &&
        t.asset.toUpperCase() !== 'SOL' &&
        (t.type === 'trade' || t.type === 'transfer_out')
    )
    .toArray();

  // Prefer trade rows; fall back to transfer_out when no trade exists for the sig.
  const bySig = new Map<string, Transaction>();
  for (const t of candidates) {
    const key = `${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`;
    const prev = bySig.get(key);
    if (!prev) {
      bySig.set(key, t);
      continue;
    }
    if (prev.type !== 'trade' && t.type === 'trade') bySig.set(key, t);
  }

  // Skip signatures that already have a full SOL leg somewhere.
  const allSolana = await db.transactions
    .filter((t) => t.chain === 'solana' && !!t.sourceRef && !t.isSpam)
    .toArray();
  const solCovered = new Set<string>();
  for (const t of allSolana) {
    if (!t.walletAddress || !t.sourceRef) continue;
    const key = `${t.walletAddress.toLowerCase()}|${t.sourceRef}`;
    if (tradeTouchesSolFully(t)) solCovered.add(key);
    if (t.asset === 'SOL' && (t.type === 'transfer_in' || t.type === 'income') && t.amount > 0.001) {
      solCovered.add(key);
    }
  }

  let updated = 0;
  for (const [key, row] of bySig) {
    if (solCovered.has(key)) continue;
    const sig = row.sourceRef!;
    const wallet = row.walletAddress!;
    // eslint-disable-next-line no-await-in-loop
    const tx = await getTransaction(sig, apiKey);
    if (!tx) continue;
    const solFromSwap = nativeSolFromSwap(tx, wallet);
    if (solFromSwap == null) continue;

    if (solFromSwap > 0.001) {
      if (row.type === 'trade') {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(row.id, {
          counterAsset: 'SOL',
          counterAmount: solFromSwap,
          notes: row.notes?.includes('SOL leg repaired')
            ? row.notes
            : `${row.notes ? `${row.notes} · ` : ''}SOL leg repaired from on-chain balance`
        });
      } else {
        // Lone USDC (etc.) out — promote to trade with SOL in.
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(row.id, {
          type: 'trade',
          counterAsset: 'SOL',
          counterAmount: solFromSwap,
          flags: (row.flags ?? []).filter((f) => f !== 'possible_internal_transfer'),
          notes: row.notes?.includes('SOL leg repaired')
            ? row.notes
            : `${row.notes ? `${row.notes} · ` : ''}Auto-detected USDC→SOL swap (SOL leg from chain)`
        });
      }

      // Ensure a network fee row exists for this signature (PR #25 SOL math).
      const feeSol = (tx.meta?.fee ?? 0) / 1e9;
      if (feeSol > 1e-9) {
        const hasFee = allSolana.some(
          (t) =>
            t.type === 'fee' &&
            t.asset === 'SOL' &&
            t.sourceRef === sig &&
            t.walletAddress?.toLowerCase() === wallet.toLowerCase()
        );
        if (!hasFee) {
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.add({
            id: makeId('rpc'),
            timestamp: row.timestamp,
            type: 'fee',
            asset: 'SOL',
            amount: feeSol,
            fiatCurrency: row.fiatCurrency ?? 'USD',
            source: row.source.startsWith('rpc:') ? row.source : 'rpc:repair',
            sourceRef: sig,
            walletAddress: wallet,
            chain: 'solana',
            flags: [],
            isInternalTransfer: false,
            notes: 'Solana network fee'
          });
        }
      }
      updated++;
      solCovered.add(key);
    }
  }

  return updated;
}
