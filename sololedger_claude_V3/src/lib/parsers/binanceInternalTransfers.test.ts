/**
 * Intra-account exchange transfers ("Transfer Between …", "Inter-Wallet
 * Transfer") are internal with 100% certainty — Binance only emits these for
 * moves between accounts inside the SAME account, no external counterparty is
 * possible. The stitcher must auto-confirm them (isInternalTransfer: true, no
 * possible_internal_transfer flag) so they net to zero without a manual Review
 * step. External Deposit/Withdraw must remain review-needed.
 */
import { describe, expect, it } from 'vitest';
import { stitchBinanceTransactionHistory } from './binanceStitch';

function row(op: string, coin: string, change: string, time = '2022-11-08 23:41:58', account = 'Spot') {
  return { 'User ID': '1', Time: time, Account: account, Operation: op, Coin: coin, Change: change, Remark: '' };
}

describe('Intra-account transfers — auto-confirmed internal', () => {
  it('"Transfer Between Spot and Funding" auto-marks internal, no review flag', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Transfer Between Spot and Funding', 'USDT', '-5000', '2022-11-08 23:41:58', 'Spot'),
      row('Transfer Between Spot and Funding', 'USDT', '5000', '2022-11-08 23:41:58', 'Funding')
    ]);
    expect(transactions).toHaveLength(2);
    const tout = transactions.find((t) => t.type === 'transfer_out')!;
    const tin = transactions.find((t) => t.type === 'transfer_in')!;
    for (const t of [tout, tin]) {
      expect(t.isInternalTransfer).toBe(true);
      expect(t.flags).not.toContain('possible_internal_transfer');
    }
    // Net to zero across the two account legs.
    expect(tin.amount).toBe(5000);
    expect(tout.amount).toBe(5000);
  });

  it('"Inter-Wallet Transfer" is also intra-account → auto-internal', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Inter-Wallet Transfer', 'BUSD', '-30000', '2022-11-08 23:57:35', 'Cross Margin'),
      row('Inter-Wallet Transfer', 'BUSD', '30000', '2022-11-08 23:57:35', 'Spot')
    ]);
    expect(transactions).toHaveLength(2);
    expect(transactions.every((t) => t.isInternalTransfer)).toBe(true);
    expect(transactions.every((t) => !t.flags.includes('possible_internal_transfer'))).toBe(true);
  });

  it('Binance Pay Transfer rows are external custody changes, not account shuffles', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      { ...row('Transfer', 'BUSD', '-5700'), Remark: 'Binance Pay - P_A17W2GBS5JW71113' },
      { ...row('Transfer', 'USDT', '101'), Remark: 'Binance Pay - P_A1CRZJTB1J171115' }
    ]);
    expect(transactions).toHaveLength(2);
    expect(transactions.map((t) => t.type).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(transactions.every((t) => !t.isInternalTransfer)).toBe(true);
    expect(transactions.every((t) => t.flags.includes('possible_internal_transfer'))).toBe(true);
  });

  it('incomplete Options history excludes the unsupported Options leg and warns explicitly', () => {
    const { transactions, warnings, balanceSnapshot, optionsBalanceUnavailable } = stitchBinanceTransactionHistory([
      row('Transfer Between Spot and Options', 'USDT', '-3000', '2023-03-22 17:48:18', 'Spot'),
      row('Transfer Between Spot and Options', 'USDT', '3000', '2023-03-22 17:48:19', 'Options')
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      type: 'transfer_out', asset: 'USDT', amount: 3000, isInternalTransfer: true
    });
    expect(transactions[0].notes).toContain('Options history unavailable');
    expect(warnings).toContainEqual(expect.stringContaining('Options account movement'));
    expect(warnings).toContainEqual(expect.stringContaining('exchange balance sync or current balance entry'));
    expect(balanceSnapshot).toEqual({ USDT: -3000 });
    expect(optionsBalanceUnavailable).toBe(true);
  });

  it('external Deposit/Withdraw stay review-needed (possible_internal_transfer)', () => {
    const { transactions } = stitchBinanceTransactionHistory([
      row('Deposit', 'BTC', '0.5', '2023-01-01 00:00:00', 'Spot'),
      row('Withdraw', 'BTC', '-0.25', '2023-01-02 00:00:00', 'Spot')
    ]);
    const dep = transactions.find((t) => t.type === 'transfer_in')!;
    const wd = transactions.find((t) => t.type === 'transfer_out')!;
    // Ledger can't tell own-wallet from third-party here → user must confirm.
    expect(dep.isInternalTransfer).toBe(false);
    expect(dep.flags).toContain('possible_internal_transfer');
    expect(wd.isInternalTransfer).toBe(false);
    expect(wd.flags).toContain('possible_internal_transfer');
  });
});
