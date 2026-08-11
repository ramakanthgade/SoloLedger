import type { TaxSettings, Transaction } from '@/types/transaction';
import type { PriceCacheRow } from '@/lib/storage/db';
import type { OpeningBalanceRow, ExchangeSourceIdentity, DerivedPosting } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { SafetyDecisionRow, SafetyState } from '@/lib/safety/types';
import type { CostBasisMethod } from '@/lib/costBasis/engine';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { estimateIndiaVDA } from '@/lib/tax/estimate';
import { pairedInternalTransferIds } from '@/lib/portfolio/portfolioCompute';
import {
  buildHoldingsProjection,
  prepareHistoricalLedgerReplay,
  type PreparedHistoricalLedgerReplay,
  type ProjectedPortfolioHolding
} from '@/lib/portfolio/holdingsProjection';
import { postingBalances, postingBalanceKey } from '@/lib/ledger/postingBalances';
import { COINGECKO_PLATFORM, type ChainId } from '@/lib/rpc/providers';
import { EVM_CHAIN_NUMERIC_IDS } from '@/lib/ledger/chainNamespace';
import { transactionLegAssetKey } from '@/lib/ledger/assetKey';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import { projectScopedEconomicExposure } from '@/lib/portfolio/economicExposureProjection';
import { isExcludedSafetyState } from '@/lib/safety/types';
import { transactionsUnderCurrentSafetyPolicy } from '@/lib/safety/assetSafety';
import { assetSubjectKey } from '@/lib/safety/canonicalAssets';
import {
  prepareDashboardPriceRows,
  resolveDashboardCurrentMark,
  resolveDashboardHistoricalMark,
  type PreparedDashboardPriceRows
} from './dashboardHistoricalMarks';
import type {
  DashboardAggregate,
  DashboardAsOfSnapshot,
  DashboardChartPoint,
  DashboardEvidenceReason,
  DashboardLedgerContributor,
  DashboardPeriodAggregate,
  DashboardPeriodCategory
} from './dashboardAsOfModel';
import {
  dashboardRealizedGainSummary,
  transactionMatchesDashboardCategory
} from './dashboardCategoryAggregation';

export interface DashboardAsOfProjectionInput {
  transactions: readonly Transaction[];
  exchangeConnections: readonly ExchangeSourceIdentity[];
  openingBalances: readonly OpeningBalanceRow[];
  authoritySnapshots: readonly AuthoritySnapshotRow[];
  authorityAssets: readonly AuthorityAssetRow[];
  sourceCoverage: readonly SourceCoverageRow[];
  defiPositionSnapshots?: readonly DefiPositionSnapshot[];
  defiPositionRows?: readonly DefiPositionRow[];
  walletDefiRefreshManifests?: readonly WalletDefiRefreshManifest[];
  priceCache: readonly PriceCacheRow[];
  settings: TaxSettings;
  specIdHints?: Readonly<Record<string, readonly string[]>>;
  safetyDecisions?: readonly SafetyDecisionRow[];
  nominalStart: number;
  nominalEnd: number;
  effectiveEnd: number;
  nowMs: number;
  chartSamples?: readonly number[];
  preparedPriceRows?: PreparedDashboardPriceRows;
}

interface HistoricalIdentity {
  asset: string;
  chain?: string;
  contractAddress?: string;
  source?: string;
  safetyState: SafetyState;
}

function platformFor(chain?: string): string | undefined {
  return chain ? COINGECKO_PLATFORM[chain as ChainId] : undefined;
}

function safetyStateFor(identity: Pick<HistoricalIdentity, 'chain' | 'contractAddress'>, decisions: readonly SafetyDecisionRow[]): SafetyState {
  if (!identity.chain || !identity.contractAddress) return 'trusted';
  const subjectKey = assetSubjectKey(identity.chain, identity.contractAddress);
  const decision = decisions.find((row) => row.subjectKey === subjectKey);
  return decision?.state ?? 'unverified';
}

function historicalIdentities(
  postings: readonly DerivedPosting[],
  transactions: readonly Transaction[],
  decisions: readonly SafetyDecisionRow[]
): Map<string, HistoricalIdentity> {
  const byTransaction = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const identities = new Map<string, HistoricalIdentity>();
  for (let index = postings.length - 1; index >= 0; index--) {
    const posting = postings[index];
    if (identities.has(posting.assetKey)) continue;
    const transaction = posting.transactionId ? byTransaction.get(posting.transactionId) : undefined;
    const leg = posting.role === 'counter' ? 'counter' : posting.role === 'fee' ? 'fee' : 'principal';
    const exactTransactionLeg = transaction && transactionLegAssetKey(transaction, leg) === posting.assetKey;
    const keyContract = /^evm:\d+:(0x[0-9a-f]+)$/i.exec(posting.assetKey)?.[1]
      ?? /^solana:mint:(.+)$/.exec(posting.assetKey)?.[1];
    const principalIdentity = transaction && exactTransactionLeg
      ? {
          chain: transaction.chain,
          contractAddress: leg === 'principal' ? transaction.contractAddress : keyContract,
          source: transaction.source
        }
      : {};
    const identity: HistoricalIdentity = {
      asset: posting.asset,
      ...principalIdentity,
      safetyState: 'trusted'
    };
    identity.safetyState = safetyStateFor(identity, decisions);
    identities.set(posting.assetKey, identity);
  }
  return identities;
}

function emptyAggregate(asOf: number, status: DashboardAggregate['valuationStatus'] = 'authoritative'): DashboardAggregate {
  return {
    value: 0, contributorIds: [], missingAssetCount: 0, missingLiabilityCount: 0,
    affectedAssetKeys: [], quantityStatus: status, valuationStatus: status,
    valuationCompleteness: 'complete', asOf, reasons: []
  };
}

function aggregateContributors(contributors: readonly DashboardLedgerContributor[], asOf: number): DashboardAggregate {
  const valued = contributors.filter((row) => row.marketValue != null);
  const missing = contributors.filter((row) => row.marketValue == null && row.signedQuantity !== 0);
  const missingAssets = missing.filter((row) => row.kind === 'asset');
  const missingLiabilities = missing.filter((row) => row.kind === 'liability');
  const historical = contributors.some((row) => row.quantityStatus === 'estimated' || row.valuationStatus === 'estimated');
  const reasons = new Set<DashboardEvidenceReason>(contributors.flatMap((row) => [...row.reasons]));
  return {
    value: valued.reduce((sum, row) => sum + row.marketValue!, 0),
    contributorIds: valued.map((row) => row.assetKey),
    missingAssetCount: missingAssets.length,
    missingLiabilityCount: missingLiabilities.length,
    affectedAssetKeys: missing.map((row) => row.assetKey),
    quantityStatus: historical
      ? 'estimated'
      : contributors.some((row) => row.quantityStatus === 'unavailable') ? 'unavailable' : 'authoritative',
    valuationStatus: historical ? 'estimated' : missing.length > 0 ? 'unavailable' : 'authoritative',
    valuationCompleteness: missing.length > 0 ? 'partial' : 'complete',
    asOf,
    markAsOf: valued.length > 0 ? Math.min(...valued.map((row) => row.markAsOf ?? asOf)) : undefined,
    reasons: [...reasons]
  };
}

function remainingCostByAsset(
  transactions: readonly Transaction[],
  cutoff: number,
  settings: TaxSettings,
  method: CostBasisMethod,
  hints: Readonly<Record<string, readonly string[]>>,
  safetyDecisions: readonly SafetyDecisionRow[]
): {
  total: number;
  byAsset: ReadonlyMap<string, number>;
  quantityByAsset: ReadonlyMap<string, number>;
  disposals: ReturnType<typeof calculateCostBasis>['disposals'];
  lots: ReturnType<typeof calculateCostBasis>['lots'];
  shortfalls: ReturnType<typeof calculateCostBasis>['shortfalls'];
} {
  const result = calculateCostBasis(
    transactions.filter((transaction) => transaction.timestamp <= cutoff) as Transaction[],
    {
      method,
      specIdHints: Object.fromEntries(Object.entries(hints).map(([id, lotIds]) => [id, [...lotIds]])),
      settings,
      safetyDecisions
    }
  );
  const byAsset = new Map<string, number>();
  const quantityByAsset = new Map<string, number>();
  for (const lot of result.lots) {
    if (lot.amountRemaining <= 0) continue;
    const identity = lot.assetKey ?? `asset:${lot.asset.toUpperCase()}`;
    byAsset.set(identity, (byAsset.get(identity) ?? 0) +
      lot.amountRemaining * lot.costBasisPerUnit);
    quantityByAsset.set(identity, (quantityByAsset.get(identity) ?? 0) + lot.amountRemaining);
  }
  return {
    total: [...byAsset.values()].reduce((sum, value) => sum + value, 0),
    byAsset, quantityByAsset, disposals: result.disposals, lots: result.lots, shortfalls: result.shortfalls
  };
}

function remainingCostTotal(
  transactions: readonly Transaction[], cutoff: number, settings: TaxSettings,
  method: CostBasisMethod, hints: Readonly<Record<string, readonly string[]>>,
  safetyDecisions: readonly SafetyDecisionRow[]
): number {
  const result = calculateCostBasis(
    transactions.filter((transaction) => transaction.timestamp <= cutoff) as Transaction[],
    {
      method,
      specIdHints: Object.fromEntries(Object.entries(hints).map(([id, lotIds]) => [id, [...lotIds]])),
      settings,
      safetyDecisions
    }
  );
  return result.lots.reduce((total, lot) => lot.amountRemaining > 0
    ? total + lot.amountRemaining * lot.costBasisPerUnit : total, 0);
}

export function projectLedgerBasisNetWorthAtCutoff(input: {
  replay: PreparedHistoricalLedgerReplay;
  transactions: readonly Transaction[];
  priceCache: readonly PriceCacheRow[];
  preparedPriceRows?: PreparedDashboardPriceRows;
  reportingCurrency: string;
  safetyDecisions?: readonly SafetyDecisionRow[];
  cutoff: number;
  costBasisByAsset?: ReadonlyMap<string, number>;
  costBasisQuantityByAsset?: ReadonlyMap<string, number>;
}): { contributors: DashboardLedgerContributor[]; aggregate: DashboardAggregate } {
  const decisions = input.safetyDecisions ?? [];
  const identities = historicalIdentities(input.replay.postings, input.transactions, decisions);
  const balances = postingBalances(input.replay.postings, { asOf: input.cutoff }, input.replay.preparedPostings);
  const grouped = new Map<string, {
    quantity: number;
    scopes: Array<{ scopeId: string; accountClass: DerivedPosting['accountClass'] }>;
    scopeQuantities: Map<string, number>;
  }>();
  for (const posting of input.replay.preparedPostings.ordered) {
    if (posting.effectiveAt > input.cutoff) break;
    const balance = balances.get(postingBalanceKey(posting)) ?? 0;
    const existing = grouped.get(posting.assetKey) ?? {
      quantity: 0,
      scopes: [] as Array<{ scopeId: string; accountClass: DerivedPosting['accountClass'] }>,
      scopeQuantities: new Map<string, number>()
    };
    const scopeIndex = existing.scopes.findIndex((scope) =>
      scope.scopeId === posting.accountScopeId && scope.accountClass === posting.accountClass);
    if (scopeIndex < 0) existing.scopes.push({ scopeId: posting.accountScopeId, accountClass: posting.accountClass });
    // Replace the previously seen final scope quantity rather than adding it per posting.
    const scopeKey = `${posting.accountScopeId}\u001f${posting.accountClass}\u001f${posting.assetKey}`;
    existing.scopeQuantities.set(scopeKey, balance);
    existing.quantity = [...existing.scopeQuantities.values()].reduce((sum, value) => sum + value, 0);
    grouped.set(posting.assetKey, existing);
  }

  const contributors: DashboardLedgerContributor[] = [];
  const positiveQuantityByAsset = new Map<string, number>();
  for (const [assetKey, groupedBalance] of grouped) {
    if (assetKey.startsWith('liability:') || groupedBalance.quantity <= 0) continue;
    positiveQuantityByAsset.set(assetKey, (positiveQuantityByAsset.get(assetKey) ?? 0) + groupedBalance.quantity);
  }
  for (const [assetKey, groupedBalance] of grouped) {
    if (groupedBalance.quantity === 0) continue;
    const identity = identities.get(assetKey) ?? { asset: assetKey, safetyState: 'unverified' as const };
    if (isExcludedSafetyState(identity.safetyState)) continue;
    const kind = assetKey.startsWith('liability:') ? 'liability' : 'asset';
    const mark = resolveDashboardHistoricalMark(input.preparedPriceRows ?? input.priceCache, {
      symbol: identity.asset,
      timestampMs: input.cutoff,
      currency: input.reportingCurrency,
      source: identity.source,
      platform: platformFor(identity.chain),
      contractAddress: identity.contractAddress,
      safetyState: identity.safetyState
    }, input.cutoff);
    const signedQuantity = kind === 'liability' ? -Math.abs(groupedBalance.quantity) : groupedBalance.quantity;
    const totalAssetCost = input.costBasisByAsset?.get(assetKey);
    const totalAssetQuantity = positiveQuantityByAsset.get(assetKey);
    const basisCoveredQuantity = input.costBasisQuantityByAsset?.get(assetKey) ?? 0;
    const fullyBasisCovered = totalAssetQuantity != null && basisCoveredQuantity + 1e-9 >= totalAssetQuantity;
    const costBasis = kind === 'asset' && groupedBalance.quantity > 0 && fullyBasisCovered && totalAssetCost != null && totalAssetQuantity
      ? totalAssetCost * groupedBalance.quantity / totalAssetQuantity
      : undefined;
    const unexplainedNegativeCustody = kind === 'asset' && signedQuantity < 0;
    const marketValue = mark.price == null || unexplainedNegativeCustody ? undefined : signedQuantity * mark.price;
    const reasons: DashboardEvidenceReason[] = ['ledger_history'];
    if (unexplainedNegativeCustody) reasons.push('missing_opening_balance');
    if (mark.reason) reasons.push(mark.reason);
    contributors.push({
      assetKey, asset: identity.asset, kind, signedQuantity,
      accountScopes: groupedBalance.scopes, chain: identity.chain, contractAddress: identity.contractAddress,
      price: mark.price, marketValue, costBasis,
      roi: kind === 'asset' && marketValue != null && costBasis != null && costBasis > 0
        ? (marketValue - costBasis) / costBasis : undefined,
      quantityStatus: unexplainedNegativeCustody ? 'unavailable' : 'estimated',
      valuationStatus: unexplainedNegativeCustody ? 'unavailable' : mark.status,
      valuationCompleteness: marketValue == null ? 'partial' : 'complete',
      asOf: input.cutoff, markAsOf: mark.markAt, reasons
    });
  }
  return { contributors, aggregate: aggregateContributors(contributors, input.cutoff) };
}

function currentContributors(
  input: DashboardAsOfProjectionInput,
  holdings: readonly ProjectedPortfolioHolding[],
  authorityFailedKeys: ReadonlySet<string>
): DashboardLedgerContributor[] {
  return holdings.map((holding) => {
    const unavailableAuthority = authorityFailedKeys.has(holding.assetKey);
    const mark = unavailableAuthority ? { status: 'unavailable' as const, reason: 'current_authority_incomplete' as const }
      : resolveDashboardCurrentMark(input.preparedPriceRows ?? input.priceCache, {
          symbol: holding.asset, timestampMs: input.nowMs, currency: input.settings.reportingCurrency,
          platform: platformFor(holding.chain), contractAddress: holding.contractAddress,
          safetyState: holding.safetyState
        }, input.nowMs);
    const marketValue = mark.price == null ? undefined : holding.quantity * mark.price;
    const reasons: DashboardEvidenceReason[] = unavailableAuthority ? ['current_authority_incomplete'] : ['current_authority'];
    if (mark.reason && !reasons.includes(mark.reason)) reasons.push(mark.reason);
    return {
      assetKey: holding.assetKey, asset: holding.asset, kind: 'asset' as const,
      signedQuantity: holding.quantity,
      accountScopes: holding.sourceVerification.map((source) => ({ scopeId: source.scopeId, accountClass: source.accountClass })),
      chain: holding.chain, contractAddress: holding.contractAddress, price: mark.price,
      marketValue, costBasis: holding.costBasis,
      roi: marketValue != null && holding.costBasis > 0 ? (marketValue - holding.costBasis) / holding.costBasis : undefined,
      quantityStatus: unavailableAuthority ? 'unavailable' as const : 'authoritative' as const,
      valuationStatus: mark.status,
      valuationCompleteness: marketValue == null ? 'partial' as const : 'complete' as const,
      asOf: input.nowMs, markAsOf: mark.markAt, reasons
    };
  });
}

function applyConfiguredRemainingCost(
  contributors: readonly DashboardLedgerContributor[],
  costByAsset: ReadonlyMap<string, number>,
  costQuantityByAsset: ReadonlyMap<string, number>
): DashboardLedgerContributor[] {
  const quantityByAsset = new Map<string, number>();
  for (const row of contributors) {
    if (row.kind !== 'asset' || row.signedQuantity <= 0) continue;
    quantityByAsset.set(row.assetKey, (quantityByAsset.get(row.assetKey) ?? 0) + row.signedQuantity);
  }
  return contributors.map((row) => {
    if (row.kind !== 'asset' || row.signedQuantity <= 0) return row;
    const totalCost = costByAsset.get(row.assetKey);
    const totalQuantity = quantityByAsset.get(row.assetKey);
    const fullyBasisCovered = totalQuantity != null && (costQuantityByAsset.get(row.assetKey) ?? 0) + 1e-9 >= totalQuantity;
    const costBasis = fullyBasisCovered && totalCost != null && totalQuantity
      ? totalCost * row.signedQuantity / totalQuantity : undefined;
    return {
      ...row,
      costBasis,
      roi: row.marketValue != null && costBasis != null && costBasis > 0
        ? (row.marketValue - costBasis) / costBasis : undefined,
      reasons: costBasis == null && !row.reasons.includes('missing_opening_balance')
        ? [...row.reasons, 'missing_opening_balance'] : row.reasons
    };
  });
}

function applyCurrentDefiAuthority(
  input: DashboardAsOfProjectionInput,
  contributors: readonly DashboardLedgerContributor[]
): { contributors: DashboardLedgerContributor[]; comparable: boolean } {
  if (!input.defiPositionSnapshots || !input.defiPositionRows || !input.walletDefiRefreshManifests) {
    return { contributors: [...contributors], comparable: true };
  }
  const walletContributors = contributors.filter((row) =>
    row.kind === 'asset' && row.accountScopes.length > 0 &&
    row.accountScopes.every((scope) => scope.scopeId.startsWith('wallet:')));
  if (walletContributors.length === 0 && input.defiPositionSnapshots.length === 0) {
    return { contributors: [...contributors], comparable: true };
  }
  const originalById = new Map(walletContributors.map((row) => [row.assetKey, row]));
  const prices = new Map<string, number>();
  for (const row of walletContributors) {
    if (row.contractAddress && row.price != null) prices.set(row.contractAddress.toLowerCase(), row.price);
  }
  for (const position of input.defiPositionRows ?? []) {
    const contract = position.underlying.contractAddress.toLowerCase();
    if (prices.has(contract)) continue;
    const mark = resolveDashboardCurrentMark(input.preparedPriceRows ?? input.priceCache, {
      symbol: position.underlying.symbol,
      timestampMs: input.nowMs,
      currency: input.settings.reportingCurrency,
      platform: 'ethereum',
      contractAddress: contract,
      safetyState: 'trusted'
    }, input.nowMs);
    if (mark.price != null) prices.set(contract, mark.price);
  }
  const projection = projectScopedEconomicExposure({
    custody: walletContributors.map((row) => ({
      id: row.assetKey,
      chainId: Number(EVM_CHAIN_NUMERIC_IDS[row.chain ?? ''] ?? 0),
      contractAddress: row.contractAddress,
      symbol: row.asset,
      quantity: row.signedQuantity,
      value: row.marketValue ?? null,
      scopeId: row.accountScopes[0].scopeId
    })),
    snapshots: input.defiPositionSnapshots,
    rows: input.defiPositionRows,
    prices,
    reportingCurrency: input.settings.reportingCurrency,
    custodyAuthoritySnapshots: input.authoritySnapshots,
    refreshManifests: input.walletDefiRefreshManifests,
    now: input.nowMs
  });
  const comparable = projection.status === 'complete';
  const reasons: DashboardEvidenceReason[] = comparable
    ? ['current_authority'] : ['current_authority_incomplete'];
  const projectedRows: DashboardLedgerContributor[] = [...projection.assets, ...projection.liabilities].map((row) => {
    const original = originalById.get(row.id) ?? (row.replacedCustodyId ? originalById.get(row.replacedCustodyId) : undefined);
    const kind = row.kind === 'liability' ? 'liability' as const : 'asset' as const;
    const signedQuantity = kind === 'liability' ? -Math.abs(row.quantity) : row.quantity;
    const costBasis = kind === 'asset' ? original?.costBasis : undefined;
    // Aggregate comparability is intentionally not a row-level kill switch.
    // A missing debt mark or one incoherent scope stays unavailable while each
    // independently valid custody/supply contribution remains published.
    const marketValue = row.contribution ?? undefined;
    return {
      assetKey: kind === 'liability' ? `liability:${row.protocolId ?? 'defi'}:${row.id}` : row.id,
      asset: row.symbol,
      kind,
      signedQuantity,
      accountScopes: row.scopeId
        ? [{ scopeId: row.scopeId, accountClass: 'wallet' as const }]
        : original?.accountScopes ?? [],
      chain: original?.chain ?? 'ethereum',
      contractAddress: row.contractAddress,
      price: row.quantity > 0 && marketValue != null ? Math.abs(marketValue) / row.quantity : undefined,
      marketValue,
      costBasis,
      roi: kind === 'asset' && marketValue != null && costBasis != null && costBasis > 0
        ? (marketValue - costBasis) / costBasis : undefined,
      quantityStatus: marketValue != null ? 'authoritative' as const : comparable ? 'authoritative' as const : 'unavailable' as const,
      valuationStatus: marketValue == null ? 'unavailable' as const : 'authoritative' as const,
      valuationCompleteness: marketValue == null ? 'partial' as const : 'complete' as const,
      asOf: input.nowMs,
      markAsOf: original?.markAsOf,
      reasons
    };
  });
  const walletIds = new Set(walletContributors.map((row) => row.assetKey));
  return {
    contributors: [...contributors.filter((row) => !walletIds.has(row.assetKey)), ...projectedRows],
    comparable
  };
}

export type DashboardTransactionValuationInput = Pick<DashboardAsOfProjectionInput, 'priceCache' | 'preparedPriceRows'> & {
  settings: Pick<TaxSettings, 'reportingCurrency'>;
};

export function dashboardTransactionValue(transaction: Transaction, input: DashboardTransactionValuationInput): number | undefined {
  const currency = input.settings.reportingCurrency;
  if (transaction.fiatCurrency.toUpperCase() === currency.toUpperCase() &&
      transaction.fiatValue != null && Number.isFinite(transaction.fiatValue)) {
    return Math.abs(transaction.fiatValue);
  }
  const mark = resolveDashboardHistoricalMark(input.preparedPriceRows ?? input.priceCache, {
    symbol: transaction.asset, timestampMs: transaction.timestamp, currency,
    source: transaction.source, platform: platformFor(transaction.chain),
    contractAddress: transaction.contractAddress,
    safetyState: transaction.safetyState ?? (transaction.contractAddress ? 'unverified' : 'trusted')
  }, transaction.timestamp);
  return mark.price == null ? undefined : Math.abs(transaction.amount) * mark.price;
}

export function dashboardFeeValue(transaction: Transaction, input: DashboardTransactionValuationInput): number | undefined {
  const currency = input.settings.reportingCurrency;
  if (transaction.type === 'fee') return dashboardTransactionValue(transaction, input);
  if (transaction.feeAmount == null || transaction.feeAmount <= 0) return undefined;
  if (transaction.feeAsset?.toUpperCase() === currency.toUpperCase()) return transaction.feeAmount;
  const feeAsset = transaction.feeAsset ?? transaction.asset;
  const sharesPrincipalIdentity = feeAsset.toUpperCase() === transaction.asset.toUpperCase();
  const mark = resolveDashboardHistoricalMark(input.preparedPriceRows ?? input.priceCache, {
    symbol: feeAsset, timestampMs: transaction.timestamp, currency, source: transaction.source,
    platform: sharesPrincipalIdentity ? platformFor(transaction.chain) : undefined,
    contractAddress: sharesPrincipalIdentity ? transaction.contractAddress : undefined,
    safetyState: sharesPrincipalIdentity
      ? transaction.safetyState ?? (transaction.contractAddress ? 'unverified' : 'trusted')
      : 'trusted'
  }, transaction.timestamp);
  return mark.price == null ? undefined : transaction.feeAmount * mark.price;
}

function periodAggregate(
  category: DashboardPeriodCategory,
  transactions: readonly Transaction[],
  input: DashboardAsOfProjectionInput,
  predicate: (transaction: Transaction) => boolean,
  values: ReadonlyMap<string, number | undefined>,
  feeValues?: ReadonlyMap<string, number | undefined>
): DashboardPeriodAggregate {
  const selected = transactions.filter(predicate);
  const selectedValues = category === 'tradingFees' && feeValues ? feeValues : values;
  const missing = selected.filter((transaction) => selectedValues.get(transaction.id) == null);
  return {
    ...emptyAggregate(input.effectiveEnd, missing.length > 0 ? 'unavailable' : 'authoritative'),
    value: selected.reduce((sum, transaction) => sum + (selectedValues.get(transaction.id) ?? 0), 0),
    contributorIds: selected.map((transaction) => transaction.id),
    transactionIds: selected.map((transaction) => transaction.id),
    affectedAssetKeys: missing.map((transaction) => transaction.asset),
    missingAssetCount: missing.length,
    valuationCompleteness: missing.length > 0 ? 'partial' : 'complete',
    reasons: missing.length > 0 ? ['unpriced'] : [],
    filter: { nominalStart: input.nominalStart, effectiveEnd: input.effectiveEnd, category }
  };
}

function periodAggregates(
  input: DashboardAsOfProjectionInput,
  cost: Pick<ReturnType<typeof remainingCostByAsset>, 'disposals' | 'lots'>
): DashboardAsOfSnapshot['period'] {
  const inRange = input.transactions.filter((transaction) =>
    transaction.timestamp >= input.nominalStart && transaction.timestamp <= input.effectiveEnd);
  const paired = pairedInternalTransferIds([...input.transactions]);
  const values = new Map(inRange.map((transaction) => [transaction.id, dashboardTransactionValue(transaction, input)]));
  const feeValues = new Map(inRange.map((transaction) => [transaction.id, dashboardFeeValue(transaction, input)]));
  const external = (transaction: Transaction) => !transaction.isInternalTransfer && !paired.has(transaction.id);
  const realized = dashboardRealizedGainSummary({
    transactions: input.transactions,
    disposals: cost.disposals,
    lots: cost.lots,
    nominalStart: input.nominalStart,
    effectiveEnd: input.effectiveEnd,
    jurisdiction: input.settings.jurisdiction
  });
  const realizedAggregate: DashboardPeriodAggregate = {
    ...emptyAggregate(input.effectiveEnd), value: realized.value,
    contributorIds: realized.transactionIds, transactionIds: realized.transactionIds,
    filter: { nominalStart: input.nominalStart, effectiveEnd: input.effectiveEnd, category: 'realizedCapitalGains' }
  };
  return {
    in: periodAggregate('in', inRange, input, (transaction) => transaction.type === 'transfer_in' && external(transaction), values),
    out: periodAggregate('out', inRange, input, (transaction) => transaction.type === 'transfer_out' && external(transaction), values),
    income: periodAggregate('income', inRange, input, (transaction) =>
      transactionMatchesDashboardCategory(transaction, 'income'), values),
    expenses: periodAggregate('expenses', inRange, input, (transaction) =>
      transactionMatchesDashboardCategory(transaction, 'expenses'), values),
    tradingFees: periodAggregate('tradingFees', inRange, input, (transaction) =>
      transactionMatchesDashboardCategory(transaction, 'tradingFees'),
      values, feeValues),
    realizedCapitalGains: realizedAggregate
  };
}

export function projectDashboardAsOf(input: DashboardAsOfProjectionInput): DashboardAsOfSnapshot {
  if (input.effectiveEnd > input.nowMs) throw new Error('effectiveEnd cannot exceed nowMs');
  if (input.nominalStart > input.effectiveEnd || input.effectiveEnd > input.nominalEnd) {
    throw new Error('invalid dashboard period');
  }
  const currentEndpoint = input.effectiveEnd === input.nowMs;
  const safetyDecisions = input.safetyDecisions ?? [];
  const policyTransactions = transactionsUnderCurrentSafetyPolicy(input.transactions, safetyDecisions);
  const projectionInput: DashboardAsOfProjectionInput = {
    ...input, transactions: policyTransactions,
    preparedPriceRows: input.preparedPriceRows ?? prepareDashboardPriceRows(input.priceCache)
  };
  const cost = remainingCostByAsset(
    policyTransactions, input.effectiveEnd, input.settings, input.settings.defaultCostBasisMethod,
    input.specIdHints ?? {}, safetyDecisions
  );
  const replay = prepareHistoricalLedgerReplay(projectionInput);
  let contributors: DashboardLedgerContributor[];
  let totalNetWorth: DashboardAggregate;
  let currentComparable = true;
  if (currentEndpoint) {
    const holdings = buildHoldingsProjection({
      transactions: policyTransactions, exchangeConnections: input.exchangeConnections,
      openingBalances: input.openingBalances.filter((row) => row.supersededAt == null), snapshots: input.authoritySnapshots,
      assets: input.authorityAssets, coverage: input.sourceCoverage,
      safetyDecisions, now: input.nowMs
    });
    const failedKeys = new Set(holdings.slices.filter((slice) =>
      slice.verificationStatus !== 'verified_authority').map((slice) => slice.assetKey));
    currentComparable = failedKeys.size === 0;
    contributors = currentContributors(projectionInput, holdings.holdings, failedKeys);
    const defi = applyCurrentDefiAuthority(projectionInput, contributors);
    contributors = applyConfiguredRemainingCost(defi.contributors, cost.byAsset, cost.quantityByAsset);
    currentComparable &&= defi.comparable;
    totalNetWorth = aggregateContributors(contributors, input.effectiveEnd);
  } else {
    const historical = projectLedgerBasisNetWorthAtCutoff({
      replay, transactions: policyTransactions, priceCache: input.priceCache,
      preparedPriceRows: projectionInput.preparedPriceRows,
      reportingCurrency: input.settings.reportingCurrency, safetyDecisions,
      cutoff: input.effectiveEnd, costBasisByAsset: cost.byAsset,
      costBasisQuantityByAsset: cost.quantityByAsset
    });
    contributors = historical.contributors;
    totalNetWorth = historical.aggregate;
  }
  const contributorQuantityByAsset = new Map<string, number>();
  for (const row of contributors) {
    if (row.kind !== 'asset' || row.signedQuantity <= 0) continue;
    contributorQuantityByAsset.set(row.assetKey, (contributorQuantityByAsset.get(row.assetKey) ?? 0) + row.signedQuantity);
  }
  const undercoveredCostAssets = new Set([...contributorQuantityByAsset].filter(([assetKey, quantity]) =>
    (cost.quantityByAsset.get(assetKey) ?? 0) + 1e-9 < quantity).map(([assetKey]) => assetKey));
  const assetsMissingCost = contributors.filter((row) =>
    row.kind === 'asset' && row.signedQuantity > 0 &&
    (row.costBasis == null || undercoveredCostAssets.has(row.assetKey)));
  const costBasis = {
    ...emptyAggregate(input.effectiveEnd), value: cost.total,
    contributorIds: contributors.filter((row) => row.costBasis != null).map((row) => row.assetKey),
    valuationStatus: assetsMissingCost.length > 0 ? 'unavailable' as const : 'authoritative' as const,
    valuationCompleteness: assetsMissingCost.length > 0 ? 'partial' as const : 'complete' as const,
    missingAssetCount: assetsMissingCost.length,
    affectedAssetKeys: assetsMissingCost.map((row) => row.assetKey),
    reasons: assetsMissingCost.length > 0 ? ['missing_opening_balance' as const] : []
  };
  const pnlContributors = contributors.filter((row) => row.marketValue != null && row.costBasis != null &&
    row.kind === 'asset' && !undercoveredCostAssets.has(row.assetKey));
  const unrealizedPnl = {
    ...emptyAggregate(input.effectiveEnd, currentEndpoint ? 'authoritative' : 'estimated'),
    value: pnlContributors.reduce((sum, row) => sum + row.marketValue! - row.costBasis!, 0),
    contributorIds: pnlContributors.map((row) => row.assetKey),
    valuationCompleteness: pnlContributors.length === contributors.filter((row) => row.kind === 'asset').length ? 'complete' as const : 'partial' as const,
    affectedAssetKeys: contributors.filter((row) => row.kind === 'asset' &&
      (row.marketValue == null || row.costBasis == null || undercoveredCostAssets.has(row.assetKey))).map((row) => row.assetKey)
  };
  const period = periodAggregates(projectionInput, cost);
  const chartSamples = [...new Set((input.chartSamples ?? [input.effectiveEnd])
    .filter((sample) => sample <= input.effectiveEnd))].sort((a, b) => a - b);
  const chart: DashboardChartPoint[] = chartSamples.map((timestamp) => {
    if (timestamp === input.effectiveEnd) return { ...totalNetWorth, timestamp, costBasis: cost.total };
    const pointCost = remainingCostTotal(
      policyTransactions, timestamp, input.settings, input.settings.defaultCostBasisMethod,
      input.specIdHints ?? {}, safetyDecisions
    );
    const point = projectLedgerBasisNetWorthAtCutoff({
      replay, transactions: policyTransactions, priceCache: input.priceCache,
      preparedPriceRows: projectionInput.preparedPriceRows,
      reportingCurrency: input.settings.reportingCurrency, safetyDecisions,
      cutoff: timestamp
    });
    return { ...point.aggregate, timestamp, costBasis: pointCost };
  });
  const selectedTds = input.settings.jurisdiction === 'IN'
    ? policyTransactions.filter((transaction) =>
      transaction.timestamp >= input.nominalStart && transaction.timestamp <= input.effectiveEnd &&
      transaction.tdsInr != null && transaction.tdsInr > 0)
      .reduce((sum, transaction) => sum + transaction.tdsInr!, 0)
    : 0;
  return {
    nominalStart: input.nominalStart, nominalEnd: input.nominalEnd,
    effectiveEnd: input.effectiveEnd, nowMs: input.nowMs,
    reportingCurrency: input.settings.reportingCurrency, currentEndpoint,
    currentAuthority: {
      status: currentEndpoint ? currentComparable ? 'authoritative' : 'unavailable' : 'estimated',
      comparable: currentEndpoint ? currentComparable : false,
      reasons: currentEndpoint ? currentComparable ? ['current_authority'] : ['current_authority_incomplete'] : ['ledger_history']
    },
    contributors, totalNetWorth, costBasis, unrealizedPnl, period,
    estimatedTax: input.settings.jurisdiction === 'IN'
      ? estimateIndiaVDA(period.realizedCapitalGains.value).total : 0,
    tds: selectedTds,
    chart
  };
}
