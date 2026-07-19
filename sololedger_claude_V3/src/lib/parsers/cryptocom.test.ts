import { describe, expect, it } from 'vitest';
import { cryptocomParser } from './cryptocom';

// Real Crypto.com app export header names — guards against format drift.
const headers = ['Timestamp (UTC)', 'Transaction Description', 'Currency', 'Amount', 'To Currency', 'To Amount', 'Native Currency', 'Native Amount', 'Native Amount (in USD)', 'Transaction Kind', 'Transaction Hash'];
const row = (kind: string) => ({
  'Timestamp (UTC)': '2025-02-01 10:00:00',
  'Transaction Description': 'Exchange ETH for BTC',
  Currency: 'ETH',
  Amount: '-1.25',
  'To Currency': '',
  'To Amount': '',
  'Native Currency': 'USD',
  'Native Amount': '-3000',
  'Native Amount (in USD)': '-3000',
  'Transaction Kind': kind,
  'Transaction Hash': `hash-${kind}`
});

describe('cryptocomParser', () => {
  it('detects the real export header shape', () => {
    expect(cryptocomParser.detect(headers)).toBe(true);
    expect(cryptocomParser.detect(['timestamp', 'currency', 'amount'])).toBe(false);
  });
  it('maps deposits, withdrawals, purchases, sales, exchanges and income', () => {
    const kinds = ['crypto_deposit', 'crypto_withdrawal', 'crypto_purchase', 'crypto_sale', 'staking_reward', 'crypto_earn_interest', 'crypto_exchange'];
    const result = cryptocomParser.parse(kinds.map(row));
    expect(result.transactions.map((t) => t.type)).toEqual(['transfer_in', 'transfer_out', 'buy', 'sell', 'income', 'income', 'trade']);
    expect(result.transactions[0]).toMatchObject({ amount: 1.25, fiatCurrency: 'USD', fiatValue: 3000, sourceRef: 'hash-crypto_deposit' });
    expect(result.transactions[6]).toMatchObject({ asset: 'ETH', counterAsset: 'BTC', notes: 'Exchange ETH for BTC' });
  });
  it('parses "Timestamp (UTC)" values as UTC, not local time', () => {
    const result = cryptocomParser.parse([{ ...row('crypto_deposit'), 'Timestamp (UTC)': '2024-06-15 14:30:00' }]);
    expect(result.transactions).toHaveLength(1);
    // Fails under local-time parsing — must be the exact UTC epoch.
    expect(result.transactions[0].timestamp).toBe(Date.UTC(2024, 5, 15, 14, 30, 0));
  });
});
