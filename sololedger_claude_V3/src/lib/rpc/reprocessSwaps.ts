import { db } from '@/lib/storage/db';
import { detectDexSwaps } from '@/lib/rpc/swapDetection';
import { batchClassifyNoves } from '@/lib/rpc/noves';
import type { Transaction, FlagReason } from '@/types/transaction';

export interface ReprocessResult {
  tradesCreated: number;
  reclassified: number;
  /** Human-readable message for the UI */
  message: string;
}

/**
 * Phase 1: local 1-in/1-out heuristic (no API needed).
 * Phase 2: Noves API classifies each undetected tx hash and fills gaps.
 *
 * When Noves returns type="swap", it provides the full sent/received data
 * even if only one leg of the swap is in the local DB (e.g., Alchemy only
 * captured the USDC transfer_in but not the DBT transfer_out).
 */
export async function reprocessSwapDetectionInDb(
  novesApiKey?: string,
  onProgress?: (done: number, total: number) => void
): Promise<ReprocessResult> {
  const all = await db.transactions.toArray();

  // --- Phase 1: local heuristic ---
  const { transactions: phase1Txs, removedIds, tradesCreated: localTrades } = detectDexSwaps(all);

  const tradeUpdates = phase1Txs.filter((t) => {
    if (t.type !== 'trade') return false;
    const orig = all.find((o) => o.id === t.id);
    return !orig || orig.type !== 'trade' || orig.counterAsset !== t.counterAsset;
  });

  // Persist phase-1 results to DB
  if (removedIds.length > 0 || tradeUpdates.length > 0) {
    await db.transaction('rw', db.transactions, async () => {
      if (removedIds.length > 0) await db.transactions.bulkDelete(removedIds);
      if (tradeUpdates.length > 0) await db.transactions.bulkPut(tradeUpdates);
    });
  }

  if (!novesApiKey) {
    if (localTrades === 0) {
      return {
        tradesCreated: 0,
        reclassified: 0,
        message:
          'No swap pairs found locally. Add your Noves API key in Settings to classify DEX swaps, staking, and rewards automatically.'
      };
    }
    return {
      tradesCreated: localTrades,
      reclassified: 0,
      message: `Detected ${localTrades} swap${localTrades === 1 ? '' : 's'} — check Capital Gains after fetching prices.`
    };
  }

  // --- Phase 2: Noves classification ---
  // Re-read after phase 1 mutations
  const afterPhase1 = await db.transactions.toArray();
  const rpcTransfers = afterPhase1.filter(
    (t) =>
      t.source.startsWith('rpc:') &&
      t.sourceRef &&
      (t.type === 'transfer_in' || t.type === 'transfer_out') &&
      !t.isInternalTransfer
  );

  // Group remaining transfers by sourceRef + chain
  const byRef = new Map<string, Transaction[]>();
  for (const t of rpcTransfers) {
    const key = `${t.chain ?? 'unknown'}:${t.sourceRef!}`;
    const group = byRef.get(key) ?? [];
    group.push(t);
    byRef.set(key, group);
  }

  if (byRef.size === 0) {
    const total = localTrades;
    return {
      tradesCreated: total,
      reclassified: 0,
      message:
        total > 0
          ? `Detected ${total} swap${total === 1 ? '' : 's'} — check Capital Gains after fetching prices.`
          : 'All transactions are already classified.'
    };
  }

  // Deduplicate: one Noves call per (chain + sourceRef)
  const items = [...byRef.entries()].map(([key, txs]) => {
    const [chain, ...rest] = key.split(':');
    const txHash = rest.join(':');
    const walletAddress = txs[0]?.walletAddress;
    return { key, chain, txHash, walletAddress, txs };
  });

  const novesResults = await batchClassifyNoves(
    novesApiKey,
    items.map((i) => ({ chain: i.chain, txHash: i.txHash, walletAddress: i.walletAddress })),
    onProgress
  );

  let novesTotalTrades = 0;
  let novesReclassified = 0;
  const toUpsert: Transaction[] = [];
  const toDelete: string[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const { txs } = items[idx];
    const noves = novesResults[idx];
    if (!noves) continue;

    const { soloLedgerType, novesType, sent, received, description } = noves;

    if (novesType === 'swap' || soloLedgerType === 'trade') {
      // Build a trade from Noves data
      const sentItem = sent.filter((s) => s.action !== 'paidGas' && s.action !== 'paidFee')[0];
      const receivedItem = received.filter((r) => r.action !== 'paidGas' && r.action !== 'paidFee')[0];

      if (!sentItem && !receivedItem) continue;

      // Find the best existing tx to use as base (prefer transfer_out if we have sent data, else transfer_in)
      const base =
        txs.find((t) => t.type === 'transfer_out') ??
        txs.find((t) => t.type === 'transfer_in') ??
        txs[0];

      const outAsset = sentItem?.token?.symbol ?? base.asset;
      const outAmount = sentItem ? parseFloat(sentItem.amount) : base.amount;
      const inAsset = receivedItem?.token?.symbol ?? undefined;
      const inAmount = receivedItem ? parseFloat(receivedItem.amount) : undefined;
      const trade: Transaction = {
        ...base,
        type: 'trade',
        asset: outAsset,
        amount: isFinite(outAmount) ? outAmount : base.amount,
        counterAsset: inAsset,
        counterAmount: inAmount != null && isFinite(inAmount) ? inAmount : undefined,
        contractAddress: sentItem?.token?.address && sentItem.token.address !== outAsset
          ? sentItem.token.address
          : base.contractAddress,
        notes: description || `Auto-classified by Noves: ${novesType}`,
        flags: (base.flags ?? []).filter((f) => f !== 'possible_internal_transfer') as FlagReason[]
      };

      toUpsert.push(trade);
      novesTotalTrades++;

      // Delete all other tx rows for this sourceRef (they're absorbed into the trade)
      for (const t of txs) {
        if (t.id !== base.id) toDelete.push(t.id);
      }
    } else if (soloLedgerType && soloLedgerType !== 'transfer_in' && soloLedgerType !== 'transfer_out') {
      // Reclassify (income, defi_deposit, etc.)
      for (const t of txs) {
        const updated: Transaction = {
          ...t,
          type: soloLedgerType,
          notes: description || `Auto-classified by Noves: ${novesType}`,
          flags: (t.flags ?? []).filter((f) => f !== 'possible_internal_transfer') as FlagReason[]
        };
        toUpsert.push(updated);
        novesReclassified++;
      }
    }
  }

  if (toUpsert.length > 0 || toDelete.length > 0) {
    await db.transaction('rw', db.transactions, async () => {
      if (toDelete.length > 0) await db.transactions.bulkDelete(toDelete);
      if (toUpsert.length > 0) await db.transactions.bulkPut(toUpsert);
    });
  }

  const total = localTrades + novesTotalTrades;
  const parts: string[] = [];
  if (total > 0) parts.push(`${total} swap${total === 1 ? '' : 's'} detected`);
  if (novesReclassified > 0) parts.push(`${novesReclassified} reclassified (staking/income/DeFi)`);

  return {
    tradesCreated: total,
    reclassified: novesReclassified,
    message:
      parts.length > 0
        ? `${parts.join(', ')} via Noves. Fetch missing prices, then check Capital Gains.`
        : 'All transactions already classified — no new swaps found.'
  };
}
