import type { ValuedHolding } from '@/lib/dashboard/dashboardModel';
import type { DefiPositionRow, DefiPositionSnapshot, WalletDefiRefreshManifest } from '@/lib/defi/types';
import { canonicalDefiAccountScope } from '@/lib/defi/types';
import type { AuthoritySnapshotRow } from '@/lib/reconcile/authoritySelection';
import { portfolioHoldingKey } from './portfolioCompute';
import {
  projectWalletDefiNetWorth,
  type CustodyExposure,
  type DefiNetWorthShadowComparison,
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
    const slices = holding.sourceVerification.length > 0
      ? holding.sourceVerification
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
