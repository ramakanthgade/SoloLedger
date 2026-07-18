/**
 * DefiLlama-driven reward-income SUGGESTIONS (Phase 2).
 *
 * Where Phase 1 (`reprocessRewardIncome` in reprocessSwaps.ts) auto-classifies
 * with HIGH confidence from the static registry (mint + known distributor
 * wallet), this pass handles the LONG TAIL: any Solana token that DefiLlama
 * reports as a pool reward. That signal is genuine but weak — the same mint
 * also moves as ordinary transfers — so matches are a MEDIUM-confidence
 * *suggestion*, never silent truth:
 *
 *   - the row is reclassified `income` / category `defi_reward` so it shows up
 *     in the Income & Rewards views immediately, BUT
 *   - it is flagged `needs_review`, which surfaces it in the Review tab's
 *     "Needs review" queue for the user to confirm (remove the flag) or send
 *     back to `transfer_in` (per-row Type selector).
 *
 * Conservative guards (same as Phase 1): only rows still typed `transfer_in`
 * are touched — never a row the user already classified, made internal, or
 * marked spam — and transfers from the user's own wallets are skipped.
 */

import { db } from '@/lib/storage/db';
import {
  fetchSolanaRewardHints,
  type LlamaRewardHint
} from '@/lib/assets/defiLlamaRewards';
import type { FlagReason, Transaction } from '@/types/transaction';

export interface RewardSuggestionResult {
  /** Solana reward-token mints in the DefiLlama hint set. */
  hintsCount: number;
  /** Unclassified Solana transfer_ins examined. */
  candidates: number;
  /** Rows flipped to income + needs_review. */
  suggested: number;
  /** True when hints came from cache rather than the network. */
  fromCache: boolean;
  message: string;
}

function suggestionNotes(asset: string, hint: LlamaRewardHint): string {
  // `hint.projects` is already capped at MAX_HINT_PROJECTS when parsed.
  return (
    `Suggested DeFi reward: ${asset} is a reward token in DefiLlama Solana pools ` +
    `(${hint.projects.join(', ')}). Confirm (remove the needs-review flag) or reclassify.`
  );
}

/**
 * A row eligible for a reward-income suggestion: an unclassified Solana token
 * transfer_in the user hasn't made internal or marked spam. The suggestion
 * pass additionally requires the mint to be in the DefiLlama hint set; the
 * Review tab uses this predicate alone to count "checkable" transfers.
 */
export function isUnclassifiedSolanaTransferIn(t: Transaction): boolean {
  return (
    t.type === 'transfer_in' &&
    t.chain === 'solana' &&
    !!t.contractAddress &&
    !t.isInternalTransfer &&
    !t.isSpam
  );
}

/**
 * Run the suggestion pass. `opts.hints` injects a hint set directly (tests,
 * or a caller that already fetched); otherwise the hints are fetched through
 * the cached, user-gated `fetchSolanaRewardHints`.
 */
export async function applyDefiLlamaRewardSuggestions(opts?: {
  hints?: Map<string, LlamaRewardHint>;
  forceRefresh?: boolean;
}): Promise<RewardSuggestionResult> {
  let hints: Map<string, LlamaRewardHint>;
  let fromCache = true;

  if (opts?.hints) {
    hints = opts.hints;
  } else {
    const fetched = await fetchSolanaRewardHints({ forceRefresh: opts?.forceRefresh });
    hints = fetched.hints;
    fromCache = fetched.fromCache;
  }

  const all = await db.transactions.toArray();
  const ownWallets = new Set(
    all.map((t) => t.walletAddress?.toLowerCase()).filter(Boolean) as string[]
  );

  const candidates = all.filter(
    (t) => isUnclassifiedSolanaTransferIn(t) && hints.has(t.contractAddress!)
  );

  let suggested = 0;
  for (const t of candidates) {
    // Skip self-transfers between the user's own wallets.
    if (t.counterpartyAddress && ownWallets.has(t.counterpartyAddress.toLowerCase())) continue;

    const hint = hints.get(t.contractAddress!)!;

    // Keep any other stored flags, but drop possible_internal_transfer (we now
    // believe this is income) and make sure needs_review is present — that
    // flag is what puts the row into the review queue.
    const flags = new Set((t.flags ?? []).filter((f) => f !== 'possible_internal_transfer'));
    flags.add('needs_review');

    // eslint-disable-next-line no-await-in-loop
    await db.transactions.update(t.id, {
      type: 'income',
      category: 'defi_reward',
      notes: suggestionNotes(t.asset, hint),
      flags: [...flags] as FlagReason[]
    });
    suggested++;
  }

  const summary =
    suggested > 0
      ? `${suggested} suggested reward income${suggested === 1 ? '' : 's'} flagged for review`
      : 'no new reward suggestions';

  return {
    hintsCount: hints.size,
    candidates: candidates.length,
    suggested,
    fromCache,
    message:
      `DefiLlama: ${hints.size} Solana reward mint${hints.size === 1 ? '' : 's'} checked — ` +
      `${summary}.` +
      (suggested > 0 ? ' Open the "Needs review" filter to confirm them.' : '')
  };
}

/** True when a row sits in the needs_review queue (flagged, not spam). */
export function isNeedsReview(t: Transaction): boolean {
  return !t.isSpam && (t.flags ?? []).includes('needs_review');
}

/** Count of transactions currently sitting in the needs_review queue. */
export function countNeedsReview(transactions: Transaction[]): number {
  return transactions.filter(isNeedsReview).length;
}
