import type { AccountClass } from '@/lib/ledger/derivedPostings';

export type DashboardEvidenceStatus = 'authoritative' | 'estimated' | 'unavailable';
export type DashboardValuationCompleteness = 'complete' | 'partial';

export type DashboardEvidenceReason =
  | 'ledger_history'
  | 'current_authority'
  | 'current_authority_incomplete'
  | 'unpriced'
  | 'future_mark'
  | 'stale_mark'
  | 'unsafe_symbol_fallback'
  | 'ambiguous_price_identity'
  | 'mismatched_contract'
  | 'unresolved_scope'
  | 'deleted_source'
  | 'missing_opening_balance'
  | 'zero_cost_basis';

export interface DashboardEvidenceMetadata {
  quantityStatus: DashboardEvidenceStatus;
  valuationStatus: DashboardEvidenceStatus;
  valuationCompleteness: DashboardValuationCompleteness;
  asOf: number;
  markAsOf?: number;
  reasons: readonly DashboardEvidenceReason[];
}

export interface DashboardLedgerContributor extends DashboardEvidenceMetadata {
  assetKey: string;
  asset: string;
  kind: 'asset' | 'liability';
  signedQuantity: number;
  accountScopes: readonly Readonly<{ scopeId: string; accountClass: AccountClass }>[];
  chain?: string;
  contractAddress?: string;
  price?: number;
  marketValue?: number;
  costBasis?: number;
  roi?: number;
}

export interface DashboardAggregate extends DashboardEvidenceMetadata {
  value: number;
  contributorIds: readonly string[];
  missingAssetCount: number;
  missingLiabilityCount: number;
  affectedAssetKeys: readonly string[];
}

export type DashboardPeriodCategory =
  | 'in' | 'out' | 'income' | 'expenses' | 'tradingFees' | 'realizedCapitalGains';

export interface DashboardPeriodFilterContract {
  nominalStart: number;
  effectiveEnd: number;
  category: DashboardPeriodCategory;
}

export interface DashboardPeriodAggregate extends DashboardAggregate {
  transactionIds: readonly string[];
  filter: DashboardPeriodFilterContract;
}

export interface DashboardChartPoint extends DashboardAggregate {
  timestamp: number;
  costBasis: number;
}

export interface DashboardCurrentAuthorityState {
  status: DashboardEvidenceStatus;
  comparable: boolean;
  reasons: readonly DashboardEvidenceReason[];
}

export interface DashboardAsOfSnapshot {
  nominalStart: number;
  nominalEnd: number;
  effectiveEnd: number;
  nowMs: number;
  reportingCurrency: string;
  currentEndpoint: boolean;
  currentAuthority: DashboardCurrentAuthorityState;
  contributors: readonly DashboardLedgerContributor[];
  totalNetWorth: DashboardAggregate;
  costBasis: DashboardAggregate;
  unrealizedPnl: DashboardAggregate;
  period: Readonly<Record<DashboardPeriodCategory, DashboardPeriodAggregate>>;
  estimatedTax: number;
  tds: number;
  chart: readonly DashboardChartPoint[];
}
