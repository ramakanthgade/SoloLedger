import { db } from '@/lib/storage/db';
import { detectDexSwaps } from '@/lib/rpc/swapDetection';
import { batchClassifyNoves } from '@/lib/rpc/noves';
import type { Transaction, FlagReason } from '@/types/transaction';

export interface ReprocessResult {
  tradesCreated: number;
  reclassified: number;
  message: string;
}

/**
 * Phase 1: local 1-in/1-out heuristic (free, instant).
 * Phase 2: Noves API classifies each undetected tx hash (handles complex swaps where
 *   only one balance-delta leg is in the DB, e.g. DBT was spent but not captured by Alchemy).
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

  if (removedIds.length > 0 || tradeUpdates.length > 0) {
    await db.transaction('rw', db.transactions, async () => {
      if (removedIds.length > 0) await db.transactions.bulkDelete(removedIds);
      if (tradeUpdates.length > 0) await db.transactions.bulkPut(tradeUpdates);
    });
  }

  if (!novesApiKey) {
    return {
      tradesCreated: localTrades,
      reclassified: 0,
      message:
        localTrades > 0
          ? `Detected ${localTrades} swap${localTrades === 1 ? '' : 's'}. Add your Noves API key in Settings for deeper DeFi classification.`
          : 'No swap pairs found locally. Add your Noves API key in Settings to classify DEX swaps, staking, and rewards automatically.'
    };
  }

  // --- Phase 2: Noves classification ---
  const afterPhase1 = await db.transactions.toArray();
  const rpcTransfers = afterPhase1.filter(
    (t) =>
      t.source.startsWith('rpc:') &&
      t.sourceRef &&
      (t.type === 'transfer_in' || t.type === 'transfer_out') &&
      !t.isInternalTransfer
  );

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
          ? `${total} swap${total === 1 ? '' : 's'} detected. Check Capital Gains after fetching prices.`
          : 'All transactions already classified.'
    };
  }

  const items = [...byRef.entries()].map(([key, txs]) => {
    const colonIdx = key.indexOf(':');
    const chain = key.slice(0, colonIdx);
    const txHash = key.slice(colonIdx + 1);
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
  let novesErrors = 0;
  const typesSeen = new Map<string, number>();
  const toUpsert: Transaction[] = [];
  const toDelete: string[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const { txs } = items[idx];
    const noves = novesResults[idx];
    if (!noves) { novesErrors++; continue; }

    const { soloLedgerType, novesType, sent, received, description } = noves;
    typesSeen.set(novesType, (typesSeen.get(novesType) ?? 0) + 1);

    if (soloLedgerType === 'trade') {
      const sentItems = sent.filter((s) => !['paidGas', 'paidFee', 'burned'].includes(s.action));
      const receivedItems = received.filter((r) => !['paidGas', 'paidFee'].includes(r.action));
      const sentItem = sentItems[0];
      const receivedItem = receivedItems[0];

      if (!receivedItem && !sentItem) continue;

      const base =
        txs.find((t) => t.type === 'transfer_out') ??
        txs.find((t) => t.type === 'transfer_in') ??
        txs[0];

      const outAsset = sentItem?.token?.symbol?.toUpperCase() ?? base.asset.toUpperCase();
      const outAmount = sentItem ? parseFloat(sentItem.amount) : base.amount;
      const inAsset =
        receivedItem?.token?.symbol?.toUpperCase() ??
        txs.find((t) => t.type === 'transfer_in')?.asset;
      const inAmount = receivedItem
        ? parseFloat(receivedItem.amount)
        : txs.find((t) => t.type === 'transfer_in')?.amount;

      const outContractAddress =
        sentItem?.token?.address &&
        !/^(SOL|ETH|BTC|BNB|MATIC|AVAX)$/i.test(sentItem.token.address)
          ? sentItem.token.address
          : base.contractAddress;

      const trade: Transaction = {
        ...base,
        type: 'trade',
        asset: outAsset,
        amount: isFinite(outAmount) && outAmount > 0 ? outAmount : base.amount,
        counterAsset: inAsset,
        counterAmount: inAmount != null && isFinite(inAmount) && inAmount > 0 ? inAmount : undefined,
        contractAddress: outContractAddress,
        notes: description || `Auto-classified by Noves: ${novesType}`,
        flags: (base.flags ?? []).filter((f) => f !== 'possible_internal_transfer') as FlagReason[]
      };

      toUpsert.push(trade);
      novesTotalTrades++;

      for (const t of txs) {
        if (t.id !== base.id) toDelete.push(t.id);
      }
    } else if (soloLedgerType && soloLedgerType !== 'transfer_in' && soloLedgerType !== 'transfer_out') {
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

  // Build diagnostic info to help debug unexpected results
  const topTypes = [...typesSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([type, count]) => `${type}(${count})`)
    .join(', ');

  const diagMsg = items.length > 0
    ? ` [Noves: ${items.length} calls, ${novesErrors} errors — types seen: ${topTypes || 'none'}]`
    : '';

  const parts: string[] = [];
  if (total > 0) parts.push(`${total} swap${total === 1 ? '' : 's'} detected`);
  if (novesReclassified > 0) parts.push(`${novesReclassified} reclassified (staking/income/DeFi)`);

  return {
    tradesCreated: total,
    reclassified: novesReclassified,
    message:
      parts.length > 0
        ? `${parts.join(', ')} — fetch prices, then check Capital Gains.${diagMsg}`
        : `No new swaps found.${diagMsg}`
  };
}
