import type { CostBasisStrategy, LotSelection } from './strategy';
import { isPositive } from './decimal';

/** First-In-First-Out: consumes the oldest open lots first. */
export const fifoStrategy: CostBasisStrategy = {
  method: 'FIFO',

  selectLots(openLots, amountToDispose) {
    const sorted = [...openLots]
      .filter((l) => isPositive(l.amountRemaining))
      // oldest first; tie-break on id so ordering is deterministic
      .sort((a, b) => a.acquiredAt - b.acquiredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const selections: LotSelection[] = [];
    let remaining = amountToDispose;

    for (const lot of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(lot.amountRemaining, remaining);
      if (take > 0) {
        selections.push({ lotId: lot.id, amount: take });
        remaining -= take;
      }
    }

    return selections;
  }
};
