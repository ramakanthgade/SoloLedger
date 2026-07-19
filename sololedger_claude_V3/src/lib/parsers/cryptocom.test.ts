import { describe, expect, it } from 'vitest';
import { cryptocomParser } from './cryptocom';

const headers = ['timestamp', 'transaction_kind', 'description', 'currency', 'amount', 'native_amount', 'native_currency', 'transaction_hash'];
const row = (transaction_kind: string) => ({ timestamp: '2025-02-01T10:00:00Z', transaction_kind, description: 'Exchange ETH for BTC', currency: 'ETH', amount: '-1.25', native_amount: '-3000', native_currency: 'USD', transaction_hash: `hash-${transaction_kind}` });

describe('cryptocomParser', () => {
  it('strictly detects Crypto.com headers', () => { expect(cryptocomParser.detect(headers)).toBe(true); expect(cryptocomParser.detect(['timestamp', 'currency', 'amount'])).toBe(false); });
  it('maps deposits, withdrawals, purchases, sales, exchanges and income', () => {
    const kinds = ['crypto_deposit', 'crypto_withdrawal', 'crypto_purchase', 'crypto_sale', 'staking_reward', 'crypto_earn_interest', 'crypto_exchange'];
    const result = cryptocomParser.parse(kinds.map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['transfer_in', 'transfer_out', 'buy', 'sell', 'income', 'income', 'trade']);
    expect(result.transactions[0]).toMatchObject({ amount: 1.25, fiatCurrency: 'USD', fiatValue: 3000, sourceRef: 'hash-crypto_deposit' });
    expect(result.transactions[6]).toMatchObject({ asset: 'ETH', counterAsset: 'BTC' });
  });
});
