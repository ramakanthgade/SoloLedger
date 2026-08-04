import type { Transaction, TxType } from '@/types/transaction';

const MARKET_VALUE_TYPES: ReadonlySet<TxType> = new Set([
  'buy', 'sell', 'trade', 'income', 'gift_sent', 'gift_received',
  'nft_mint', 'nft_buy', 'nft_sell'
]);

/** Whether this classification needs FMV for tax and report calculations. */
export function requiresMarketValue(value: Transaction | TxType): boolean {
  return MARKET_VALUE_TYPES.has(typeof value === 'string' ? value : value.type);
}
