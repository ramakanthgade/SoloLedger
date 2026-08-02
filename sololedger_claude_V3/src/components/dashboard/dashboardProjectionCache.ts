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

function ledgerValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left == null || typeof right !== 'object' || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => ledgerValueEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      ledgerValueEqual(leftRecord[key], rightRecord[key]));
}

function unchangedLedgerPrefix(previous: readonly Transaction[], next: readonly Transaction[]): boolean {
  if (next.length !== previous.length + 1) return false;
  for (let index = 0; index < previous.length; index++) {
    if (!ledgerValueEqual(previous[index], next[index])) return false;
  }
  return true;
}

function singleLedgerInsertion(
  previous: readonly Transaction[],
  next: readonly Transaction[]
): { index: number; transaction: Transaction } | undefined {
  if (next.length !== previous.length + 1) return undefined;
  let insertionIndex = 0;
  while (insertionIndex < previous.length &&
    ledgerValueEqual(previous[insertionIndex], next[insertionIndex])) insertionIndex += 1;
  for (let index = insertionIndex; index < previous.length; index++) {
    if (!ledgerValueEqual(previous[index], next[index + 1])) return undefined;
  }
  return { index: insertionIndex, transaction: next[insertionIndex] };
}

export function createTransactionViewsProjector() {
  let cached: {
    source: readonly Transaction[];
    nonSpam: Transaction[];
    projection: Transaction[];
  } | undefined;
  return (source: readonly Transaction[]) => {
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
      cached = { source, nonSpam, projection };
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
  return (input: HoldingsProjectionInput) => {
    const staticInputsUnchanged = cached != null &&
      cached.input.exchangeConnections === input.exchangeConnections &&
      cached.input.openingBalances === input.openingBalances &&
      cached.input.snapshots === input.snapshots && cached.input.assets === input.assets &&
      cached.input.coverage === input.coverage && cached.input.now === input.now;
    const previous = cached;
    const appended = staticInputsUnchanged && previous != null &&
      unchangedLedgerPrefix(previous.transactions, input.transactions)
      ? appendProjection(
          previous.projection, input, input.transactions[input.transactions.length - 1]
        )
      : undefined;
    const projection = appended ?? buildHoldingsProjection(input);
    cached = { transactions: input.transactions, input, projection };
    return projection;
  };
}
