import type { Transaction } from '@/types/transaction';
import {
  AUTOMATIC_SPAM_THRESHOLD,
  isExcludedSafetyState,
  type ProviderEvidenceRow,
  type SafetyDecisionRow,
  type SafetyResolution,
  type SafetyState
} from './types';
import { assetSubjectKey, eventSubjectKey, isCanonicalTrustedAsset } from './canonicalAssets';

/** Versioned local allowlist. A provider's boolean alone is never enough. */
export const SAFETY_RULE_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  'moralis:possible_spam': new Set(['1']),
  'sololedger:spoofed_outbound_log': new Set(['1'])
});

function allowed(evidence: ProviderEvidenceRow): boolean {
  return SAFETY_RULE_ALLOWLIST[`${evidence.provider}:${evidence.ruleId}`]?.has(evidence.ruleVersion) === true;
}

export function qualifiesForAutomaticSpam(evidence: ProviderEvidenceRow): boolean {
  return evidence.subjectKind !== undefined && allowed(evidence) && Number.isFinite(evidence.confidence) &&
    evidence.confidence >= AUTOMATIC_SPAM_THRESHOLD && evidence.confidence <= 1;
}

export function resolveAssetSafety(input: {
  subjectKey: string;
  chain?: string;
  contractAddress?: string;
  evidence?: readonly ProviderEvidenceRow[];
  decision?: SafetyDecisionRow;
}): SafetyResolution {
  const evidence = (input.evidence ?? []).filter((row) => row.subjectKey === input.subjectKey);
  const userState = input.decision?.origin === 'user' &&
    (input.decision.state === 'user_hidden' || input.decision.state === 'user_visible')
    ? input.decision.state : undefined;
  const trusted = Boolean(input.chain && isCanonicalTrustedAsset(input.chain, input.contractAddress)) ||
    input.decision?.state === 'trusted';
  const spamEvidence = evidence.filter(qualifiesForAutomaticSpam)
    .sort((left, right) => right.confidence - left.confidence || right.observedAt - left.observedAt)[0];
  const state: SafetyState = userState ?? (trusted ? 'trusted' : spamEvidence ? 'high_confidence_spam' : 'unverified');
  return {
    state,
    excluded: isExcludedSafetyState(state),
    warned: state === 'unverified',
    exactContractPriceOnly: state === 'unverified',
    evidenceIds: evidence.map((row) => row.id),
    automaticEvidence: spamEvidence && {
      provider: spamEvidence.provider, ruleId: spamEvidence.ruleId,
      ruleVersion: spamEvidence.ruleVersion, confidence: spamEvidence.confidence
    }
  };
}

export function transactionSafetySubject(transaction: Pick<Transaction,
  'id' | 'chain' | 'txHash' | 'sourceRef' | 'contractAddress' | 'type' | 'safetySubjectKey'>): string {
  if (transaction.safetySubjectKey) return transaction.safetySubjectKey;
  const sourceMatch = /moralis:event:[^:]+:(?:erc20|native):(\d+)/i.exec(transaction.sourceRef ?? '');
  return eventSubjectKey({
    chain: transaction.chain ?? 'unknown',
    txHash: transaction.txHash ?? transaction.sourceRef ?? transaction.id,
    contractAddress: transaction.contractAddress,
    eventIndex: sourceMatch?.[1] ?? 0,
    direction: transaction.type === 'transfer_in' ? 'in' : transaction.type === 'transfer_out' ? 'out' : 'unknown'
  });
}

export function transactionAssetSubject(transaction: Pick<Transaction, 'chain' | 'contractAddress'>): string | undefined {
  return transaction.chain ? assetSubjectKey(transaction.chain, transaction.contractAddress) : undefined;
}

/** Materialized state is persisted for deterministic offline consumers; legacy isSpam remains readable. */
export function resolvedTransactionSafetyState(transaction: Pick<Transaction, 'isSpam' | 'safetyState'>): SafetyState {
  return transaction.safetyState ?? (transaction.isSpam ? 'user_hidden' : 'unverified');
}

export function isTransactionExcluded(transaction: Pick<Transaction, 'isSpam' | 'safetyState'>): boolean {
  return isExcludedSafetyState(resolvedTransactionSafetyState(transaction));
}

export function providerEvidenceFromTransaction(transaction: Transaction): ProviderEvidenceRow[] {
  const raw = transaction.raw?.safetyEvidence;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const subjectKey = transaction.safetySubjectKey;
    if (!subjectKey || typeof row.id !== 'string' || typeof row.provider !== 'string' ||
      typeof row.ruleId !== 'string' || typeof row.ruleVersion !== 'string' ||
      typeof row.confidence !== 'number' || typeof row.observedAt !== 'number') return [];
    return [{
      id: row.id, subjectKey, subjectKind: 'event' as const, provider: row.provider,
      ruleId: row.ruleId, ruleVersion: row.ruleVersion, confidence: row.confidence,
      observedAt: row.observedAt,
      raw: typeof row.raw === 'object' && row.raw != null && !Array.isArray(row.raw)
        ? row.raw as Record<string, unknown> : undefined
    }];
  });
}

export interface SafetyMaterializationMetrics {
  evidenceIndexVisits: number;
  transactionEvidenceLookups: number;
}

/**
 * Resolve imported rows from immutable normalized evidence in O(t + e).
 * Suspicious evidence remains auditable for a proved wallet-initiated send,
 * but that provider hint cannot suppress real outbound custody.
 */
export function materializeImportedTransactionSafety(
  transactions: readonly Transaction[],
  metrics?: SafetyMaterializationMetrics
): { transactions: Transaction[]; providerEvidence: ProviderEvidenceRow[]; automaticDecisions: SafetyDecisionRow[] } {
  const providerEvidence = transactions.flatMap(providerEvidenceFromTransaction);
  const evidenceBySubject = new Map<string, ProviderEvidenceRow[]>();
  for (const row of providerEvidence) {
    if (metrics) metrics.evidenceIndexVisits += 1;
    const rows = evidenceBySubject.get(row.subjectKey);
    if (rows) rows.push(row);
    else evidenceBySubject.set(row.subjectKey, [row]);
  }
  const automaticDecisions: SafetyDecisionRow[] = [];
  const materialized = transactions.map((transaction) => {
    const subjectKey = transaction.safetySubjectKey;
    if (!subjectKey) return { ...transaction, safetyState: undefined };
    if (metrics) metrics.transactionEvidenceLookups += 1;
    const subjectEvidence = evidenceBySubject.get(subjectKey) ?? [];
    const resolvableEvidence = transaction.outboundInitiation === 'wallet_initiated'
      ? subjectEvidence.filter((row) => row.ruleId !== 'possible_spam')
      : subjectEvidence;
    const resolution = resolveAssetSafety({
      subjectKey,
      chain: transaction.chain,
      contractAddress: transaction.contractAddress,
      evidence: resolvableEvidence
    });
    if (resolution.state === 'high_confidence_spam') {
      const qualifying = resolvableEvidence.filter(qualifiesForAutomaticSpam);
      automaticDecisions.push({
        subjectKey,
        state: 'high_confidence_spam',
        updatedAt: transaction.timestamp,
        origin: 'automatic',
        reason: transaction.outboundInitiation === 'spoofed_outbound_log'
          ? 'Outbound-looking transfer was not initiated by the watched wallet.'
          : 'Allowlisted provider evidence met the automatic-spam threshold.',
        evidenceIds: qualifying.map((row) => row.id)
      });
    }
    return { ...transaction, safetyState: resolution.state, isSpam: resolution.excluded };
  });
  return { transactions: materialized, providerEvidence, automaticDecisions };
}
