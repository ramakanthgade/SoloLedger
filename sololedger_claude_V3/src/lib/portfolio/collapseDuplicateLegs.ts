/**
 * Remove SPL transfer legs that duplicate a trade's asset/counterAsset on the same signature.
 * Fixes overstated balances (e.g. USDC credited on both trade and transfer_in).
 */
import { db, mutateTransactionsAndReconcileCsv } from '@/lib/storage/db';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import type { Transaction } from '@/types/transaction';
import { canonicalWalletSourceRefKey } from '@/lib/ledger/chainNamespace';
import { cleanCounterpartsForDeletedTransactions } from '@/lib/internalTransfers/persistence';

export async function collapseDuplicateTradeTransferLegs(): Promise<number> {
  const all = await db.transactions
    .filter((t) => !isTransactionExcluded(t) && !!t.sourceRef && !!t.walletAddress)
    .toArray();
  const trades = all.filter((t) => t.type === 'trade' && t.counterAsset && (t.counterAmount ?? 0) > 0);
  const tradeByRef = new Map<string, Transaction>();
  for (const t of trades) {
    const key = canonicalWalletSourceRefKey(t.chain, t.walletAddress, t.txHash ?? t.sourceRef);
    if (key) tradeByRef.set(key, t);
  }

  const toDelete: string[] = [];
  for (const t of all) {
    if (t.type !== 'transfer_in' && t.type !== 'transfer_out' && t.type !== 'income') continue;
    if (t.asset.toUpperCase() === 'SOL') continue;
    const key = canonicalWalletSourceRefKey(t.chain, t.walletAddress, t.txHash ?? t.sourceRef);
    const trade = key ? tradeByRef.get(key) : undefined;
    if (!trade) continue;
    const legs = new Set(
      [trade.asset, trade.counterAsset].filter(Boolean).map((a) => a!.toUpperCase())
    );
    if (legs.has(t.asset.toUpperCase())) toDelete.push(t.id);
  }

  if (toDelete.length > 0) {
    await mutateTransactionsAndReconcileCsv(async () => {
      await cleanCounterpartsForDeletedTransactions(toDelete);
      await db.transactions.bulkDelete(toDelete);
    });
  }
  return toDelete.length;
}
