import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { transactionLegAssetKey } from '@/lib/ledger/assetKey';
import {
  derivePostings,
  type AccountClass,
  type DerivedPosting,
  type ExchangeSourceIdentity,
  type OpeningBalanceRow
} from '@/lib/ledger/derivedPostings';
import {
  postingBalanceKey,
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
  createDisplayCostProjectionAccumulator
} from './displayCostProjection';

export interface HoldingsScopeFilter {
  scopeIds?: readonly string[];
  accountClasses?: readonly AccountClass[];
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
  /** Non-zero canonical asset aggregates across the selected slices. */
  holdings: ProjectedPortfolioHolding[];
  /** One immutable posting projection, useful to downstream chart consumers. */
  postings: readonly DerivedPosting[];
  preparedPostings: PreparedPostingAggregation;
  /** Whether chart costs can use the faster posting-equivalent implementation. */
  chartPostingCostsEquivalent: boolean;
}

interface DisplayIdentity {
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
      transaction && posting.role !== 'opening_balance' &&
      transactionLegAssetKey(transaction, posting.role) === posting.assetKey
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

function matchesScope(slice: AuthorityBalanceSlice, filter?: HoldingsScopeFilter): boolean {
  if (filter?.scopeIds && !filter.scopeIds.includes(slice.scopeId)) return false;
  if (filter?.accountClasses && !filter.accountClasses.includes(slice.accountClass)) return false;
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
  const chronologicallyAppendable = input.comparisonAt == null && input.openingBalances.length === 0 &&
    input.transactions.every((transaction, index) =>
      index === 0 || input.transactions[index - 1].timestamp < transaction.timestamp ||
      (input.transactions[index - 1].timestamp === transaction.timestamp &&
        input.transactions[index - 1].id <= transaction.id));
  const costAccumulator = chronologicallyAppendable
    ? createDisplayCostProjectionAccumulator()
    : undefined;
  const postings = derivePostings(input.transactions, {
    exchangeConnections: [...input.exchangeConnections],
    openingBalances: [...input.openingBalances],
    onTransactionPostings: costAccumulator
      ? (transaction, transactionPostings, start) => {
          costAccumulator.addTransaction(transaction);
          costAccumulator.addPostings(transaction, transactionPostings, start);
        }
      : undefined
  });
  const preparedPostings = preparePostingAggregation(postings, chronologicallyAppendable);
  const allSlices = buildAuthorityBalanceModel({
    postings,
    snapshots: input.snapshots,
    assets: input.assets,
    coverage: input.coverage,
    exchangeConnections: input.exchangeConnections,
    now: input.now,
    comparisonAt: input.comparisonAt,
    preparedPostings
  });
  const slices = allSlices.filter((slice) => matchesScope(slice, input.scopeFilter));
  const identities = displayIdentities(input.transactions, postings, slices, input.comparisonAt);

  const slicesByAsset = new Map<string, AuthorityBalanceSlice[]>();
  for (const slice of slices) {
    const rows = slicesByAsset.get(slice.assetKey) ?? [];
    rows.push(slice);
    slicesByAsset.set(slice.assetKey, rows);
  }
  const displayCostProjections = costAccumulator?.finish() ??
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
    if (quantity === 0) continue;
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
    chartPostingCostsEquivalent: displayCostProjections.chartPostingCostsEquivalent
  };
}
