/**
 * One-time repair for DCA mis-classifications written by the pre-hardening
 * detector (see dcaDetection.ts header — the phantom "USDC → USDT trade").
 *
 * Strategy: undo → redo.
 *   1. Revert every auto-generated DCA row to its pre-classification state:
 *      - fills (trade rows with `DCA fill:` notes) → back to `transfer_in` of
 *        the received leg (counterAsset/counterAmount faithfully preserve it);
 *        fiatValue is kept — it was priced on that received leg.
 *      - deposits (internal rows with `DCA deposit` notes) → back to ordinary
 *        transfer_outs (only flags/notes/internal were touched originally).
 *      Reverted rows are flagged needs_review with a plain-language note so
 *      the user sees exactly what changed.
 *   2. Re-run the HARDENED detector + classification over the reverted data.
 *      Genuine orders re-classify (with Jupiter-exact amounts); phantom groups
 *      fail the new rules and stay as plain transfers.
 *
 * Safety: if any affected row is Solana-chain and Jupiter's API is
 * unreachable, NOTHING is written (retry next session) — an outage must never
 * turn a genuine classification into a revert-only degradation.
 *
 * Hosted mode only: the caller (ReviewTab) gates invocation. Local/BYOK users
 * classified manually, so their rows are their own decision.
 */
import { db } from '@/lib/storage/db';
import type { FlagReason, Transaction } from '@/types/transaction';
import { fetchJupiterRecurringHistory } from '@/lib/rpc/jupiterDca';
import { resolveSolanaMintAddress } from '@/lib/assets/solanaMints';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';

export interface DcaRepairResult {
  status: 'none' | 'aborted-unreachable' | 'done';
  revertedFills: number;
  revertedDeposits: number;
  reappliedGroups: number;
  estimated: number;
}

const FILL_NOTE = 'dca fill:';
const DEPOSIT_NOTE = 'dca deposit';

const REVERT_FILL_NOTE =
  'We corrected an automatic "recurring order" grouping that didn’t hold up — this is a plain receive again. Please check it.';
const REVERT_DEPOSIT_NOTE =
  'We corrected an automatic "recurring order" grouping that didn’t hold up — this is a plain send again. Please check it.';

function isAutoDcaFill(t: Transaction): boolean {
  return t.type === 'trade' && (t.notes?.toLowerCase().startsWith(FILL_NOTE) ?? false);
}

function isAutoDcaDeposit(t: Transaction): boolean {
  return t.isInternalTransfer === true && (t.notes?.toLowerCase().includes(DEPOSIT_NOTE) ?? false);
}

/** Rebuild a fill row as the plain transfer_in it was before classification. */
function revertFillRow(t: Transaction): Transaction {
  const receivedAsset = t.counterAsset ?? t.asset;
  const receivedAmount = t.counterAmount ?? t.amount;
  // The contract address was overwritten with the INPUT (sold) mint. Recover
  // the received token's mint from the Solana registry; when it isn't there
  // (and for all EVM rows) set NO contract — a missing contract falls back to
  // symbol-based pricing, a wrong one would misprice the received token as
  // the sold one.
  const recoveredContract =
    t.chain === 'solana' && t.counterAsset
      ? resolveSolanaMintAddress(t.counterAsset)
      : undefined;
  const { counterAsset: _ca, counterAmount: _cm, ...rest } = t;
  return {
    ...rest,
    type: 'transfer_in',
    asset: receivedAsset,
    amount: receivedAmount,
    contractAddress: recoveredContract,
    flags: ['needs_review'] as FlagReason[],
    notes: REVERT_FILL_NOTE
    // fiatValue intentionally preserved — it was priced on this received leg.
  };
}

/** Rebuild a deposit row as the plain transfer_out it was before classification. */
function revertDepositRow(t: Transaction): Transaction {
  return {
    ...t,
    type: 'transfer_out',
    isInternalTransfer: false,
    flags: ['needs_review'] as FlagReason[],
    notes: REVERT_DEPOSIT_NOTE
  };
}

export async function repairDcaMisclassifications(
  alchemyApiKey?: string
): Promise<DcaRepairResult> {
  const all = await db.transactions.toArray();
  const fills = all.filter(isAutoDcaFill);
  const deposits = all.filter(isAutoDcaDeposit);

  if (fills.length === 0 && deposits.length === 0) {
    return { status: 'none', revertedFills: 0, revertedDeposits: 0, reappliedGroups: 0, estimated: 0 };
  }

  // Solana rows need Jupiter for the redo half — refuse to run during an outage.
  const solanaWallets = new Set(
    [...fills, ...deposits]
      .filter((t) => t.chain === 'solana')
      .map((t) => t.walletAddress)
      .filter(Boolean) as string[]
  );
  for (const wallet of solanaWallets) {
    // eslint-disable-next-line no-await-in-loop
    const jupiter = await fetchJupiterRecurringHistory(wallet);
    if (!jupiter.reachable) {
      return {
        status: 'aborted-unreachable',
        revertedFills: 0,
        revertedDeposits: 0,
        reappliedGroups: 0,
        estimated: 0
      };
    }
  }

  // 1. Revert (bulkPut whole rows so counterAsset/counterAmount are truly gone).
  // One rw transaction: fills + deposits commit together or not at all.
  await db.transaction('rw', db.transactions, async () => {
    await db.transactions.bulkPut(fills.map(revertFillRow));
    await db.transactions.bulkPut(deposits.map(revertDepositRow));
  });

  // 2. Redo with the hardened detector (Jupiter-verified for Solana).
  const reverted = await db.transactions.toArray();
  const groups = detectDcaGroups(reverted);
  let reappliedGroups = 0;
  let estimated = 0;
  if (groups.length > 0) {
    const applied = await applyDcaClassification(groups, alchemyApiKey);
    reappliedGroups = applied.applied;
    estimated = applied.estimated;
  }

  return {
    status: 'done',
    revertedFills: fills.length,
    revertedDeposits: deposits.length,
    reappliedGroups,
    estimated
  };
}
