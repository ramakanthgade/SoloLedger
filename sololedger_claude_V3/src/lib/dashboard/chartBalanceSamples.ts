import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import type { PreparedHistoricalLedgerReplay } from '@/lib/portfolio/holdingsProjection';

export interface HistoricalGroupedBalance {
  quantity: number;
  scopes: Array<{ scopeId: string; accountClass: DerivedPosting['accountClass'] }>;
}

/** Sample in posting order, preserving opening-balance resets and floating-point order. */
export function groupedBalancesAtSamples(
  replay: PreparedHistoricalLedgerReplay,
  samples: readonly number[],
  metrics?: { groupedPostingVisits: number }
): ReadonlyMap<number, ReadonlyMap<string, HistoricalGroupedBalance>> {
  const prepared = replay.preparedPostings;
  const { ordered, balanceSlotByPosting, assetSlotByPosting, assetKeys } = prepared;
  const balances: number[] = [];
  const assets: Array<HistoricalGroupedBalance | undefined> = [];
  // Legacy pipe-delimited balance slots can alias distinct tuples. Preserve the
  // historical grouping key in that uncommon case rather than merging custody.
  const fallbackSlots = prepared.hasBalanceKeyCollisions ? new Map<string, number>() : undefined;
  const result = new Map<number, ReadonlyMap<string, HistoricalGroupedBalance>>();
  let postingIndex = 0;
  for (const sample of samples) {
    while (postingIndex < ordered.length && ordered[postingIndex].effectiveAt <= sample) {
      const index = postingIndex++;
      const posting = ordered[index];
      if (metrics) metrics.groupedPostingVisits += 1;
      let balanceSlot = balanceSlotByPosting[index];
      if (fallbackSlots) {
        const key = `${posting.accountScopeId}\u001f${posting.accountClass}\u001f${posting.assetKey}`;
        let slot = fallbackSlots.get(key);
        if (slot == null) {
          slot = fallbackSlots.size;
          fallbackSlots.set(key, slot);
        }
        balanceSlot = slot;
      }
      const assetSlot = assetSlotByPosting[index];
      let asset = assets[assetSlot];
      if (!asset) {
        asset = { quantity: 0, scopes: [] };
        assets[assetSlot] = asset;
      }
      const previous = balances[balanceSlot] ?? 0;
      if (balances[balanceSlot] === undefined) {
        asset.scopes.push({ scopeId: posting.accountScopeId, accountClass: posting.accountClass });
      }
      const next = posting.role === 'opening_balance' ? posting.signedQuantity : previous + posting.signedQuantity;
      balances[balanceSlot] = next;
      asset.quantity += next - previous;
    }
    const snapshot = new Map<string, HistoricalGroupedBalance>();
    for (let slot = 0; slot < assets.length; slot++) {
      const asset = assets[slot];
      if (asset) snapshot.set(assetKeys[slot], { quantity: asset.quantity, scopes: [...asset.scopes] });
    }
    result.set(sample, snapshot);
  }
  return result;
}
