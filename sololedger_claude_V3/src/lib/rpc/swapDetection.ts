import type { Transaction, FlagReason } from '@/types/transaction';

/**
 * Last-resort fixed thresholds for native-asset dust, used ONLY when neither a
 * fee leg nor a swapped notional is available to size the threshold. The
 * primary dust test is gas-aware (see `isLikelyNativeFee`).
 */
const NATIVE_FEE_THRESHOLDS: Record<string, number> = {
  SOL: 0.05,
  ETH: 0.01,
  BNB: 0.02,
  MATIC: 0.5,
  AVAX: 0.05
};

const NATIVE_ASSETS = new Set(Object.keys(NATIVE_FEE_THRESHOLDS));

/**
 * Context for gas-aware dust detection within a single on-chain tx group.
 *  - `feeByAsset`: total explicit fee-leg amount seen for each native asset.
 *  - `maxLegByAsset`: largest swap-leg amount for each native asset (used to
 *    size the dust threshold apples-to-apples — a tiny SOL gas leg alongside a
 *    large SOL swap leg is dust; a lone small SOL swap leg is not).
 */
export interface DustContext {
  feeByAsset: Map<string, number>;
  maxLegByAsset: Map<string, number>;
}

/** A leg below this fraction of the largest same-asset leg is gas dust. */
const NOTIONAL_DUST_FRACTION = 0.05; // 5%

/**
 * Ignore tiny native-chain movements that are usually gas/rent inside a swap tx.
 *
 * Gas-aware, in priority order:
 *  1. If the tx has an explicit fee leg in the same native asset, a native leg
 *     at or below that fee amount (+25% slack) is dust.
 *  2. Else, if the same native asset also appears as a larger swap leg, a leg
 *     below a small fraction of that same-asset notional is dust (this catches
 *     gas larger than the fixed constant without cross-asset unit confusion).
 *  3. Else fall back to the fixed per-asset constant.
 */
export function isLikelyNativeFee(tx: Transaction, ctx?: DustContext): boolean {
  const asset = tx.asset?.toUpperCase();
  if (!asset || !NATIVE_ASSETS.has(asset)) return false;
  const amount = Math.abs(tx.amount);

  if (ctx) {
    const feeSeen = ctx.feeByAsset.get(asset);
    if (feeSeen != null && feeSeen > 0) {
      // Gas + a 25% slack band around the observed fee.
      if (amount <= feeSeen * 1.25) return true;
    }
    const maxSameAsset = ctx.maxLegByAsset.get(asset) ?? 0;
    // Only meaningful when a *larger* same-asset leg exists (maxSameAsset > amount).
    if (maxSameAsset > amount && amount < maxSameAsset * NOTIONAL_DUST_FRACTION) {
      return true;
    }
  }

  const threshold = NATIVE_FEE_THRESHOLDS[asset];
  if (threshold == null) return false;
  return amount < threshold;
}

function isSwapCandidate(tx: Transaction, ctx?: DustContext): boolean {
  if (tx.category === 'nft') return false;
  if (isLikelyNativeFee(tx, ctx)) return false;
  return tx.type === 'transfer_in' || tx.type === 'transfer_out';
}

/** Build the dust context for a group of rows sharing one on-chain tx. */
function buildDustContext(group: Transaction[]): DustContext {
  const feeByAsset = new Map<string, number>();
  const maxLegByAsset = new Map<string, number>();
  for (const t of group) {
    const asset = t.asset?.toUpperCase();
    if (!asset) continue;
    if (t.type === 'fee' && NATIVE_ASSETS.has(asset)) {
      feeByAsset.set(asset, (feeByAsset.get(asset) ?? 0) + Math.abs(t.amount));
    }
    if (t.type === 'transfer_in' || t.type === 'transfer_out') {
      maxLegByAsset.set(asset, Math.max(maxLegByAsset.get(asset) ?? 0, Math.abs(t.amount)));
    }
  }
  return { feeByAsset, maxLegByAsset };
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

/**
 * Net same-asset legs into one signed position per asset.
 * Outflows count negative, inflows positive. Returns the aggregated assets and,
 * per asset, the representative (largest-magnitude) leg so we keep its metadata.
 */
interface NettedAsset {
  asset: string;
  net: number; // >0 net inflow, <0 net outflow
  rep: Transaction; // largest-magnitude leg for this asset
}

function netSwapLegs(legs: Transaction[]): NettedAsset[] {
  const byAsset = new Map<string, { net: number; rep: Transaction; repMag: number }>();
  for (const leg of legs) {
    const asset = leg.asset.toUpperCase();
    const signed = leg.type === 'transfer_out' ? -Math.abs(leg.amount) : Math.abs(leg.amount);
    const mag = Math.abs(leg.amount);
    const existing = byAsset.get(asset);
    if (!existing) {
      byAsset.set(asset, { net: signed, rep: leg, repMag: mag });
    } else {
      existing.net += signed;
      if (mag > existing.repMag) {
        existing.rep = leg;
        existing.repMag = mag;
      }
    }
  }
  return [...byAsset.entries()].map(([asset, v]) => ({ asset, net: v.net, rep: v.rep }));
}

/**
 * When a single on-chain transaction moves one asset out and another in (typical DEX
 * swap on Solana/EVM), merge the balance-delta rows into one `trade` row so cost
 * basis and price lookup treat it as a taxable swap rather than non-taxable transfers.
 *
 * Handles multi-hop / split-route swaps too: 2+ out legs and/or 2+ in legs are
 * netted per asset; if the group reduces to exactly one dominant out asset and
 * one dominant in asset, they merge into a single trade. Otherwise the legs are
 * left intact and flagged `needs_review`.
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

    const ctx = buildDustContext(group);
    const swapLegs = group.filter((t) => isSwapCandidate(t, ctx));
    const outs = swapLegs.filter((t) => t.type === 'transfer_out');
    const ins = swapLegs.filter((t) => t.type === 'transfer_in');

    // Simple 1-out / 1-in swap.
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

    // Multi-hop / split route: 2+ outs and/or 2+ ins.
    if (outs.length + ins.length >= 3 && outs.length >= 1 && ins.length >= 1) {
      const netted = netSwapLegs(swapLegs).filter((n) => Math.abs(n.net) > 0);
      const netOuts = netted.filter((n) => n.net < 0);
      const netIns = netted.filter((n) => n.net > 0);

      if (netOuts.length === 1 && netIns.length === 1) {
        const outAsset = netOuts[0];
        const inAsset = netIns[0];
        const base = outAsset.rep;
        removedIds.push(...swapLegs.filter((t) => t.id !== base.id).map((t) => t.id));
        tradesCreated++;
        standalone.push({
          ...base,
          type: 'trade',
          asset: outAsset.asset,
          amount: Math.abs(outAsset.net),
          counterAsset: inAsset.asset,
          counterAmount: Math.abs(inAsset.net),
          flags: (base.flags ?? []).filter((f) => f !== 'possible_internal_transfer'),
          notes: base.notes ?? 'Auto-detected multi-hop swap (netted on-chain balance changes).'
        });
        // Keep any non-swap legs (fees/income) untouched.
        for (const t of group) {
          if (!swapLegs.includes(t)) standalone.push(t);
        }
        continue;
      }

      // Ambiguous (multiple distinct in/out assets) — leave legs, flag for review.
      for (const t of group) {
        if (swapLegs.includes(t)) {
          const flags = (t.flags ?? []).filter((f) => f !== 'needs_review') as FlagReason[];
          flags.push('needs_review');
          standalone.push({ ...t, flags });
        } else {
          standalone.push(t);
        }
      }
      continue;
    }

    standalone.push(...group);
  }

  return { transactions: standalone, removedIds, tradesCreated };
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
    const ctx = buildDustContext(group);
    const outs = group.filter((t) => t.type === 'transfer_out' && isSwapCandidate(t, ctx));
    const ins = group.filter((t) => t.type === 'transfer_in' && isSwapCandidate(t, ctx));
    if (outs.length === 1 && ins.length === 1) count++;
    else if (outs.length + ins.length >= 3 && outs.length >= 1 && ins.length >= 1) {
      const netted = netSwapLegs([...outs, ...ins]).filter((n) => Math.abs(n.net) > 0);
      if (netted.filter((n) => n.net < 0).length === 1 && netted.filter((n) => n.net > 0).length === 1) {
        count++;
      }
    }
  }
  return count;
}
