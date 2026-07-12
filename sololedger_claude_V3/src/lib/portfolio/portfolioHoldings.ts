/**
 * Portfolio holdings helpers — wallet balance must reflect main-wallet on-chain state.
 *
 * Jupiter DCA:
 *  - DBT leaves the wallet on deposit (escrow) → portfolio MUST debit the deposit
 *    even when the row is tax-flagged `isInternalTransfer` (non-taxable escrow).
 *  - Fills only deliver USDC; wallet DBT is unchanged on fill txs → do not debit DBT
 *    on fill trades (still used for capital-gains elsewhere).
 */
import type { Transaction } from '@/types/transaction';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';

export interface PortfolioDcaContext {
  /** Deposit rows — tax-internal escrow; still reduce portfolio holdings. */
  internalDepositIds: Set<string>;
  /** Fill rows → apply counter-asset only (USDC in), never debit input asset from wallet. */
  dcaFillIds: Set<string>;
}

export function isDcaEscrowDeposit(t: Transaction, depositIds?: Set<string>): boolean {
  if (depositIds?.has(t.id)) return true;
  const notes = t.notes?.toLowerCase() ?? '';
  return notes.includes('dca deposit') || notes.includes('non-taxable escrow');
}

export function buildPortfolioDcaContext(txs: Transaction[]): PortfolioDcaContext {
  const groups = detectDcaGroups(txs.filter((t) => !t.isSpam));
  const internalDepositIds = new Set<string>();
  const dcaFillIds = new Set<string>();

  for (const g of groups) {
    internalDepositIds.add(g.depositTx.id);
    for (const fill of g.fillTxs) dcaFillIds.add(fill.id);
  }

  // Persist-classified deposits may already be internal and missed by detection — recover via notes.
  for (const t of txs) {
    if (isDcaEscrowDeposit(t)) internalDepositIds.add(t.id);
  }

  return { internalDepositIds, dcaFillIds };
}

/**
 * Ensure DCA deposit tax flags are visible at runtime.
 * Portfolio holdings still debit these rows (see applyTxToHoldings).
 */
export function applyRuntimeDcaFlags(
  txs: Transaction[],
  ctx: PortfolioDcaContext
): Transaction[] {
  return txs.map((t) => {
    if (ctx.internalDepositIds.has(t.id) && !t.isInternalTransfer) {
      return { ...t, isInternalTransfer: true };
    }
    return t;
  });
}

export function isDcaFillTrade(t: Transaction, dcaFillIds: Set<string>): boolean {
  return dcaFillIds.has(t.id) || (t.type === 'trade' && (t.notes?.includes('DCA fill') ?? false));
}
