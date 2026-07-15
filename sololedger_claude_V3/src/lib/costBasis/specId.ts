import type { CostBasisStrategy, LotSelection } from './strategy';
import { fifoStrategy } from './fifo';
import { isPositive } from './decimal';

/**
 * Specific Identification: the user picks exactly which lot(s) a disposal
 * draws from (hint.preferredLotIds, in the order/amounts they specify via
 * the Review UI). Falls back to FIFO for any remainder if the user's
 * selection doesn't cover the full disposed amount, so the calculation
 * never silently loses track of quantity.
 *
 * Duplicate hint ids are de-duplicated (first occurrence wins) and any lot
 * already consumed in this same selection is skipped, so a lot can never be
 * consumed twice or produce a negative residual.
 */
export const specIdStrategy: CostBasisStrategy = {
  method: 'SpecID',

  selectLots(openLots, amountToDispose, hint) {
    const byId = new Map(openLots.map((l) => [l.id, l]));
    const selections: LotSelection[] = [];
    const consumedIds = new Set<string>();
    let remaining = amountToDispose;

    for (const lotId of hint?.preferredLotIds ?? []) {
      if (remaining <= 0) break;
      // Dedupe: skip ids we've already picked (double-consume guard).
      if (consumedIds.has(lotId)) continue;
      const lot = byId.get(lotId);
      if (!lot || !isPositive(lot.amountRemaining)) continue;
      const take = Math.min(lot.amountRemaining, remaining);
      if (take > 0) {
        selections.push({ lotId: lot.id, amount: take });
        consumedIds.add(lot.id);
        remaining -= take;
      }
    }

    if (remaining > 0) {
      const rest = openLots.filter((l) => !consumedIds.has(l.id));
      const fallback = fifoStrategy.selectLots(rest, remaining);
      selections.push(...fallback);
    }

    return selections;
  }
};
