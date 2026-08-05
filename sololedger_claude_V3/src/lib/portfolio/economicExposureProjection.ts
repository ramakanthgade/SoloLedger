import { canonicalDefiAccountScope, type DefiPositionRow, type DefiPositionSnapshot } from '@/lib/defi/types';

export interface CustodyExposure {
  id: string;
  chainId: number;
  contractAddress?: string;
  symbol: string;
  quantity: number;
  value: number | null;
  scopeId?: string;
}

export function projectScopedEconomicExposure(input: {
  custody: readonly CustodyExposure[];
  snapshots: readonly DefiPositionSnapshot[];
  rows: readonly DefiPositionRow[];
  prices?: ReadonlyMap<string, number>;
}): EconomicExposureProjection {
  const custodyByScope = new Map<string, CustodyExposure[]>();
  for (const row of input.custody) {
    const scope = canonicalDefiAccountScope(row.scopeId ?? 'unscoped');
    const group = custodyByScope.get(scope) ?? [];
    group.push(row);
    custodyByScope.set(scope, group);
  }
  for (const scope of input.snapshots.map((row) => canonicalDefiAccountScope(row.accountIdentityScope))) if (!custodyByScope.has(scope)) custodyByScope.set(scope, []);
  const projections: EconomicExposureProjection[] = [];
  for (const [scope, custody] of custodyByScope) {
    const protocols = [...new Set(input.snapshots.filter((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope).map((row) => row.protocolId))];
    const selectedRows: DefiPositionRow[] = [];
    const partialDebtRows: DefiPositionRow[] = [];
    let selectedHeader: DefiPositionSnapshot | undefined;
    let stale = false;
    let hasPartialOnly = false;
    let hasComplete = false;
    for (const protocolId of protocols) {
      const candidates = input.snapshots.filter((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope && row.protocolId === protocolId).sort((a, b) => b.generation - a.generation);
      const latest = candidates[0];
      const complete = candidates.find((row) => row.status === 'complete');
      if (complete) {
        hasComplete = true;
        selectedHeader ??= complete;
        selectedRows.push(...input.rows.filter((row) => row.snapshotId === complete.snapshotId));
        stale ||= latest.snapshotId !== complete.snapshotId || complete.restoredAt != null;
      } else if (latest) {
        selectedHeader ??= latest;
        hasPartialOnly = true;
      }
      if (latest?.status === 'partial') partialDebtRows.push(...input.rows.filter((row) => row.snapshotId === latest.snapshotId && row.role === 'debt'));
    }
    const header = selectedHeader
      ? { ...selectedHeader, status: hasComplete ? 'complete' as const : selectedHeader.status, ...(stale ? { restoredAt: selectedHeader.restoredAt ?? selectedHeader.capturedAt } : {}) }
      : undefined;
    const projection = projectEconomicExposure({ custody, snapshot: header, rows: selectedRows, latestPartialRows: partialDebtRows, prices: input.prices });
    projections.push({
      ...projection,
      assets: projection.assets.map((row) => ({ ...row, scopeId: scope })),
      liabilities: projection.liabilities.map((row) => ({ ...row, scopeId: scope }))
    });
    if (hasPartialOnly && projections[projections.length - 1]?.status === 'complete') projections[projections.length - 1] = { ...projections[projections.length - 1], status: 'partial' };
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

function valueFor(row: DefiPositionRow, prices: ReadonlyMap<string, number>): number | null {
  const evidenced = row.valueEvidence?.value;
  if (evidenced != null && Number.isFinite(evidenced)) return Math.abs(evidenced);
  const price = prices.get(row.underlying.contractAddress.toLowerCase());
  return price == null ? null : row.quantity * price;
}

/** Pure current-economic projection. It never reads or mutates transactions, postings, lots, gains, or tax facts. */
export function projectEconomicExposure(input: {
  custody: readonly CustodyExposure[];
  snapshot?: DefiPositionSnapshot;
  rows: readonly DefiPositionRow[];
  prices?: ReadonlyMap<string, number>;
  latestPartialRows?: readonly DefiPositionRow[];
  unsupported?: boolean;
}): EconomicExposureProjection {
  const prices = input.prices ?? new Map();
  const usableComplete = input.snapshot?.status === 'complete';
  const mappedTokens = usableComplete ? new Set(input.rows.map((row) => row.protocolToken.contractAddress.toLowerCase())) : new Set<string>();
  const retainedCustody = input.custody.filter((row) => !row.contractAddress || !mappedTokens.has(row.contractAddress.toLowerCase()));
  const assets: EconomicExposureRow[] = retainedCustody.map((row) => ({ ...row, kind: 'liquid', contribution: row.value }));
  const liabilities: EconomicExposureRow[] = [];
  if (usableComplete) {
    for (const row of input.rows) {
      const value = valueFor(row, prices);
      const base = { id: row.id, chainId: 1, contractAddress: row.underlying.contractAddress, symbol: row.underlying.symbol, quantity: row.quantity, value, protocolId: row.protocolId, replacedCustodyId: input.custody.find((item) => item.contractAddress?.toLowerCase() === row.protocolToken.contractAddress.toLowerCase())?.id };
      if (row.role === 'supply') assets.push({ ...base, kind: 'supply', isCollateral: row.isCollateral, contribution: value });
      else liabilities.push({ ...base, kind: 'liability', debtRateMode: row.debtRateMode, contribution: value == null ? null : -value });
    }
    // A newer incomplete generation cannot lower a previously known liability.
    // Keep the larger positive owed magnitude for each reserve/rate mode.
    for (const row of input.latestPartialRows ?? []) if (row.role === 'debt') {
      const existing = liabilities.find((item) => item.protocolId === row.protocolId && item.contractAddress?.toLowerCase() === row.underlying.contractAddress.toLowerCase() && item.debtRateMode === row.debtRateMode);
      if (existing && existing.quantity >= row.quantity) continue;
      const value = valueFor(row, prices);
      const conservative = { id: row.id, chainId: 1, contractAddress: row.underlying.contractAddress, symbol: row.underlying.symbol, quantity: row.quantity, value, protocolId: row.protocolId, kind: 'liability' as const, debtRateMode: row.debtRateMode, contribution: value == null ? null : -value };
      if (existing) liabilities.splice(liabilities.indexOf(existing), 1, conservative);
      else liabilities.push(conservative);
    }
  } else {
    // Fail closed: partial evidence may add known debt, but never supplies and never removes raw custody.
    for (const row of input.latestPartialRows ?? input.rows) if (row.role === 'debt') {
      const value = valueFor(row, prices);
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
