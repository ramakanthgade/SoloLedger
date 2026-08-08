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
  const userState = input.decision &&
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

export interface SafetyPolicyMetrics {
  decisionIndexBuilds: number;
  decisionIndexVisits: number;
  transactionResolutions: number;
}

export interface SafetyBackfillMetrics {
  transactionIndexVisits: number;
  evidenceTransactionLookups: number;
  assetIdentityLookups: number;
}

function decisionMap(
  decisions: readonly SafetyDecisionRow[],
  metrics?: SafetyPolicyMetrics
): Map<string, SafetyDecisionRow> {
  if (metrics) metrics.decisionIndexBuilds += 1;
  const bySubject = new Map<string, SafetyDecisionRow>();
  for (const decision of decisions) {
    if (metrics) metrics.decisionIndexVisits += 1;
    bySubject.set(decision.subjectKey, decision);
  }
  return bySubject;
}

/**
 * Current visibility policy is an exact-identity snapshot: explicit event user
 * choice, then exact asset user/trusted choice, then automatic exact asset/event
 * evidence. Historical reports intentionally follow this current reversible
 * policy rather than preserving a stale exclusion decision from filing time.
 */
function resolveTransactionSafetyPolicyFromMap(
  transaction: Transaction,
  bySubject: ReadonlyMap<string, SafetyDecisionRow>,
  eventEvidence: readonly ProviderEvidenceRow[] = []
): SafetyResolution {
  const eventSubject = transactionSafetySubject(transaction);
  const eventDecision = bySubject.get(eventSubject);
  const assetSubject = transaction.chain && transaction.contractAddress
    ? assetSubjectKey(transaction.chain, transaction.contractAddress)
    : undefined;
  const assetDecision = assetSubject ? bySubject.get(assetSubject) : undefined;
  const explicitEvent = eventDecision && (
    eventDecision.state === 'user_hidden' || eventDecision.state === 'user_visible'
  ) ? eventDecision : undefined;
  const exactAssetOverride = assetDecision && (
    assetDecision.origin === 'user' || assetDecision.state === 'trusted'
  ) ? assetDecision : undefined;
  const controllingDecision = explicitEvent ?? exactAssetOverride ?? assetDecision ?? eventDecision;
  const resolved = resolveAssetSafety({
    subjectKey: eventSubject,
    chain: transaction.chain,
    contractAddress: transaction.contractAddress,
    evidence: eventEvidence,
    decision: controllingDecision && { ...controllingDecision, subjectKey: eventSubject }
  });
  if (resolved.state !== 'unverified' || controllingDecision?.state !== 'high_confidence_spam') {
    return resolved;
  }
  return {
    state: 'high_confidence_spam', excluded: true, warned: false,
    exactContractPriceOnly: false,
    evidenceIds: controllingDecision.evidenceIds ?? []
  };
}

export function prepareTransactionSafetyPolicy(
  decisions: readonly SafetyDecisionRow[],
  metrics?: SafetyPolicyMetrics
): (transaction: Transaction, eventEvidence?: readonly ProviderEvidenceRow[]) => SafetyResolution {
  const bySubject = decisionMap(decisions, metrics);
  return (transaction, eventEvidence = []) => {
    if (metrics) metrics.transactionResolutions += 1;
    return resolveTransactionSafetyPolicyFromMap(transaction, bySubject, eventEvidence);
  };
}

export function resolveTransactionSafetyPolicy(
  transaction: Transaction,
  decisions: readonly SafetyDecisionRow[],
  eventEvidence: readonly ProviderEvidenceRow[] = []
): SafetyResolution {
  return prepareTransactionSafetyPolicy(decisions)(transaction, eventEvidence);
}

export function transactionsUnderCurrentSafetyPolicy(
  transactions: readonly Transaction[],
  decisions: readonly SafetyDecisionRow[],
  metrics?: SafetyPolicyMetrics
): Transaction[] {
  const bySubject = decisionMap(decisions, metrics);
  return transactions.map((transaction) => {
    const eventSubject = transactionSafetySubject(transaction);
    const assetSubject = transaction.chain && transaction.contractAddress
      ? assetSubjectKey(transaction.chain, transaction.contractAddress)
      : undefined;
    if (!bySubject.has(eventSubject) && (!assetSubject || !bySubject.has(assetSubject))) {
      return transaction;
    }
    if (metrics) metrics.transactionResolutions += 1;
    const resolution = resolveTransactionSafetyPolicyFromMap(transaction, bySubject);
    if (resolution.state === 'unverified') {
      return transaction;
    }
    return {
      ...transaction,
      safetyState: resolution.state,
      isSpam: resolution.excluded
    };
  });
}

export function backfillExactAssetSafetyRows(input: {
  transactions: readonly Transaction[];
  providerEvidence: readonly ProviderEvidenceRow[];
  decisions: readonly SafetyDecisionRow[];
  metrics?: SafetyBackfillMetrics;
}): {
  transactions: Transaction[];
  providerEvidence: ProviderEvidenceRow[];
  decisions: SafetyDecisionRow[];
} {
  const transactionByEvent = new Map<string, Transaction>();
  const assetIdentityBySubject = new Map<string, { chain: string; contractAddress: string }>();
  for (const transaction of input.transactions) {
    if (input.metrics) input.metrics.transactionIndexVisits += 1;
    transactionByEvent.set(transactionSafetySubject(transaction), transaction);
    if (transaction.chain && transaction.contractAddress) {
      assetIdentityBySubject.set(assetSubjectKey(transaction.chain, transaction.contractAddress), {
        chain: transaction.chain,
        contractAddress: transaction.contractAddress
      });
    }
  }
  const assetEvidence = input.providerEvidence.flatMap((evidence) => {
    if (evidence.subjectKind !== 'event' || !qualifiesForAutomaticSpam(evidence)) return [];
    if (input.metrics) input.metrics.evidenceTransactionLookups += 1;
    const transaction = transactionByEvent.get(evidence.subjectKey);
    if (!transaction?.chain || !transaction.contractAddress ||
      transaction.outboundInitiation === 'wallet_initiated') return [];
    return [{
      ...evidence,
      id: `${evidence.id}:asset`,
      subjectKey: assetSubjectKey(transaction.chain, transaction.contractAddress),
      subjectKind: 'asset' as const,
      raw: { ...(evidence.raw ?? {}), sourceEventEvidenceId: evidence.id }
    }];
  });
  const evidenceById = new Map([...input.providerEvidence, ...assetEvidence].map((row) => [row.id, row]));
  const decisionsBySubject = decisionMap(input.decisions);
  const newlyAutomaticAssetSubjects = new Set<string>();
  const grouped = new Map<string, ProviderEvidenceRow[]>();
  for (const evidence of assetEvidence) {
    const rows = grouped.get(evidence.subjectKey) ?? [];
    rows.push(evidence);
    grouped.set(evidence.subjectKey, rows);
  }
  for (const [subjectKey, evidence] of grouped) {
    const prior = decisionsBySubject.get(subjectKey);
    if (prior) continue;
    if (input.metrics) input.metrics.assetIdentityLookups += 1;
    const identity = assetIdentityBySubject.get(subjectKey);
    const resolution = resolveAssetSafety({
      subjectKey,
      chain: identity?.chain,
      contractAddress: identity?.contractAddress,
      evidence
    });
    if (resolution.state !== 'high_confidence_spam') continue;
    decisionsBySubject.set(subjectKey, {
      subjectKey, state: 'high_confidence_spam', origin: 'automatic',
      updatedAt: Math.max(...evidence.map((row) => row.observedAt)),
      reason: 'Backfilled from exact allowlisted provider event evidence.',
      evidenceIds: evidence.map((row) => row.id)
    });
    newlyAutomaticAssetSubjects.add(subjectKey);
  }
  const decisions = [...decisionsBySubject.values()];
  return {
    transactions: input.transactions.map((transaction) => {
      if (!transaction.chain || !transaction.contractAddress ||
        !newlyAutomaticAssetSubjects.has(assetSubjectKey(transaction.chain, transaction.contractAddress))) {
        return transaction;
      }
      const priorEvent = decisionsBySubject.get(transactionSafetySubject(transaction));
      if (priorEvent && (
        priorEvent.state === 'user_hidden' || priorEvent.state === 'user_visible' || priorEvent.state === 'trusted'
      )) return transaction;
      return { ...transaction, safetyState: 'high_confidence_spam', isSpam: true };
    }),
    providerEvidence: [...evidenceById.values()],
    decisions
  };
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

export function automaticDecisionsRespectingPrecedence(
  candidates: readonly SafetyDecisionRow[],
  prior: readonly (SafetyDecisionRow | undefined)[]
): SafetyDecisionRow[] {
  return candidates.filter((_decision, index) =>
    prior[index]?.origin !== 'user' && prior[index]?.state !== 'trusted');
}

/**
 * Resolve imported rows from immutable normalized evidence in O(t + e).
 * Suspicious evidence remains auditable for a proved wallet-initiated send,
 * but that provider hint cannot suppress real outbound custody.
 */
export function materializeImportedTransactionSafety(
  transactions: readonly Transaction[],
  metrics?: SafetyMaterializationMetrics,
  priorDecisions: readonly SafetyDecisionRow[] = []
): { transactions: Transaction[]; providerEvidence: ProviderEvidenceRow[]; automaticDecisions: SafetyDecisionRow[] } {
  const priorDecisionMap = decisionMap(priorDecisions);
  const eventEvidence = transactions.flatMap(providerEvidenceFromTransaction);
  const transactionBySubject = new Map(transactions.flatMap((transaction) =>
    transaction.safetySubjectKey ? [[transaction.safetySubjectKey, transaction] as const] : []));
  const assetIdentityBySubject = new Map<string, { chain: string; contractAddress: string }>();
  const assetEvidence = eventEvidence.flatMap((row) => {
    const transaction = transactionBySubject.get(row.subjectKey);
    if (!transaction?.chain || !transaction.contractAddress || !qualifiesForAutomaticSpam(row) ||
      transaction.outboundInitiation === 'wallet_initiated') return [];
    const subjectKey = assetSubjectKey(transaction.chain, transaction.contractAddress);
    assetIdentityBySubject.set(subjectKey, {
      chain: transaction.chain,
      contractAddress: transaction.contractAddress
    });
    return [{
      ...row,
      id: `${row.id}:asset`,
      subjectKey,
      subjectKind: 'asset' as const,
      raw: { ...(row.raw ?? {}), sourceEventEvidenceId: row.id }
    }];
  });
  const providerEvidence = [...eventEvidence, ...assetEvidence];
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
    const resolution = resolveTransactionSafetyPolicyFromMap(transaction, priorDecisionMap, resolvableEvidence);
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
  const assetEvidenceBySubject = new Map<string, ProviderEvidenceRow[]>();
  for (const row of assetEvidence) {
    const rows = assetEvidenceBySubject.get(row.subjectKey) ?? [];
    rows.push(row);
    assetEvidenceBySubject.set(row.subjectKey, rows);
  }
  for (const [assetKey, evidence] of assetEvidenceBySubject) {
    const identity = assetIdentityBySubject.get(assetKey);
    const priorAssetDecision = priorDecisionMap.get(assetKey);
    const resolution = resolveAssetSafety({
      subjectKey: assetKey,
      chain: identity?.chain,
      contractAddress: identity?.contractAddress,
      evidence,
      decision: priorAssetDecision
    });
    if (resolution.state !== 'high_confidence_spam') continue;
    automaticDecisions.push({
      subjectKey: assetKey,
      state: 'high_confidence_spam',
      updatedAt: Math.max(...evidence.map((row) => row.observedAt)),
      origin: 'automatic',
      reason: 'Exact chain and contract inherited allowlisted high-confidence provider event evidence.',
      evidenceIds: evidence.map((row) => row.id)
    });
  }
  return {
    transactions: transactionsUnderCurrentSafetyPolicy(
      materialized,
      [...automaticDecisions, ...priorDecisions]
    ),
    providerEvidence,
    automaticDecisions
  };
}
