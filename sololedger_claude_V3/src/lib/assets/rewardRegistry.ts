/**
 * Reward-token registry — data-driven, mint-keyed income classification.
 *
 * Generalizes the Dabba DBT special-case (see dabbaRegistry.ts) into a list of
 * known reward tokens. When an inbound transfer matches an entry — by token mint
 * AND, where required, by the sending distributor/rewards wallet — the
 * transaction is auto-classified as `income` of the right kind instead of a
 * plain `transfer_in`.
 *
 * Why mint-keyed (and not "is the from-address a contract"): on Solana, many
 * rewards (e.g. Geodnet GEOD) are paid directly from a project-operated
 * distributor *wallet* (a plain account, not an executable program). So the
 * reliable signals are (1) the token mint — a unique 44-char base58 address —
 * and (2) the known distributor wallet that pays it out. Both are matched here.
 */

import { classifyDbtIncome, DBT_TOKEN_MINT } from '@/lib/assets/dabbaRegistry';
import type { DabbaIncomeKind } from '@/lib/assets/dabbaRegistry';

/** Geodnet GEOD SPL token mint on Solana mainnet. */
export const GEOD_TOKEN_MINT = '7JA5eZdCzztSfQbJvS8aVVxMFfd81Rs9VvwnocV1mKHu';

/** Geodnet's official rewards distributor wallet (pays out daily GEOD mining rewards). */
export const GEOD_REWARDS_WALLET = '8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE';

/**
 * Income classification kinds for reward tokens. `mining_reward` is deliberately
 * NOT the literal string 'mining': `isMiningIncome` in costBasis matches only
 * category === 'mining' (zero-cost, taxed on sale), whereas `mining_reward`
 * counts as receipt-side income at fair-market-value (India Section 56(2)(x)).
 */
export type RewardIncomeKind =
  | 'mining_reward'
  | 'defi_reward' // DefiLlama-hinted yield/farm reward — SUGGESTED, user confirms via review queue
  | DabbaIncomeKind; // 'genesis_reward' | 'staking_reward' | 'airdrop' | 'mainnet_reward'

export interface RewardClassification {
  kind: RewardIncomeKind;
  label: string;
  notes: string;
}

export interface RewardTokenEntry {
  /** SPL token mint address (Solana) — the unique fingerprint of the token. */
  mint: string;
  /** Ticker symbol for display. */
  symbol: string;
  /** Default income kind when no finer-grained classifier applies. */
  defaultKind: RewardIncomeKind;
  /** Human-readable label for the UI / notes. */
  label: string;
  /** Notes written to the transaction's notes field. */
  notes: string;
  /**
   * Optional: only auto-classify as income when the sender (counterparty) is one
   * of these known distributor/rewards wallets. When set, an inbound transfer of
   * this mint from any OTHER address is NOT income (stays a normal transfer_in).
   */
  distributorAllowlist?: string[];
  /**
   * Optional: a richer per-counterparty classifier (e.g. Dabba program matching).
   * Takes precedence over `distributorAllowlist` / `defaultKind`.
   */
  classifyByCounterparty?: (
    mint: string | undefined,
    counterparty: string | undefined
  ) => RewardClassification | null;
}

export const REWARD_TOKENS: RewardTokenEntry[] = [
  {
    mint: GEOD_TOKEN_MINT,
    symbol: 'GEOD',
    defaultKind: 'mining_reward',
    label: 'Geodnet GEOD mining reward',
    notes: 'Geodnet GEOD mining reward — auto-classified as income',
    distributorAllowlist: [GEOD_REWARDS_WALLET]
  },
  {
    mint: DBT_TOKEN_MINT,
    symbol: 'DBT',
    defaultKind: 'genesis_reward',
    label: 'Dabba Network DBT reward',
    notes: 'Auto-classified as DBT income',
    classifyByCounterparty: classifyDbtIncome
  }
];

/** Product-neutral labels for generic (non-Dabba) reward kinds. */
export const REWARD_KIND_LABEL: Partial<Record<RewardIncomeKind, string>> = {
  mining_reward: 'Mining reward',
  defi_reward: 'DeFi reward (suggested)'
};

/** True if the mint belongs to a known reward token. NOTE: this alone does NOT
 *  mean an inbound transfer is income — use classifyRewardIncome for that. */
export function isKnownRewardToken(mint?: string): boolean {
  return getEntry(mint) !== undefined;
}

function getEntry(mint?: string): RewardTokenEntry | undefined {
  if (!mint) return undefined;
  return REWARD_TOKENS.find((e) => e.mint === mint);
}

/**
 * Classify an inbound transfer of `mint` from `counterparty` as reward income.
 * Returns null when the transfer should NOT be treated as income (unknown mint,
 * missing counterparty, or a mint whose distributor allowlist doesn't include
 * the sender). Callers fall back to `transfer_in` on null.
 */
export function classifyRewardIncome(
  mint?: string,
  counterpartyAddress?: string
): RewardClassification | null {
  const entry = getEntry(mint);
  if (!entry) return null;

  // Rich per-counterparty classifier (e.g. Dabba). A missing/unknown counterparty
  // falls back to the default kind (mirrors the existing DBT `?? genesis_reward`
  // behaviour, including the ATA-balance-change path where no sender is known).
  if (entry.classifyByCounterparty) {
    const specific = counterpartyAddress
      ? entry.classifyByCounterparty(mint, counterpartyAddress)
      : null;
    if (specific) return specific;
    return { kind: entry.defaultKind, label: entry.label, notes: entry.notes };
  }

  // Distributor allowlist: only the known rewards wallet counts as income. A
  // missing or non-allowlisted sender is NOT income (the GEOD guard the user
  // explicitly required). With no allowlist and no sender there's nothing to
  // match against either.
  if (!counterpartyAddress) return null;
  if (entry.distributorAllowlist?.length && !entry.distributorAllowlist.includes(counterpartyAddress)) {
    return null;
  }

  return { kind: entry.defaultKind, label: entry.label, notes: entry.notes };
}
