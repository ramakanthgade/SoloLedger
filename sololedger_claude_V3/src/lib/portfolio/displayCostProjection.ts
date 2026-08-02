import type { AccountClass, DerivedPosting } from '@/lib/ledger/derivedPostings';
import {
  postingBalanceKey,
  preparePostingAggregation,
  type PostingBalanceKey,
  type PreparedPostingAggregation
} from '@/lib/ledger/postingBalances';
import type { Transaction } from '@/types/transaction';

export interface DisplayCostBalance {
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  /** Positive display units that carry the average-cost overlay. */
  amount: number;
  costBasis: number;
}

export interface DisplayCostProjectionInput {
  transactions: readonly Transaction[];
  postings: readonly DerivedPosting[];
  preparedPostings?: PreparedPostingAggregation;
  asOf?: number;
}

export interface DisplayCostSample { t: number; cost: number }

export interface CanonicalDisplayCostBalance {
  assetKey: string;
  amount: number;
  costBasis: number;
}

export interface DisplayCostProjections {
  exact: Map<PostingBalanceKey, DisplayCostBalance>;
  unresolved: Map<string, CanonicalDisplayCostBalance>;
  openingAffected: Set<PostingBalanceKey>;
}

function acquisitionCost(posting: DerivedPosting, transaction: Transaction | undefined): number {
  if (!transaction || posting.signedQuantity <= 0) return 0;
  const fiatValue = transaction.fiatValue ?? 0;
  if (!(fiatValue > 0) || !Number.isFinite(fiatValue)) return 0;
  if (posting.role === 'principal') {
    return [
      'buy', 'transfer_in', 'income', 'gift_received', 'nft_mint', 'nft_buy', 'defi_withdraw'
    ].includes(transaction.type) ? fiatValue : 0;
  }
  if (posting.role === 'counter') {
    return ['sell', 'trade', 'nft_sell'].includes(transaction.type) ? fiatValue : 0;
  }
  return 0;
}

/**
 * Projects the non-tax display cost independently for every exact
 * scope/class/canonical-asset balance key. Opening postings are absolute resets:
 * their quantity has unknown (zero) display cost and discards all earlier cost
 * in that one key without affecting another scope, class, or asset.
 */
export function buildDisplayCostProjection(
  input: DisplayCostProjectionInput
): Map<PostingBalanceKey, DisplayCostBalance> {
  const prepared = input.preparedPostings ?? preparePostingAggregation(input.postings);
  if (prepared.source !== input.postings) {
    throw new Error('prepared posting aggregation source mismatch');
  }
  const transactions = new Map(input.transactions.map((transaction) => [transaction.id, transaction]));
  const balances = new Map<PostingBalanceKey, DisplayCostBalance>();

  for (let index = 0; index < prepared.ordered.length; index++) {
    const posting = prepared.ordered[index];
    if (input.asOf != null && posting.effectiveAt > input.asOf) break;
    const key = prepared.keys[index];
    const balance = balances.get(key) ?? {
      scopeId: posting.accountScopeId,
      accountClass: posting.accountClass,
      assetKey: posting.assetKey,
      amount: 0,
      costBasis: 0
    };
    if (posting.role === 'opening_balance') {
      balance.amount = posting.signedQuantity;
      balance.costBasis = 0;
    } else if (posting.signedQuantity > 0) {
      balance.amount += posting.signedQuantity;
      balance.costBasis += acquisitionCost(
        posting,
        posting.transactionId ? transactions.get(posting.transactionId) : undefined
      );
    } else if (posting.signedQuantity < 0 && balance.amount > 0) {
      const removed = Math.min(-posting.signedQuantity, balance.amount);
      balance.costBasis -= balance.costBasis * (removed / balance.amount);
      balance.amount -= removed;
      if (balance.amount === 0) balance.costBasis = 0;
    }
    balances.set(key, balance);
  }
  return balances;
}

function openingAffectedKeys(postings: readonly DerivedPosting[]): Set<PostingBalanceKey> {
  return new Set(postings
    .filter((posting) => posting.role === 'opening_balance')
    .map(postingBalanceKey));
}

function unresolvedPostingEligible(
  posting: DerivedPosting,
  openings: ReadonlySet<PostingBalanceKey>
): boolean {
  return posting.accountScopeId.startsWith('unresolved:') && !openings.has(postingBalanceKey(posting));
}

function applyDisplayCost(
  balance: { amount: number; costBasis: number },
  posting: DerivedPosting,
  transaction: Transaction | undefined
): void {
  if (posting.role === 'opening_balance') {
    balance.amount = posting.signedQuantity;
    balance.costBasis = 0;
  } else if (posting.signedQuantity > 0) {
    balance.amount += posting.signedQuantity;
    balance.costBasis += acquisitionCost(posting, transaction);
  } else if (posting.signedQuantity < 0 && balance.amount > 0) {
    const removed = Math.min(-posting.signedQuantity, balance.amount);
    balance.costBasis -= balance.costBasis * (removed / balance.amount);
    balance.amount -= removed;
    if (balance.amount === 0) balance.costBasis = 0;
  }
}

/**
 * Legacy-compatible fallback for transactions whose ownership cannot be
 * resolved: independent `unresolved:<txId>` scopes are folded only by their
 * canonical asset key so later disposals reduce earlier acquisition cost.
 * Keys touched by an opening balance are excluded and must use the exact model.
 */
export function buildUnresolvedDisplayCostProjection(
  input: DisplayCostProjectionInput
): Map<string, CanonicalDisplayCostBalance> {
  const prepared = input.preparedPostings ?? preparePostingAggregation(input.postings);
  if (prepared.source !== input.postings) {
    throw new Error('prepared posting aggregation source mismatch');
  }
  const transactions = new Map(input.transactions.map((transaction) => [transaction.id, transaction]));
  const openings = openingAffectedKeys(input.postings);
  const balances = new Map<string, CanonicalDisplayCostBalance>();
  for (const posting of prepared.ordered) {
    if (input.asOf != null && posting.effectiveAt > input.asOf) break;
    if (!unresolvedPostingEligible(posting, openings)) continue;
    const balance = balances.get(posting.assetKey) ?? {
      assetKey: posting.assetKey, amount: 0, costBasis: 0
    };
    applyDisplayCost(
      balance,
      posting,
      posting.transactionId ? transactions.get(posting.transactionId) : undefined
    );
    balances.set(posting.assetKey, balance);
  }
  return balances;
}

/**
 * Builds the exact and unresolved compatibility views in one chronological
 * pass. Consumers that need both avoid rebuilding the transaction index and
 * revisiting every posting a second time.
 */
export function buildDisplayCostProjections(
  input: DisplayCostProjectionInput
): DisplayCostProjections {
  const prepared = input.preparedPostings ?? preparePostingAggregation(input.postings);
  if (prepared.source !== input.postings) {
    throw new Error('prepared posting aggregation source mismatch');
  }
  const transactions = new Map(input.transactions.map((transaction) => [transaction.id, transaction]));
  const openingAffected = openingAffectedKeys(input.postings);
  const exact = new Map<PostingBalanceKey, DisplayCostBalance>();
  const unresolved = new Map<string, CanonicalDisplayCostBalance>();

  for (let index = 0; index < prepared.ordered.length; index++) {
    const posting = prepared.ordered[index];
    if (input.asOf != null && posting.effectiveAt > input.asOf) break;
    const transaction = posting.transactionId ? transactions.get(posting.transactionId) : undefined;
    const key = prepared.keys[index];
    const exactBalance = exact.get(key) ?? {
      scopeId: posting.accountScopeId,
      accountClass: posting.accountClass,
      assetKey: posting.assetKey,
      amount: 0,
      costBasis: 0
    };
    applyDisplayCost(exactBalance, posting, transaction);
    exact.set(key, exactBalance);

    if (!unresolvedPostingEligible(posting, openingAffected)) continue;
    const unresolvedBalance = unresolved.get(posting.assetKey) ?? {
      assetKey: posting.assetKey,
      amount: 0,
      costBasis: 0
    };
    applyDisplayCost(unresolvedBalance, posting, transaction);
    unresolved.set(posting.assetKey, unresolvedBalance);
  }
  return { exact, unresolved, openingAffected };
}

/** Opening-aware chart costs in one chronological posting pass. */
export function buildDisplayCostSamples(
  input: Omit<DisplayCostProjectionInput, 'asOf'>,
  sampleTimes: readonly number[]
): DisplayCostSample[] {
  const prepared = input.preparedPostings ?? preparePostingAggregation(input.postings);
  if (prepared.source !== input.postings) {
    throw new Error('prepared posting aggregation source mismatch');
  }
  const transactions = new Map(input.transactions.map((transaction) => [transaction.id, transaction]));
  const exactBalances = new Map<PostingBalanceKey, DisplayCostBalance>();
  const unresolvedBalances = new Map<string, CanonicalDisplayCostBalance>();
  const openings = openingAffectedKeys(input.postings);
  let cursor = 0;
  let totalCost = 0;
  return sampleTimes.map((sampleTime) => {
    while (cursor < prepared.ordered.length && prepared.ordered[cursor].effectiveAt <= sampleTime) {
      const posting = prepared.ordered[cursor];
      const key = prepared.keys[cursor];
      const unresolved = unresolvedPostingEligible(posting, openings);
      const balance = unresolved
        ? unresolvedBalances.get(posting.assetKey) ?? {
            assetKey: posting.assetKey, amount: 0, costBasis: 0
          }
        : exactBalances.get(key) ?? {
            scopeId: posting.accountScopeId,
            accountClass: posting.accountClass,
            assetKey: posting.assetKey,
            amount: 0,
            costBasis: 0
          };
      const previousCost = balance.costBasis;
      applyDisplayCost(
        balance,
        posting,
        posting.transactionId ? transactions.get(posting.transactionId) : undefined
      );
      if (unresolved) unresolvedBalances.set(posting.assetKey, balance);
      else exactBalances.set(key, balance as DisplayCostBalance);
      totalCost += balance.costBasis - previousCost;
      cursor++;
    }
    return { t: sampleTime, cost: totalCost };
  });
}

export function displayCostBalanceKey(
  scopeId: string,
  accountClass: AccountClass,
  assetKey: string
): PostingBalanceKey {
  return postingBalanceKey({ accountScopeId: scopeId, accountClass, assetKey });
}
