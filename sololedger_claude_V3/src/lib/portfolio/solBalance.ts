/**
 * Solana main-wallet SOL balance — matches Solscan / getBalance (lamports on owner pubkey).
 *
 * PR #25 rules (stable — do not override in PortfolioTab or elsewhere):
 *  1. Network fees (type=fee, notes "Solana network fee") → subtract
 *  2. Token-account rent deposits (type=fee, outgoing rent) → subtract
 *  3. Internal transfer_out (DCA DBT deposit, etc.) → skip
 *  4. transfer_in / income / gift_received → add (includes rent refunds to main wallet)
 *  5. transfer_out / gift_sent (non-internal) → subtract
 *  6. trade with SOL as asset or counterAsset → apply legs
 *  7. Trade + fee rows on the same tx are separate legs; transfers drop when trade covers SOL
 */
import { db, transactionSourceKey } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

/** Tolerance for SOL mismatch warning (~1 main-wallet tx fee). */
export const SOL_MAIN_WALLET_TOLERANCE = 0.00005;

const SOL_IN_TYPES = new Set(['transfer_in', 'income', 'gift_received', 'buy']);
const SOL_OUT_TYPES = new Set(['transfer_out', 'gift_sent', 'sell']);

function solRowScore(t: Transaction): number {
  if (t.type === 'fee') return 1_000_000;
  if (t.type === 'trade') return 500_000;
  return 100_000 + (t.fiatValue != null ? 10_000 : 0);
}

function tradeTouchesSol(t: Transaction): boolean {
  if (t.type !== 'trade') return false;
  if (t.asset === 'SOL' && t.amount >= 0.001) return true;
  return t.counterAsset?.toUpperCase() === 'SOL' && (t.counterAmount ?? 0) >= 0.001;
}

/** Rent returned to main wallet when token accounts close — must ADD to balance. */
export function isSolRentRefund(t: Transaction): boolean {
  if (t.asset !== 'SOL') return false;
  const note = t.notes?.toLowerCase() ?? '';
  return note.includes('refund') || note.includes('account close') || note.includes('close');
}

/** Rent paid from main wallet to open token accounts — must SUBTRACT from balance. */
export function isSolRentDeposit(t: Transaction): boolean {
  if (t.asset !== 'SOL' || isSolRentRefund(t)) return false;
  const note = t.notes?.toLowerCase() ?? '';
  if (note.includes('rent') && !note.includes('refund')) return true;
  return t.type === 'transfer_out' && t.amount > 0 && t.amount < 0.01;
}

/**
 * Collapse duplicate SOL transfer rows per on-chain tx.
 * Trade and fee rows always pass through — they are separate legs (swap + network fee).
 */
export function collapseSolTxRows(txs: Transaction[]): Transaction[] {
  const feeKeys = new Set<string>();
  const tradeKeys = new Set<string>();
  for (const t of txs) {
    if (t.isSpam || t.asset !== 'SOL') continue;
    const sk = transactionSourceKey(t);
    if (!sk) continue;
    if (t.type === 'fee') feeKeys.add(sk);
    if (tradeTouchesSol(t)) tradeKeys.add(sk);
  }

  const best = new Map<string, Transaction>();
  for (const t of txs) {
    if (t.isSpam || t.asset !== 'SOL') continue;
    if (t.type === 'fee' || t.type === 'trade') continue;
    const sk = transactionSourceKey(t);
    if (!sk) continue;
    const prev = best.get(sk);
    if (!prev || solRowScore(t) > solRowScore(prev)) best.set(sk, t);
  }
  return txs.filter((t) => {
    if (t.isSpam || t.asset !== 'SOL') return true;
    if (t.type === 'fee' || t.type === 'trade') return true;
    const sk = transactionSourceKey(t);
    // Swap txs already encode SOL legs on the trade row — skip redundant transfers.
    if (sk && tradeKeys.has(sk)) return false;
    // Drop tiny outgoing transfers when a fee row already captures rent on this tx.
    if (
      sk &&
      feeKeys.has(sk) &&
      t.type === 'transfer_out' &&
      t.amount < 0.01 &&
      !isSolRentRefund(t)
    ) {
      return false;
    }
    return !sk || best.get(sk) === t;
  });
}

function solDedupKey(t: Transaction): string | null {
  const sk = transactionSourceKey(t);
  if (!sk) return null;
  return `${sk}|${t.type}`;
}

/**
 * Reconstruct main-wallet SOL from transaction history (PR #25 math).
 * Compare against live getBalance on the all-time Portfolio view to validate imports.
 */
export function computeMainWalletSolFromTransactions(txs: Transaction[]): number {
  const collapsed = collapseSolTxRows(txs);
  const applied = new Set<string>();
  let sol = 0;

  for (const t of [...collapsed].sort((a, b) => a.timestamp - b.timestamp)) {
    if (t.isSpam || t.asset !== 'SOL') continue;

    const dedup = solDedupKey(t);
    if (dedup) {
      if (applied.has(dedup)) continue;
      applied.add(dedup);
    }

    if (
      t.isInternalTransfer &&
      (t.type === 'transfer_out' || t.type === 'sell' || t.type === 'gift_sent')
    ) {
      continue;
    }

    if (t.type === 'fee') {
      // Legacy rows: rent refunds were sometimes misclassified as fee — credit, don't debit.
      if (isSolRentRefund(t)) sol += t.amount;
      else sol -= t.amount;
      continue;
    }

    if (t.type === 'trade') {
      if (t.asset === 'SOL') sol -= t.amount;
      const solCounter = t.counterAsset?.toUpperCase() === 'SOL' ? t.counterAmount : undefined;
      if (solCounter && solCounter > 0) sol += solCounter;
      if (t.feeAsset?.toUpperCase() === 'SOL' && t.feeAmount) sol -= t.feeAmount;
      continue;
    }

    if (SOL_IN_TYPES.has(t.type)) sol += t.amount;
    else if (SOL_OUT_TYPES.has(t.type)) sol -= t.amount;

    if (t.feeAsset?.toUpperCase() === 'SOL' && t.feeAmount && t.type !== 'trade') {
      sol -= t.feeAmount;
    }
  }

  return sol;
}

export function isSolanaRentRow(t: Transaction): boolean {
  return t.asset === 'SOL' && (isSolRentDeposit(t) || isSolRentRefund(t));
}

/**
 * Normalize SOL rows in IndexedDB to canonical PR #25 form.
 * Idempotent — run after import, DCA apply, or on Portfolio load.
 */
export async function normalizeSolLedgerRows(): Promise<number> {
  const solTxs = await db.transactions.filter((t) => t.asset === 'SOL').toArray();
  let updated = 0;

  for (const t of solTxs) {
    const isNetworkFee = t.notes === 'Solana network fee';

    // Repair rent refunds wrongly stored as fee (understates balance by 2× refund amount).
    if (t.type === 'fee' && isSolRentRefund(t)) {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(t.id, {
        type: 'transfer_in',
        isInternalTransfer: false,
        flags: [],
        notes: t.notes?.includes('refund')
          ? t.notes
          : 'Token account rent refund (DCA account close)'
      });
      updated++;
      continue;
    }

    if (isNetworkFee && t.type !== 'fee') {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(t.id, { type: 'fee', isInternalTransfer: false });
      updated++;
      continue;
    }

    // Outgoing rent only — never convert transfer_in / refunds to fee.
    if (isSolRentDeposit(t) && !isNetworkFee) {
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

    if (isSolRentRefund(t) && t.type !== 'transfer_in') {
      // eslint-disable-next-line no-await-in-loop
      await db.transactions.update(t.id, {
        type: 'transfer_in',
        isInternalTransfer: false,
        flags: [],
        notes: t.notes?.includes('refund')
          ? t.notes
          : 'Token account rent refund (DCA account close)'
      });
      updated++;
    }
  }

  return updated;
}
