import type { UnifiedTransfer } from './ccxtLoader';

/** Prefer MEXC's immutable native deposit reference over CCXT's parsed fallbacks. */
export function mexcDepositSourceRef(transfer: UnifiedTransfer): string | undefined {
  const nativeTxId = transfer.info?.txId;
  if (nativeTxId != null && String(nativeTxId).trim()) return String(nativeTxId);
  if (transfer.txid?.trim()) return transfer.txid;
  return transfer.id?.trim() || undefined;
}
