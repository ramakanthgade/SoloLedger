import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow } from '@/lib/storage/db';
import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import { postingBalances, postingBalanceKey } from '@/lib/ledger/postingBalances';
import type {
  AuthorityAssetRow,
  AuthoritySelection,
  AuthorityStatus
} from './authoritySelection';

/**
 * RECONCILIATION ENGINE (Phase 2) — pure, testable, no ccxt/db runtime imports.
 *
 * For each exchange connection, per asset, compares:
 *   - authorityQty: what the exchange SAYS you hold (ExchangeBalanceRow.amount
 *     from fetchBalance — the truth anchor persisted in Phase 1), and
 *   - ledgerQty: what the imported transaction ledger IMPLIES for THIS
 *     connection's rows only (importBatchId === connectionId).
 *
 * The GAP between them is the completeness diagnostic the user demanded:
 *   - ledger UNDER authority → in-side history missing (buys never discovered,
 *     deposits not imported)
 *   - ledger OVER authority → ledger records holdings the source no longer has
 *     (un-netted withdrawals to not-yet-imported wallets, deposit-address phantoms)
 *
 * Ledger sign convention mirrors buildPortfolioHoldings:
 *   + buy, transfer_in, income, gift_received
 *   - sell, transfer_out, gift_sent, fee
 *   trade: -asset/+counterAsset. Legacy consumers skip confirmed internal
 *   transfers exactly as before; custody-correct scope handling is available
 *   only through DerivedPosting APIs until consumer migration.
 */

export type ReconStatus = 'reconciled' | 'ledger_under' | 'ledger_over' | 'no_authority';

export interface SourceAssetRecon {
  asset: string;
  /** What the source's authority says (exchange balance). */
  authorityQty: number;
  /** What the ledger implies for THIS source's rows only. */
  ledgerQty: number;
  /** authorityQty − ledgerQty. 0 ⇒ fully reconciled. */
  delta: number;
  status: ReconStatus;
}

export interface SourceReconResult {
  connectionId: string;
  exchange: string;
  assets: SourceAssetRecon[]; // sorted by |delta| desc
  reconciledCount: number;
  divergentCount: number;
  /** assets with authority balance the ledger can't explain (missing history). */
  unexplainedCount: number;
  /** true when the connection has no balance rows yet (first sync pre-v10). */
  hasAuthority: boolean;
}

/** Per-asset dust threshold so $0.00000046 dust doesn't page anyone. */
function epsilon(authorityQty: number): number {
  // Absolute dust floor: anything under ~1e-6 of an asset is negligible
  // (sub-cent for any realistic price). Plus a relative term so large balances
  // tolerate proportionally tiny reconstruction error.
  return Math.max(1e-6, Math.abs(authorityQty) * 1e-6);
}

/**
 * Ledger-implied net quantity per asset for a set of transactions (already
 * filtered to one connection). Mirrors buildPortfolioHoldings sign rules,
 * simplified: skips internal transfers (net zero) and spam.
 */
export function ledgerImpliedQty(txs: Transaction[]): Map<string, number> {
  const map = new Map<string, number>();
  const add = (asset: string | undefined, delta: number) => {
    if (!asset) return;
    const a = asset.toUpperCase();
    map.set(a, (map.get(a) ?? 0) + delta);
  };

  for (const t of txs) {
    if (t.isSpam) continue;
    if (t.isInternalTransfer) continue;
    if (t.type === 'trade' && t.counterAsset && t.counterAmount != null) {
      add(t.asset, -Math.abs(t.amount));
      add(t.counterAsset, Math.abs(t.counterAmount));
    } else if (t.type === 'buy') {
      add(t.asset, Math.abs(t.amount));
      if (t.counterAsset && t.counterAmount != null) add(t.counterAsset, -Math.abs(t.counterAmount));
    } else if (t.type === 'sell') {
      add(t.asset, -Math.abs(t.amount));
      if (t.counterAsset && t.counterAmount != null) add(t.counterAsset, Math.abs(t.counterAmount));
    } else if (t.type === 'transfer_in' || t.type === 'income' || t.type === 'gift_received') {
      add(t.asset, Math.abs(t.amount));
    } else if (t.type === 'transfer_out' || t.type === 'gift_sent' || t.type === 'fee') {
      add(t.asset, -Math.abs(t.amount));
    }
    // Explicit fee leg (fee charged in a separate asset).
    if (t.feeAmount && t.feeAmount > 0) add(t.feeAsset ?? t.asset, -Math.abs(t.feeAmount));
  }
  return map;
}

export type BalanceStatus = 'reconciled' | 'ledger_under' | 'ledger_over' | 'not_compared';
export type CoverageStatus = 'complete' | 'partial' | 'failed' | 'unknown' | 'opening_balance_required';
export type ScopeStatus = 'resolved' | 'unresolved' | 'source_deleted';
export type ReconSeverity = 'blocked' | 'error' | 'warning' | 'info' | 'clean';

export interface CoverageEvidence {
  status: Exclude<CoverageStatus, 'opening_balance_required'>;
  /** Earliest instant structurally proven by the source, not a user-selected date. */
  provenHistoryStart?: number;
  authorityAsOf?: number;
  hasEvidenceBackedOpeningBalance?: boolean;
  firstMovement?: { effectiveAt: number; signedQuantity: number };
  minimumPrefixQuantity?: number;
  negativeTolerance?: number;
  declaredOpeningSnapshot?: { effectiveAt: number; quantity: number };
  earliestExplainingAcquisitionAt?: number;
}

export function coverageStatusFromEvidence(evidence: CoverageEvidence): CoverageStatus {
  if (evidence.status !== 'complete' || evidence.hasEvidenceBackedOpeningBalance === true) return evidence.status;
  if (
    evidence.provenHistoryStart == null || evidence.authorityAsOf == null ||
    !Number.isFinite(evidence.provenHistoryStart) || !Number.isFinite(evidence.authorityAsOf) ||
    evidence.provenHistoryStart > evidence.authorityAsOf
  ) return evidence.status;
  const tolerance = Math.max(0, evidence.negativeTolerance ?? 1e-9);
  const firstOutflow = evidence.firstMovement != null &&
    evidence.firstMovement.effectiveAt >= evidence.provenHistoryStart &&
    evidence.firstMovement.effectiveAt <= evidence.authorityAsOf &&
    evidence.firstMovement.signedQuantity < -tolerance;
  const negativePrefix = evidence.minimumPrefixQuantity != null &&
    evidence.minimumPrefixQuantity < -tolerance;
  const opening = evidence.declaredOpeningSnapshot;
  const unexplainedDeclaredOpening = opening != null &&
    opening.effectiveAt >= evidence.provenHistoryStart && opening.effectiveAt <= evidence.authorityAsOf &&
    opening.quantity > tolerance &&
    (evidence.earliestExplainingAcquisitionAt == null || evidence.earliestExplainingAcquisitionAt > opening.effectiveAt);
  if (firstOutflow || negativePrefix || unexplainedDeclaredOpening) return 'opening_balance_required';
  return evidence.status;
}

export interface ReconciliationResult {
  scopeId: string;
  accountClass: DerivedPosting['accountClass'];
  assetKey: string;
  asset: string;
  balanceStatus: BalanceStatus;
  authorityStatus: AuthorityStatus;
  coverageStatus: CoverageStatus;
  scopeStatus: ScopeStatus;
  selectedSnapshotId?: string;
  selectedGeneration?: number;
  asOf?: number;
  ledgerQuantity?: number;
  authorityQuantity?: number;
  delta?: number;
  postingEvidenceCount: number;
  authorityEvidenceCount: number;
}

export interface ReconPresentation {
  severity: ReconSeverity;
  primaryRemediation: string;
  secondaryRemediations: string[];
}

function remediationFindings(result: ReconciliationResult): { severity: ReconSeverity; remediation: string }[] {
  const findings: { severity: ReconSeverity; remediation: string }[] = [];
  if (result.scopeStatus !== 'resolved') findings.push({ severity: 'blocked', remediation: result.scopeStatus === 'source_deleted' ? 'reconnect_source' : 'resolve_source_scope' });
  if (result.authorityStatus === 'non_comparable') findings.push({ severity: 'blocked', remediation: 'capture_coherent_authority' });
  if (result.authorityStatus === 'missing') findings.push({ severity: 'warning', remediation: 'add_timestamped_authority' });
  if (result.coverageStatus === 'failed') findings.push({ severity: 'error', remediation: 'retry_source_operation' });
  if (result.coverageStatus === 'partial') findings.push({ severity: 'warning', remediation: 'complete_source_history' });
  if (result.coverageStatus === 'unknown') findings.push({ severity: 'warning', remediation: 'establish_source_coverage' });
  if (result.coverageStatus === 'opening_balance_required') findings.push({ severity: 'warning', remediation: 'add_evidence_backed_opening_balance' });
  if (result.authorityStatus === 'stale') findings.push({ severity: 'info', remediation: 'refresh_authority' });
  if (result.balanceStatus === 'ledger_under' || result.balanceStatus === 'ledger_over') findings.push({ severity: 'warning', remediation: 'inspect_evidence_history' });
  return findings;
}

export function deriveReconPresentation(result: ReconciliationResult): ReconPresentation {
  const findings = remediationFindings(result);
  if (findings.length === 0) return { severity: 'clean', primaryRemediation: 'none', secondaryRemediations: [] };
  return {
    severity: findings[0].severity,
    primaryRemediation: findings[0].remediation,
    secondaryRemediations: findings.slice(1).map((finding) => finding.remediation)
  };
}

export interface ReconcileDerivedPostingsInput {
  scopeId: string;
  accountClass: DerivedPosting['accountClass'];
  assetKey: string;
  asset: string;
  postings: readonly DerivedPosting[];
  authority: AuthoritySelection;
  coverage: CoverageEvidence;
  scopeStatus: ScopeStatus;
}

function authorityQuantity(rows: readonly AuthorityAssetRow[], assetKey: string): number {
  return rows.reduce((sum, row) => row.assetKey === assetKey ? sum + row.quantity : sum, 0);
}

export function reconcileDerivedPostings(input: ReconcileDerivedPostingsInput): ReconciliationResult {
  const coverageStatus = coverageStatusFromEvidence(input.coverage);
  const hasExactAuthorityAsset = input.authority.selectedAssets.some((row) => row.assetKey === input.assetKey);
  const canInferAbsentZero = input.authority.selectedSnapshot?.endpointProof.exhaustiveBalances === true;
  const absentAssetNonComparable = input.authority.selectedSnapshot != null &&
    !hasExactAuthorityAsset && !canInferAbsentZero;
  const effectiveAuthorityStatus: AuthorityStatus = absentAssetNonComparable
    ? 'non_comparable' : input.authority.authorityStatus;
  const blocked = input.scopeStatus !== 'resolved' ||
    effectiveAuthorityStatus === 'missing' || effectiveAuthorityStatus === 'non_comparable' ||
    input.authority.selectedSnapshot?.asOf == null;
  const relevantEvidence = new Set<string>();
  const visitedEvidence = new Set<DerivedPosting['evidence'][number]>();
  for (const posting of input.postings) {
    if (posting.accountScopeId !== input.scopeId || posting.accountClass !== input.accountClass || posting.assetKey !== input.assetKey) continue;
    for (const evidence of posting.evidence) {
      // Multiple legs from one transaction intentionally share evidence objects.
      // Preserve structural de-duplication while avoiding repeated serialization.
      if (visitedEvidence.has(evidence)) continue;
      visitedEvidence.add(evidence);
      relevantEvidence.add(`${evidence.kind}:${JSON.stringify(evidence)}`);
    }
  }
  const base: ReconciliationResult = {
    scopeId: input.scopeId, accountClass: input.accountClass, assetKey: input.assetKey, asset: input.asset,
    balanceStatus: 'not_compared', authorityStatus: effectiveAuthorityStatus,
    coverageStatus, scopeStatus: input.scopeStatus,
    selectedSnapshotId: input.authority.selectedSnapshot?.snapshotId,
    selectedGeneration: input.authority.selectedSnapshot?.generation,
    asOf: input.authority.selectedSnapshot?.asOf,
    postingEvidenceCount: relevantEvidence.size,
    authorityEvidenceCount: input.authority.selectedAssets.length + input.authority.diagnostics.length
  };
  if (blocked) return base;

  const asOf = input.authority.selectedSnapshot!.asOf!;
  const probe: Pick<DerivedPosting, 'accountScopeId' | 'accountClass' | 'assetKey'> = {
    accountScopeId: input.scopeId, accountClass: input.accountClass, assetKey: input.assetKey
  };
  const ledgerQuantity = postingBalances(input.postings, {
    asOf, scopeId: input.scopeId, accountClass: input.accountClass
  }).get(postingBalanceKey(probe)) ?? 0;
  const sourceQuantity = authorityQuantity(input.authority.selectedAssets, input.assetKey);
  const delta = sourceQuantity - ledgerQuantity;
  const tolerance = epsilon(sourceQuantity);
  const balanceStatus: BalanceStatus = Math.abs(delta) <= tolerance
    ? 'reconciled' : delta > 0 ? 'ledger_under' : 'ledger_over';
  return { ...base, balanceStatus, ledgerQuantity, authorityQuantity: sourceQuantity, delta };
}

/**
 * Reconcile one connection: authority balances vs ledger-implied quantities.
 * `balanceRows` = the connection's ExchangeBalanceRow set (may be empty).
 * `connectionTxs` = transactions with importBatchId === connectionId.
 */
export function reconcileSource(
  connectionId: string,
  exchange: string,
  balanceRows: ExchangeBalanceRow[],
  connectionTxs: Transaction[]
): SourceReconResult {
  const hasAuthority = balanceRows.length > 0;
  const authority = new Map<string, number>();
  for (const b of balanceRows) authority.set(b.asset.toUpperCase(), b.amount);

  const ledger = ledgerImpliedQty(connectionTxs);

  const assets = new Set<string>([...authority.keys(), ...ledger.keys()]);
  const recons: SourceAssetRecon[] = [];
  let reconciledCount = 0;
  let divergentCount = 0;
  let unexplainedCount = 0;

  for (const asset of assets) {
    const authorityQty = authority.get(asset) ?? 0;
    const ledgerQty = ledger.get(asset) ?? 0;
    const delta = authorityQty - ledgerQty;

    let status: ReconStatus;
    if (!hasAuthority) {
      status = 'no_authority';
    } else if (Math.abs(delta) <= epsilon(authorityQty)) {
      status = 'reconciled';
    } else if (authorityQty > ledgerQty) {
      status = 'ledger_under'; // ledger missing in-side history
    } else {
      status = 'ledger_over'; // ledger records holdings source no longer has
    }

    if (status === 'reconciled') reconciledCount++;
    else if (status === 'ledger_under' || status === 'ledger_over') {
      divergentCount++;
      if (authorityQty > 0 && status === 'ledger_under') unexplainedCount++;
    }

    recons.push({ asset, authorityQty, ledgerQty, delta, status });
  }

  // Sort by |delta| desc so the biggest gaps surface first.
  recons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    connectionId,
    exchange,
    assets: recons,
    reconciledCount,
    divergentCount,
    unexplainedCount,
    hasAuthority
  };
}
