import type { Transaction } from '@/types/transaction';

const NATIVE_FEE_THRESHOLDS: Record<string, number> = {
  SOL: 0.05,
  ETH: 0.01,
  BNB: 0.02,
  MATIC: 0.5,
  AVAX: 0.05
};

/** Ignore tiny native-chain movements that are usually gas/rent inside a swap tx. */
function isLikelyNativeFee(tx: Transaction): boolean {
  const threshold = NATIVE_FEE_THRESHOLDS[tx.asset];
  if (threshold == null) return false;
  return tx.amount < threshold;
}

function isSwapCandidate(tx: Transaction): boolean {
  if (tx.category === 'nft') return false;
  if (isLikelyNativeFee(tx)) return false;
  return tx.type === 'transfer_in' || tx.type === 'transfer_out';
}

export function tradeLegAssets(trade: Transaction): Set<string> {
  return new Set(
    [trade.asset, trade.counterAsset]
      .filter(Boolean)
      .map((a) => a!.toUpperCase())
  );
}

/** Transfer / income leg already represented on a trade row for the same on-chain tx. */
export function isAbsorbedTradeLeg(tx: Transaction, trade: Transaction): boolean {
  if (
    tx.type !== 'transfer_in' &&
    tx.type !== 'transfer_out' &&
    tx.type !== 'income'
  ) {
    return false;
  }
  if (!trade.counterAsset || (trade.counterAmount ?? 0) <= 0) return false;
  return tradeLegAssets(trade).has(tx.asset.toUpperCase());
}

export interface SwapDetectionResult {
  transactions: Transaction[];
  /** transfer_in rows absorbed into a trade (safe to delete from DB). */
  removedIds: string[];
  tradesCreated: number;
}

/** Count rpc groups that look like unprocessed 1-out / 1-in swap pairs. */
export function countPotentialSwapPairs(transactions: Transaction[]): number {
  const byRef = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (!tx.sourceRef || !tx.source.startsWith('rpc:') || tx.type === 'trade') continue;
    const group = byRef.get(tx.sourceRef) ?? [];
    group.push(tx);
    byRef.set(tx.sourceRef, group);
  }
  let count = 0;
  for (const group of byRef.values()) {
    const outs = group.filter((t) => t.type === 'transfer_out' && isSwapCandidate(t));
    const ins = group.filter((t) => t.type === 'transfer_in' && isSwapCandidate(t));
    if (outs.length === 1 && ins.length === 1) count++;
  }
  return count;
}

/**
 * When a single on-chain transaction moves one asset out and another in (typical DEX
 * swap on Solana/EVM), merge the balance-delta rows into one `trade` row so cost
 * basis and price lookup treat it as a taxable swap rather than non-taxable transfers.
 */
export function detectDexSwaps(transactions: Transaction[]): SwapDetectionResult {
  const standalone: Transaction[] = [];
  const byRef = new Map<string, Transaction[]>();
  const removedIds: string[] = [];
  let tradesCreated = 0;

  for (const tx of transactions) {
    if (!tx.sourceRef || !tx.source.startsWith('rpc:')) {
      standalone.push(tx);
      continue;
    }
    const group = byRef.get(tx.sourceRef) ?? [];
    group.push(tx);
    byRef.set(tx.sourceRef, group);
  }

  for (const group of byRef.values()) {
    const existingTrade = group.find((t) => t.type === 'trade');
    if (existingTrade) {
      standalone.push(existingTrade);
      for (const t of group) {
        if (t.id === existingTrade.id) continue;
        // Keep fees, income, and legs not already on the trade (e.g. SOL rent on a token swap).
        if (t.type === 'fee' || !isAbsorbedTradeLeg(t, existingTrade)) {
          standalone.push(t);
        } else {
          removedIds.push(t.id);
        }
      }
      continue;
    }

    const swapLegs = group.filter((t) => isSwapCandidate(t));
    const outs = swapLegs.filter((t) => t.type === 'transfer_out');
    const ins = swapLegs.filter((t) => t.type === 'transfer_in');

    if (outs.length === 1 && ins.length === 1) {
      const out = outs[0];
      const inn = ins[0];
      removedIds.push(inn.id);
      tradesCreated++;
      standalone.push({
        ...out,
        type: 'trade',
        counterAsset: inn.asset,
        counterAmount: inn.amount,
        flags: (out.flags ?? []).filter((f) => f !== 'possible_internal_transfer'),
        notes: out.notes ?? 'Auto-detected swap from on-chain balance changes.'
      });
      continue;
    }

    standalone.push(...group);
  }

  return { transactions: standalone, removedIds, tradesCreated };
}
