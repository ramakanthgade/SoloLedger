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

/** Meaningful SOL — dust "touches" must not block repair. */
const MIN_SOL_LEG = 0.001;

function tradeTouchesSolFully(t: Transaction): boolean {
  if (t.asset === 'SOL' && t.amount >= MIN_SOL_LEG) return true;
  return t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) >= MIN_SOL_LEG;
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
  meta?: {
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: any[];
    postTokenBalances?: any[];
  };
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
  return solDelta + feeSol;
}

function tokenDelta(
  tx: NonNullable<Awaited<ReturnType<typeof getTransaction>>>,
  wallet: string,
  mint: string
): number {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const sum = (arr: any[]) =>
    arr
      .filter((b) => b.mint === mint && b.owner === wallet)
      .reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);
  return sum(post) - sum(pre);
}

/**
 * Patch missing/dust SOL legs on Solana swap rows. Also promotes lone token
 * transfer_out rows into trades when on-chain shows a large native SOL credit.
 * Fixes dust counterAmount that previously blocked repair.
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

  const bySig = new Map<string, Transaction>();
  for (const t of candidates) {
    const key = `${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`;
    const prev = bySig.get(key);
    if (!prev) {
      bySig.set(key, t);
      continue;
    }
    if (prev.type !== 'trade' && t.type === 'trade') bySig.set(key, t);
    // Prefer incomplete SOL trades for repair over "fully" tagged dust legs.
    else if (
      prev.type === 'trade' &&
      t.type === 'trade' &&
      tradeTouchesSolFully(prev) &&
      !tradeTouchesSolFully(t)
    ) {
      bySig.set(key, t);
    }
  }

  const allSolana = await db.transactions
    .filter((t) => t.chain === 'solana' && !!t.sourceRef && !t.isSpam)
    .toArray();
  const solCovered = new Set<string>();
  for (const t of allSolana) {
    if (!t.walletAddress || !t.sourceRef) continue;
    const key = `${t.walletAddress.toLowerCase()}|${t.sourceRef}`;
    if (tradeTouchesSolFully(t)) solCovered.add(key);
    if (
      t.asset === 'SOL' &&
      (t.type === 'transfer_in' || t.type === 'income') &&
      t.amount >= MIN_SOL_LEG
    ) {
      solCovered.add(key);
    }
  }

  // Also repair trades that claim SOL but only have dust counterAmount.
  for (const t of allSolana) {
    if (t.type !== 'trade' || !t.walletAddress || !t.sourceRef) continue;
    if (t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) > 0 && (t.counterAmount ?? 0) < MIN_SOL_LEG) {
      const key = `${t.walletAddress.toLowerCase()}|${t.sourceRef}`;
      solCovered.delete(key);
      bySig.set(key, t);
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

    if (solFromSwap >= MIN_SOL_LEG) {
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
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(row.id, {
          type: 'trade',
          counterAsset: 'SOL',
          counterAmount: solFromSwap,
          flags: (row.flags ?? []).filter((f) => f !== 'possible_internal_transfer'),
          notes: row.notes?.includes('SOL leg repaired')
            ? row.notes
            : `${row.notes ? `${row.notes} · ` : ''}Auto-detected swap (SOL leg from chain)`
        });
      }

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

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Reconcile USDC trade/transfer amounts on a signature with on-chain delta.
 * Removes extra inbound USDC rows that overstate the wallet.
 */
export async function repairUsdcOvercount(alchemyApiKey?: string): Promise<number> {
  const settings = alchemyApiKey ? null : await getSettings();
  const apiKey =
    alchemyApiKey ??
    settings?.alchemyApiKey ??
    (isSaasMode() ? SAAS_PROXY_KEY : undefined);
  if (!apiKey) return 0;

  const usdcRows = await db.transactions
    .filter(
      (t) =>
        t.chain === 'solana' &&
        !!t.sourceRef &&
        !!t.walletAddress &&
        !t.isSpam &&
        (t.asset.toUpperCase() === 'USDC' || t.counterAsset?.toUpperCase() === 'USDC')
    )
    .toArray();

  const bySig = new Map<string, Transaction[]>();
  for (const t of usdcRows) {
    const key = `${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`;
    const list = bySig.get(key) ?? [];
    list.push(t);
    bySig.set(key, list);
  }

  let fixed = 0;
  for (const [key, rows] of bySig) {
    const wallet = rows[0].walletAddress!;
    const sig = rows[0].sourceRef!;
    // eslint-disable-next-line no-await-in-loop
    const tx = await getTransaction(sig, apiKey);
    if (!tx) continue;
    const chainDelta = tokenDelta(tx, wallet, USDC_MINT);
    if (Math.abs(chainDelta) < 1e-9) continue;

    // Ledger USDC effect from these rows (simplified).
    let ledger = 0;
    for (const t of rows) {
      if (t.type === 'trade' && t.counterAsset?.toUpperCase() === 'USDC') ledger += t.counterAmount ?? 0;
      if (t.type === 'trade' && t.asset.toUpperCase() === 'USDC') ledger -= t.amount;
      if (t.type === 'transfer_in' || t.type === 'income' || t.type === 'buy') {
        if (t.asset.toUpperCase() === 'USDC') ledger += t.amount;
      }
      if (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'fee') {
        if (t.asset.toUpperCase() === 'USDC') ledger -= t.amount;
      }
    }

    const excess = ledger - chainDelta;
    if (excess <= 0.0001) continue;

    // Prefer deleting duplicate transfer_in legs that match the excess.
    const dupIns = rows
      .filter((t) => t.type === 'transfer_in' && t.asset.toUpperCase() === 'USDC')
      .sort((a, b) => Math.abs(a.amount - excess) - Math.abs(b.amount - excess));
    if (dupIns.length > 0 && Math.abs(dupIns[0].amount - excess) < 0.01) {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.delete(dupIns[0].id);
      fixed++;
      continue;
    }

    // Or shrink an oversized trade counterAmount.
    const tradeIn = rows.find(
      (t) => t.type === 'trade' && t.counterAsset?.toUpperCase() === 'USDC' && (t.counterAmount ?? 0) > 0
    );
    if (tradeIn && excess > 0.0001) {
      const next = Math.max(0, (tradeIn.counterAmount ?? 0) - excess);
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(tradeIn.id, { counterAmount: next });
      fixed++;
    }
  }

  return fixed;
}
