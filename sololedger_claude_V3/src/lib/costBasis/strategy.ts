import type { Lot } from '@/types/transaction';

/**
 * A CostBasisStrategy decides which open lot(s) a disposal consumes.
 * FIFO and Specific ID both implement this; adding LIFO/HIFO later is just
 * a new class satisfying the same interface — nothing else in the engine
 * needs to change.
 */
export interface LotSelection {
  lotId: string;
  amount: number;
}

export interface CostBasisStrategy {
  method: 'FIFO' | 'SpecID';
  /**
   * Given the open lots for an asset (sorted however the strategy wants) and
   * an amount being disposed, return which lots to consume and how much
   * from each. Must consume exactly `amountToDispose` in total, or as much
   * as is available (caller flags a shortfall as `missing_cost_basis`).
   */
  selectLots(openLots: Lot[], amountToDispose: number, hint?: { preferredLotIds?: string[] }): LotSelection[];
}
