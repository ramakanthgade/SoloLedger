import { buildPriceIndex, currentPriceFor, type PriceIndex } from '@/lib/dashboard/dashboardModel';
import type { ExchangeSourceIdentity, OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import {
  selectLatestSemanticSourceCoverage,
  sourceCoverageOperationTime,
  type SourceCoverageRow,
  type StructuralCoverageStatus
} from '@/lib/reconcile/sourceCoverage';
import type { SafetyDecisionRow } from '@/lib/safety/types';
import type { LookupAddressRow, PriceCacheRow } from '@/lib/storage/db';
import type { TaxSettings, Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';
import {
  buildConnectionWorkspaceFromCard,
  prepareConnectionWorkspaceCollectionIndex,
  type ConnectionWorkspaceCollectionIndex,
  type ConnectionWorkspaceMetrics
} from './connectionWorkspaceModel';

export interface WalletChainSummary {
  row: LookupAddressRow;
  transactionCount: number;
  lastActivityAt?: number;
  coverageStatus?: StructuralCoverageStatus;
  coverageAt?: number;
  /** Persisted operation time used for deterministic sync copy. */
  syncAt?: number;
  /** Provider-supplied partial/failure detail when persisted. */
  coverageReason?: string;
  currentValue: number | null;
  pricedAssetCount: number;
  unpricedAssetCount: number;
}

export interface WalletChainCollectionInput {
  transactions: readonly Transaction[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  openingBalances: readonly OpeningBalanceRow[];
  snapshots: readonly AuthoritySnapshotRow[];
  assets: readonly AuthorityAssetRow[];
  sourceCoverage: readonly SourceCoverageRow[];
  safetyDecisions: readonly SafetyDecisionRow[];
  priceRows: readonly PriceCacheRow[];
  liveWalletRows: readonly LookupAddressRow[];
  settings?: Pick<TaxSettings, 'reportingCurrency'>;
  metrics?: ConnectionWorkspaceMetrics;
}

export interface WalletChainCollectionEvidence extends Omit<WalletChainCollectionInput, 'priceRows' | 'settings' | 'metrics'> {
  collectionIndex: ConnectionWorkspaceCollectionIndex;
  priceIndex: PriceIndex;
  transactionById: ReadonlyMap<string, Transaction>;
  currency: string;
  preparedAt: number;
}

function currentChainValue(
  snapshot: ReturnType<typeof buildConnectionWorkspaceFromCard>,
  priceIndex: PriceIndex
): Pick<WalletChainSummary, 'currentValue' | 'pricedAssetCount' | 'unpricedAssetCount'> {
  const hasCurrentExhaustiveAuthority = snapshot.scopes.some((scope) =>
    scope.accountClass === 'wallet' &&
    scope.authority.status === 'current' &&
    scope.authority.selectedSnapshot?.endpointProof.exhaustiveBalances === true
  );
  let currentValue = 0;
  let pricedAssetCount = 0;
  let unpricedAssetCount = 0;
  for (const holding of snapshot.overview.holdings) {
    if (holding.quantity <= 1e-9) continue;
    const mark = currentPriceFor(holding, priceIndex);
    if (!mark) {
      unpricedAssetCount += 1;
      continue;
    }
    pricedAssetCount += 1;
    currentValue += holding.quantity * mark.price;
  }
  return {
    currentValue: hasCurrentExhaustiveAuthority && (pricedAssetCount > 0 || unpricedAssetCount === 0)
      ? currentValue
      : null,
    pricedAssetCount,
    unpricedAssetCount
  };
}

/** One global linear evidence/index pass, shared by every expanded wallet card. */
export function prepareWalletChainCollectionEvidence(
  input: WalletChainCollectionInput
): WalletChainCollectionEvidence {
  return {
    transactions: input.transactions,
    exchangeConnections: input.exchangeConnections,
    openingBalances: input.openingBalances,
    snapshots: input.snapshots,
    assets: input.assets,
    sourceCoverage: input.sourceCoverage,
    safetyDecisions: input.safetyDecisions,
    liveWalletRows: input.liveWalletRows,
    collectionIndex: prepareConnectionWorkspaceCollectionIndex({
      transactions: input.transactions,
      exchangeConnections: input.exchangeConnections,
      openingBalances: input.openingBalances,
      snapshots: input.snapshots,
      assets: input.assets,
      sourceCoverage: input.sourceCoverage,
      safetyDecisions: input.safetyDecisions,
      liveWalletRows: input.liveWalletRows,
      metrics: input.metrics
    }),
    priceIndex: buildPriceIndex([...input.priceRows], input.settings?.reportingCurrency ?? 'INR'),
    transactionById: new Map(input.transactions.map((transaction) => [transaction.id, transaction])),
    currency: input.settings?.reportingCurrency ?? 'INR',
    preparedAt: Date.now()
  };
}

export function aggregateWalletCurrentValue(summaries: readonly WalletChainSummary[]): number | null {
  if (summaries.some((summary) => summary.currentValue == null)) return null;
  return summaries.reduce((sum, summary) => sum + summary.currentValue!, 0);
}

export function aggregateWalletTransactionCount(summaries: readonly WalletChainSummary[]): number {
  return summaries.reduce((sum, summary) => sum + summary.transactionCount, 0);
}

function coverageReason(coverage: SourceCoverageRow | undefined): string | undefined {
  if (!coverage || (coverage.status !== 'partial' && coverage.status !== 'failed')) return undefined;
  return coverage.endpointOutcomes.find((outcome) =>
    outcome.status !== 'complete' && outcome.warning?.trim()
  )?.warning?.trim() ?? coverage.warnings?.find((warning) => warning.trim())?.trim() ?? (coverage.failureKind?.trim() || undefined);
}

/**
 * Build all selected chain rows from the same one-pass collection index and
 * wallet authority projection used by the connection workspace. Current
 * value never substitutes historical cost: missing spot marks stay unpriced.
 */
export function buildWalletChainSummaries(
  card: ConnectionCardData,
  evidence: WalletChainCollectionEvidence,
  now: number
): WalletChainSummary[] {
  if (card.kind !== 'wallet') return [];

  return (card.walletRows ?? []).map((row) => {
    const chainCard: ConnectionCardData = {
      ...card,
      id: `${card.id}:${row.id}`,
      walletRows: [row]
    };
    const snapshot = buildConnectionWorkspaceFromCard({
      card: chainCard,
      transactions: evidence.transactions,
      exchangeConnections: evidence.exchangeConnections,
      openingBalances: evidence.openingBalances,
      snapshots: evidence.snapshots,
      assets: evidence.assets,
      sourceCoverage: evidence.sourceCoverage,
      safetyDecisions: evidence.safetyDecisions,
      now,
      liveWalletRows: [row],
      collectionIndex: evidence.collectionIndex
    });
    const coverage = selectLatestSemanticSourceCoverage(
      evidence.collectionIndex.coverageBySource.get(row.id) ?? []
    );
    const transactionIds = evidence.collectionIndex.transactionIdsByWallet.get(
      canonicalWalletIdentity(row.chain, row.address)
    ) ?? [];
    const lastActivityAt = transactionIds.reduce<number | undefined>((latest, id) => {
      const timestamp = evidence.transactionById.get(id)?.timestamp;
      return timestamp != null && (latest == null || timestamp > latest) ? timestamp : latest;
    }, undefined);
    return {
      row,
      transactionCount: snapshot.overview.transactionCount,
      lastActivityAt,
      coverageStatus: coverage?.status,
      coverageAt: coverage ? sourceCoverageOperationTime(coverage) : undefined,
      syncAt: coverage ? sourceCoverageOperationTime(coverage) : row.lastSyncedAt || undefined,
      coverageReason: coverageReason(coverage),
      ...currentChainValue(snapshot, evidence.priceIndex)
    };
  });
}
