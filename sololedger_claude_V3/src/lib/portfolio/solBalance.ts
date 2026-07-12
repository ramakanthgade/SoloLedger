/**
 * Solana SOL portfolio balance — single source of truth.
 *
 * Matches Phantom / getBalance (main-wallet lamports, spendable SOL).
 *
 * Stable rules (do not override elsewhere):
 *  1. Network fees (type=fee, asset=SOL, notes NOT rent) → subtract from holdings
 *  2. Token-account rent (fee rows with rent notes) → subtract (main wallet paid rent)
 *  3. Internal transfer_out (DCA DBT deposit, etc.) → skip
 *  4. transfer_in / income / gift_received → add
 *  5. transfer_out / gift_sent (non-internal) → subtract
 *  6. trade rows with SOL legs → handled like other assets in applyTxToHoldings
 *  7. One row per (wallet, sourceRef, asset) after collapseForPortfolio
 */
import { db } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

export function isSolanaRentRow(t: Transaction): boolean {
  return t.asset === 'SOL' && (t.notes?.toLowerCase().includes('rent') ?? false);
}

/**
 * Normalize SOL rows in IndexedDB to the canonical ledger form.
 * Fixes legacy rows flipped between internal/fee by earlier patches.
 * Idempotent — run after import, DCA apply, or on Portfolio load.
 */
export async function normalizeSolLedgerRows(): Promise<number> {
  const solTxs = await db.transactions.filter((t) => t.asset === 'SOL').toArray();
  let updated = 0;

  for (const t of solTxs) {
    const noteLower = t.notes?.toLowerCase() ?? '';
    const isRentDeposit =
      noteLower.includes('rent deposit') ||
      noteLower.includes('rent (jupiter') ||
      (noteLower.includes('rent') && noteLower.includes('jupiter dca setup'));
    const isLegacyInternalRent =
      t.isInternalTransfer &&
      (t.type === 'transfer_out' || t.type === 'fee') &&
      t.amount > 0 &&
      t.amount < 0.01;

    if (isRentDeposit || isLegacyInternalRent) {
      if (t.type !== 'fee' || t.isInternalTransfer) {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(t.id, {
          type: 'fee',
          isInternalTransfer: false,
          flags: [],
          notes: 'Token account rent (Jupiter DCA setup) — reduces wallet SOL balance'
        });
        updated++;
      }
      continue;
    }

    if (t.notes === 'Solana network fee' && t.type !== 'fee') {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(t.id, { type: 'fee', isInternalTransfer: false });
      updated++;
    }
  }

  return updated;
}
