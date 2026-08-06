import type { Transaction } from '@/types/transaction';

const PAIR_FIELDS = [
  'internalTransferPairId', 'linkedTransferId', 'internalTransferDecision',
  'internalTransferMatchMethod', 'internalTransferMatcherVersion', 'internalTransferDecisionAt'
] as const;
const DECISIONS = new Set(['confirmed', 'suggested', 'rejected']);
const METHODS = new Set(['exact_onchain_event', 'parser_native', 'heuristic', 'manual', 'legacy']);

function assertDecisionMethodCompatibility(row: Transaction): void {
  const decision = row.internalTransferDecision!;
  const method = row.internalTransferMatchMethod!;
  const compatible =
    (method === 'heuristic' && decision === 'suggested') ||
    ((method === 'exact_onchain_event' || method === 'parser_native' || method === 'legacy') && decision === 'confirmed') ||
    (method === 'manual' && (decision === 'confirmed' || decision === 'rejected'));
  if (!compatible) throw new Error('Invalid internal transfer pair: decision and match method are incompatible.');
}

export function assertValidReciprocalTransferPairs(transactions: readonly Transaction[]): void {
  const byId = new Map<string, Transaction>();
  const byPairId = new Map<string, Transaction[]>();
  for (const row of transactions) {
    if (byId.has(row.id)) throw new Error('Invalid internal transfer pair: duplicate transaction id.');
    byId.set(row.id, row);
    if (row.internalTransferPairId) {
      const group = byPairId.get(row.internalTransferPairId) ?? [];
      group.push(row);
      byPairId.set(row.internalTransferPairId, group);
    }
  }
  for (const [pairId, rows] of byPairId) {
    if (rows.length !== 2 || new Set(rows.map((row) => row.id)).size !== 2) {
      throw new Error(`Invalid internal transfer pair: ${pairId} must identify exactly two unique legs.`);
    }
    const types = new Set(rows.map((row) => row.type));
    if (types.size !== 2 || !types.has('transfer_out') || !types.has('transfer_in')) {
      throw new Error('Invalid internal transfer pair: pair must contain one transfer_out and one transfer_in leg.');
    }
  }
  for (const row of transactions) {
    const present = PAIR_FIELDS.filter((field) => row[field] != null);
    if (present.length === 0) continue;
    if (present.length !== PAIR_FIELDS.length || !row.internalTransferPairId?.trim() ||
      !row.linkedTransferId?.trim() || row.linkedTransferId === row.id ||
      !DECISIONS.has(row.internalTransferDecision!) || !METHODS.has(row.internalTransferMatchMethod!) ||
      !row.internalTransferMatcherVersion?.trim() || !Number.isFinite(row.internalTransferDecisionAt)) {
      throw new Error('Invalid internal transfer pair: incomplete, self-linked, or malformed pair metadata.');
    }
    assertDecisionMethodCompatibility(row);
    const linked = byId.get(row.linkedTransferId);
    if (!linked) throw new Error('Invalid internal transfer pair: linked transaction is missing.');
    if (linked.linkedTransferId !== row.id || linked.internalTransferPairId !== row.internalTransferPairId ||
      linked.internalTransferDecision !== row.internalTransferDecision ||
      linked.internalTransferMatchMethod !== row.internalTransferMatchMethod ||
      linked.internalTransferMatcherVersion !== row.internalTransferMatcherVersion ||
      linked.internalTransferDecisionAt !== row.internalTransferDecisionAt) {
      throw new Error('Invalid internal transfer pair: reciprocal metadata does not match.');
    }
    if (row.internalTransferDecision === 'confirmed' && (!row.isInternalTransfer || !linked.isInternalTransfer)) {
      throw new Error('Invalid internal transfer pair: confirmed legs must retain isInternalTransfer=true.');
    }
    if (row.internalTransferDecision !== 'confirmed' && (row.isInternalTransfer || linked.isInternalTransfer)) {
      throw new Error('Invalid internal transfer pair: suggested or rejected pairs cannot change tax state.');
    }
  }
}
