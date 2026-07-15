import type { CostBasisStrategy, LotSelection } from './strategy';
import { isPositive } from './decimal';

/**
 * Highest-In-First-Out: consumes the lots with the highest cost-per-unit
 * first, minimizing realized gains (or maximizing realized losses) on each
 * disposal. Ties on cost-per-unit break to the oldest lot first, then by id,
 * so the ordering is fully deterministic.
 */
export const hifoStrategy: CostBasisStrategy = {
  method: 'HIFO',

  selectLots(openLots, amountToDispose) {
    const sorted = [...openLots]
      .filter((l) => isPositive(l.amountRemaining))
      .sort(
        (a, b) =>
          b.costBasisPerUnit - a.costBasisPerUnit ||
          a.acquiredAt - b.acquiredAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );

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
