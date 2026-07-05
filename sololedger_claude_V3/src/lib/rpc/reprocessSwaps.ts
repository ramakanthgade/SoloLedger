import { db } from '@/lib/storage/db';
import { detectDexSwaps } from '@/lib/rpc/swapDetection';

/** Re-run swap detection on wallet imports already stored in IndexedDB. */
export async function reprocessSwapDetectionInDb(): Promise<number> {
  const all = await db.transactions.toArray();
  const { transactions, removedIds, tradesCreated } = detectDexSwaps(all);

  if (removedIds.length === 0 && tradesCreated === 0) return 0;

  const tradeUpdates = transactions.filter((t) => {
    if (t.type !== 'trade') return false;
    const orig = all.find((o) => o.id === t.id);
    return !orig || orig.type !== 'trade' || orig.counterAsset !== t.counterAsset;
  });

  await db.transaction('rw', db.transactions, async () => {
    if (removedIds.length > 0) {
      await db.transactions.bulkDelete(removedIds);
    }
    if (tradeUpdates.length > 0) {
      await db.transactions.bulkPut(tradeUpdates);
    }
  });

  return tradesCreated;
}
