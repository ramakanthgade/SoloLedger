/**
 * Jupiter DCA / Recurring order pattern detection and classification.
 *
 * Pass 1 (counterpartyAddress match): both deposit and fills have same vault address.
 * Pass 2 (fill-side only): works when deposit has no counterpartyAddress (old imports).
 *
 * Exact DBT amounts per fill are resolved in this priority:
 *   1. Jupiter Recurring API (free, exact amounts by txId)
 *   2. Alchemy getTransaction (on-chain vault DBT balance change — exact and always correct)
 *   3. Proportional estimate (totalInput × fill_output / totalOutput) — last resort
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
  /** The DBT token mint address (from the deposit tx) */
  inputContractAddress?: string;
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_CHAIN_ASSETS = new Set(['SOL', 'ETH', 'BTC', 'BNB', 'MATIC', 'AVAX', 'ADA', 'DOT']);

export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  const groups: DcaGroup[] = [];
  const ownWallets = new Set(
    transactions.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean) as string[]
  );

  // Pass 1: counterpartyAddress-based
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
      totalOutput: ins.reduce((s, t) => s + t.amount, 0),
      inputContractAddress: outs[0].contractAddress
    });
  }

  // Pass 2: fill-side only (works when deposit has no counterpartyAddress)
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
    if (groups.some((g) => g.vaultAddress.toLowerCase() === vaultAddr.toLowerCase())) continue;

    const firstFillTime = Math.min(...fillTxs.map((f) => f.timestamp));
    const depositCandidates = transactions.filter(
      (t) =>
        t.type === 'transfer_out' &&
        !NATIVE_CHAIN_ASSETS.has(t.asset.toUpperCase()) &&
        t.asset.toUpperCase() !== outputAsset.toUpperCase() &&
        t.walletAddress?.toLowerCase() === walletAddr.toLowerCase() &&
        t.source.startsWith('rpc:') &&
        !t.isInternalTransfer &&
        !t.isSpam &&
        Math.abs(t.timestamp - firstFillTime) <= ONE_WEEK_MS
    );

    if (depositCandidates.length === 0) continue;

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
      totalOutput: fillTxs.reduce((s, t) => s + t.amount, 0),
      inputContractAddress: depositTx.contractAddress
    });
  }

  return groups;
}

/**
 * Try to get the exact DBT amount consumed by the DCA vault in a specific fill tx.
 * Reads vault's pre/post token balances via Alchemy getTransaction.
 * This is 100% accurate — no estimation needed.
 */
async function getExactDbtPerFillFromChain(
  txSignature: string,
  vaultAddress: string,
  dbtMint: string,
  alchemyApiKey: string
): Promise<number | null> {
  try {
    const url = `https://solana-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [txSignature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tx = data?.result;
    if (!tx) return null;

    const allPre: any[] = tx.meta?.preTokenBalances ?? [];
    const allPost: any[] = tx.meta?.postTokenBalances ?? [];

    const vaultLower = vaultAddress.toLowerCase();
    const preBal = allPre.find(
      (b: any) => b.mint === dbtMint && b.owner?.toLowerCase() === vaultLower
    );
    const postBal = allPost.find(
      (b: any) => b.mint === dbtMint && b.owner?.toLowerCase() === vaultLower
    );

    const preAmt = preBal?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt = postBal?.uiTokenAmount?.uiAmount ?? 0;
    const dbtConsumed = preAmt - postAmt;

    if (dbtConsumed > 0.0001) return dbtConsumed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply DCA classification:
 * - Deposit → isInternalTransfer = true (escrow, non-taxable)
 * - Each fill → type = 'trade': sold inputAsset (DBT), received outputAsset (USDC)
 *
 * Amount resolution priority:
 * 1. Jupiter Recurring API (exact, matched by txId)
 * 2. Alchemy getTransaction (exact vault DBT balance change)
 * 3. Proportional estimate (fallback)
 */
export async function applyDcaClassification(
  groups: DcaGroup[],
  alchemyApiKey?: string
): Promise<number> {
  if (groups.length === 0) return 0;
  let applied = 0;

  for (const g of groups) {
    const walletAddress = g.depositTx.walletAddress;
    const dbtMint = g.inputContractAddress;

    // Try Jupiter Recurring API for exact fill amounts
    const jupiterData = walletAddress
      ? await fetchJupiterRecurringHistory(walletAddress)
      : { orders: [], fillsByTxId: new Map() };

    const totalOutput = g.fillTxs.reduce((s, t) => s + t.amount, 0);

    // Mark deposit as non-taxable escrow
    await db.transactions.update(g.depositTx.id, {
      isInternalTransfer: true,
      flags: [] as FlagReason[],
      notes:
        `DCA deposit: ${g.totalInput.toFixed(4)} ${g.inputAsset} → ` +
        `vault (${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)}). ` +
        `Non-taxable escrow.`
    });

    for (const fill of g.fillTxs) {
      const jupFill = fill.sourceRef ? jupiterData.fillsByTxId.get(fill.sourceRef) : null;
      let inputAmountPerFill: number;
      let amountSource: string;

      if (jupFill) {
        inputAmountPerFill =
          jupFill.fill.inputAmount > 0
            ? jupFill.fill.inputAmount
            : toHumanAmount(jupFill.fill.rawInputAmount, jupFill.order.inputMint);
        amountSource = 'Jupiter API (exact)';
      } else if (alchemyApiKey && dbtMint && fill.sourceRef) {
        // Try Alchemy: get vault's DBT balance change in this specific tx
        const onChainAmt = await getExactDbtPerFillFromChain(
          fill.sourceRef,
          g.vaultAddress,
          dbtMint,
          alchemyApiKey
        );
        if (onChainAmt != null && onChainAmt > 0) {
          inputAmountPerFill = onChainAmt;
          amountSource = 'on-chain (exact)';
        } else {
          inputAmountPerFill =
            totalOutput > 0
              ? (fill.amount / totalOutput) * g.totalInput
              : g.totalInput / g.fillTxs.length;
          amountSource = 'proportional estimate';
        }
      } else {
        inputAmountPerFill =
          totalOutput > 0
            ? (fill.amount / totalOutput) * g.totalInput
            : g.totalInput / g.fillTxs.length;
        amountSource = 'proportional estimate';
      }

      await db.transactions.update(fill.id, {
        type: 'trade',
        // Asset SOLD (input): DBT — use the deposit tx's asset/contract info
        asset: g.inputAsset,
        amount: parseFloat(inputAmountPerFill.toFixed(6)),
        contractAddress: dbtMint ?? g.depositTx.contractAddress,
        // Asset RECEIVED (output): USDC
        counterAsset: g.outputAsset,
        counterAmount: fill.amount,
        // Keep the fill's walletAddress / chain / timestamps
        flags: [] as FlagReason[],
        notes:
          `DCA fill: sold ${inputAmountPerFill.toFixed(4)} ${g.inputAsset} ` +
          `for ${fill.amount.toFixed(4)} ${g.outputAsset} (${amountSource})`
      });
    }
    applied++;
  }

  return applied;
}
