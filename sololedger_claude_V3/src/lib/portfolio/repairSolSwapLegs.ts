/**
 * Repair incomplete swaps that never recorded a native SOL leg (common for USDC→SOL).
 * Uses Vite `/solana-rpc` on localhost (no API key / no SaaS login required).
 */
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { makeId } from '@/lib/parsers/types';
import {
  getSolanaTransaction,
  swapAssociatedSol,
  tokenMintDelta,
  walletSolDelta
} from '@/lib/rpc/solanaRpc';

const MIN_SOL_LEG = 0.001;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tradeTouchesSolFully(t: Transaction): boolean {
  if (t.asset === 'SOL' && t.amount >= MIN_SOL_LEG) return true;
  return t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) >= MIN_SOL_LEG;
}

/**
 * Patch missing/dust SOL legs on Solana swap rows. Promotes lone token transfer_out
 * rows into trades when on-chain shows a large native SOL credit.
 */
export async function repairMissingSolSwapLegs(_alchemyApiKey?: string): Promise<number> {
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

  // Dust SOL counterAmount incorrectly marks coverage — force re-repair.
  for (const t of allSolana) {
    if (t.type !== 'trade' || !t.walletAddress || !t.sourceRef) continue;
    if (
      t.counterAsset?.toUpperCase() === 'SOL' &&
      (t.counterAmount ?? 0) > 0 &&
      (t.counterAmount ?? 0) < MIN_SOL_LEG
    ) {
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
    const tx = await getSolanaTransaction(sig);
    if (!tx) continue;
    const solFromSwap = swapAssociatedSol(tx, wallet);
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

  // Second pass: any signature with a large on-chain SOL credit and no ledger SOL credit at all.
  const sigsByWallet = new Map<string, Set<string>>();
  for (const t of allSolana) {
    if (!t.walletAddress || !t.sourceRef) continue;
    const w = t.walletAddress.toLowerCase();
    if (!sigsByWallet.has(w)) sigsByWallet.set(w, new Set());
    sigsByWallet.get(w)!.add(t.sourceRef);
  }

  for (const [walletLower, sigs] of sigsByWallet) {
    const wallet = allSolana.find((t) => t.walletAddress?.toLowerCase() === walletLower)?.walletAddress;
    if (!wallet) continue;
    for (const sig of sigs) {
      const key = `${walletLower}|${sig}`;
      if (solCovered.has(key)) continue;
      // eslint-disable-next-line no-await-in-loop
      const tx = await getSolanaTransaction(sig);
      if (!tx) continue;
      const delta = walletSolDelta(tx, wallet);
      if (delta == null || delta < MIN_SOL_LEG) continue;

      // No ledger SOL credit for this sig — insert transfer_in.
      const hasSolIn = allSolana.some(
        (t) =>
          t.sourceRef === sig &&
          t.walletAddress?.toLowerCase() === walletLower &&
          t.asset === 'SOL' &&
          (t.type === 'transfer_in' || t.type === 'income' || (t.type === 'trade' && tradeTouchesSolFully(t)))
      );
      if (hasSolIn) continue;

      const base = allSolana.find(
        (t) => t.sourceRef === sig && t.walletAddress?.toLowerCase() === walletLower
      );
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.add({
        id: makeId('rpc'),
        timestamp: base?.timestamp ?? Date.now(),
        type: 'transfer_in',
        asset: 'SOL',
        amount: delta,
        fiatCurrency: 'USD',
        source: 'rpc:repair',
        sourceRef: sig,
        walletAddress: wallet,
        chain: 'solana',
        flags: ['missing_cost_basis'],
        isInternalTransfer: false,
        notes: 'SOL credit restored from on-chain balance (missing from import)'
      });
      updated++;
      solCovered.add(key);
    }
  }

  return updated;
}

/**
 * Reconcile USDC amounts per signature with on-chain delta; drop duplicate credits.
 */
export async function repairUsdcOvercount(_alchemyApiKey?: string): Promise<number> {
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
  for (const rows of bySig.values()) {
    const wallet = rows[0].walletAddress!;
    const sig = rows[0].sourceRef!;
    // eslint-disable-next-line no-await-in-loop
    const tx = await getSolanaTransaction(sig);
    if (!tx) continue;
    const chainDelta = tokenMintDelta(tx, wallet, USDC_MINT);
    if (Math.abs(chainDelta) < 1e-9) continue;

    let ledger = 0;
    for (const t of rows) {
      if (t.type === 'trade' && t.counterAsset?.toUpperCase() === 'USDC') ledger += t.counterAmount ?? 0;
      if (t.type === 'trade' && t.asset.toUpperCase() === 'USDC') ledger -= t.amount;
      if (['transfer_in', 'income', 'buy'].includes(t.type) && t.asset.toUpperCase() === 'USDC') {
        ledger += t.amount;
      }
      if (['transfer_out', 'sell', 'fee'].includes(t.type) && t.asset.toUpperCase() === 'USDC') {
        ledger -= t.amount;
      }
    }

    const excess = ledger - chainDelta;
    if (excess <= 0.0001) continue;

    const dupIns = rows
      .filter((t) => t.type === 'transfer_in' && t.asset.toUpperCase() === 'USDC')
      .sort((a, b) => Math.abs(a.amount - excess) - Math.abs(b.amount - excess));
    if (dupIns.length > 0 && Math.abs(dupIns[0].amount - excess) < 0.01) {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.delete(dupIns[0].id);
      fixed++;
      continue;
    }

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
