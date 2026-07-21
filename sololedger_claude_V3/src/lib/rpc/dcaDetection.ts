/**
 * Jupiter DCA / Recurring order pattern detection and classification.
 *
 * HARDENED 2026-07-21 after a live false-positive: a single 1,300 USDT
 * transfer-in was paired with an unrelated 1,199.25 USDC transfer-out 70
 * minutes LATER, the send was hidden as an "internal escrow deposit", and the
 * receive was rewritten into a phantom "USDC → USDT trade" with an invented
 * amount. The rules below exist so that can never happen again:
 *
 *   1. RECURRENCE — a group needs at least TWO fills (one transfer can never
 *      prove a recurring order). Already-classified fills count toward the
 *      recurrence total so a genuine order dripping one new fill at a time
 *      still classifies the new fill.
 *   2. ORDERING — the deposit must come BEFORE the fills (it funds them);
 *      only a small clock skew is tolerated.
 *   3. VERIFICATION (Solana) — the group must be confirmed against Jupiter's
 *      free Recurring API (active + completed orders). API unreachable → skip
 *      and retry later (never guess). Confirmed no such order → skip.
 *   4. NO INVENTED AMOUNTS — exact per-fill input comes from (a) Jupiter's
 *      fill history, (b) on-chain vault balance change (Alchemy, Solana). The
 *      equal-split last resort flags the fill `needs_review` instead of
 *      silently writing a guessed taxable amount.
 *   5. IDEMPOTENT — already-classified deposits/fills are never re-processed.
 *
 * Pass 1 (counterpartyAddress match): both deposit and fills have same vault address.
 * Pass 2 (fill-side only): works when deposit has no counterpartyAddress (old imports).
 * Pass 3: Helius SWAP imports — deposit + trade fills (no vault on fill counterparty).
 */
import type { Transaction, FlagReason } from '@/types/transaction';
import { db } from '@/lib/storage/db';
import {
  fetchJupiterRecurringHistory,
  toHumanAmount,
  type JupiterRecurringResult
} from '@/lib/rpc/jupiterDca';
import { isSaasMode } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { DBT_TOKEN_MINT } from '@/lib/assets/dabbaRegistry';
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { normalizeSolLedgerRows } from '@/lib/portfolio/solBalance';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

export interface DcaGroup {
  vaultAddress: string;
  depositTx: Transaction;
  /** Every fill in the deposit's window (classified + unclassified). */
  fillTxs: Transaction[];
  /** The fills that still need classification (never re-processed). */
  unclassifiedFillTxs: Transaction[];
  inputAsset: string;
  outputAsset: string;
  totalInput: number;
  totalOutput: number;
  /** The DBT token mint address (from the deposit tx) */
  inputContractAddress?: string;
  /** Chain of the group ('solana', 'bsc', …) — drives verification. */
  chain?: string;
}

export interface DcaApplyResult {
  /** Groups successfully applied. */
  applied: number;
  /** Individual fills (re)written as trades. */
  fillsClassified: number;
  /** Fills whose sold amount is an equal-split estimate (flagged needs_review). */
  estimated: number;
  /** Groups skipped (unverifiable / Jupiter unreachable / nothing to do). */
  skipped: number;
  /** Plain-language reasons for skips — surfaced on the manual (local/BYOK) path. */
  skipReasons: string[];
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Deposits may land a few seconds/minutes after the first fill (clock skew). */
const ORDERING_SKEW_MS = 5 * 60 * 1000;
/** A "recurring order" needs at least this many fills (classified counts too). */
const MIN_TOTAL_FILLS = 2;

const NATIVE_CHAIN_ASSETS = new Set(['SOL', 'ETH', 'BTC', 'BNB', 'MATIC', 'AVAX', 'ADA', 'DOT']);

/** Fill already classified by a previous run (never re-processed). */
export function isClassifiedDcaFill(t: Transaction): boolean {
  return t.type === 'trade' && (t.notes?.toLowerCase().includes('dca fill') ?? false);
}

/** Deposit already marked internal by a previous run. */
export function isClassifiedDcaDeposit(t: Transaction): boolean {
  return t.isInternalTransfer === true && (t.notes?.toLowerCase().includes('dca deposit') ?? false);
}

function isDcaFillRow(t: Transaction): boolean {
  return t.type === 'transfer_in' || (t.type === 'trade' && !!t.counterAsset);
}

/** A fill row that still needs classification. */
function isUnclassifiedFillRow(t: Transaction): boolean {
  return isDcaFillRow(t) && !isClassifiedDcaFill(t);
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
      recordNetworkActivity(resolveMode(true));
      const res = await saasProxyFetch('/api/proxy/alchemy/solana-mainnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) return null;
      return (await res.json())?.result ?? null;
    }
    recordNetworkActivity(resolveMode(false));
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

/** Total input mint consumed in a swap tx — sum of all negative balance deltas for that mint. */
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

/**
 * Detect DCA groups. Spam rows are always ignored; already-classified DCA
 * deposits/fills are included so recurrence totals and drip-fills keep working,
 * but a group is only returned when it contains at least one UNCLASSIFIED fill
 * (i.e. there is something to do). Both callers (importJob, ReviewTab) pass
 * the full, unfiltered transaction set.
 */
export function detectDcaGroups(transactions: Transaction[]): DcaGroup[] {
  const groups: DcaGroup[] = [];
  const pool = transactions.filter((t) => !t.isSpam);
  const ownWallets = new Set(
    pool.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean) as string[]
  );

  // Pass 1: counterpartyAddress match — supports multiple deposits to the same vault.
  // Include already-classified DCA deposits (isInternalTransfer) so fill IDs stay discoverable.
  const byVault = new Map<string, { outs: Transaction[]; ins: Transaction[] }>();
  for (const t of pool) {
    const vault = t.counterpartyAddress;
    if (!vault || !t.source.startsWith('rpc:')) continue;
    if (t.isInternalTransfer && !isClassifiedDcaDeposit(t)) continue;
    if (!byVault.has(vault)) byVault.set(vault, { outs: [], ins: [] });
    if (t.type === 'transfer_out') byVault.get(vault)!.outs.push(t);
    if (isDcaFillRow(t)) byVault.get(vault)!.ins.push(t);
  }

  for (const [vaultAddress, { outs, ins }] of byVault) {
    if (outs.length === 0) continue;
    // Recurrence: at least MIN_TOTAL_FILLS fills at this vault (classified or not).
    if (ins.length < MIN_TOTAL_FILLS) continue;

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

      // Windows stay disjoint even with the skew: a fill inside the next
      // deposit's skew band belongs to THAT deposit, never to both.
      const windowEnd = (sortedOuts[i + 1]?.timestamp ?? Number.POSITIVE_INFINITY) - ORDERING_SKEW_MS;
      const fillTxs = sortedIns.filter(
        (f) => f.timestamp >= deposit.timestamp - ORDERING_SKEW_MS && f.timestamp < windowEnd
      );
      const unclassifiedFillTxs = fillTxs.filter(isUnclassifiedFillRow);
      // Nothing to do for this deposit (all fills already classified).
      if (unclassifiedFillTxs.length < 1) continue;
      if (groups.some((g) => g.depositTx.id === deposit.id)) continue;

      groups.push({
        vaultAddress,
        depositTx: deposit,
        fillTxs,
        unclassifiedFillTxs,
        inputAsset,
        outputAsset,
        totalInput: deposit.amount,
        totalOutput: fillTxs.reduce(
          (s, t) => s + (t.type === 'trade' ? (t.counterAmount ?? 0) : t.amount),
          0
        ),
        inputContractAddress: deposit.contractAddress,
        chain: deposit.chain ?? fillTxs[0]?.chain
      });
    }
  }

  // Pass 2: fill-side only (works when deposit has no counterpartyAddress)
  const fillOnlyGroups = new Map<
    string,
    { vaultAddr: string; walletAddr: string; outputAsset: string; fillTxs: Transaction[] }
  >();

  for (const t of pool) {
    // Unclassified fills (transfer_in) plus already-classified fills (which keep
    // their counterparty) so the recurrence total survives re-runs. Classified
    // fills are trades whose asset is the SOLD token — the received (output)
    // token lives on counterAsset, so derive the output asset per row.
    const isCandidate =
      (t.type === 'transfer_in' && !t.isInternalTransfer) || isClassifiedDcaFill(t);
    if (!isCandidate || !t.counterpartyAddress || !t.source.startsWith('rpc:')) continue;
    if (ownWallets.has(t.counterpartyAddress.toLowerCase())) continue;
    const outAsset = t.type === 'trade' ? t.counterAsset! : t.asset;
    // Native chain assets (SOL, ETH) are never DCA output fills — only tokens are
    if (NATIVE_CHAIN_ASSETS.has(outAsset.toUpperCase())) continue;

    const key = `${t.counterpartyAddress.toLowerCase()}:${outAsset.toUpperCase()}:${t.walletAddress?.toLowerCase() ?? ''}`;
    if (!fillOnlyGroups.has(key)) {
      fillOnlyGroups.set(key, {
        vaultAddr: t.counterpartyAddress,
        walletAddr: t.walletAddress ?? '',
        outputAsset: outAsset,
        fillTxs: []
      });
    }
    fillOnlyGroups.get(key)!.fillTxs.push(t);
  }

  for (const [, { vaultAddr, walletAddr, outputAsset, fillTxs }] of fillOnlyGroups) {
    // Recurrence: single fills are indistinguishable from ordinary transfers.
    if (fillTxs.length < MIN_TOTAL_FILLS) continue;
    const unclassifiedFillTxs = fillTxs.filter((t) => t.type === 'transfer_in');
    if (unclassifiedFillTxs.length < 1) continue;
    if (groups.some((g) => g.vaultAddress.toLowerCase() === vaultAddr.toLowerCase())) continue;

    const firstFillTime = Math.min(...fillTxs.map((f) => f.timestamp));
    const depositCandidates = pool.filter(
      (t) =>
        t.type === 'transfer_out' &&
        !NATIVE_CHAIN_ASSETS.has(t.asset.toUpperCase()) &&
        t.asset.toUpperCase() !== outputAsset.toUpperCase() &&
        t.walletAddress?.toLowerCase() === walletAddr.toLowerCase() &&
        t.source.startsWith('rpc:') &&
        (!t.isInternalTransfer || isClassifiedDcaDeposit(t)) &&
        // ORDERING: the deposit funds the fills — it cannot come AFTER them
        // (small skew tolerated). The old ±1-week window paired a receive with
        // an unrelated send 70 minutes later and fabricated a trade.
        t.timestamp <= firstFillTime + ORDERING_SKEW_MS &&
        firstFillTime - t.timestamp <= ONE_WEEK_MS + ORDERING_SKEW_MS
    );

    if (depositCandidates.length === 0) continue;

    const depositTx = depositCandidates.reduce((best, candidate) => {
      // Nearest deposit BEFORE the first fill wins.
      const bestDiff = firstFillTime - best.timestamp;
      const candDiff = firstFillTime - candidate.timestamp;
      return candDiff <= bestDiff ? candidate : best;
    });

    groups.push({
      vaultAddress: vaultAddr,
      depositTx,
      fillTxs: fillTxs.sort((a, b) => a.timestamp - b.timestamp),
      unclassifiedFillTxs,
      inputAsset: depositTx.asset,
      outputAsset,
      totalInput: depositTx.amount,
      // Classified fills are trades: the received amount lives on counterAmount.
      totalOutput: fillTxs.reduce(
        (s, t) => s + (t.type === 'trade' ? (t.counterAmount ?? 0) : t.amount),
        0
      ),
      inputContractAddress: depositTx.contractAddress,
      chain: depositTx.chain ?? fillTxs[0]?.chain
    });
  }

  // Pass 3: Helius SWAP imports — deposit + trade fills (no vault on fill counterparty)
  for (const deposit of pool) {
    if (
      deposit.type !== 'transfer_out' ||
      !deposit.counterpartyAddress ||
      !deposit.source.startsWith('rpc:') ||
      NATIVE_CHAIN_ASSETS.has(deposit.asset.toUpperCase())
    ) {
      continue;
    }
    // Allow already-classified DCA deposits; skip other internal outs.
    if (deposit.isInternalTransfer && !isClassifiedDcaDeposit(deposit)) {
      continue;
    }
    const vaultLower = deposit.counterpartyAddress.toLowerCase();
    if (groups.some((g) => g.depositTx.id === deposit.id)) continue;
    if (ownWallets.has(vaultLower)) continue;

    const walletLower = deposit.walletAddress?.toLowerCase() ?? '';
    const inputAsset = deposit.asset.toUpperCase();

    const tradeFills = pool.filter(
      (t) =>
        t.type === 'trade' &&
        t.counterAsset &&
        !NATIVE_CHAIN_ASSETS.has(t.counterAsset.toUpperCase()) &&
        (t.asset.toUpperCase() === inputAsset || isClassifiedDcaFill(t)) &&
        t.walletAddress?.toLowerCase() === walletLower &&
        t.source.startsWith('rpc:') &&
        t.timestamp >= deposit.timestamp - ORDERING_SKEW_MS &&
        t.timestamp <= deposit.timestamp + ONE_WEEK_MS
    );

    if (tradeFills.length < MIN_TOTAL_FILLS) continue;
    const unclassifiedFillTxs = tradeFills.filter(isUnclassifiedFillRow);
    if (unclassifiedFillTxs.length < 1) continue;

    const outputAssets = new Set(tradeFills.map((t) => t.counterAsset!.toUpperCase()));
    if (outputAssets.size !== 1) continue;
    const outputAsset = [...outputAssets][0];
    if (outputAsset === inputAsset) continue;

    groups.push({
      vaultAddress: deposit.counterpartyAddress,
      depositTx: deposit,
      fillTxs: tradeFills.sort((a, b) => a.timestamp - b.timestamp),
      unclassifiedFillTxs,
      inputAsset: deposit.asset,
      outputAsset,
      totalInput: deposit.amount,
      totalOutput: tradeFills.reduce((s, t) => s + (t.counterAmount ?? 0), 0),
      inputContractAddress: deposit.contractAddress,
      chain: deposit.chain ?? tradeFills[0]?.chain
    });
  }

  return groups;
}

/**
 * Try to get the exact input-mint amount consumed by the DCA vault in a specific fill tx.
 * Reads vault's pre/post token balances via Alchemy getTransaction (Solana only).
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
 * Does Jupiter confirm this group as a real recurring order?
 * Matches on (a) any fill signature in Jupiter's fill history, (b) the order
 * account address, or (c) the input+output mints of an order.
 */
function jupiterConfirmsGroup(g: DcaGroup, jupiter: JupiterRecurringResult): boolean {
  if (g.fillTxs.some((f) => f.sourceRef && jupiter.fillsByTxId.has(f.sourceRef))) return true;
  const vaultLower = g.vaultAddress.toLowerCase();
  if (jupiter.orders.some((o) => o.orderKey.toLowerCase() === vaultLower)) return true;
  const inputMint = g.inputContractAddress ?? g.depositTx.contractAddress;
  const outputMint = g.fillTxs.find((f) => f.type === 'transfer_in')?.contractAddress;
  return jupiter.orders.some((o) => {
    if (inputMint && o.inputMint === inputMint) {
      if (outputMint && o.outputMint === outputMint) return true;
      const outSymbol = resolveSolanaMintSymbol(o.outputMint);
      if (outSymbol && outSymbol.toUpperCase() === g.outputAsset.toUpperCase()) return true;
    }
    return false;
  });
}

/**
 * Apply DCA classification:
 * - Deposit → isInternalTransfer = true (escrow, non-taxable)
 * - Each unclassified fill → type = 'trade': sold inputAsset, received outputAsset
 *
 * Solana groups are VERIFIED against Jupiter's Recurring API first:
 * unreachable → skip (retry later); confirmed-no-order → skip. Amount
 * resolution priority: (1) Jupiter fill history, (2) on-chain vault balance
 * change (Solana), (3) equal split — flagged needs_review, never silent.
 */
export async function applyDcaClassification(
  groups: DcaGroup[],
  alchemyApiKey?: string
): Promise<DcaApplyResult> {
  const result: DcaApplyResult = {
    applied: 0,
    fillsClassified: 0,
    estimated: 0,
    skipped: 0,
    skipReasons: []
  };
  if (groups.length === 0) return result;

  // Jupiter results are per-wallet — fetch once and reuse across groups.
  const jupiterByWallet = new Map<string, JupiterRecurringResult>();
  const jupiterFor = async (walletAddress: string): Promise<JupiterRecurringResult> => {
    const cached = jupiterByWallet.get(walletAddress);
    if (cached) return cached;
    const fresh = await fetchJupiterRecurringHistory(walletAddress);
    jupiterByWallet.set(walletAddress, fresh);
    return fresh;
  };

  for (const g of groups) {
    const walletAddress = g.depositTx.walletAddress;
    const dbtMint = g.inputContractAddress;
    // Detection always sets chain from the deposit/fill rows; a missing chain
    // falls back by address shape (0x… vaults are EVM, never Solana) so an
    // EVM group is never wrongly Jupiter-gated.
    const isSolana = g.chain ? g.chain === 'solana' : !g.vaultAddress.startsWith('0x');

    // --- Solana verification gate (fail CLOSED on confirmation, OPEN on outage) ---
    let jupiterData: JupiterRecurringResult = { orders: [], fillsByTxId: new Map(), reachable: false };
    if (isSolana) {
      if (!walletAddress) {
        result.skipped++;
        result.skipReasons.push(
          `Recurring-order group at vault ${g.vaultAddress.slice(0, 8)}… skipped: no wallet address on the deposit row to verify with Jupiter.`
        );
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      jupiterData = await jupiterFor(walletAddress);
      if (!jupiterData.reachable) {
        result.skipped++;
        result.skipReasons.push(
          'Jupiter’s recurring-order check is unreachable right now — nothing was changed; it will retry automatically later.'
        );
        continue;
      }
      if (!jupiterConfirmsGroup(g, jupiterData)) {
        result.skipped++;
        result.skipReasons.push(
          `Jupiter shows no recurring order matching vault ${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)} — left as plain transfers.`
        );
        continue;
      }
    }

    // Mark deposit as non-taxable escrow (idempotent).
    if (!isClassifiedDcaDeposit(g.depositTx)) {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(g.depositTx.id, {
        isInternalTransfer: true,
        flags: [] as FlagReason[],
        notes:
          `DCA deposit: ${g.totalInput.toFixed(4)} ${g.inputAsset} → ` +
          `vault (${g.vaultAddress.slice(0, 8)}…${g.vaultAddress.slice(-4)}). ` +
          `Non-taxable escrow.`
      });
    }

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
    // These are rent deposits for token accounts created by Jupiter DCA (Solana only).
    if (isSolana) {
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
    }

    const equalSplit = g.totalInput / g.fillTxs.length;
    const inputMint = dbtMint ?? g.depositTx.contractAddress ?? DBT_TOKEN_MINT;

    for (const fill of g.unclassifiedFillTxs) {
      const jupFill = fill.sourceRef ? jupiterData.fillsByTxId.get(fill.sourceRef) : null;
      const outputReceived = fill.type === 'trade' ? (fill.counterAmount ?? fill.amount) : fill.amount;
      let inputAmountPerFill: number;
      let amountSource: string;
      let estimated = false;

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
      } else if (isSolana && alchemyApiKey && inputMint && fill.sourceRef) {
        // eslint-disable-next-line no-await-in-loop
        const swapConsumed = await getInputConsumedInFillTx(
          fill.sourceRef,
          inputMint,
          alchemyApiKey
        );
        if (swapConsumed != null && swapConsumed > 0) {
          inputAmountPerFill = swapConsumed;
          amountSource = 'on-chain swap (exact)';
        } else {
          // eslint-disable-next-line no-await-in-loop
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
            amountSource = `estimated — equal split across ${g.fillTxs.length} fills, please verify`;
            estimated = true;
          }
        }
      } else {
        inputAmountPerFill = equalSplit;
        amountSource = `estimated — equal split across ${g.fillTxs.length} fills, please verify`;
        estimated = true;
      }

      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(fill.id, {
        type: 'trade',
        asset: g.inputAsset,
        amount: parseFloat(inputAmountPerFill.toFixed(6)),
        contractAddress: inputMint ?? g.depositTx.contractAddress,
        counterAsset: g.outputAsset,
        counterAmount: outputReceived,
        flags: (estimated ? ['needs_review'] : []) as FlagReason[],
        notes:
          `DCA fill: sold ${inputAmountPerFill.toFixed(4)} ${g.inputAsset} ` +
          `for ${outputReceived.toFixed(4)} ${g.outputAsset} (${amountSource})`
      });
      result.fillsClassified++;
      if (estimated) result.estimated++;
    }
    result.applied++;
  }

  if (result.applied > 0) {
    await normalizeSolLedgerRows();
  }
  return result;
}
