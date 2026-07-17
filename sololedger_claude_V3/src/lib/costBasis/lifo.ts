import type { CostBasisStrategy, LotSelection } from './strategy';
import { isPositive } from './decimal';

/** Last-In-First-Out: consumes the newest open lots first. */
export const lifoStrategy: CostBasisStrategy = {
  method: 'LIFO',

  selectLots(openLots, amountToDispose) {
    const sorted = [...openLots]
      .filter((l) => isPositive(l.amountRemaining))
      // newest first; tie-break on id so ordering is deterministic
      .sort((a, b) => b.acquiredAt - a.acquiredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
