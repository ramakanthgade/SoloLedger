import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import type { CsvImportRow, LookupAddressRow } from '@/lib/storage/db';
import {
  buildCards,
  fileImportTitle,
  groupWallets,
  pillCounts,
  relativeTime,
  shortAddress,
  shortFileName,
  walletLane,
  type BuildCardsInput
} from './connectionModel';

/**
 * The unified connection model behind the Connections home — every card
 * field derives from data that actually exists (no invented health scores),
 * and the pill lanes classify honestly.
 */

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

// buildCards derives relative times from Date.now() — pin the clock to NOW
// so the suite is deterministic regardless of when it runs.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function exchangeConn(over: Partial<ExchangeConnectionView> = {}): ExchangeConnectionView {
  return {
    id: 'exc_1',
    exchange: 'binance',
    label: undefined,
    createdAt: NOW,
    lastSyncAt: NOW - 2 * 3_600_000,
    txCount: 1284,
    lastError: null,
    ...over
  };
}

function csvRow(over: Partial<CsvImportRow> = {}): CsvImportRow {
  return {
    id: 'csv_1',
    fileName: 'coindcx-trades-fy25.csv',
    importedAt: NOW - 86_400_000,
    txCount: 412,
    parserId: 'coindcx',
    ...over
  } as CsvImportRow;
}

function walletRow(over: Partial<LookupAddressRow> = {}): LookupAddressRow {
  return {
    id: 'ethereum:0xAAA',
    chain: 'ethereum',
    address: '0xAAA',
    label: undefined,
    lastSyncedAt: NOW - 3_600_000,
    txCount: 100,
    ...over
  } as LookupAddressRow;
}

function input(over: Partial<BuildCardsInput> = {}): BuildCardsInput {
  return {
    connections: [],
    csvImports: [],
    wallets: [],
    manualCount: 0,
    syncingConnectionId: null,
    syncActive: false,
    ...over
  };
}

describe('shortAddress / shortFileName / relativeTime', () => {
  it('truncates long addresses keep-start/keep-end style', () => {
    expect(shortAddress('0x7a3F1234567890abcdef1234567890abcdef4Ef2')).toBe('0x7a3F…4Ef2');
    expect(shortAddress('bc1qxy2k')).toBe('bc1qxy2k'); // short stays whole
  });

  it('truncates long file names, keeps short ones whole', () => {
    const long = 'a'.repeat(50) + '.csv';
    expect(shortFileName(long)).toHaveLength(39); // 28 + ellipsis + 10
    expect(shortFileName('trades.csv')).toBe('trades.csv');
  });

  it('renders plain relative time', () => {
    expect(relativeTime(null, NOW)).toBe('never');
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
    expect(relativeTime(NOW - 30 * 86_400_000, NOW)).toMatch(/\d/); // a date
  });
});

describe('groupWallets', () => {
  it('groups chain rows per unique address (case-insensitive), summing counts and maxing sync time', () => {
    const groups = groupWallets([
      walletRow({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA', txCount: 100, lastSyncedAt: 10 }),
      walletRow({ id: 'polygon:0xaaa', chain: 'polygon', address: '0xaaa', txCount: 5, lastSyncedAt: 20, label: 'Main' }),
      walletRow({ id: 'bitcoin:bc1q', chain: 'bitcoin', address: 'bc1q', txCount: 3, lastSyncedAt: 5 })
    ]);

    expect(groups).toHaveLength(2);
    const evm = groups.find((g) => g.key === '0xaaa')!;
    expect(evm.chains).toEqual(['ethereum', 'polygon']);
    expect(evm.txCount).toBe(105);
    expect(evm.lastSyncedAt).toBe(20);
    expect(evm.label).toBe('Main');
    expect(evm.rows).toHaveLength(2);
  });
});

describe('walletLane', () => {
  const group = (label: string | undefined, chains: string[]) => ({
    key: 'k',
    address: '0xAAA',
    label,
    rows: [],
    chains,
    txCount: 0,
    lastSyncedAt: 0
  });

  it('classifies app-labeled or multi-chain groups as Wallet apps, plain single-chain as Blockchains', () => {
    expect(walletLane(group('MetaMask · Main', ['ethereum']))).toBe('wallets');
    expect(walletLane(group('my ledger nano', ['bitcoin']))).toBe('wallets');
    expect(walletLane(group(undefined, ['ethereum', 'polygon']))).toBe('wallets');
    expect(walletLane(group(undefined, ['bitcoin']))).toBe('chains');
    expect(walletLane(group('Savings', ['bitcoin']))).toBe('chains');
  });
});

describe('fileImportTitle', () => {
  it('prefers the brand label for known parsers, then the import source, then the file name', () => {
    expect(fileImportTitle(csvRow({ parserId: 'wazirx_ledger' }))).toBe('WazirX');
    expect(fileImportTitle(csvRow({ parserId: 'coindcx' }))).toBe('CoinDCX');
    expect(fileImportTitle(csvRow({ parserId: 'mudrex' }))).toBe('Mudrex'); // source, no logo
    expect(fileImportTitle(csvRow({ parserId: 'generic_history', fileName: 'my-export.csv' }))).toBe('my-export.csv');
  });
});

describe('buildCards', () => {
  it('maps an exchange API connection to a Synced card in the exchanges lane', () => {
    const [card] = buildCards(input({ connections: [exchangeConn()] }));
    expect(card).toMatchObject({
      id: 'exchange:exc_1',
      kind: 'exchange-api',
      lane: 'exchanges',
      iconId: 'binance',
      title: 'Binance',
      status: { tone: 'gain', label: 'Synced' },
      metaLine: 'Synced 2h ago',
      txLine: '1,284 transactions'
    });
  });

  it('appends the user label to the exchange card title', () => {
    const [card] = buildCards(input({ connections: [exchangeConn({ label: 'Main' })] }));
    expect(card.title).toBe('Binance · Main');
  });

  it('flags lastError as Needs attention, and Syncing while its job runs', () => {
    const [attention] = buildCards(
      input({ connections: [exchangeConn({ lastError: 'relay_auth' })] })
    );
    expect(attention.status).toEqual({ tone: 'warn', label: 'Needs attention' });
    expect(attention.error).toBe('relay_auth');

    const [syncing] = buildCards(
      input({ connections: [exchangeConn()], syncingConnectionId: 'exc_1', syncActive: true })
    );
    expect(syncing.status).toEqual({ tone: 'primary', label: 'Syncing' });

    // A different connection's job does NOT mark this card syncing.
    const [other] = buildCards(
      input({ connections: [exchangeConn()], syncingConnectionId: 'exc_2', syncActive: true })
    );
    expect(other.status.label).toBe('Synced');
  });

  it('maps a file import to an Imported card titled by brand, sublined by file name', () => {
    const [card] = buildCards(input({ csvImports: [csvRow()] }));
    expect(card).toMatchObject({
      id: 'file:csv_1',
      kind: 'file',
      lane: 'exchanges',
      iconId: 'coindcx',
      title: 'CoinDCX',
      subtitle: 'coindcx-trades-fy25.csv',
      status: { tone: 'primary', label: 'Imported' },
      txLine: '412 transactions'
    });
  });

  it('groups watched addresses into one Watching card per address', () => {
    const cards = buildCards(
      input({
        wallets: [
          walletRow({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA', txCount: 40, label: 'MetaMask · Main' }),
          walletRow({ id: 'polygon:0xaaa', chain: 'polygon', address: '0xaaa', txCount: 7 }),
          walletRow({ id: 'bitcoin:bc1qxy2k', chain: 'bitcoin', address: 'bc1qxy2k', txCount: 3 })
        ]
      })
    );
    expect(cards).toHaveLength(2);

    const app = cards.find((c) => c.lane === 'wallets')!;
    expect(app.title).toBe('MetaMask · Main');
    expect(app.subtitle).toContain('Ethereum');
    expect(app.tags).toContain('2 chains');
    expect(app.status).toEqual({ tone: 'gain', label: 'Watching' });
    expect(app.txLine).toBe('47 transactions');
    expect(app.walletRows).toHaveLength(2);

    const chain = cards.find((c) => c.lane === 'chains')!;
    expect(chain.title).toBe('bc1qxy2k');
    expect(chain.iconId).toBe('bitcoin');
    expect(chain.tags).toEqual(['Blockchain', 'Address']);
  });

  it('adds the manual summary card only when manual transactions exist', () => {
    expect(buildCards(input({ manualCount: 0 }))).toHaveLength(0);
    const [card] = buildCards(input({ manualCount: 3 }));
    expect(card).toMatchObject({
      id: 'manual',
      kind: 'manual',
      lane: 'manual',
      title: 'Manual entry',
      status: { tone: 'neutral', label: 'By hand' },
      txLine: '3 transactions'
    });
  });

  it('singularizes the transaction count', () => {
    const [card] = buildCards(input({ connections: [exchangeConn({ txCount: 1 })] }));
    expect(card.txLine).toBe('1 transaction');
  });
});

describe('pillCounts', () => {
  it('counts cards per lane (All = everything)', () => {
    const cards = buildCards(
      input({
        connections: [exchangeConn()],
        csvImports: [csvRow()],
        wallets: [
          walletRow({ label: 'MetaMask' }),
          walletRow({ id: 'bitcoin:bc1q', chain: 'bitcoin', address: 'bc1q' })
        ],
        manualCount: 2
      })
    );
    expect(pillCounts(cards)).toEqual({ all: 5, exchanges: 2, wallets: 1, chains: 1, manual: 1 });
  });
});
