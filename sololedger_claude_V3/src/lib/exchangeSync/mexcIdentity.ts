import type { UnifiedTransfer } from './ccxtLoader';

/** Deposit history has no unified id. Bind identity to the complete provider evidence tuple. */
export function mexcDepositSourceRef(transfer: UnifiedTransfer): string {
  const info = transfer.info ?? {};
  const evidence = [info.txId ?? transfer.txid, info.transHash, info.network ?? transfer.network,
    info.coin ?? transfer.currency, info.insertTime ?? transfer.timestamp, info.amount ?? transfer.amount,
    info.address ?? transfer.address, info.memo, info.index ?? info.txIndex].map((item) => String(item ?? ''));
  // JSON tuple encoding preserves field boundaries even when provider values
  // contain punctuation; no hash or invented CSV-compatible identifier is used.
  return `mexc-deposit:${JSON.stringify(evidence)}`;
}
