import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { genericHistoryParser, detectMissingFields } from './genericHistory';
import { parseImportFile } from './index';

const HERE = dirname(fileURLToPath(import.meta.url));

function readFixture(rel: string): string {
  return readFileSync(join(HERE, '__fixtures__', rel), 'utf8');
}

/** The effective header + data rows of the Binance "Deposit History" layout. */
const DEPOSIT_HEADERS = ['Time', 'Coin', 'Network', 'Amount', 'Address', 'TXID', 'Status'];
const DEPOSIT_ROWS: Record<string, string>[] = [
  {
    Time: '2024-03-08 12:48:31',
    Coin: 'USDT',
    Network: 'ETH',
    Amount: '300',
    Address: '0xabc',
    TXID: '0xdef',
    Status: 'Completed'
  },
  {
    Time: '2024-02-25 15:50:02',
    Coin: 'BTC',
    Network: 'BTC',
    Amount: '0.05',
    Address: 'bc1q',
    TXID: '0x123',
    Status: 'Completed'
  }
];

describe('genericHistoryParser — detect()', () => {
  it('detects a deposit-style header set (date + coin + amount)', () => {
    expect(genericHistoryParser.detect(DEPOSIT_HEADERS)).toBe(true);
  });

  it('is false when the amount family is missing', () => {
    expect(genericHistoryParser.detect(['Time', 'Coin', 'Network', 'Status'])).toBe(false);
  });

  it('is false when the asset family is missing', () => {
    expect(genericHistoryParser.detect(['Time', 'Amount', 'Status'])).toBe(false);
  });
});

describe('genericHistoryParser — implied type from report title', () => {
  it('imports deposit rows as transfer_in when impliedType is transfer_in', () => {
    const { transactions, skippedRows } = genericHistoryParser.parse(DEPOSIT_ROWS, {
      impliedType: 'transfer_in',
      sheetTitle: 'Deposit History'
    });
    expect(skippedRows).toBe(0);
    expect(transactions).toHaveLength(2);
    for (const t of transactions) expect(t.type).toBe('transfer_in');

    const usdt = transactions.find((t) => t.asset === 'USDT')!;
    expect(usdt.amount).toBe(300);
    expect(usdt.timestamp).toBe(Date.parse('2024-03-08 12:48:31'));

    const btc = transactions.find((t) => t.asset === 'BTC')!;
    expect(btc.amount).toBe(0.05);
  });

  it('imports rows as transfer_out for a withdrawal title', () => {
    const { transactions } = genericHistoryParser.parse(DEPOSIT_ROWS, {
      impliedType: 'transfer_out',
      sheetTitle: 'Withdrawal History'
    });
    expect(transactions).toHaveLength(2);
    for (const t of transactions) expect(t.type).toBe('transfer_out');
  });

  it('reports missingFields:[type] when there is no type column and no implied type', () => {
    const result = genericHistoryParser.parse(DEPOSIT_ROWS);
    expect(result.transactions).toHaveLength(0);
    expect(result.missingFields).toEqual(['type']);
  });
});

describe('genericHistoryParser — parse() with an explicit type column', () => {
  it('maps deposit/withdrawal values via DEFAULT_TYPE_VALUE_MAP', () => {
    const rows = [
      { Date: '2024-01-01 00:00:00', Asset: 'ETH', Amount: '1', Type: 'deposit' },
      { Date: '2024-01-02 00:00:00', Asset: 'ETH', Amount: '2', Type: 'withdrawal' }
    ];
    const { transactions } = genericHistoryParser.parse(rows);
    expect(transactions.map((t) => t.type).sort()).toEqual(['transfer_in', 'transfer_out']);
  });
});

describe('detectMissingFields', () => {
  it('flags each absent required family', () => {
    expect(detectMissingFields(['Coin', 'Amount'])).toEqual(['timestamp', 'type']);
    expect(detectMissingFields(['Time', 'Amount'])).toEqual(['asset', 'type']);
    expect(detectMissingFields(['Time', 'Coin'])).toEqual(['amount', 'type']);
    // Implied type satisfies the type requirement.
    expect(detectMissingFields(DEPOSIT_HEADERS, { impliedType: 'transfer_in' })).toEqual([]);
    // No implied type + no type column → type is missing.
    expect(detectMissingFields(DEPOSIT_HEADERS)).toEqual(['type']);
  });
});

describe('parseImportFile — full extract→detect→parse on a Binance deposit layout', () => {
  it('imports the deposit history file as transfer_in with no key', async () => {
    const csv = readFixture('genericHistory/binance-deposit.csv');
    const file = new File([csv], 'binance-deposit.csv', { type: 'text/csv' });
    const outcome = await parseImportFile(file);

    expect(outcome.detectedParser).toBe('generic_history');
    expect(outcome.transactions.length).toBeGreaterThan(0);
    for (const t of outcome.transactions) expect(t.type).toBe('transfer_in');

    const assets = outcome.transactions.map((t) => t.asset).sort();
    expect(assets).toEqual(['BTC', 'USDC', 'USDT']);
  });
});

describe('parser specificity — a specific parser still wins over generic_history', () => {
  it('routes a Hyperliquid deposit header set to the hyperliquid parser', async () => {
    const csv = [
      'time,action,source,destination,accountValueChange,fee',
      '07/06/2026 - 00:26:56,deposit,arbitrum,trading,1989.8 USDC,0.2 USDC'
    ].join('\n');
    const file = new File([csv], 'hl.csv', { type: 'text/csv' });
    const outcome = await parseImportFile(file);
    expect(outcome.detectedParser).toBe('hyperliquid_deposits');
    expect(outcome.detectedParser).not.toBe('generic_history');
  });
});
