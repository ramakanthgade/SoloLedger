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
import { isSaasMode } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { DBT_TOKEN_MINT } from '@/lib/assets/dabbaRegistry';
import { normalizeSolLedgerRows } from '@/lib/portfolio/solBalance';

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

function isDcaFillRow(t: Transaction): boolean {
  return t.type === 'transfer_in' || (t.type === 'trade' && !!t.counterAsset);
}

async function alchemyGetTransaction(txSignature: string, alchemyApiKey: string): Promise<any | null> {
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txSignature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]
    });
    if (isSaasMode() && alchemyApiKey === SAAS_PROXY_KEY) {
      const res = await saasProxyFetch('/api/proxy/alchemy/solana-mainnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) return null;
      return (await res.json())?.result ?? null;
    }
    const res = await fetch(`https://solana-mainnet.g.alchemy.com/v2/${alchemyApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) return null;
    return (await res.json())?.result ?? null;
  } catch {
    return null;
  }
}

/** Total DBT (or input mint) consumed in a swap tx — sum of all negative balance deltas for that mint. */
async function getInputConsumedInFillTx(
  txSignature: string,
  inputMint: string,
  alchemyApiKey: string
): Promise<number | null> {
  const tx = await alchemyGetTransaction(txSignature, alchemyApiKey);
  if (!tx) return null;

  const allPre: any[] = tx.meta?.preTokenBalances ?? [];
  const allPost: any[] = tx.meta?.postTokenBalances ?? [];
  const accounts = new Set<string>(
    [...allPre, ...allPost]
      .filter((b: any) => b.mint === inputMint)
      .map((b: any) => `${b.accountIndex}:${b.owner ?? ''}`)
  );

  let consumed = 0;
  for (const key of accounts) {
    const [idxStr] = key.split(':');
    const idx = Number(idxStr);
    const preAmt =
      allPre.find((b: any) => b.accountIndex === idx && b.mint === inputMint)?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt =
      allPost.find((b: any) => b.accountIndex === idx && b.mint === inputMint)?.uiTokenAmount?.uiAmount ?? 0;
    const delta = postAmt - preAmt;
    if (delta < -1e-9) consumed += -delta;
  }

  return consumed > 1e-6 ? consumed : null;
}

export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  const groups: DcaGroup[] = [];
  const ownWallets = new Set(
    transactions.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean) as string[]
  );

  // Pass 1: counterpartyAddress match — supports multiple deposits to the same vault.
  // Include already-classified DCA deposits (isInternalTransfer) so fill IDs stay discoverable.
  const byVault = new Map<string, { outs: Transaction[]; ins: Transaction[] }>();
  for (const t of transactions) {
    const vault = t.counterpartyAddress;
    if (!vault || !t.source.startsWith('rpc:') || t.isSpam) continue;
    if (t.isInternalTransfer && !(t.notes?.toLowerCase().includes('dca deposit'))) continue;
    if (!byVault.has(vault)) byVault.set(vault, { outs: [], ins: [] });
    if (t.type === 'transfer_out') byVault.get(vault)!.outs.push(t);
    if (isDcaFillRow(t)) byVault.get(vault)!.ins.push(t);
  }

  for (const [vaultAddress, { outs, ins }] of byVault) {
    if (outs.length === 0 || ins.length < 1) continue;

    const sortedOuts = [...outs].sort((a, b) => a.timestamp - b.timestamp);
    const sortedIns = [...ins].sort((a, b) => a.timestamp - b.timestamp);
    const outputAssets = new Set(
      sortedIns.map((t) => (t.type === 'trade' ? t.counterAsset! : t.asset).toUpperCase())
    );
    if (outputAssets.size !== 1) continue;
    const outputAsset = [...outputAssets][0];
    if (ownWallets.has(vaultAddress.toLowerCase())) continue;

    for (let i = 0; i < sortedOuts.length; i++) {
      const deposit = sortedOuts[i];
      const inputAsset = deposit.asset;
      if (inputAsset.toUpperCase() === outputAsset) continue;

      const windowEnd = sortedOuts[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY;
      const fillTxs = sortedIns.filter(
        (f) => f.timestamp >= deposit.timestamp && f.timestamp < windowEnd
      );
      if (fillTxs.length < 1) continue;
      if (groups.some((g) => g.depositTx.id === deposit.id)) continue;

      groups.push({
        vaultAddress,
        depositTx: deposit,
        fillTxs,
        inputAsset,
        outputAsset,
        totalInput: deposit.amount,
        totalOutput: fillTxs.reduce(
          (s, t) => s + (t.type === 'trade' ? (t.counterAmount ?? 0) : t.amount),
          0
        ),
        inputContractAddress: deposit.contractAddress
      });
    }
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
    // Native chain assets (SOL, ETH) are never DCA output fills — only tokens are
    if (NATIVE_CHAIN_ASSETS.has(t.asset.toUpperCase())) continue;

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
    if (fillTxs.length < 1) continue;
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

  // Pass 3: Helius SWAP imports — deposit + trade fills (no vault on fill counterparty)
  for (const deposit of transactions) {
    if (
      deposit.type !== 'transfer_out' ||
      !deposit.counterpartyAddress ||
      deposit.isSpam ||
      !deposit.source.startsWith('rpc:') ||
      NATIVE_CHAIN_ASSETS.has(deposit.asset.toUpperCase())
    ) {
      continue;
    }
    // Allow already-classified DCA deposits; skip other internal outs.
    if (deposit.isInternalTransfer && !(deposit.notes?.toLowerCase().includes('dca deposit'))) {
      continue;
    }
    const vaultLower = deposit.counterpartyAddress.toLowerCase();
    if (groups.some((g) => g.depositTx.id === deposit.id)) continue;
    if (ownWallets.has(vaultLower)) continue;

    const walletLower = deposit.walletAddress?.toLowerCase() ?? '';
    const inputAsset = deposit.asset.toUpperCase();

    const tradeFills = transactions.filter(
      (t) =>
        t.type === 'trade' &&
        t.counterAsset &&
        !NATIVE_CHAIN_ASSETS.has(t.counterAsset.toUpperCase()) &&
        (t.asset.toUpperCase() === inputAsset || (t.notes?.includes('DCA fill') ?? false)) &&
        t.walletAddress?.toLowerCase() === walletLower &&
        t.source.startsWith('rpc:') &&
        !t.isSpam &&
        t.timestamp >= deposit.timestamp &&
        t.timestamp <= deposit.timestamp + ONE_WEEK_MS
    );

    if (tradeFills.length < 1) continue;

    const outputAssets = new Set(tradeFills.map((t) => t.counterAsset!.toUpperCase()));
    if (outputAssets.size !== 1) continue;
    const outputAsset = [...outputAssets][0];
    if (outputAsset === inputAsset) continue;

    groups.push({
      vaultAddress: deposit.counterpartyAddress,
      depositTx: deposit,
      fillTxs: tradeFills.sort((a, b) => a.timestamp - b.timestamp),
      inputAsset: deposit.asset,
      outputAsset,
      totalInput: deposit.amount,
      totalOutput: tradeFills.reduce((s, t) => s + (t.counterAmount ?? 0), 0),
      inputContractAddress: deposit.contractAddress
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
  const tx = await alchemyGetTransaction(txSignature, alchemyApiKey);
  if (!tx) return null;

  const allPre: any[] = tx.meta?.preTokenBalances ?? [];
  const allPost: any[] = tx.meta?.postTokenBalances ?? [];
  const vaultLower = vaultAddress.toLowerCase();

  const sumUi = (balances: any[]) =>
    balances
      .filter((b: any) => b.mint === dbtMint && b.owner?.toLowerCase() === vaultLower)
      .reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);

  const consumed = sumUi(allPre) - sumUi(allPost);
  return consumed > 0.0001 ? consumed : null;
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

    const equalSplit = g.totalInput / g.fillTxs.length;
    const inputMint = dbtMint ?? g.depositTx.contractAddress ?? DBT_TOKEN_MINT;

    // Mark deposit as non-taxable escrow
    await db.transactions.update(g.depositTx.id, {
      isInternalTransfer: true,
      flags: [] as FlagReason[],
      notes:
        `DCA deposit: ${g.totalInput.toFixed(4)} ${g.inputAsset} → ` +
        `vault (${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)}). ` +
        `Non-taxable escrow.`
    });

    // Also mark any OTHER transfer_outs to the same vault that weren't the primary deposit
    // (handles the case where the user has multiple DCA orders to the same vault address)
    const otherVaultDeposits = await db.transactions
      .filter(
        (t) =>
          t.type === 'transfer_out' &&
          !t.isInternalTransfer &&
          t.counterpartyAddress?.toLowerCase() === g.vaultAddress.toLowerCase()
      )
      .toArray();
    for (const dep of otherVaultDeposits) {
      if (dep.id === g.depositTx.id) continue; // already handled above
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(dep.id, {
        isInternalTransfer: true,
        flags: [] as FlagReason[],
        notes: `DCA deposit to vault (${g.vaultAddress.slice(0, 8)}…) — non-taxable escrow`
      });
    }

    // Mark tiny SOL transfers (< 0.01 SOL) in the same transactions as the DCA deposit as fee
    // These are rent deposits for token accounts created by Jupiter DCA
    const TINY_SOL_THRESHOLD = 0.01;
    const depositSourceRefs = [
      g.depositTx.sourceRef,
      ...otherVaultDeposits.map((d) => d.sourceRef)
    ].filter(Boolean) as string[];

    const tinySOLTxs = await db.transactions
      .filter(
        (t) =>
          t.asset === 'SOL' &&
          t.amount < TINY_SOL_THRESHOLD &&
          t.type !== 'fee' &&
          !t.isInternalTransfer &&
          (t.type === 'transfer_in' || t.type === 'transfer_out')
      )
      .toArray();

    for (const sol of tinySOLTxs) {
      // Rent leaves main wallet (Phantom balance) — record as fee, not internal skip.
      if (sol.sourceRef && depositSourceRefs.includes(sol.sourceRef) && sol.type === 'transfer_out') {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(sol.id, {
          type: 'fee',
          isInternalTransfer: false,
          flags: [] as FlagReason[],
          notes: 'Token account rent (Jupiter DCA setup) — reduces wallet SOL balance'
        });
        continue;
      }
      // Rent refund when DCA vault/token accounts close.
      if (sol.type === 'transfer_in' && sol.sourceRef) {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(sol.id, {
          isInternalTransfer: false,
          flags: [] as FlagReason[],
          notes: 'Token account rent refund (DCA account close)'
        });
      }
    }

    for (const fill of g.fillTxs) {
      const jupFill = fill.sourceRef ? jupiterData.fillsByTxId.get(fill.sourceRef) : null;
      const outputReceived = fill.type === 'trade' ? (fill.counterAmount ?? fill.amount) : fill.amount;
      let inputAmountPerFill: number;
      let amountSource: string;

      if (jupFill) {
        inputAmountPerFill =
          jupFill.fill.inputAmount > 0
            ? jupFill.fill.inputAmount
            : toHumanAmount(jupFill.fill.rawInputAmount, jupFill.order.inputMint);
        amountSource = 'Jupiter API (exact)';
      } else if (
        fill.type === 'trade' &&
        fill.asset.toUpperCase() === g.inputAsset.toUpperCase() &&
        fill.amount > 0
      ) {
        inputAmountPerFill = fill.amount;
        amountSource = 'Helius swap (exact)';
      } else if (alchemyApiKey && inputMint && fill.sourceRef) {
        const swapConsumed = await getInputConsumedInFillTx(
          fill.sourceRef,
          inputMint,
          alchemyApiKey
        );
        if (swapConsumed != null && swapConsumed > 0) {
          inputAmountPerFill = swapConsumed;
          amountSource = 'on-chain swap (exact)';
        } else {
          const vaultAmt = await getExactDbtPerFillFromChain(
            fill.sourceRef,
            g.vaultAddress,
            inputMint,
            alchemyApiKey
          );
          if (vaultAmt != null && vaultAmt > 0) {
            inputAmountPerFill = vaultAmt;
            amountSource = 'vault balance (exact)';
          } else {
            inputAmountPerFill = equalSplit;
            amountSource = `equal split (${g.fillTxs.length} fills)`;
          }
        }
      } else {
        inputAmountPerFill = equalSplit;
        amountSource = `equal split (${g.fillTxs.length} fills)`;
      }

      await db.transactions.update(fill.id, {
        type: 'trade',
        asset: g.inputAsset,
        amount: parseFloat(inputAmountPerFill.toFixed(6)),
        contractAddress: inputMint ?? g.depositTx.contractAddress,
        counterAsset: g.outputAsset,
        counterAmount: outputReceived,
        flags: [] as FlagReason[],
        notes:
          `DCA fill: sold ${inputAmountPerFill.toFixed(4)} ${g.inputAsset} ` +
          `for ${outputReceived.toFixed(4)} ${g.outputAsset} (${amountSource})`
      });
    }
    applied++;
  }

  await normalizeSolLedgerRows();
  return applied;
}
