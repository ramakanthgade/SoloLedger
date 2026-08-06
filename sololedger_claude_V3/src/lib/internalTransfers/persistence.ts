import type { Transaction } from '@/types/transaction';
import { canonicalWalletAddress } from '@/lib/ledger/chainNamespace';
import { assertValidReciprocalTransferPairs } from './model';
import {
  INTERNAL_TRANSFER_MATCHER_VERSION, matchInternalTransfers,
  type TransferAccountEvidence, type TransferCandidate, type TransferMatch
} from './matcher';
import { db } from '@/lib/storage/db';

const AUTO_METHODS = new Set(['exact_onchain_event', 'parser_native', 'heuristic']);

export function sanitizeTransferPairMetadata(
  row: Transaction,
  options: { preserveManualState?: boolean } = { preserveManualState: true }
): Transaction {
  const removeDerivedHint = row.internalTransferSuggestionFlagAdded === true;
  const preserveManualState = options.preserveManualState !== false &&
    (row.internalTransferMatchMethod === 'manual' || row.internalTransferMatchMethod === 'legacy');
  return {
    ...row,
    internalTransferPairId: undefined, linkedTransferId: undefined, internalTransferDecision: undefined,
    internalTransferMatchMethod: undefined, internalTransferMatcherVersion: undefined,
    internalTransferDecisionAt: undefined, internalTransferSuggestionFlagAdded: undefined,
    isInternalTransfer: preserveManualState ? row.isInternalTransfer : false,
    flags: removeDerivedHint ? row.flags.filter((flag) => flag !== 'possible_internal_transfer') : row.flags
  };
}

export function sanitizeEmbeddedTransferPairEvidence(row: Transaction): Transaction {
  const sanitized = row.internalTransferPairId || row.internalTransferSuggestionFlagAdded
    ? sanitizeTransferPairMetadata(row) : row;
  return sanitized.dedupMatchedApiRow
    ? { ...sanitized, dedupMatchedApiRow: sanitizeTransferPairMetadata(sanitized.dedupMatchedApiRow,
      { preserveManualState: false }) }
    : sanitized;
}

async function accountEvidenceFor(rows: readonly Transaction[]): Promise<Map<string, TransferAccountEvidence>> {
  const walletSourceIds = [...new Set(rows.flatMap((row) => row.chain && row.walletAddress
    ? [`${row.chain}:${canonicalWalletAddress(row.chain, row.walletAddress)}`] : []))];
  const batchIds = [...new Set(rows.flatMap((row) => row.importBatchId ? [row.importBatchId] : []))];
  const [walletSources, csvSources, exchangeSources] = await Promise.all([
    db.lookupAddresses.bulkGet(walletSourceIds), db.csvImports.bulkGet(batchIds), db.exchangeConnections.bulkGet(batchIds)
  ]);
  const walletsById = new Map(walletSources.filter(Boolean).map((row) => [row!.id, row!]));
  const csvById = new Map(csvSources.filter(Boolean).map((row) => [row!.id, row!]));
  const exchangeById = new Map(exchangeSources.filter(Boolean).map((row) => [row!.id, row!]));
  const sourceFor = (transaction: Transaction) => {
    const walletId = transaction.chain && transaction.walletAddress
      ? `${transaction.chain}:${canonicalWalletAddress(transaction.chain, transaction.walletAddress)}` : undefined;
    return (walletId ? walletsById.get(walletId) : undefined) ??
      (transaction.importBatchId ? exchangeById.get(transaction.importBatchId) ?? csvById.get(transaction.importBatchId) : undefined);
  };
  const sources = rows.map(sourceFor);
  const accountIds = [...new Set(sources.flatMap((source) => source?.accountIdentityId ? [source.accountIdentityId] : []))];
  const accounts = await db.accountIdentities.bulkGet(accountIds);
  const accountsById = new Map(accounts.filter(Boolean).map((row) => [row!.id, row!]));
  const result = new Map<string, TransferAccountEvidence>();
  rows.forEach((transaction, index) => {
    const source = sources[index];
    const account = source?.accountIdentityId ? accountsById.get(source.accountIdentityId) : undefined;
    if (!source || !account) return;
    result.set(transaction.id, {
      accountId: account.id, ownership: account.ownershipStatus,
      lifecycleRevision: account.lifecycleRevision, sourceRevision: source.revision ?? 0,
      endpointAddress: 'address' in source ? source.address : undefined,
      parserNativeEndpoint: transaction.parserNativeTransfer ? {
        accountIdentityId: account.id,
        laneId: transaction.parserNativeTransfer.laneId
      } : undefined
    });
  });
  return result;
}

async function indexedCandidates(seedIds: readonly string[], seedAssets: readonly string[]): Promise<{
  candidates: TransferCandidate[]; actualSeedIds: Set<string>;
}> {
  const seeds = (await db.transactions.bulkGet([...seedIds])).filter((row): row is Transaction => !!row);
  const assets = [...new Set([...seedAssets, ...seeds.map((row) => row.asset)].map((asset) => asset.trim()).filter(Boolean))];
  if (assets.length === 0) return { candidates: [], actualSeedIds: new Set() };
  const indexedRows = assets.length === 1
    ? await db.transactions.where('asset').equals(assets[0]).toArray()
    : await db.transactions.where('asset').anyOf(assets).toArray();
  const rows = indexedRows.filter((row) =>
    (row.type === 'transfer_in' || row.type === 'transfer_out') && row.internalTransferPairId == null);
  const evidence = await accountEvidenceFor(rows);
  return {
    candidates: rows.flatMap((transaction) => {
      const account = evidence.get(transaction.id);
      return account ? [{ transaction, account }] : [];
    }),
    actualSeedIds: new Set(seedAssets.length > 0 ? rows.map((row) => row.id) : seeds.map((row) => row.id))
  };
}

function pairRows(outgoing: Transaction, incoming: Transaction, match: TransferMatch, decidedAt: number): [Transaction, Transaction] {
  const suggested = match.decision === 'suggested';
  const common = {
    internalTransferPairId: match.pairId, internalTransferDecision: match.decision,
    internalTransferMatchMethod: match.method, internalTransferMatcherVersion: INTERNAL_TRANSFER_MATCHER_VERSION,
    internalTransferDecisionAt: decidedAt,
    isInternalTransfer: match.decision === 'confirmed'
  } as const;
  const patch = (row: Transaction) => {
    const alreadyHinted = row.flags.includes('possible_internal_transfer');
    return {
      internalTransferSuggestionFlagAdded: (suggested && !alreadyHinted) || undefined,
      flags: suggested && !alreadyHinted ? [...row.flags, 'possible_internal_transfer' as const] : row.flags
    };
  };
  return [
    { ...outgoing, ...common, ...patch(outgoing), linkedTransferId: incoming.id },
    { ...incoming, ...common, ...patch(incoming), linkedTransferId: outgoing.id }
  ];
}

export interface MatchingSeed { transactionIds?: readonly string[]; assets?: readonly string[] }

/** Re-reads candidate indexes, revisions, proof, ties and uniqueness in one atomic batch. */
export async function runInternalTransferMatching(seed: readonly string[] | MatchingSeed): Promise<number> {
  const matchingSeed: MatchingSeed = Array.isArray(seed) ? { transactionIds: seed } : seed as MatchingSeed;
  const transactionIds = [...(matchingSeed.transactionIds ?? [])];
  const assets = [...(matchingSeed.assets ?? [])];
  if (transactionIds.length === 0 && assets.length === 0) return 0;
  if (typeof db.transactions.bulkGet !== 'function' || typeof db.transactions.where !== 'function') return 0;
  return db.transaction('rw', [db.transactions, db.lookupAddresses, db.csvImports, db.exchangeConnections, db.accountIdentities], async () => {
    const { candidates, actualSeedIds } = await indexedCandidates(transactionIds, assets);
    const matches = matchInternalTransfers(candidates).filter((match) =>
      actualSeedIds.has(match.outgoingTransactionId) || actualSeedIds.has(match.incomingTransactionId));
    const byId = new Map(candidates.map((candidate) => [candidate.transaction.id, candidate.transaction]));
    const writes: Transaction[] = [];
    const now = Date.now();
    for (const match of matches) {
      const outgoing = byId.get(match.outgoingTransactionId);
      const incoming = byId.get(match.incomingTransactionId);
      if (outgoing && incoming) writes.push(...pairRows(outgoing, incoming, match, now));
    }
    if (writes.length > 0) {
      assertValidReciprocalTransferPairs(writes);
      await db.transactions.bulkPut(writes);
    }
    return matches.length;
  });
}

export interface ExpectedTransferPairState {
  transactionId: string; pairId: string; linkedTransactionId: string;
  decision: 'suggested' | 'confirmed' | 'rejected'; decisionAt: number; matcherVersion: string;
}

function assertExpectedPairState(row: Transaction | undefined, expected: ExpectedTransferPairState): asserts row is Transaction {
  if (!row || row.internalTransferPairId !== expected.pairId || row.linkedTransferId !== expected.linkedTransactionId ||
    row.internalTransferDecision !== expected.decision || row.internalTransferDecisionAt !== expected.decisionAt ||
    row.internalTransferMatcherVersion !== expected.matcherVersion) {
    throw new Error('Internal transfer pair changed before this action was saved. Refresh and try again.');
  }
}

export async function decideSuggestedTransferPair(
  expected: ExpectedTransferPairState, decision: 'confirmed' | 'rejected', decidedAt = Date.now()
): Promise<void> {
  await db.transaction('rw', db.transactions, async () => {
    const [row, linked] = await db.transactions.bulkGet([expected.transactionId, expected.linkedTransactionId]);
    assertExpectedPairState(row, expected);
    assertExpectedPairState(linked, { ...expected, transactionId: expected.linkedTransactionId,
      linkedTransactionId: expected.transactionId });
    if (row.internalTransferDecision !== 'suggested') throw new Error('Internal transfer suggestion is no longer available.');
    const common = {
      internalTransferDecision: decision, internalTransferMatchMethod: 'manual' as const,
      internalTransferMatcherVersion: INTERNAL_TRANSFER_MATCHER_VERSION, internalTransferDecisionAt: decidedAt,
      internalTransferSuggestionFlagAdded: undefined, isInternalTransfer: decision === 'confirmed'
    };
    const next = [row, linked].map((item) => ({ ...item, ...common,
      flags: item.internalTransferSuggestionFlagAdded
        ? item.flags.filter((flag) => flag !== 'possible_internal_transfer')
        : item.flags }));
    assertValidReciprocalTransferPairs(next);
    await db.transactions.bulkPut(next);
  });
}

export async function unlinkTransferPair(expected: ExpectedTransferPairState): Promise<void> {
  await db.transaction('rw', db.transactions, async () => {
    const [row, linked] = await db.transactions.bulkGet([expected.transactionId, expected.linkedTransactionId]);
    assertExpectedPairState(row, expected);
    assertExpectedPairState(linked, { ...expected, transactionId: expected.linkedTransactionId,
      linkedTransactionId: expected.transactionId });
    await db.transactions.bulkPut([
      sanitizeTransferPairMetadata(row, { preserveManualState: false }),
      sanitizeTransferPairMetadata(linked, { preserveManualState: false })
    ]);
  });
}

export async function cleanCounterpartsForDeletedTransactions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || typeof db.transactions.bulkGet !== 'function' || typeof db.transactions.bulkPut !== 'function') return;
  const deleting = new Set(ids);
  const rows = (await db.transactions.bulkGet([...ids])).filter((row): row is Transaction => !!row);
  const counterpartIds = [...new Set(rows.map((row) => row.linkedTransferId).filter((id): id is string => !!id && !deleting.has(id)))];
  const counterparts = (await db.transactions.bulkGet(counterpartIds)).filter((row): row is Transaction => !!row);
  if (counterparts.length > 0) await db.transactions.bulkPut(counterparts.map((row) => sanitizeTransferPairMetadata(row)));
}

/** Called inside the ownership update transaction. Manual decisions remain user-authoritative. */
export async function invalidateAutomaticPairsForAccount(accountIdentityId: string): Promise<number> {
  const [walletSources, csvSources, exchangeSources] = await Promise.all([
    db.lookupAddresses.where('accountIdentityId').equals(accountIdentityId).toArray(),
    db.csvImports.where('accountIdentityId').equals(accountIdentityId).toArray(),
    db.exchangeConnections.where('accountIdentityId').equals(accountIdentityId).toArray()
  ]);
  const batches = new Set([...csvSources, ...exchangeSources].map((row) => row.id));
  const walletKeys = new Set(walletSources.map((row) => `${row.chain}:${canonicalWalletAddress(row.chain, row.address)}`));
  const involved = await db.transactions.filter((row) =>
    (row.importBatchId != null && batches.has(row.importBatchId)) ||
    (row.chain != null && row.walletAddress != null &&
      walletKeys.has(`${row.chain}:${canonicalWalletAddress(row.chain, row.walletAddress)}`))).toArray();
  const pairIds = new Set(involved.flatMap((row) => row.internalTransferPairId && row.internalTransferMatchMethod &&
    AUTO_METHODS.has(row.internalTransferMatchMethod) ? [row.internalTransferPairId] : []));
  if (pairIds.size === 0) return 0;
  const rows = await db.transactions.where('internalTransferPairId').anyOf([...pairIds]).toArray();
  await db.transactions.bulkPut(rows.map((row) => sanitizeTransferPairMetadata(row)));
  return pairIds.size;
}
