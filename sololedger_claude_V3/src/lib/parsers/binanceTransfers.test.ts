import { describe, it, expect } from 'vitest';
import { binanceTransfersParser } from './binanceTransfers';
import { PARSERS } from './index';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('Binance Deposit & Withdrawal History parser', () => {
  it('matches the golden deposit fixture (pending row skipped)', () => {
    const rows = loadFixtureRows('binanceTransfers/deposit-history.csv');
    const { transactions, skippedRows, warnings } = binanceTransfersParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('binanceTransfers/deposit-history.expected.json')
    );
    // The "Pending" BTC deposit is not settled and must be skipped.
    expect(skippedRows).toBe(1);
    expect(warnings.join(' ')).toMatch(/status not completed/i);
  });

  it('matches the golden withdrawal fixture (failed row skipped, fee captured)', () => {
    const rows = loadFixtureRows('binanceTransfers/withdrawal-history.csv');
    const { transactions, skippedRows } = binanceTransfersParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('binanceTransfers/withdrawal-history.expected.json')
    );
    expect(skippedRows).toBe(1);
    // Withdrawal network fee is charged in the withdrawn coin.
    const btc = transactions.find((t) => t.asset === 'BTC')!;
    expect(btc.feeAmount).toBe(0.0005);
    expect(btc.feeAsset).toBe('BTC');
    // Destination address is the counterparty for a withdrawal.
    expect(btc.counterpartyAddress).toMatch(/^bc1/);
  });

  it('parses Date(UTC) as UTC regardless of machine timezone', () => {
    const rows = loadFixtureRows('binanceTransfers/deposit-history.csv');
    const { transactions } = binanceTransfersParser.parse(rows);
    const eth = transactions.find((t) => t.asset === 'ETH')!;
    expect(eth.timestamp).toBe(Date.UTC(2025, 2, 12, 14, 30, 0));
  });

  it('reads DD-MM-YYYY exports as day-first UTC, not V8’s MM-DD-YYYY local parse', () => {
    // Regression: `Date.parse('01-02-2026 10:00:00')` succeeds in V8 as
    // MM-DD-YYYY LOCAL time — the DD-MM-YYYY branch must win first, or
    // day/month swap (days 1–12) and the anchor leaves UTC.
    const { transactions } = binanceTransfersParser.parse([
      {
        'Date(UTC)': '01-02-2026 10:00:00',
        Coin: 'USDT',
        Network: 'TRX',
        Amount: '500',
        TXID: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        Status: 'Completed'
      }
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].timestamp).toBe(Date.UTC(2026, 1, 1, 10, 0, 0));
  });

  it('detects the deposit-only and withdrawal-only header shapes', () => {
    expect(
      binanceTransfersParser.detect(['Date(UTC)', 'Coin', 'Network', 'Amount', 'TXID', 'Status'])
    ).toBe(true);
    expect(
      binanceTransfersParser.detect([
        'Date(UTC)',
        'Coin',
        'Network',
        'Amount',
        'Fee',
        'Address',
        'TXID',
        'Status'
      ])
    ).toBe(true);
  });

  it('detects header variants: Date without (UTC) and Transaction ID instead of TXID', () => {
    expect(
      binanceTransfersParser.detect(['Date', 'Coin', 'Network', 'Amount', 'Transaction ID', 'Status'])
    ).toBe(true);
    expect(
      binanceTransfersParser.detect(['Time', 'Coin', 'Network', 'Amount', 'TxID'])
    ).toBe(true);
  });

  it('does not claim Binance full-ledger or spot trade-history headers', () => {
    // Full ledger ("Transaction History") — owned by binanceParser.
    expect(
      binanceTransfersParser.detect(['UTC_Time', 'Account', 'Operation', 'Coin', 'Change', 'Remark'])
    ).toBe(false);
    // Spot trade history — owned by binanceSpotParser.
    expect(
      binanceTransfersParser.detect(['Date(UTC)', 'Pair', 'Side', 'Price', 'Executed', 'Amount', 'Fee', 'Fee Coin'])
    ).toBe(false);
  });

  it('infers withdrawal from the Fee column shape and deposit otherwise', () => {
    const withdrawal = binanceTransfersParser.parse([
      {
        'Date(UTC)': '2025-04-01 10:00:00',
        Coin: 'BTC',
        Network: 'BTC',
        Amount: '0.25',
        Fee: '0.0005',
        Address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        TXID: '3333333333333333333333333333333333333333333333333333333333333333',
        Status: 'Completed'
      }
    ]);
    expect(withdrawal.transactions[0].type).toBe('transfer_out');

    const deposit = binanceTransfersParser.parse([
      {
        'Date(UTC)': '2025-03-10 08:15:00',
        Coin: 'USDT',
        Network: 'TRX',
        Amount: '500',
        TXID: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        Status: 'Completed'
      }
    ]);
    expect(deposit.transactions[0].type).toBe('transfer_in');
  });

  it('honours a per-row Type column in combined exports (overrides column shape)', () => {
    const rows = [
      {
        'Date(UTC)': '2025-05-05 09:00:00',
        Type: 'Deposit',
        Coin: 'ETH',
        Network: 'ETH',
        Amount: '1',
        Fee: '0',
        Address: '0xabc',
        TXID: '0x6666666666666666666666666666666666666666666666666666666666666666',
        Status: 'Completed'
      },
      {
        'Date(UTC)': '2025-05-06 10:00:00',
        Type: 'Withdrawal',
        Coin: 'ETH',
        Network: 'ETH',
        Amount: '0.5',
        Fee: '0.001',
        Address: '0xdef',
        TXID: '0x7777777777777777777777777777777777777777777777777777777777777777',
        Status: 'Completed'
      }
    ];
    const { transactions } = binanceTransfersParser.parse(rows);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].type).toBe('transfer_in');
    expect(transactions[1].type).toBe('transfer_out');
  });

  it('honours the report-title implied type from SheetContext', () => {
    const rows = [
      {
        'Date(UTC)': '2025-03-10 08:15:00',
        Coin: 'USDT',
        Network: 'TRX',
        Amount: '500',
        TXID: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        Status: 'Completed'
      }
    ];
    const { transactions } = binanceTransfersParser.parse(rows, {
      impliedType: 'transfer_in',
      sheetTitle: 'Deposit History'
    });
    expect(transactions[0].type).toBe('transfer_in');
  });

  it('keeps only chain-shaped real tx hashes (TRX row has no linkable hash)', () => {
    const rows = loadFixtureRows('binanceTransfers/deposit-history.csv');
    const { transactions } = binanceTransfersParser.parse(rows);
    const trx = transactions.find((t) => t.asset === 'USDT')!;
    // Tron is not a chain the app can link an explorer for → no chain/txHash.
    expect(trx.chain).toBeUndefined();
    expect(trx.txHash).toBeUndefined();
  });

  it('produces a stable dedup sourceRef across re-imports', () => {
    const rows = loadFixtureRows('binanceTransfers/withdrawal-history.csv');
    const first = binanceTransfersParser.parse(rows).transactions.map((t) => t.sourceRef);
    const second = binanceTransfersParser.parse(rows).transactions.map((t) => t.sourceRef);
    expect(first).toEqual(second);
  });

  it('wins registry detection for its own files; full ledger still goes to binanceParser', () => {
    const depositHeaders = ['Date(UTC)', 'Coin', 'Network', 'Amount', 'TXID', 'Status'];
    const winner = PARSERS.find((p) => p.detect(depositHeaders));
    expect(winner?.id).toBe('binance_transfers');

    const ledgerHeaders = ['UTC_Time', 'Account', 'Operation', 'Coin', 'Change', 'Remark'];
    const ledgerWinner = PARSERS.find((p) => p.detect(ledgerHeaders));
    expect(ledgerWinner?.id).toBe('binance');

    const spotHeaders = ['Date(UTC)', 'Pair', 'Side', 'Price', 'Executed', 'Amount', 'Fee', 'Fee Coin'];
    const spotWinner = PARSERS.find((p) => p.detect(spotHeaders));
    expect(spotWinner?.id).toBe('binance_spot');
  });
});
