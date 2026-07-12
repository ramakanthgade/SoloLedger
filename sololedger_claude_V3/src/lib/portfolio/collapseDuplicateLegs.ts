/**
 * Remove SPL transfer legs that duplicate a trade's asset/counterAsset on the same signature.
 * Fixes overstated balances (e.g. USDC credited on both trade and transfer_in).
 */
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

export async function collapseDuplicateTradeTransferLegs(): Promise<number> {
  const all = await db.transactions
    .filter((t) => !t.isSpam && !!t.sourceRef && !!t.walletAddress)
    .toArray();
  const trades = all.filter((t) => t.type === 'trade' && t.counterAsset && (t.counterAmount ?? 0) > 0);
  const tradeByRef = new Map<string, Transaction>();
  for (const t of trades) {
    tradeByRef.set(`${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`, t);
  }

  const toDelete: string[] = [];
  for (const t of all) {
    if (t.type !== 'transfer_in' && t.type !== 'transfer_out' && t.type !== 'income') continue;
    if (t.asset.toUpperCase() === 'SOL') continue;
    const trade = tradeByRef.get(`${t.walletAddress!.toLowerCase()}|${t.sourceRef!}`);
    if (!trade) continue;
    const legs = new Set(
      [trade.asset, trade.counterAsset].filter(Boolean).map((a) => a!.toUpperCase())
    );
    if (legs.has(t.asset.toUpperCase())) toDelete.push(t.id);
  }

  if (toDelete.length > 0) {
    await db.transactions.bulkDelete(toDelete);
  }
  return toDelete.length;
}
