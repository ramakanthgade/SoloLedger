/**
 * Full-wallet on-chain reconcile for Solana SOL (and USDC excess).
 * Scans every signature for the wallet — works even when a swap was never imported.
 */
import { db, getLookupAddresses } from '@/lib/storage/db';
import { makeId } from '@/lib/parsers/types';
import type { FlagReason, Transaction } from '@/types/transaction';
import {
  getSignaturesForAddress,
  getSolanaTransaction,
  swapAssociatedSol,
  tokenMintDelta,
  walletSolDelta
} from '@/lib/rpc/solanaRpc';
import { resolveSolanaMintAddress } from '@/lib/assets/solanaMints';

const MIN_SOL = 0.001;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function ledgerSolForSig(rows: Transaction[]): number {
  let sol = 0;
  for (const t of rows) {
    if (t.isSpam) continue;
    if (t.type === 'fee' && t.asset === 'SOL') {
      sol -= t.amount;
      continue;
    }
    if (t.type === 'trade') {
      if (t.asset === 'SOL') sol -= t.amount;
      if (t.counterAsset?.toUpperCase() === 'SOL') sol += t.counterAmount ?? 0;
      if (t.feeAsset?.toUpperCase() === 'SOL' && t.feeAmount) sol -= t.feeAmount;
      continue;
    }
    if (t.asset !== 'SOL') continue;
    if (t.isInternalTransfer && (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent')) {
      continue;
    }
    if (['transfer_in', 'income', 'gift_received', 'buy'].includes(t.type)) sol += t.amount;
    else if (['transfer_out', 'gift_sent', 'sell'].includes(t.type)) sol -= t.amount;
  }
  return sol;
}

function ledgerUsdcForSig(rows: Transaction[]): number {
  let u = 0;
  for (const t of rows) {
    if (t.isSpam) continue;
    if (t.type === 'trade') {
      if (t.asset.toUpperCase() === 'USDC') u -= t.amount;
      if (t.counterAsset?.toUpperCase() === 'USDC') u += t.counterAmount ?? 0;
      continue;
    }
    if (t.asset.toUpperCase() !== 'USDC') continue;
    if (t.isInternalTransfer && (t.type === 'transfer_out' || t.type === 'sell')) continue;
    if (['transfer_in', 'income', 'buy', 'gift_received'].includes(t.type)) u += t.amount;
    else if (['transfer_out', 'sell', 'fee', 'gift_sent'].includes(t.type)) u -= t.amount;
  }
  return u;
}

export interface WalletChainReconcileResult {
  walletsScanned: number;
  signaturesChecked: number;
  solRowsFixed: number;
  usdcRowsFixed: number;
  message: string;
}

/**
 * For each imported Solana wallet, walk on-chain signatures and patch the ledger
 * so per-signature SOL (and obvious USDC duplicates) match the chain.
 */
export async function reconcileSolanaWalletsFromChain(): Promise<WalletChainReconcileResult> {
  const wallets = (await getLookupAddresses()).filter((w) => w.chain === 'solana');
  const allTxs = await db.transactions.filter((t) => t.chain === 'solana' && !t.isSpam).toArray();

  let signaturesChecked = 0;
  let solRowsFixed = 0;
  let usdcRowsFixed = 0;

  for (const w of wallets) {
    const wallet = w.address;
    const walletLower = wallet.toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    const sigs = await getSignaturesForAddress(wallet);
    const bySig = new Map<string, Transaction[]>();
    for (const t of allTxs) {
      if (t.walletAddress?.toLowerCase() !== walletLower || !t.sourceRef) continue;
      const list = bySig.get(t.sourceRef) ?? [];
      list.push(t);
      bySig.set(t.sourceRef, list);
    }

    for (const s of sigs) {
      signaturesChecked++;
      const sig = s.signature;
      // eslint-disable-next-line no-await-in-loop
      const tx = await getSolanaTransaction(sig);
      if (!tx) continue;

      const chainSol = walletSolDelta(tx, wallet);
      const rows = bySig.get(sig) ?? [];
      const ledgerSol = ledgerSolForSig(rows);

      if (chainSol != null && Math.abs(chainSol - ledgerSol) > MIN_SOL) {
        const gap = chainSol - ledgerSol;
        // Prefer fixing an existing USDC (etc.) trade that is missing the SOL counter.
        const trade = rows.find(
          (t) =>
            t.type === 'trade' &&
            t.asset.toUpperCase() !== 'SOL' &&
            (t.counterAsset?.toUpperCase() !== 'SOL' || (t.counterAmount ?? 0) < MIN_SOL)
        );
        const transferOut = rows.find(
          (t) => t.type === 'transfer_out' && t.asset.toUpperCase() !== 'SOL'
        );

        if (gap > MIN_SOL && trade) {
          const solFromSwap = swapAssociatedSol(tx, wallet) ?? gap;
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.update(trade.id, {
            counterAsset: 'SOL',
            counterAmount: Math.max(solFromSwap, gap),
            notes: trade.notes?.includes('SOL leg repaired')
              ? trade.notes
              : `${trade.notes ? `${trade.notes} · ` : ''}SOL leg repaired from chain reconcile`
          });
          solRowsFixed++;
        } else if (gap > MIN_SOL && transferOut) {
          const solFromSwap = swapAssociatedSol(tx, wallet) ?? gap;
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.update(transferOut.id, {
            type: 'trade',
            counterAsset: 'SOL',
            counterAmount: Math.max(solFromSwap, gap),
            flags: (transferOut.flags ?? []).filter((f) => f !== 'possible_internal_transfer'),
            notes: 'Auto-detected swap from chain reconcile'
          });
          solRowsFixed++;
        } else if (Math.abs(gap) > MIN_SOL) {
          // Insert a SOL transfer to close the gap (works when the whole sig was missing).
          const inbound = gap > 0;
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.add({
            id: makeId('rpc'),
            timestamp: (s.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
            type: inbound ? 'transfer_in' : 'transfer_out',
            asset: 'SOL',
            amount: Math.abs(gap),
            fiatCurrency: 'USD',
            source: 'rpc:repair',
            sourceRef: sig,
            walletAddress: wallet,
            chain: 'solana',
            contractAddress: resolveSolanaMintAddress('SOL'),
            flags: ['missing_cost_basis'] as FlagReason[],
            isInternalTransfer: false,
            notes: 'SOL balance reconciled from on-chain delta'
          });
          solRowsFixed++;
        }
      }

      // USDC excess on this signature (duplicate credit).
      const chainUsdc = tokenMintDelta(tx, wallet, USDC_MINT);
      const ledgerUsdc = ledgerUsdcForSig(rows);
      const usdcExcess = ledgerUsdc - chainUsdc;
      if (usdcExcess > 0.0001) {
        const dupIn = rows
          .filter((t) => t.type === 'transfer_in' && t.asset.toUpperCase() === 'USDC')
          .sort((a, b) => Math.abs(a.amount - usdcExcess) - Math.abs(b.amount - usdcExcess))[0];
        if (dupIn && Math.abs(dupIn.amount - usdcExcess) < 0.01) {
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.delete(dupIn.id);
          usdcRowsFixed++;
        } else {
          const tradeIn = rows.find(
            (t) => t.type === 'trade' && t.counterAsset?.toUpperCase() === 'USDC'
          );
          if (tradeIn && (tradeIn.counterAmount ?? 0) > usdcExcess) {
            // eslint-disable-next-line no-await-in-loop
            await db.transactions.update(tradeIn.id, {
              counterAmount: (tradeIn.counterAmount ?? 0) - usdcExcess
            });
            usdcRowsFixed++;
          }
        }
      }
    }
  }

  const message =
    solRowsFixed + usdcRowsFixed === 0
      ? `Checked ${signaturesChecked} signatures across ${wallets.length} wallet(s) — no SOL/USDC gaps found to patch.`
      : `Fixed ${solRowsFixed} SOL and ${usdcRowsFixed} USDC row(s) across ${signaturesChecked} signatures.`;

  return {
    walletsScanned: wallets.length,
    signaturesChecked,
    solRowsFixed,
    usdcRowsFixed,
    message
  };
}
