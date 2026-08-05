import type { InventoryDisposal } from './engine';
import type { Transaction } from '@/types/transaction';
import { isMiningIncome } from './matchedGains';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';

const MATCH_EPSILON = 1e-10;

export function isFullyMatchedInventoryDisposal(disposal: InventoryDisposal): boolean {
  const matched = disposal.lotConsumption.reduce((sum, row) => sum + row.amount, 0);
  return matched + MATCH_EPSILON >= disposal.amount;
}

export function unpricedInventoryDisposalsInPeriod(
  disposals: readonly InventoryDisposal[],
  start: number,
  end: number
): InventoryDisposal[] {
  return disposals.filter((row) =>
    !row.finalized && row.disposedAt >= start && row.disposedAt <= end
  );
}

/** Explicit taxable receipt rows whose FMV is unresolved; mining stays zero-cost by design. */
export function unpricedTaxableReceiptsInPeriod(
  transactions: readonly Transaction[],
  start: number,
  end: number
): Transaction[] {
  return transactions.filter((row) =>
    (row.type === 'income' || row.type === 'gift_received') &&
    !row.isInternalTransfer &&
    !isTransactionExcluded(row) &&
    !isDerivativeTransaction(row) &&
    !isMiningIncome(row) &&
    (row.fiatValue == null || !Number.isFinite(row.fiatValue)) &&
    row.timestamp >= start &&
    row.timestamp <= end
  );
}

export function assertTaxExportsComplete(
  unpricedDisposals: readonly InventoryDisposal[],
  unpricedReceipts: readonly Transaction[] = []
): void {
  if (unpricedDisposals.length === 0 && unpricedReceipts.length === 0) return;
  throw new Error(
    `${unpricedDisposals.length} taxable disposal(s) and ${unpricedReceipts.length} taxable receipt(s) are missing market value. Complete them before exporting.`
  );
}
