import {
  appendHoldingsProjection,
  buildHoldingsProjection,
  type HoldingsProjection,
  type HoldingsProjectionInput
} from '@/lib/portfolio/holdingsProjection';
import type { Transaction } from '@/types/transaction';

function chronologicallyOrderedProjectionTransactions(transactions: Transaction[]): Transaction[] {
  for (let index = 1; index < transactions.length; index++) {
    if (transactions[index - 1].timestamp > transactions[index].timestamp) {
      // Stable sort preserves source order when timestamps are equal.
      return [...transactions].sort((left, right) => left.timestamp - right.timestamp);
    }
  }
  return transactions;
}

function nestedValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left == null || typeof right !== 'object' || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => nestedValueEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      nestedValueEqual(leftRecord[key], rightRecord[key]));
}

function transactionValueEqual(left: Transaction, right: Transaction): boolean {
  if (Object.is(left, right)) return true;
  return left.id === right.id &&
    Object.is(left.timestamp, right.timestamp) &&
    left.type === right.type && left.asset === right.asset &&
    Object.is(left.amount, right.amount) && left.feeAsset === right.feeAsset &&
    Object.is(left.feeAmount, right.feeAmount) && left.fiatCurrency === right.fiatCurrency &&
    Object.is(left.fiatValue, right.fiatValue) && left.counterAsset === right.counterAsset &&
    Object.is(left.counterAmount, right.counterAmount) && left.source === right.source &&
    left.sourceRef === right.sourceRef && left.dedupMatchedApiId === right.dedupMatchedApiId &&
    left.walletAddress === right.walletAddress && left.counterpartyAddress === right.counterpartyAddress &&
    left.contractAddress === right.contractAddress && left.chain === right.chain &&
    left.txHash === right.txHash && left.notes === right.notes &&
    left.isInternalTransfer === right.isInternalTransfer && left.isSpam === right.isSpam &&
    left.category === right.category && left.instrumentClass === right.instrumentClass &&
    left.parserAccountClass === right.parserAccountClass && left.importBatchId === right.importBatchId &&
    Object.is(left.tdsAmount, right.tdsAmount) && left.tdsAsset === right.tdsAsset &&
    Object.is(left.tdsInr, right.tdsInr) && nestedValueEqual(left.flags, right.flags) &&
    nestedValueEqual(left.raw, right.raw) &&
    nestedValueEqual(left.deletedSourceEvidence, right.deletedSourceEvidence) &&
    (left.dedupMatchedApiRow == null || right.dedupMatchedApiRow == null
      ? left.dedupMatchedApiRow === right.dedupMatchedApiRow
      : transactionValueEqual(left.dedupMatchedApiRow, right.dedupMatchedApiRow));
}

function singleLedgerInsertion(
  previous: readonly Transaction[],
  next: readonly Transaction[]
): { index: number; transaction: Transaction } | undefined {
  if (next.length !== previous.length + 1) return undefined;
  let insertionIndex = 0;
  while (insertionIndex < previous.length &&
    previous[insertionIndex].id === next[insertionIndex].id) insertionIndex += 1;
  for (let index = insertionIndex; index < previous.length; index++) {
    if (!transactionValueEqual(previous[index], next[index + 1])) return undefined;
  }
  for (let index = 0; index < insertionIndex; index++) {
    if (!transactionValueEqual(previous[index], next[index])) return undefined;
  }
  return { index: insertionIndex, transaction: next[insertionIndex] };
}

export interface TransactionAppendProof {
  previousProjection: readonly Transaction[];
  transaction: Transaction;
}

interface TransactionViews {
  source: readonly Transaction[];
  nonSpam: Transaction[];
  projection: Transaction[];
  appendProof?: TransactionAppendProof;
}

export function createTransactionViewsProjector() {
  let cached: TransactionViews | undefined;
  return (source: readonly Transaction[]): TransactionViews => {
    const insertion = cached ? singleLedgerInsertion(cached.source, source) : undefined;
    if (cached && insertion) {
      const inserted = insertion.transaction;
      let nonSpamInsertionIndex = 0;
      for (let index = 0; index < insertion.index; index++) {
        if (!source[index].isSpam) nonSpamInsertionIndex += 1;
      }
      const nonSpam = inserted.isSpam
        ? cached.nonSpam
        : [
            ...cached.nonSpam.slice(0, nonSpamInsertionIndex),
            inserted,
            ...cached.nonSpam.slice(nonSpamInsertionIndex)
          ];
      const lastProjected = cached.projection[cached.projection.length - 1];
      const projection = inserted.isSpam
        ? cached.projection
        : lastProjected == null || lastProjected.timestamp < inserted.timestamp
          ? [...cached.projection, inserted]
          : chronologicallyOrderedProjectionTransactions(nonSpam);
      const appendProof = !inserted.isSpam && projection[projection.length - 1] === inserted
        ? { previousProjection: cached.projection, transaction: inserted }
        : undefined;
      cached = { source, nonSpam, projection, appendProof };
      return cached;
    }
    const nonSpam = source.filter((transaction) => !transaction.isSpam);
    cached = { source, nonSpam, projection: chronologicallyOrderedProjectionTransactions(nonSpam) };
    return cached;
  };
}

export function createHoldingsProjector(appendProjection = appendHoldingsProjection) {
  let cached: {
    transactions: readonly Transaction[];
    input: HoldingsProjectionInput;
    projection: HoldingsProjection;
  } | undefined;
  return (input: HoldingsProjectionInput, proof?: TransactionAppendProof) => {
    const staticInputsUnchanged = cached != null &&
      cached.input.exchangeConnections === input.exchangeConnections &&
      cached.input.openingBalances === input.openingBalances &&
      cached.input.snapshots === input.snapshots && cached.input.assets === input.assets &&
      cached.input.coverage === input.coverage && cached.input.now === input.now &&
      cached.input.comparisonAt === input.comparisonAt &&
      cached.input.scopeFilter === input.scopeFilter;
    const previous = cached;
    const appended = staticInputsUnchanged && previous != null && proof != null &&
      previous.transactions === proof.previousProjection &&
      input.transactions.length === previous.transactions.length + 1 &&
      input.transactions[input.transactions.length - 1] === proof.transaction
      ? appendProjection(
          previous.projection, input, proof.transaction
        )
      : undefined;
    const projection = appended ?? buildHoldingsProjection(input);
    cached = { transactions: input.transactions, input, projection };
    return projection;
  };
}
