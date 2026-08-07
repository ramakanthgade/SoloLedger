import { canonicalDefiAccountScope, type DefiPositionRow, type DefiPositionSnapshot, type ProtocolId, type WalletDefiRefreshManifest } from '@/lib/defi/types';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';

const REQUIRED_PROTOCOLS: readonly ProtocolId[] = ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'];
const COMPLETE_AUTHORITY_MAX_AGE_MS = 24 * 60 * 60_000;
const POSITION_VALUE_MAX_AGE_MS = 15 * 60_000;

export interface CustodyExposure {
  id: string;
  chainId: number;
  contractAddress?: string;
  symbol: string;
  quantity: number;
  value: number | null;
  scopeId?: string;
}

export interface EconomicExposureProjectionMetrics {
  custodyVisits: number;
  snapshotRowVisits: number;
  snapshotVisits: number;
  custodyAuthorityVisits: number;
  manifestVisits: number;
}

export function projectScopedEconomicExposure(input: {
  custody: readonly CustodyExposure[];
  snapshots: readonly DefiPositionSnapshot[];
  rows: readonly DefiPositionRow[];
  prices?: ReadonlyMap<string, number>;
  reportingCurrency: string;
  /** Explicit USD -> reporting-currency FX evidence for this valuation instant. */
  usdToReportingCurrencyRate?: number;
  custodyAuthoritySnapshots?: readonly AuthoritySnapshotRow[];
  refreshManifests?: readonly WalletDefiRefreshManifest[];
  metrics?: EconomicExposureProjectionMetrics;
  now?: number;
}): EconomicExposureProjection {
  const now = input.now ?? Date.now();
  const custodyByScope = new Map<string, CustodyExposure[]>();
  for (const row of input.custody) {
    if (input.metrics) input.metrics.custodyVisits += 1;
    const scope = canonicalDefiAccountScope(row.scopeId ?? 'unscoped');
    const group = custodyByScope.get(scope) ?? [];
    group.push(row);
    custodyByScope.set(scope, group);
  }
  const snapshotRows = new Map<string, DefiPositionRow[]>();
  for (const row of input.rows) {
    if (input.metrics) input.metrics.snapshotRowVisits += 1;
    const group = snapshotRows.get(row.snapshotId) ?? [];
    group.push(row); snapshotRows.set(row.snapshotId, group);
  }
  const generations = new Map<string, { latest: DefiPositionSnapshot; all: DefiPositionSnapshot[] }>();
  for (const row of input.snapshots) {
    if (input.metrics) input.metrics.snapshotVisits += 1;
    const scope = canonicalDefiAccountScope(row.accountIdentityScope);
    if (!custodyByScope.has(scope)) custodyByScope.set(scope, []);
    const key = `${scope}:${row.protocolId}`;
    const selected = generations.get(key);
    if (!selected) {
      generations.set(key, { latest: row, all: [row] });
      continue;
    }
    selected.all.push(row);
    if (row.generation > selected.latest.generation) selected.latest = row;
  }
  const manifests = new Map<string, WalletDefiRefreshManifest>();
  for (const row of input.refreshManifests ?? []) {
    if (input.metrics) input.metrics.manifestVisits += 1;
    manifests.set(canonicalDefiAccountScope(row.accountIdentityScope), row);
  }
  for (const scope of manifests.keys()) if (!custodyByScope.has(scope)) custodyByScope.set(scope, []);
  const latestCustodyByScope = new Map<string, AuthoritySnapshotRow>();
  for (const row of input.custodyAuthoritySnapshots ?? []) {
    if (input.metrics) input.metrics.custodyAuthorityVisits += 1;
    if (row.accountClass !== 'wallet') continue;
    const scope = canonicalDefiAccountScope(row.scopeId);
    const current = latestCustodyByScope.get(scope);
    if (!current || row.generation > current.generation) latestCustodyByScope.set(scope, row);
  }
  const projections: EconomicExposureProjection[] = [];
  for (const [scope, custody] of custodyByScope) {
    const selectedRows: DefiPositionRow[] = [];
    const conservativeDebtRows: DefiPositionRow[] = [];
    const latestHeaders: DefiPositionSnapshot[] = [];
    const manifestHeaders: DefiPositionSnapshot[] = [];
    let hasPostManifestGeneration = false;
    const manifest = manifests.get(scope);
    for (const protocolId of REQUIRED_PROTOCOLS) {
      const candidates = generations.get(`${scope}:${protocolId}`);
      const latest = candidates?.latest;
      if (!latest) continue;
      latestHeaders.push(latest);
      const manifestHeader = candidates?.all.find((row) => row.snapshotId === manifest?.protocolSnapshotIds[protocolId]);
      if (!manifestHeader) {
        conservativeDebtRows.push(...candidates!.all.flatMap((header) =>
          (snapshotRows.get(header.snapshotId) ?? []).filter((row) => row.role === 'debt')));
        continue;
      }
      manifestHeaders.push(manifestHeader);
      selectedRows.push(...(snapshotRows.get(manifestHeader.snapshotId) ?? []));
      const unresolvedHeaders = candidates!.all.filter((row) => row.generation > manifestHeader.generation);
      hasPostManifestGeneration ||= unresolvedHeaders.length > 0;
      conservativeDebtRows.push(...[manifestHeader, ...unresolvedHeaders].flatMap((header) =>
        (snapshotRows.get(header.snapshotId) ?? []).filter((row) => row.role === 'debt')));
    }
    const currentCustody = latestCustodyByScope.get(scope);
    const refreshTimes = manifest && currentCustody
      ? [manifest.custodyAsOf, currentCustody.asOf, currentCustody.capturedAt, ...manifestHeaders.map((row) => row.capturedAt)]
        .filter((value): value is number => value != null)
      : [];
    const fresh = (value: number | undefined) => value != null && Number.isFinite(value) && now >= value && now - value <= COMPLETE_AUTHORITY_MAX_AGE_MS;
    const coherentCompleteAuthority = manifest != null && manifestHeaders.length === REQUIRED_PROTOCOLS.length
      && currentCustody?.status === 'complete' && currentCustody.snapshotId === manifest.custodySnapshotId
      && currentCustody.generation === manifest.custodyGeneration && currentCustody.restoredAt == null
      && currentCustody.scopeId === manifest.custodyScopeId && currentCustody.asOf === manifest.custodyAsOf
      && refreshTimes.length === REQUIRED_PROTOCOLS.length + 3
      && refreshTimes.every(Number.isFinite) && Math.max(...refreshTimes) - Math.min(...refreshTimes) <= 5 * 60_000
      && fresh(manifest.custodyAsOf) && fresh(currentCustody.capturedAt) && fresh(manifest.capturedAt)
      && manifestHeaders.every((row) => fresh(row.capturedAt))
      && manifest.capturedAt === Math.max(...manifestHeaders.map((row) => row.capturedAt))
      && manifestHeaders.every((row) => row.status === 'complete' && row.restoredAt == null && row.blockNumber === manifest.blockNumber
        && manifest.protocolSnapshotIds[row.protocolId] === row.snapshotId && row.evidence.length > 0
        && row.evidence.every((item) => item.status === 'complete' &&
          (item.provider !== 'ethereum-rpc' || item.blockNumber === row.blockNumber)));
    const debtRows = conservativeDebtByPosition(conservativeDebtRows);
    const allLiabilitiesPriced = debtRows.every((row) => valueFor(row, input.prices ?? new Map(), input.reportingCurrency, input.usdToReportingCurrencyRate, now) != null);
    const rolloutReady = coherentCompleteAuthority && !hasPostManifestGeneration && allLiabilitiesPriced;
    const header = rolloutReady ? manifestHeaders[0] : undefined;
    const isEvmWallet = scope.startsWith('wallet:evm:');
    const projection = !isEvmWallet && latestHeaders.length === 0 ? projectLegacyWalletNetWorth(custody) : projectEconomicExposure({
      custody, snapshot: header, rows: rolloutReady ? selectedRows : [], latestPartialRows: rolloutReady ? [] : debtRows,
      prices: input.prices, reportingCurrency: input.reportingCurrency,
      usdToReportingCurrencyRate: input.usdToReportingCurrencyRate, now
    });
    projections.push({
      ...projection,
      assets: projection.assets.map((row) => ({ ...row, scopeId: scope })),
      liabilities: projection.liabilities.map((row) => ({ ...row, scopeId: scope }))
    });
  }
  const assets = projections.flatMap((item) => item.assets);
  const liabilities = projections.flatMap((item) => item.liabilities);
  const contributions = [...assets, ...liabilities].map((row) => row.contribution);
  const hasUnpricedValues = contributions.some((value) => value == null);
  const hasUnpricedLiabilities = liabilities.some((row) => row.quantity > 0 && row.contribution == null);
  const netWorth = hasUnpricedLiabilities
    ? null
    : contributions.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const statuses = projections.map((item) => item.status);
  const status = statuses.includes('unsupported') ? 'unsupported' : statuses.includes('partial') || hasUnpricedValues ? 'partial' : statuses.includes('stale') ? 'stale' : 'complete';
  return { assets, liabilities, netWorth, hasUnpricedValues, hasUnpricedLiabilities, status, evidence: projections.flatMap((item) => item.evidence), retainedCustody: input.custody };
}
export interface EconomicExposureRow extends CustodyExposure {
  kind: 'liquid' | 'supply' | 'liability';
  protocolId?: string;
  isCollateral?: boolean;
  debtRateMode?: 'stable' | 'variable';
  contribution: number | null;
  replacedCustodyId?: string;
}
export interface EconomicExposureProjection {
  assets: EconomicExposureRow[];
  liabilities: EconomicExposureRow[];
  netWorth: number | null;
  hasUnpricedValues: boolean;
  hasUnpricedLiabilities: boolean;
  status: 'complete' | 'partial' | 'stale' | 'unsupported';
  evidence: string[];
  retainedCustody: readonly CustodyExposure[];
}

function conservativeDebtByPosition(rows: readonly DefiPositionRow[]): DefiPositionRow[] {
  const selected = new Map<string, DefiPositionRow>();
  for (const row of rows) {
    if (row.role !== 'debt' || row.quantity <= 0) continue;
    const key = `${row.protocolId}:${row.underlying.contractAddress.toLowerCase()}:${row.debtRateMode}`;
    const existing = selected.get(key);
    if (!existing || existing.quantity < row.quantity) selected.set(key, row);
  }
  return [...selected.values()];
}

export interface DefiNetWorthShadowComparison {
  legacyNetWorth: number | null;
  defiNetWorth: number | null;
  difference: number | null;
  featureEnabled: boolean;
  projection: EconomicExposureProjection;
}

export const WALLET_DEFI_SHADOW_STORAGE_KEY = 'sololedger_wallet_defi_net_worth_shadow_v1';

/** Persist arithmetic diagnostics locally without wallet identifiers or rows. */
export function storeWalletDefiNetWorthShadow(
  shadow: DefiNetWorthShadowComparison,
  storage: Pick<Storage, 'setItem'> = localStorage,
  observedAt = Date.now()
): void {
  try {
    storage.setItem(WALLET_DEFI_SHADOW_STORAGE_KEY, JSON.stringify({
      version: 1,
      observedAt,
      legacyNetWorth: shadow.legacyNetWorth,
      defiNetWorth: shadow.defiNetWorth,
      difference: shadow.difference,
      status: shadow.projection.status,
      featureEnabled: shadow.featureEnabled
    }));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

/** Compare both arithmetic paths locally before selecting the feature output. */
export function projectWalletDefiNetWorth(input: {
  custody: readonly CustodyExposure[];
  snapshots: readonly DefiPositionSnapshot[];
  rows: readonly DefiPositionRow[];
  prices?: ReadonlyMap<string, number>;
  reportingCurrency: string;
  usdToReportingCurrencyRate?: number;
  enabled: boolean;
  custodyAuthoritySnapshots?: readonly AuthoritySnapshotRow[];
  refreshManifests?: readonly WalletDefiRefreshManifest[];
  metrics?: EconomicExposureProjectionMetrics;
  now?: number;
}): DefiNetWorthShadowComparison {
  const candidate = projectScopedEconomicExposure(input);
  const fallback = projectLegacyWalletNetWorth(input.custody);
  const legacyNetWorth = fallback.netWorth;
  return {
    legacyNetWorth, defiNetWorth: candidate.netWorth,
    difference: legacyNetWorth == null || candidate.netWorth == null ? null : candidate.netWorth - legacyNetWorth,
    featureEnabled: input.enabled, projection: input.enabled ? candidate : fallback
  };
}

/** Build the legacy wallet presentation without evaluating the DeFi candidate. */
export function projectLegacyWalletNetWorth(
  custody: readonly CustodyExposure[]
): EconomicExposureProjection {
  const values = custody.map((row) => row.value);
  const hasUnpricedLegacyValues = values.some((value) => value == null);
  // Legacy wallet presentation excludes unpriced assets from its displayed
  // total while retaining the rows and the accompanying disclosure.
  const legacyNetWorth = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    assets: custody.map((row) => ({ ...row, kind: 'liquid', contribution: row.value })),
    liabilities: [], netWorth: legacyNetWorth,
    hasUnpricedValues: hasUnpricedLegacyValues, hasUnpricedLiabilities: false,
    status: hasUnpricedLegacyValues ? 'partial' : 'complete', evidence: [], retainedCustody: custody
  };
}

function valueFor(
  row: DefiPositionRow,
  prices: ReadonlyMap<string, number>,
  reportingCurrency: string,
  usdToReportingCurrencyRate?: number,
  now = Date.now()
): number | null {
  const price = prices.get(row.underlying.contractAddress.toLowerCase());
  if (price != null && Number.isFinite(price) && price > 0) return row.quantity * price;
  const valueEvidence = row.valueEvidence;
  if (!valueEvidence) return null;
  const evidenced = valueEvidence.value;
  if (evidenced == null || !Number.isFinite(evidenced)) return null;
  if (!Number.isFinite(valueEvidence.observedAt) || now < valueEvidence.observedAt ||
    now - valueEvidence.observedAt > POSITION_VALUE_MAX_AGE_MS) return null;
  if (row.quantity > 0 && evidenced <= 0) return null;
  if (reportingCurrency.trim().toUpperCase() === 'USD') return Math.abs(evidenced);
  return usdToReportingCurrencyRate != null && Number.isFinite(usdToReportingCurrencyRate) && usdToReportingCurrencyRate > 0
    ? Math.abs(evidenced) * usdToReportingCurrencyRate
    : null;
}

/** Pure current-economic projection. It never reads or mutates transactions, postings, lots, gains, or tax facts. */
export function projectEconomicExposure(input: {
  custody: readonly CustodyExposure[];
  snapshot?: DefiPositionSnapshot;
  rows: readonly DefiPositionRow[];
  prices?: ReadonlyMap<string, number>;
  reportingCurrency: string;
  usdToReportingCurrencyRate?: number;
  latestPartialRows?: readonly DefiPositionRow[];
  unsupported?: boolean;
  now?: number;
}): EconomicExposureProjection {
  const now = input.now ?? Date.now();
  const prices = input.prices ?? new Map();
  const usableComplete = input.snapshot?.status === 'complete';
  const mappedTokens = usableComplete ? new Set(input.rows.map((row) => row.protocolToken.contractAddress.toLowerCase())) : new Set<string>();
  const retainedCustody = input.custody.filter((row) => !row.contractAddress || !mappedTokens.has(row.contractAddress.toLowerCase()));
  const assets: EconomicExposureRow[] = retainedCustody.map((row) => ({ ...row, kind: 'liquid', contribution: row.value }));
  const liabilities: EconomicExposureRow[] = [];
  if (usableComplete) {
    for (const row of input.rows) {
      const value = valueFor(row, prices, input.reportingCurrency, input.usdToReportingCurrencyRate, now);
      const base = { id: row.id, chainId: 1, contractAddress: row.underlying.contractAddress, symbol: row.underlying.symbol, quantity: row.quantity, value, protocolId: row.protocolId, replacedCustodyId: input.custody.find((item) => item.contractAddress?.toLowerCase() === row.protocolToken.contractAddress.toLowerCase())?.id };
      if (row.role === 'supply') assets.push({ ...base, kind: 'supply', isCollateral: row.isCollateral, contribution: value });
      else liabilities.push({ ...base, kind: 'liability', debtRateMode: row.debtRateMode, contribution: value == null ? null : -value });
    }
    // A newer incomplete generation cannot lower a previously known liability.
    // Keep the larger positive owed magnitude for each reserve/rate mode.
    for (const row of input.latestPartialRows ?? []) if (row.role === 'debt') {
      const existing = liabilities.find((item) => item.protocolId === row.protocolId && item.contractAddress?.toLowerCase() === row.underlying.contractAddress.toLowerCase() && item.debtRateMode === row.debtRateMode);
      if (existing && existing.quantity >= row.quantity) continue;
      const value = valueFor(row, prices, input.reportingCurrency, input.usdToReportingCurrencyRate, now);
      const conservative = { id: row.id, chainId: 1, contractAddress: row.underlying.contractAddress, symbol: row.underlying.symbol, quantity: row.quantity, value, protocolId: row.protocolId, kind: 'liability' as const, debtRateMode: row.debtRateMode, contribution: value == null ? null : -value };
      if (existing) liabilities.splice(liabilities.indexOf(existing), 1, conservative);
      else liabilities.push(conservative);
    }
  } else {
    // Fail closed: partial evidence may add known debt, but never supplies and never removes raw custody.
    for (const row of input.latestPartialRows ?? input.rows) if (row.role === 'debt') {
      const value = valueFor(row, prices, input.reportingCurrency, input.usdToReportingCurrencyRate, now);
      liabilities.push({ id: row.id, chainId: 1, contractAddress: row.underlying.contractAddress, symbol: row.underlying.symbol, quantity: row.quantity, value, protocolId: row.protocolId, kind: 'liability', debtRateMode: row.debtRateMode, contribution: value == null ? null : -value });
    }
  }
  const contributions = [...assets, ...liabilities].map((row) => row.contribution);
  const hasUnpricedValues = contributions.some((value) => value == null);
  const hasUnpricedLiabilities = liabilities.some((row) => row.quantity > 0 && row.contribution == null);
  // Unpriced supply is conservatively zero. A known positive liability with
  // unknown value makes adjusted net worth unknowable and must fail closed.
  const netWorth = hasUnpricedLiabilities
    ? null
    : contributions.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const status = input.unsupported ? 'unsupported' : !input.snapshot || hasUnpricedValues ? 'partial' : input.snapshot.restoredAt != null ? 'stale' : input.snapshot.status;
  return { assets, liabilities, netWorth, hasUnpricedValues, hasUnpricedLiabilities, status, evidence: input.snapshot?.evidence.map((item) => `${item.provider}:${item.status}:${item.detail}`) ?? [], retainedCustody: input.custody };
}
