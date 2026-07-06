/**
 * Jupiter DCA / Recurring order pattern detection — two-pass algorithm.
 *
 * Pass 1 (counterparty match): Group transactions by counterpartyAddress.
 *   Requires both the DBT transfer_out AND the USDC fills to have counterpartyAddress set.
 *   Works after a wallet re-sync with the new Alchemy counterparty extraction.
 *
 * Pass 2 (fill-side only): If Pass 1 finds nothing, detect from the fills alone.
 *   Identifies vault addresses that appear as counterpartyAddress in 2+ transfer_in
 *   of the same asset (e.g. HLnpSz...TLcC sends USDC 10 times).
 *   Then finds the deposit by looking for a transfer_out of a different asset (DBT)
 *   in the same wallet within ±7 days of the first fill.
 *   Works even when the DBT transfer_out has no counterpartyAddress (old imports).
 */
import type { Transaction, FlagReason } from '@/types/transaction';
import { db } from '@/lib/storage/db';
import { fetchJupiterRecurringHistory, toHumanAmount } from '@/lib/rpc/jupiterDca';

export interface DcaGroup {
  vaultAddress: string;
  depositTx: Transaction;
  fillTxs: Transaction[];
  inputAsset: string;
  outputAsset: string;
  totalInput: number;
  totalOutput: number;
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Native blockchain assets used to pay gas fees — never a DCA deposit. */
const NATIVE_CHAIN_ASSETS = new Set(['SOL', 'ETH', 'BTC', 'BNB', 'MATIC', 'AVAX', 'ADA', 'DOT']);

/** Detect DCA vault patterns from a flat list of RPC-sourced transactions. */
export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  const groups: DcaGroup[] = [];
  const ownWallets = new Set(
    transactions.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean) as string[]
  );

  // ──────────────────────────────────────────────────────────
  // Pass 1: counterpartyAddress-based (requires both sides to have it set)
  // ──────────────────────────────────────────────────────────
  const byVault = new Map<string, { outs: Transaction[]; ins: Transaction[] }>();
  for (const t of transactions) {
    const vault = t.counterpartyAddress;
    if (!vault || !t.source.startsWith('rpc:') || t.isInternalTransfer || t.isSpam) continue;
    if (!byVault.has(vault)) byVault.set(vault, { outs: [], ins: [] });
    if (t.type === 'transfer_out') byVault.get(vault)!.outs.push(t);
    if (t.type === 'transfer_in') byVault.get(vault)!.ins.push(t);
  }

  for (const [vaultAddress, { outs, ins }] of byVault) {
    if (outs.length !== 1 || ins.length < 2) continue;
    const inputAsset = outs[0].asset;
    const outputAssets = new Set(ins.map((t) => t.asset));
    if (outputAssets.size !== 1) continue;
    const outputAsset = [...outputAssets][0];
    if (inputAsset === outputAsset) continue;
    if (ownWallets.has(vaultAddress.toLowerCase())) continue;

    groups.push({
      vaultAddress,
      depositTx: outs[0],
      fillTxs: ins.sort((a, b) => a.timestamp - b.timestamp),
      inputAsset,
      outputAsset,
      totalInput: outs[0].amount,
      totalOutput: ins.reduce((s, t) => s + t.amount, 0)
    });
  }

  // ──────────────────────────────────────────────────────────
  // Pass 2: fill-side only detection
  // Works when the deposit (DBT transfer_out) has no counterpartyAddress set.
  // Identify vaults purely from the recurring INBOUND fills, then find the
  // matching outbound deposit by time proximity.
  // ──────────────────────────────────────────────────────────
  const fillOnlyGroups = new Map<
    string,
    { vaultAddr: string; walletAddr: string; outputAsset: string; fillTxs: Transaction[] }
  >();

  for (const t of transactions) {
    if (
      t.type !== 'transfer_in' ||
      !t.counterpartyAddress ||
      !t.source.startsWith('rpc:') ||
      t.isSpam ||
      t.isInternalTransfer
    )
      continue;
    if (ownWallets.has(t.counterpartyAddress.toLowerCase())) continue;

    const key = `${t.counterpartyAddress.toLowerCase()}:${t.asset.toUpperCase()}:${t.walletAddress?.toLowerCase() ?? ''}`;
    if (!fillOnlyGroups.has(key)) {
      fillOnlyGroups.set(key, {
        vaultAddr: t.counterpartyAddress,
        walletAddr: t.walletAddress ?? '',
        outputAsset: t.asset,
        fillTxs: []
      });
    }
    fillOnlyGroups.get(key)!.fillTxs.push(t);
  }

  for (const [, { vaultAddr, walletAddr, outputAsset, fillTxs }] of fillOnlyGroups) {
    if (fillTxs.length < 2) continue;
    // Skip if Pass 1 already detected this vault
    if (groups.some((g) => g.vaultAddress.toLowerCase() === vaultAddr.toLowerCase())) continue;

    const firstFillTime = Math.min(...fillTxs.map((f) => f.timestamp));

    // Find the deposit: a transfer_out of a token (NOT native gas like SOL) from the
    // same wallet, within ±7 days of the first fill.
    // Gas fee transfers (tiny SOL) are excluded to prevent false positives.
    const depositCandidates = transactions.filter(
      (t) =>
        t.type === 'transfer_out' &&
        !NATIVE_CHAIN_ASSETS.has(t.asset.toUpperCase()) && // exclude SOL/ETH gas fees
        t.asset.toUpperCase() !== outputAsset.toUpperCase() &&
        t.walletAddress?.toLowerCase() === walletAddr.toLowerCase() &&
        t.source.startsWith('rpc:') &&
        !t.isInternalTransfer &&
        !t.isSpam &&
        Math.abs(t.timestamp - firstFillTime) <= ONE_WEEK_MS
    );

    if (depositCandidates.length === 0) continue;

    // If multiple deposit candidates (e.g. two DCA orders placed on the same day),
    // pick the one closest in time to the first fill.
    const depositTx = depositCandidates.reduce((best, candidate) => {
      const bestDiff = Math.abs(best.timestamp - firstFillTime);
      const candDiff = Math.abs(candidate.timestamp - firstFillTime);
      return candDiff <= bestDiff ? candidate : best;
    });

    groups.push({
      vaultAddress: vaultAddr,
      depositTx,
      fillTxs: fillTxs.sort((a, b) => a.timestamp - b.timestamp),
      inputAsset: depositTx.asset,
      outputAsset,
      totalInput: depositTx.amount,
      totalOutput: fillTxs.reduce((s, t) => s + t.amount, 0)
    });
  }

  return groups;
}

/**
 * Apply DCA classification:
 * - Deposit tx → isInternalTransfer = true (escrow, non-taxable)
 * - Fill txs → type = 'trade' (sold inputAsset, received outputAsset)
 *   Uses Jupiter Recurring API for exact per-fill amounts; falls back to proportional.
 */
export async function applyDcaClassification(groups: DcaGroup[]): Promise<number> {
  if (groups.length === 0) return 0;
  let applied = 0;

  for (const g of groups) {
    const walletAddress = g.depositTx.walletAddress;
    const jupiterData = walletAddress
      ? await fetchJupiterRecurringHistory(walletAddress)
      : { orders: [], fillsByTxId: new Map() };

    const totalOutput = g.fillTxs.reduce((s, t) => s + t.amount, 0);

    await db.transactions.update(g.depositTx.id, {
      isInternalTransfer: true,
      flags: [] as FlagReason[],
      notes:
        `DCA deposit: ${g.totalInput.toFixed(4)} ${g.inputAsset} → ` +
        `vault (${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)}). ` +
        `Non-taxable escrow — proceeds recognised per fill.`
    });

    for (const fill of g.fillTxs) {
      const jupFill = fill.sourceRef ? jupiterData.fillsByTxId.get(fill.sourceRef) : null;
      let inputAmountPerFill: number;

      if (jupFill) {
        inputAmountPerFill =
          jupFill.fill.inputAmount > 0
            ? jupFill.fill.inputAmount
            : toHumanAmount(jupFill.fill.rawInputAmount, jupFill.order.inputMint);
      } else {
        inputAmountPerFill =
          totalOutput > 0
            ? (fill.amount / totalOutput) * g.totalInput
            : g.totalInput / g.fillTxs.length;
      }

      await db.transactions.update(fill.id, {
        type: 'trade',
        asset: g.inputAsset,
        amount: parseFloat(inputAmountPerFill.toFixed(6)),
        counterAsset: g.outputAsset,
        counterAmount: fill.amount,
        contractAddress: fill.contractAddress,
        flags: [] as FlagReason[],
        notes:
          `DCA fill: sold ${inputAmountPerFill.toFixed(4)} ${g.inputAsset} ` +
          `for ${fill.amount.toFixed(4)} ${g.outputAsset}` +
          (jupFill ? ' (exact from Jupiter API)' : ' (proportional estimate)')
      });
    }
    applied++;
  }

  return applied;
}
