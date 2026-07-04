import type { Lot } from '@/types/transaction';
import type { CostBasisStrategy, LotSelection } from './strategy';

/** First-In-First-Out: consumes the oldest open lots first. */
export const fifoStrategy: CostBasisStrategy = {
  method: 'FIFO',

  selectLots(openLots, amountToDispose) {
    const sorted = [...openLots]
      .filter((l) => l.amountRemaining > 0)
      .sort((a, b) => a.acquiredAt - b.acquiredAt);

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
