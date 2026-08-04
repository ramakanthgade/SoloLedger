import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { transactionLegAssetKey } from '@/lib/ledger/assetKey';
import {
  derivePostings,
  deriveTransactionPostings,
  type AccountClass,
  type DerivedPosting,
  type ExchangeSourceIdentity,
  type OpeningBalanceRow
} from '@/lib/ledger/derivedPostings';
import {
  postingBalanceKey,
  appendPreparedPostingAggregation,
  preparePostingAggregation,
  type PreparedPostingAggregation
} from '@/lib/ledger/postingBalances';
import {
  buildAuthorityBalanceModel,
  type AuthorityBalanceSlice,
  type AuthorityBalanceVerificationStatus
} from '@/lib/reconcile/authorityBalanceModel';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { Transaction } from '@/types/transaction';
import {
  buildDisplayCostProjections,
  appendDisplayCostProjections,
  createDisplayCostProjectionAccumulator
} from './displayCostProjection';
import type { DisplayCostProjections } from './displayCostProjection';

export interface HoldingsScopeFilter {
  scopeIds?: readonly string[];
  accountClasses?: readonly AccountClass[];
  /** Exact custody pairs. When present, no scope/class Cartesian product is inferred. */
  scopePairs?: readonly Readonly<{ scopeId: string; accountClass: AccountClass }>[];
}

export interface HoldingsProjectionInput {
  transactions: readonly Transaction[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  openingBalances: readonly OpeningBalanceRow[];
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  coverage: readonly SourceCoverageRow[];
  now: number;
  comparisonAt?: number;
  scopeFilter?: HoldingsScopeFilter;
  nonComparableAuthorityScopes?: readonly Readonly<{ scopeId: string; accountClass: AccountClass }>[];
  /** Reuse immutable transaction/posting/cost work when only authority freshness changed. */
  preparedProjection?: HoldingsProjection;
  metrics?: { postingDerivationCount: number };
}

export interface HoldingSourceVerification {
  scopeId: string;
  accountClass: AccountClass;
  quantity: number;
  postingQuantity: number;
  authorityQuantity?: number;
  verificationStatus: AuthorityBalanceVerificationStatus;
  fallbackReason?: AuthorityBalanceSlice['fallbackReason'];
  authorityStatus: AuthorityBalanceSlice['authorityStatus'];
  coverageStatus: AuthorityBalanceSlice['coverageStatus'];
  scopeStatus: AuthorityBalanceSlice['scopeStatus'];
  selectedSnapshotId?: string;
  selectedGeneration?: number;
  authorityAsOf?: number;
}

export interface ProjectedPortfolioHolding {
  assetKey: string;
  asset: string;
  /** Canonical projected quantity. Legacy holdings never override this value. */
  quantity: number;
  /** Compatibility alias for consumers migrating from PortfolioHolding. */
  amount: number;
  costBasis: number;
  chain?: string;
  contractAddress?: string;
  verificationStatus: AuthorityBalanceVerificationStatus | 'mixed';
  sourceVerification: HoldingSourceVerification[];
}

export interface HoldingsProjection {
  /** Exact scope/class/asset evidence, including verified zero balances. */
  slices: AuthorityBalanceSlice[];
  /** Non-zero aggregates plus zero-quantity assets carrying conflicting authority evidence. */
  holdings: ProjectedPortfolioHolding[];
  /** One immutable posting projection, useful to downstream chart consumers. */
  postings: readonly DerivedPosting[];
  preparedPostings: PreparedPostingAggregation;
  /** Whether chart costs can use the faster posting-equivalent implementation. */
  chartPostingCostsEquivalent: boolean;
  /** Internal immutable state used by a proven chronological append. */
  displayCostProjections: DisplayCostProjections;
  /** Internal canonical metadata for every projected key, including zero balances. */
  displayIdentityIndex: ReadonlyMap<string, DisplayIdentity>;
}

export interface DisplayIdentity {
  asset: string;
  chain?: string;
  contractAddress?: string;
}

const CUSTOM_EVM_KEY_PREFIX = 'evm:custom:';

function customEvmIdentityFromCanonicalKey(key: string): Pick<DisplayIdentity, 'chain' | 'contractAddress'> | undefined {
  if (!key.startsWith(CUSTOM_EVM_KEY_PREFIX)) return undefined;
  const networkAndAsset = key.slice(CUSTOM_EVM_KEY_PREFIX.length);
  const assetSeparator = networkAndAsset.lastIndexOf(':');
  if (assetSeparator <= 0) return undefined;
  const assetIdentity = networkAndAsset.slice(assetSeparator + 1);
  return {
    chain: 'custom_evm',
    contractAddress: assetIdentity === 'native' ? undefined : assetIdentity
  };
}

function rawString(transaction: Transaction, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = transaction.raw?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function contractFromCanonicalKey(key: string): string | undefined {
  const customEvmIdentity = customEvmIdentityFromCanonicalKey(key);
  if (customEvmIdentity) return customEvmIdentity.contractAddress;
  if (key.startsWith('solana:') && key !== 'solana:native') return key.slice('solana:'.length);
  if (key.startsWith('bitcoin:') && key !== 'bitcoin:native') return key.slice('bitcoin:'.length);
  if (key.startsWith('starknet:') && key !== 'starknet:native') return key.slice('starknet:'.length);
  const evm = /^evm:[^:]+:(.+)$/.exec(key);
  if (evm?.[1] !== 'native') return evm?.[1];
  const unsupported = /^unsupported:[^:]+:(.+)$/.exec(key);
  return unsupported?.[1] !== 'native' ? unsupported?.[1] : undefined;
}

function chainFromCanonicalKey(key: string): string | undefined {
  const customEvmIdentity = customEvmIdentityFromCanonicalKey(key);
  if (customEvmIdentity) return customEvmIdentity.chain;
  if (key.startsWith('solana:')) return 'solana';
  if (key.startsWith('bitcoin:')) return 'bitcoin';
  if (key.startsWith('starknet:')) return 'starknet';
  const qualified = /^(?:evm|unsupported):([^:]+):/.exec(key);
  return qualified?.[1];
}

function transactionLegIdentity(
  transaction: Transaction,
  role: Extract<DerivedPosting['role'], 'principal' | 'counter' | 'fee'>,
  canonicalKey: string,
  asset: string
): DisplayIdentity {
  const legAsset = role === 'principal'
    ? transaction.asset
    : role === 'counter'
      ? transaction.counterAsset ?? asset
      : transaction.feeAsset ?? transaction.asset;
  if (canonicalKey.startsWith('asset:')) {
    return { asset: resolveAssetLabel(legAsset) };
  }
  const rawContract = role === 'principal'
    ? transaction.contractAddress
    : rawString(transaction, role === 'counter'
        ? ['counterContractAddress', 'counterMint', 'outputMint', 'toMint']
        : ['feeContractAddress', 'feeMint']);
  const chain = transaction.chain ?? chainFromCanonicalKey(canonicalKey);
  const contractAddress = rawContract ?? contractFromCanonicalKey(canonicalKey);
  return {
    asset: resolveAssetLabel(legAsset, contractAddress, chain),
    chain,
    contractAddress
  };
}

function postingMatchesTransactionLeg(
  transaction: Transaction,
  posting: DerivedPosting
): posting is DerivedPosting & { role: 'principal' | 'counter' | 'fee' } {
  if (posting.role === 'opening_balance') return false;
  const exchangeSymbolKey = `asset:${posting.asset.toUpperCase()}`;
  return transactionLegAssetKey(transaction, posting.role, {
    exchangeCustody: posting.assetKey === exchangeSymbolKey
  }) === posting.assetKey;
}

function displayIdentities(
  transactions: readonly Transaction[],
  postings: readonly DerivedPosting[],
  slices: readonly AuthorityBalanceSlice[],
  comparisonAt?: number
): Map<string, DisplayIdentity> {
  const transactionsById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const result = new Map<string, DisplayIdentity>();
  // The forward implementation overwrote each canonical key, so only its
  // newest posting supplied display metadata. Walk backward and stop once all
  // projected assets are resolved instead of revisiting every historical leg.
  const unresolvedKeys = new Set(slices.map((slice) => slice.assetKey));
  const selectedScopeClasses = new Set(
    slices.map((slice) => `${slice.scopeId}\u001f${slice.accountClass}`)
  );
  const openingFallbacks = new Map<string, DisplayIdentity>();
  for (let index = postings.length - 1; index >= 0 && unresolvedKeys.size > 0; index--) {
    const posting = postings[index];
    if (
      !unresolvedKeys.has(posting.assetKey) ||
      (comparisonAt != null && posting.effectiveAt > comparisonAt) ||
      !selectedScopeClasses.has(`${posting.accountScopeId}\u001f${posting.accountClass}`)
    ) continue;
    const transaction = posting.transactionId ? transactionsById.get(posting.transactionId) : undefined;
    if (
      transaction && postingMatchesTransactionLeg(transaction, posting)
    ) {
      result.set(posting.assetKey, transactionLegIdentity(
        transaction, posting.role, posting.assetKey, posting.asset
      ));
      unresolvedKeys.delete(posting.assetKey);
    } else if (posting.role === 'opening_balance' && !openingFallbacks.has(posting.assetKey)) {
      // A transaction identity always won over an opening row in the forward
      // implementation, even when the opening was chronologically newer.
      openingFallbacks.set(posting.assetKey, {
        asset: posting.asset,
        chain: chainFromCanonicalKey(posting.assetKey),
        contractAddress: contractFromCanonicalKey(posting.assetKey)
      });
    }
  }
  for (const [key, identity] of openingFallbacks) {
    if (!result.has(key)) result.set(key, identity);
  }
  for (const slice of slices) {
    if (result.has(slice.assetKey)) continue;
    result.set(slice.assetKey, {
      asset: slice.asset,
      chain: chainFromCanonicalKey(slice.assetKey),
      contractAddress: contractFromCanonicalKey(slice.assetKey)
    });
  }
  return result;
}

interface PreparedHoldingsScopeFilter {
  scopeIds?: ReadonlySet<string>;
  accountClasses?: ReadonlySet<AccountClass>;
  scopePairs?: ReadonlySet<string>;
}

function prepareScopeFilter(filter?: HoldingsScopeFilter): PreparedHoldingsScopeFilter | undefined {
  if (!filter) return undefined;
  return {
    scopeIds: filter.scopeIds && new Set(filter.scopeIds),
    accountClasses: filter.accountClasses && new Set(filter.accountClasses),
    scopePairs: filter.scopePairs && new Set(filter.scopePairs.map((pair) =>
      `${pair.scopeId}\u001f${pair.accountClass}`))
  };
}

function matchesScope(slice: AuthorityBalanceSlice, filter?: PreparedHoldingsScopeFilter): boolean {
  if (filter?.scopePairs && !filter.scopePairs.has(`${slice.scopeId}\u001f${slice.accountClass}`)) return false;
  if (filter?.scopeIds && !filter.scopeIds.has(slice.scopeId)) return false;
  if (filter?.accountClasses && !filter.accountClasses.has(slice.accountClass)) return false;
  return true;
}

function sourceVerification(slice: AuthorityBalanceSlice): HoldingSourceVerification {
  return {
    scopeId: slice.scopeId,
    accountClass: slice.accountClass,
    quantity: slice.quantity,
    postingQuantity: slice.postingQuantity,
    authorityQuantity: slice.authorityQuantity,
    verificationStatus: slice.verificationStatus,
    fallbackReason: slice.fallbackReason,
    authorityStatus: slice.authorityStatus,
    coverageStatus: slice.coverageStatus,
    scopeStatus: slice.scopeStatus,
    selectedSnapshotId: slice.selectedSnapshotId,
    selectedGeneration: slice.selectedGeneration,
    authorityAsOf: slice.authorityAsOf
  };
}

/**
 * Pure consumer adapter from transactions/evidence to one authoritative holdings
 * view. Quantity always comes from the authority model; transaction legs
 * contribute display metadata and the posting projection contributes display cost.
 */
export function buildHoldingsProjection(input: HoldingsProjectionInput): HoldingsProjection {
  const reusable = input.preparedProjection;
  const chronologicallyAppendable = input.comparisonAt == null && input.openingBalances.length === 0 &&
    input.transactions.every((transaction, index) =>
      index === 0 || input.transactions[index - 1].timestamp < transaction.timestamp ||
      (input.transactions[index - 1].timestamp === transaction.timestamp &&
        input.transactions[index - 1].id <= transaction.id));
  const costAccumulator = reusable == null && chronologicallyAppendable
    ? createDisplayCostProjectionAccumulator()
    : undefined;
  const postings = reusable?.postings ?? derivePostings(input.transactions, {
      exchangeConnections: [...input.exchangeConnections],
      openingBalances: [...input.openingBalances],
      onTransactionPostings: costAccumulator
        ? (transaction, transactionPostings, start) => {
            costAccumulator.addTransaction(transaction);
            costAccumulator.addPostings(transaction, transactionPostings, start);
          }
        : undefined
    });
  if (reusable == null && input.metrics) input.metrics.postingDerivationCount += 1;
  const preparedPostings = reusable?.preparedPostings ??
    preparePostingAggregation(postings, chronologicallyAppendable);
  const allSlices = buildAuthorityBalanceModel({
    postings,
    snapshots: input.snapshots,
    assets: input.assets,
    coverage: input.coverage,
    exchangeConnections: input.exchangeConnections,
    now: input.now,
    comparisonAt: input.comparisonAt,
    nonComparableScopes: input.nonComparableAuthorityScopes,
    preparedPostings
  });
  const preparedScopeFilter = prepareScopeFilter(input.scopeFilter);
  const slices = allSlices.filter((slice) => matchesScope(slice, preparedScopeFilter));
  const identities = reusable?.displayIdentityIndex ??
    displayIdentities(input.transactions, postings, slices, input.comparisonAt);

  const slicesByAsset = new Map<string, AuthorityBalanceSlice[]>();
  for (const slice of slices) {
    const rows = slicesByAsset.get(slice.assetKey) ?? [];
    rows.push(slice);
    slicesByAsset.set(slice.assetKey, rows);
  }
  const displayCostProjections = reusable?.displayCostProjections ?? costAccumulator?.finish() ??
    buildDisplayCostProjections({
      transactions: input.transactions,
      postings,
      preparedPostings,
      asOf: input.comparisonAt
    });
  const displayCosts = displayCostProjections.exact;
  const unresolvedDisplayCosts = displayCostProjections.unresolved;
  const openingAffected = displayCostProjections.openingAffected;

  const holdings: ProjectedPortfolioHolding[] = [];
  for (const [canonicalKey, assetSlices] of slicesByAsset) {
    const quantity = assetSlices.reduce((sum, slice) => sum + slice.quantity, 0);
    const visibleNonComparableEvidence = assetSlices.some((slice) =>
      slice.authorityStatus === 'non_comparable' && slice.fallbackReason === 'non_comparable_authority');
    if (quantity === 0 && !visibleNonComparableEvidence) continue;
    const canonicalIdentity = identities.get(canonicalKey) ?? { asset: assetSlices[0].asset };
    const identity = canonicalIdentity;
    const statuses = new Set(assetSlices.map((slice) => slice.verificationStatus));
    let unresolvedQuantity = 0;
    const exactCost = assetSlices.reduce((sum, slice) => {
      const key = postingBalanceKey({
        accountScopeId: slice.scopeId,
        accountClass: slice.accountClass,
        assetKey: slice.assetKey
      });
      if (
        slice.verificationStatus === 'posting_fallback' && slice.scopeStatus === 'unresolved' &&
        !openingAffected.has(key)
      ) {
        unresolvedQuantity += slice.quantity;
        return sum;
      }
          const displayCost = displayCosts.get(postingBalanceKey({
            accountScopeId: slice.scopeId,
            accountClass: slice.accountClass,
            assetKey: slice.assetKey
          }));
          const perUnitCost = displayCost && displayCost.amount > 0 && displayCost.costBasis > 0
            ? displayCost.costBasis / displayCost.amount
            : 0;
          return sum + Math.max(0, slice.quantity) * perUnitCost;
        }, 0);
    const unresolvedDisplayCost = unresolvedDisplayCosts.get(canonicalKey);
    const unresolvedPerUnitCost = unresolvedDisplayCost &&
      unresolvedDisplayCost.amount > 0 && unresolvedDisplayCost.costBasis > 0
      ? unresolvedDisplayCost.costBasis / unresolvedDisplayCost.amount
      : 0;
    const cost = quantity > 0
      ? exactCost + Math.max(0, unresolvedQuantity) * unresolvedPerUnitCost
      : 0;
    holdings.push({
      assetKey: canonicalKey,
      asset: identity.asset,
      quantity,
      amount: quantity,
      costBasis: cost,
      chain: identity.chain,
      contractAddress: identity.contractAddress,
      verificationStatus: statuses.size === 1 ? [...statuses][0] : 'mixed',
      sourceVerification: assetSlices.map(sourceVerification)
    });
  }
  holdings.sort((left, right) =>
    right.costBasis - left.costBasis || left.assetKey.localeCompare(right.assetKey));
  return {
    slices,
    holdings,
    postings,
    preparedPostings,
    chartPostingCostsEquivalent: reusable?.chartPostingCostsEquivalent ??
      displayCostProjections.chartPostingCostsEquivalent,
    displayCostProjections,
    displayIdentityIndex: identities
  };
}

/**
 * Re-project one strictly chronological transaction while retaining Transaction[]
 * as the source ledger. Callers must separately prove the historical prefix did
 * not change; all authority selection and holding assembly still run normally.
 */
export function appendHoldingsProjection(
  previous: HoldingsProjection,
  input: HoldingsProjectionInput,
  transaction: Transaction
): HoldingsProjection | undefined {
  if (
    input.comparisonAt != null || input.scopeFilter != null || input.openingBalances.length !== 0 ||
    (input.nonComparableAuthorityScopes?.length ?? 0) > 0
  ) return undefined;
  const finalInputIndex = input.transactions.length - 1;
  if (finalInputIndex < 0 || input.transactions[finalInputIndex] !== transaction) return undefined;
  const precedingTransaction = input.transactions[finalInputIndex - 1];
  if (precedingTransaction && transaction.timestamp <= precedingTransaction.timestamp) return undefined;
  const appended = deriveTransactionPostings(transaction, {
    exchangeConnections: [...input.exchangeConnections]
  });
  if (appended.length === 0) return undefined;
  const postings = [...previous.postings, ...appended];
  const preparedPostings = appendPreparedPostingAggregation(
    previous.preparedPostings, postings, appended
  );
  const displayCostProjections = appendDisplayCostProjections(
    previous.displayCostProjections, transaction, appended
  );
  const allSlices = buildAuthorityBalanceModel({
    postings,
    snapshots: input.snapshots,
    assets: input.assets,
    coverage: input.coverage,
    exchangeConnections: input.exchangeConnections,
    now: input.now,
    nonComparableScopes: input.nonComparableAuthorityScopes,
    preparedPostings
  });
  const identities = new Map(previous.displayIdentityIndex);
  for (const posting of appended) {
    if (postingMatchesTransactionLeg(transaction, posting)) {
      identities.set(posting.assetKey, transactionLegIdentity(
        transaction, posting.role, posting.assetKey, posting.asset
      ));
    }
  }
  for (const slice of allSlices) {
    if (!identities.has(slice.assetKey)) {
      identities.set(slice.assetKey, {
        asset: slice.asset,
        chain: chainFromCanonicalKey(slice.assetKey),
        contractAddress: contractFromCanonicalKey(slice.assetKey)
      });
    }
  }
  const slicesByAsset = new Map<string, AuthorityBalanceSlice[]>();
  for (const slice of allSlices) {
    const rows = slicesByAsset.get(slice.assetKey) ?? [];
    rows.push(slice);
    slicesByAsset.set(slice.assetKey, rows);
  }
  const holdings: ProjectedPortfolioHolding[] = [];
  for (const [canonicalKey, assetSlices] of slicesByAsset) {
    const quantity = assetSlices.reduce((sum, slice) => sum + slice.quantity, 0);
    if (quantity === 0) continue;
    const identity = identities.get(canonicalKey) ?? { asset: assetSlices[0].asset };
    const statuses = new Set(assetSlices.map((slice) => slice.verificationStatus));
    let unresolvedQuantity = 0;
    const exactCost = assetSlices.reduce((sum, slice) => {
      const key = postingBalanceKey({
        accountScopeId: slice.scopeId, accountClass: slice.accountClass, assetKey: slice.assetKey
      });
      if (slice.verificationStatus === 'posting_fallback' && slice.scopeStatus === 'unresolved' &&
          !displayCostProjections.openingAffected.has(key)) {
        unresolvedQuantity += slice.quantity;
        return sum;
      }
      const displayCost = displayCostProjections.exact.get(key);
      const perUnitCost = displayCost && displayCost.amount > 0 && displayCost.costBasis > 0
        ? displayCost.costBasis / displayCost.amount : 0;
      return sum + Math.max(0, slice.quantity) * perUnitCost;
    }, 0);
    const unresolvedCost = displayCostProjections.unresolved.get(canonicalKey);
    const unresolvedPerUnit = unresolvedCost && unresolvedCost.amount > 0 && unresolvedCost.costBasis > 0
      ? unresolvedCost.costBasis / unresolvedCost.amount : 0;
    holdings.push({
      assetKey: canonicalKey,
      asset: identity.asset,
      quantity,
      amount: quantity,
      costBasis: quantity > 0 ? exactCost + Math.max(0, unresolvedQuantity) * unresolvedPerUnit : 0,
      chain: identity.chain,
      contractAddress: identity.contractAddress,
      verificationStatus: statuses.size === 1 ? [...statuses][0] : 'mixed',
      sourceVerification: assetSlices.map(sourceVerification)
    });
  }
  holdings.sort((left, right) => right.costBasis - left.costBasis ||
    left.assetKey.localeCompare(right.assetKey));
  return {
    slices: allSlices,
    holdings,
    postings,
    preparedPostings,
    chartPostingCostsEquivalent: displayCostProjections.chartPostingCostsEquivalent,
    displayCostProjections,
    displayIdentityIndex: identities
  };
}
