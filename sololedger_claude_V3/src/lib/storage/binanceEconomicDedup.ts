import type { Transaction } from '@/types/transaction';

function amountKey(amount: number): string {
  const value = Math.abs(amount);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toFixed(9);
}

export function binanceEconomicKey(t: Transaction): string | null {
  if (t.source !== 'binance_api' && t.source !== 'binance') return null;
  const second = Math.floor(t.timestamp / 1_000);
  const asset = t.asset.toUpperCase();
  if (t.type === 'transfer_in' || t.type === 'transfer_out') {
    if (t.isInternalTransfer) return null;
    if (t.source === 'binance' && t.raw?.Operation !== 'Deposit' && t.raw?.Operation !== 'Withdraw') return null;
    return `transfer|${second}|${t.type}|${asset}|${amountKey(t.amount)}`;
  }
  if ((t.type === 'buy' || t.type === 'sell') && t.counterAsset && t.counterAmount != null) {
    return ['spot', second, t.type, asset, amountKey(t.amount), t.counterAsset.toUpperCase(), amountKey(t.counterAmount)].join('|');
  }
  if (t.type === 'trade' && t.counterAsset && t.counterAmount != null) {
    return ['trade', second, asset, amountKey(t.amount), t.counterAsset.toUpperCase(), amountKey(t.counterAmount)].join('|');
  }
  return null;
}

export function binanceApiIdentity(t: Transaction): string | null {
  if (t.source !== 'binance_api') return null;
  const nativeId = t.raw?.tradeId ?? t.raw?.transferId ?? t.raw?.refid ?? t.raw?.txid;
  const scope = t.counterAsset
    ? `${t.asset.toUpperCase()}:${t.counterAsset.toUpperCase()}`
    : t.asset.toUpperCase();
  const account = t.importBatchId ?? 'unscoped';
  if (typeof nativeId === 'string' || typeof nativeId === 'number') {
    return `${account}:${t.type}:${scope}:${String(nativeId)}`;
  }
  return t.sourceRef ? `${account}:${t.type}:${scope}:${t.sourceRef}` : null;
}
