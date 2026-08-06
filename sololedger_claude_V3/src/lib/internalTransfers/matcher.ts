import type { Transaction } from '@/types/transaction';

export const INTERNAL_TRANSFER_MATCHER_VERSION = 'b4-v1';

export interface TransferAccountEvidence {
  accountId: string;
  ownership: 'owned' | 'not_owned' | 'unknown';
  lifecycleRevision: number;
  sourceRevision: number;
  endpointAddress?: string;
  /** Durable parser endpoint context resolved from the source/account FK, never parser text. */
  parserNativeEndpoint?: {
    accountIdentityId: string;
    laneId: string;
  };
}

export interface TransferCandidate {
  transaction: Transaction;
  account: TransferAccountEvidence;
}

export interface TransferMatch {
  outgoingTransactionId: string;
  incomingTransactionId: string;
  pairId: string;
  decision: 'confirmed' | 'suggested';
  method: 'exact_onchain_event' | 'parser_native' | 'heuristic';
  proofKey: string;
  outgoingAccount: TransferAccountEvidence;
  incomingAccount: TransferAccountEvidence;
}

function canonical(value: string | undefined): string | undefined {
  const result = value?.trim().toLowerCase();
  return result || undefined;
}

function canonicalQuantity(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return undefined;
  const [whole, fraction = ''] = trimmed.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

function quantity(row: Transaction): string | undefined {
  if (!Number.isFinite(row.amount) || row.amount === 0) return undefined;
  return canonicalQuantity(Math.abs(row.amount).toString());
}

function isExcluded(candidate: TransferCandidate): boolean {
  const row = candidate.transaction;
  return candidate.account.ownership !== 'owned' ||
    (row.type !== 'transfer_out' && row.type !== 'transfer_in') ||
    quantity(row) == null || row.isSpam === true ||
    row.safetyState === 'user_hidden' || row.safetyState === 'high_confidence_spam' ||
    (row.type === 'transfer_out' && row.outboundInitiation != null && row.outboundInitiation !== 'wallet_initiated') ||
    row.isInternalTransfer === true || row.internalTransferDecision != null ||
    row.internalTransferMatchMethod === 'manual' || row.internalTransferMatchMethod === 'legacy' ||
    row.internalTransferPairId != null;
}

function exactEventKey(row: Transaction): string | undefined {
  const event = row.onchainTransferEvent;
  if (!event) return undefined;
  const chain = canonical(event.chain);
  const hash = canonical(event.txHash);
  const assetKey = canonical(event.assetKey);
  const sender = canonical(event.sender);
  const recipient = canonical(event.recipient);
  const index = canonical(event.index);
  const eventQuantity = canonicalQuantity(event.quantity);
  const rowAssetKey = canonical(row.contractAddress ?? 'native');
  if (!chain || !hash || !assetKey || !sender || !recipient || sender === recipient || !index || !eventQuantity ||
    (event.indexKind !== 'log' && event.indexKind !== 'trace') || eventQuantity !== quantity(row) ||
    chain !== canonical(row.chain) || hash !== canonical(row.txHash) || assetKey !== rowAssetKey) return undefined;
  return [chain, hash, assetKey, event.indexKind, index, sender, recipient, eventQuantity].join('|');
}

function eventEndpointMatches(candidate: TransferCandidate): boolean {
  const event = candidate.transaction.onchainTransferEvent;
  const endpoint = canonical(candidate.account.endpointAddress);
  if (!event || !endpoint) return false;
  return candidate.transaction.type === 'transfer_out'
    ? canonical(event.sender) === endpoint
    : canonical(event.recipient) === endpoint;
}

export function parserKey(row: Transaction): string | undefined {
  const native = row.parserNativeTransfer;
  const system = canonical(native?.accountSystem);
  const operation = canonical(native?.operationId);
  const lane = canonical(native?.laneId);
  const counterpartLane = canonical(native?.counterpartLaneId);
  return system && operation && lane && counterpartLane && lane !== counterpartLane
    ? `${system}|${operation}` : undefined;
}

function canonicalAsset(row: Transaction): string {
  return canonical(row.onchainTransferEvent?.assetKey ?? row.contractAddress ?? row.asset) ?? '';
}

function stableHash(value: string): string {
  // Four independently salted FNV-1a lanes avoid relying on async WebCrypto
  // while giving persisted pair identities a practical 128-bit collision boundary.
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed, lane) => {
    let hash = seed;
    const input = `${lane}|${value}`;
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

export function deterministicTransferPairId(outId: string, inId: string, proofKey: string): string {
  return `itp:${stableHash(`${outId}|${inId}|${proofKey}`)}`;
}

function appendByKey(
  rows: readonly TransferCandidate[],
  key: (candidate: TransferCandidate) => string | undefined
): Map<string, TransferCandidate[]> {
  const result = new Map<string, TransferCandidate[]>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    const bucket = result.get(value);
    if (bucket) bucket.push(row);
    else result.set(value, [row]);
  }
  return result;
}

function uniqueExactPairs(
  outs: readonly TransferCandidate[], ins: readonly TransferCandidate[]
): Array<[TransferCandidate, TransferCandidate, string]> {
  const outByKey = appendByKey(outs.filter(eventEndpointMatches), (row) => exactEventKey(row.transaction));
  const inByKey = appendByKey(ins.filter(eventEndpointMatches), (row) => exactEventKey(row.transaction));
  const result: Array<[TransferCandidate, TransferCandidate, string]> = [];
  for (const [proofKey, outgoingRows] of outByKey) {
    const incomingRows = inByKey.get(proofKey) ?? [];
    const outAccounts = new Map<string, number>();
    for (const outgoing of outgoingRows) outAccounts.set(outgoing.account.accountId,
      (outAccounts.get(outgoing.account.accountId) ?? 0) + 1);
    let compatibleCount = 0;
    let sole: [TransferCandidate, TransferCandidate] | undefined;
    for (const incoming of incomingRows) {
      const compatibleForIncoming = outgoingRows.length - (outAccounts.get(incoming.account.accountId) ?? 0);
      compatibleCount += compatibleForIncoming;
      if (compatibleCount > 1) break;
      if (compatibleForIncoming === 1) {
        sole = [outgoingRows.find((row) => row.account.accountId !== incoming.account.accountId)!, incoming];
      }
    }
    if (compatibleCount === 1 && sole) result.push([sole[0], sole[1], proofKey]);
  }
  return result;
}

function uniqueParserPairs(
  outs: readonly TransferCandidate[], ins: readonly TransferCandidate[]
): Array<[TransferCandidate, TransferCandidate, string]> {
  const outByKey = new Map<string, TransferCandidate[]>();
  const inByKey = new Map<string, TransferCandidate[]>();
  const parserProofKey = (candidate: TransferCandidate) => {
    const parsed = parserKey(candidate.transaction);
    const endpoint = candidate.account.parserNativeEndpoint;
    return parsed && endpoint && endpoint.accountIdentityId === candidate.account.accountId &&
      canonical(endpoint.laneId) === canonical(candidate.transaction.parserNativeTransfer?.laneId)
      ? `${parsed}|${canonicalAsset(candidate.transaction)}|${quantity(candidate.transaction)}` : undefined;
  };
  for (const [key, rows] of appendByKey(outs, parserProofKey)) outByKey.set(key, rows);
  for (const [key, rows] of appendByKey(ins, parserProofKey)) inByKey.set(key, rows);
  const result: Array<[TransferCandidate, TransferCandidate, string]> = [];
  for (const [proofKey, outgoingRows] of outByKey) {
    const incomingRows = inByKey.get(proofKey) ?? [];
    const byEndpoint = new Map<string, { count: number; sole: TransferCandidate }>();
    for (const outgoing of outgoingRows) {
      const account = outgoing.account.accountId;
      const lane = canonical(outgoing.transaction.parserNativeTransfer?.laneId)!;
      const counterpartLane = canonical(outgoing.transaction.parserNativeTransfer?.counterpartLaneId)!;
      const key = `${account}|${lane}|${counterpartLane}`;
      const existing = byEndpoint.get(key);
      if (existing) existing.count += 1;
      else byEndpoint.set(key, { count: 1, sole: outgoing });
    }
    let compatibleCount = 0;
    let sole: [TransferCandidate, TransferCandidate] | undefined;
    for (const incoming of incomingRows) {
      const account = incoming.account.accountId;
      const lane = canonical(incoming.transaction.parserNativeTransfer?.laneId)!;
      const counterpartLane = canonical(incoming.transaction.parserNativeTransfer?.counterpartLaneId)!;
      const compatible = byEndpoint.get(`${account}|${counterpartLane}|${lane}`);
      compatibleCount += compatible?.count ?? 0;
      if (compatibleCount > 1) break;
      if (compatible?.count === 1) sole = [compatible.sole, incoming];
    }
    if (compatibleCount === 1 && sole) result.push([sole[0], sole[1], proofKey]);
  }
  return result;
}

export function matchInternalTransfers(candidates: readonly TransferCandidate[]): TransferMatch[] {
  const eligible = candidates.filter((candidate) => !isExcluded(candidate));
  const outs = eligible.filter((candidate) => candidate.transaction.type === 'transfer_out');
  const ins = eligible.filter((candidate) => candidate.transaction.type === 'transfer_in');
  const consumed = new Set<string>();
  const matches: TransferMatch[] = [];
  const add = (outgoing: TransferCandidate, incoming: TransferCandidate, proofKey: string,
    decision: TransferMatch['decision'], method: TransferMatch['method']) => {
    if (consumed.has(outgoing.transaction.id) || consumed.has(incoming.transaction.id)) return;
    consumed.add(outgoing.transaction.id); consumed.add(incoming.transaction.id);
    matches.push({
      outgoingTransactionId: outgoing.transaction.id, incomingTransactionId: incoming.transaction.id,
      pairId: deterministicTransferPairId(outgoing.transaction.id, incoming.transaction.id, proofKey),
      decision, method, proofKey, outgoingAccount: outgoing.account, incomingAccount: incoming.account
    });
  };

  for (const [outgoing, incoming, proof] of uniqueExactPairs(outs, ins)) {
    add(outgoing, incoming, proof, 'confirmed', 'exact_onchain_event');
  }
  for (const [outgoing, incoming, proof] of uniqueParserPairs(
    outs.filter((row) => !consumed.has(row.transaction.id)), ins.filter((row) => !consumed.has(row.transaction.id))
  )) {
    add(outgoing, incoming, proof, 'confirmed', 'parser_native');
  }

  // Weak evidence is review-only. Exact asset/quantity and chronology are minimum gates; ambiguity/ties yield no suggestion.
  const remainingOuts = outs.filter((row) => !consumed.has(row.transaction.id));
  const remainingIns = ins.filter((row) => !consumed.has(row.transaction.id));
  const weakKey = (row: TransferCandidate) => `${canonicalAsset(row.transaction)}|${quantity(row.transaction)}`;
  const byWeakIn = new Map<string, TransferCandidate[]>();
  const byWeakOut = new Map<string, TransferCandidate[]>();
  const append = (index: Map<string, TransferCandidate[]>, row: TransferCandidate) => {
    const key = weakKey(row);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  };
  for (const row of remainingIns) append(byWeakIn, row);
  for (const row of remainingOuts) append(byWeakOut, row);
  for (const rows of [...byWeakIn.values(), ...byWeakOut.values()]) {
    rows.sort((left, right) => left.transaction.timestamp - right.transaction.timestamp ||
      left.transaction.id.localeCompare(right.transaction.id));
  }
  const lowerBound = (rows: readonly TransferCandidate[], timestamp: number) => {
    let low = 0; let high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid].transaction.timestamp < timestamp) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const weakCompatible = (outgoing: TransferCandidate, incoming: TransferCandidate) =>
    outgoing.account.accountId !== incoming.account.accountId ||
    (parserKey(outgoing.transaction) != null && parserKey(outgoing.transaction) === parserKey(incoming.transaction));
  for (const outgoing of remainingOuts) {
    const incomingBucket = byWeakIn.get(weakKey(outgoing)) ?? [];
    const start = lowerBound(incomingBucket, outgoing.transaction.timestamp);
    const end = lowerBound(incomingBucket, outgoing.transaction.timestamp + 12 * 60 * 60 * 1000 + 1);
    if (end - start !== 1) continue;
    const incoming = incomingBucket[start];
    if (consumed.has(incoming.transaction.id) || !weakCompatible(outgoing, incoming)) continue;
    const outgoingBucket = byWeakOut.get(weakKey(incoming)) ?? [];
    const reverseStart = lowerBound(outgoingBucket, incoming.transaction.timestamp - 12 * 60 * 60 * 1000);
    const reverseEnd = lowerBound(outgoingBucket, incoming.transaction.timestamp + 1);
    if (reverseEnd - reverseStart !== 1 || outgoingBucket[reverseStart].transaction.id !== outgoing.transaction.id) continue;
    add(outgoing, incoming, `heuristic|${canonicalAsset(outgoing.transaction)}|${quantity(outgoing.transaction)}|${outgoing.transaction.id}|${incoming.transaction.id}`,
      'suggested', 'heuristic');
  }
  return matches;
}
