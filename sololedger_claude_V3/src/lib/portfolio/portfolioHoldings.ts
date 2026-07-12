/**
 * Portfolio holdings helpers — wallet balance must reflect main-wallet on-chain state.
 *
 * Jupiter DCA: DBT leaves the wallet on deposit (escrow). Fills only deliver USDC;
 * wallet DBT balance is unchanged on fill txs. Trade rows for fills must not debit DBT
 * in portfolio math (still used for capital-gains / cost-basis elsewhere).
 */
import type { Transaction } from '@/types/transaction';
import { detectDcaGroups } from '@/lib/rpc/dcaDetection';

export interface PortfolioDcaContext {
  /** Deposit rows → treat outgoing leg as internal (non-taxable escrow). */
  internalDepositIds: Set<string>;
  /** Fill rows → apply counter-asset only (USDC in), never debit input asset from wallet. */
  dcaFillIds: Set<string>;
}

export function buildPortfolioDcaContext(txs: Transaction[]): PortfolioDcaContext {
  const groups = detectDcaGroups(txs.filter((t) => !t.isSpam));
  const internalDepositIds = new Set<string>();
  const dcaFillIds = new Set<string>();

  for (const g of groups) {
    internalDepositIds.add(g.depositTx.id);
    for (const fill of g.fillTxs) dcaFillIds.add(fill.id);
  }

  return { internalDepositIds, dcaFillIds };
}

/** Apply runtime DCA flags so holdings match wallet without requiring a DB re-import. */
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
