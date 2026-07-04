import type { Lot } from '@/types/transaction';
import type { CostBasisStrategy, LotSelection } from './strategy';
import { fifoStrategy } from './fifo';

/**
 * Specific Identification: the user picks exactly which lot(s) a disposal
 * draws from (hint.preferredLotIds, in the order/amounts they specify via
 * the Review UI). Falls back to FIFO for any remainder if the user's
 * selection doesn't cover the full disposed amount, so the calculation
 * never silently loses track of quantity.
 */
export const specIdStrategy: CostBasisStrategy = {
  method: 'SpecID',

  selectLots(openLots, amountToDispose, hint) {
    const byId = new Map(openLots.map((l) => [l.id, l]));
    const selections: LotSelection[] = [];
    let remaining = amountToDispose;

    for (const lotId of hint?.preferredLotIds ?? []) {
      if (remaining <= 0) break;
      const lot = byId.get(lotId);
      if (!lot || lot.amountRemaining <= 0) continue;
      const take = Math.min(lot.amountRemaining, remaining);
      selections.push({ lotId: lot.id, amount: take });
      remaining -= take;
    }

    if (remaining > 0) {
      const consumedIds = new Set(selections.map((s) => s.lotId));
      const rest = openLots.filter((l) => !consumedIds.has(l.id));
      const fallback = fifoStrategy.selectLots(rest, remaining);
      selections.push(...fallback);
    }

    return selections;
  }
};
