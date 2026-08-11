import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import { canonicalDefiAccountScope } from '@/lib/defi/types';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { portfolioHoldingKey } from './portfolioCompute';
import {
  projectLegacyWalletNetWorth,
  projectWalletDefiNetWorth,
  type CustodyExposure,
  type DefiNetWorthShadowComparison,
  type EconomicExposureProjection,
  type EconomicExposureProjectionMetrics
} from './economicExposureProjection';

export interface WalletDefiCustodyHolding {
  assetKey: string;
  asset: string;
  chain?: string;
  contractAddress?: string;
  quantity: number;
  costBasis: number;
  sourceVerification: readonly { scopeId: string; quantity: number }[];
}

function custodyHoldingIdentity(holding: Pick<WalletDefiCustodyHolding, 'asset' | 'chain' | 'contractAddress'>): string {
  return `${holding.chain?.trim().toLowerCase() ?? 'unchained'}:${portfolioHoldingKey(holding)}`;
}

/** Build canonical wallet custody slices identically for Dashboard and Data Health. */
export function walletDefiCustodyFromHoldings(
  holdings: readonly WalletDefiCustodyHolding[],
  valued: readonly ValuedHolding[]
): CustodyExposure[] {
  const valueByKey = new Map(valued.map((row) => [custodyHoldingIdentity(row), row]));
  const custody: CustodyExposure[] = [];
  for (const holding of holdings) {
    const valuedHolding = valueByKey.get(custodyHoldingIdentity(holding));
    // Cost basis is historical evidence, not a current market mark. Preserve
    // an unknown current valuation instead of turning it into a numeric zero.
    const unitValue = valuedHolding && valuedHolding.amount > 1e-9 && valuedHolding.valueNow != null
      ? valuedHolding.valueNow / valuedHolding.amount
      : null;
    const sourceVerification = holding.sourceVerification ?? [];
    const slices = sourceVerification.length > 0
      ? sourceVerification
      : [{ scopeId: 'unscoped', quantity: holding.quantity }];
    for (const slice of slices) {
      if (slice.quantity <= 1e-9) continue;
      custody.push({
        id: `${slice.scopeId}:${holding.assetKey}`,
        scopeId: slice.scopeId,
        chainId: holding.chain === 'ethereum' ? 1 : 0,
        contractAddress: holding.contractAddress,
        symbol: holding.asset,
        quantity: slice.quantity,
        value: unitValue == null ? null : slice.quantity * unitValue
      });
    }
  }
  return custody;
}

export function projectManifestSelectedWalletDefi(input: {
  custody: readonly CustodyExposure[];
  snapshots: readonly DefiPositionSnapshot[];
  rows: readonly DefiPositionRow[];
  custodyAuthoritySnapshots: readonly AuthoritySnapshotRow[];
  refreshManifests: readonly WalletDefiRefreshManifest[];
  prices?: ReadonlyMap<string, number>;
  reportingCurrency: string;
  enabled: boolean;
  /** Restricts a Connections card while retaining zero/exited manifest scopes. */
  scopeFilter?: ReadonlySet<string>;
  metrics?: EconomicExposureProjectionMetrics;
  now?: number;
}): DefiNetWorthShadowComparison {
  const allowed = input.scopeFilter
    ? new Set([...input.scopeFilter].map(canonicalDefiAccountScope))
    : undefined;
  const inScope = (scope: string) => !allowed || allowed.has(canonicalDefiAccountScope(scope));
  const custody = input.custody.filter((row) => inScope(row.scopeId ?? 'unscoped'));
  const snapshots = input.snapshots.filter((row) => inScope(row.accountIdentityScope));
  const snapshotIds = new Set(snapshots.map((row) => row.snapshotId));
  const rows = input.rows.filter((row) => snapshotIds.has(row.snapshotId));
  const refreshManifests = input.refreshManifests.filter((row) => inScope(row.accountIdentityScope));
  const custodyAuthoritySnapshots = input.custodyAuthoritySnapshots.filter((row) => inScope(row.scopeId));
  return projectWalletDefiNetWorth({
    custody, snapshots, rows, custodyAuthoritySnapshots, refreshManifests,
    prices: input.prices, reportingCurrency: input.reportingCurrency,
    enabled: input.enabled, metrics: input.metrics, now: input.now
  });
}

/**
 * Numeric subtotal shared by Dashboard and wallet Connections. Unknown liquid
 * marks may use only their own historical-cost fallback; protocol rows retain
 * signed known contributions and replaced custody is never counted twice.
 */
export function knownWalletEconomicSubtotal(
  projection: Pick<EconomicExposureProjection, 'assets' | 'liabilities' | 'netWorth'>,
  custodyCostFallbackById: ReadonlyMap<string, number>
): number {
  if (projection.netWorth != null) return projection.netWorth;
  const replacedCustodyIds = new Set([...projection.assets, ...projection.liabilities]
    .flatMap((row) => row.replacedCustodyId ? [row.replacedCustodyId] : []));
  const assets = projection.assets.reduce((sum, row) => {
    if (row.kind === 'liquid' && replacedCustodyIds.has(row.id)) return sum;
    if (row.contribution != null) return sum + row.contribution;
    return row.kind === 'liquid' ? sum + (custodyCostFallbackById.get(row.id) ?? 0) : sum;
  }, 0);
  return assets + projection.liabilities.reduce(
    (sum, row) => sum + (row.contribution ?? 0), 0
  );
}

/** Canonical wallet-scoped economic presentation used by wallet surfaces. */
export function presentWalletEconomicExposure(input: {
  holdings: readonly WalletDefiCustodyHolding[];
  valued: readonly ValuedHolding[];
  snapshots: readonly DefiPositionSnapshot[];
  rows: readonly DefiPositionRow[];
  custodyAuthoritySnapshots: readonly AuthoritySnapshotRow[];
  refreshManifests: readonly WalletDefiRefreshManifest[];
  prices?: ReadonlyMap<string, number>;
  reportingCurrency: string;
  enabled: boolean;
  scopeFilter?: ReadonlySet<string>;
  now?: number;
}): {
  projection: EconomicExposureProjection;
  shadow: DefiNetWorthShadowComparison;
  knownSubtotal: number;
} {
  const custody = walletDefiCustodyFromHoldings(input.holdings, input.valued);
  const shadow = projectManifestSelectedWalletDefi({
    custody,
    snapshots: input.snapshots,
    rows: input.rows,
    custodyAuthoritySnapshots: input.custodyAuthoritySnapshots,
    refreshManifests: input.refreshManifests,
    prices: input.prices,
    reportingCurrency: input.reportingCurrency,
    enabled: input.enabled,
    scopeFilter: input.scopeFilter,
    now: input.now
  });
  const projection = input.enabled ? shadow.projection : projectLegacyWalletNetWorth(custody);
  const custodyCostFallbackById = new Map<string, number>();
  for (const holding of input.holdings) {
    const sourceVerification = holding.sourceVerification ?? [];
    const slices = sourceVerification.length > 0
      ? sourceVerification
      : [{ scopeId: 'unscoped', quantity: holding.quantity }];
    for (const slice of slices) {
      const ratio = holding.quantity > 1e-9 ? slice.quantity / holding.quantity : 0;
      custodyCostFallbackById.set(`${slice.scopeId}:${holding.assetKey}`, holding.costBasis * ratio);
    }
  }
  return {
    projection,
    shadow,
    knownSubtotal: knownWalletEconomicSubtotal(projection, custodyCostFallbackById)
  };
}
