import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import type { CsvImportRow, LookupAddressRow } from '@/lib/storage/db';
import {
  buildCards,
  exchangeCoverageChip,
  fileImportExchangeId,
  fileImportTitle,
  groupWallets,
  pillCounts,
  relativeTime,
  shortAddress,
  shortFileName,
  walletChainChip,
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
    credentialsState: 'ready',
    // Full data-range coverage by default — the coverage chip is opt-out at 100%.
    cursors: { trades: NOW - 3_600_000, deposits: NOW - 3_600_000, withdrawals: NOW - 3_600_000 },
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
    const evm = groups.find((g) => g.key === 'evm:0xaaa')!;
    expect(evm.chains).toEqual(['ethereum', 'polygon']);
    expect(evm.txCount).toBe(105);
    expect(evm.lastSyncedAt).toBe(20);
    expect(evm.label).toBe('Main');
    expect(evm.rows).toHaveLength(2);
  });

  it('keeps case-distinct Base58 addresses as separate exact wallet groups', () => {
    const groups = groupWallets([
      walletRow({ id: 'solana:Base58Case', chain: 'solana', address: 'Base58Case', label: 'Upper' }),
      walletRow({ id: 'solana:base58Case', chain: 'solana', address: 'base58Case', label: 'Lower' })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.address).sort()).toEqual(['Base58Case', 'base58Case']);
    expect(groups.every((group) => group.rows.length === 1 && group.chains.length === 1)).toBe(true);
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

  it('matches catalog names and aliases on word boundaries (no substring false positives)', () => {
    // Short names must not match inside longer words.
    expect(walletLane(group('PancakeSwap LP', ['bsc']))).toBe('chains');
    expect(walletLane(group('my Cake Wallet', ['bitcoin']))).toBe('wallets');
    // Aliases cover what users actually type.
    expect(walletLane(group('MEW vault', ['ethereum']))).toBe('wallets');
    expect(walletLane(group('Coinbase Wallet', ['ethereum']))).toBe('wallets');
    expect(walletLane(group('my xumm', ['xrpl']))).toBe('wallets');
  });
});

describe('fileImportTitle', () => {
  it('prefers the brand label for known parsers, then the import source, then the file name', () => {
    expect(fileImportTitle(csvRow({ parserId: 'wazirx_ledger' }))).toBe('WazirX');
    expect(fileImportTitle(csvRow({ parserId: 'coindcx' }))).toBe('CoinDCX');
    expect(fileImportTitle(csvRow({ parserId: 'mudrex' }))).toBe('Mudrex'); // source, no logo
    expect(fileImportTitle(csvRow({ parserId: 'binance_options' }))).toBe('Binance Options');
    expect(fileImportTitle(csvRow({ parserId: 'generic_history', fileName: 'my-export.csv' }))).toBe('my-export.csv');
  });
});

describe('fileImportExchangeId', () => {
  it('normalizes parser variants without inferring identity from the filename', () => {
    expect(fileImportExchangeId(csvRow({ parserId: 'binance_spot' }))).toBe('binance');
    expect(fileImportExchangeId(csvRow({ parserId: 'coinbase' }))).toBe('coinbase');
    expect(fileImportExchangeId(csvRow({ parserId: 'generic_history', fileName: 'binance.csv' }))).toBeNull();
    expect(fileImportExchangeId(csvRow({ parserId: null, fileName: 'binance.csv' }))).toBeNull();
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

  it('maps required reauthorization to a clear paused state instead of an ordinary sync state', () => {
    const [card] = buildCards(
      input({
        connections: [
          exchangeConn({
            credentialsState: 'reauthorization_required',
            lastError: 'stale internal error',
            cursors: { trades: NOW }
          })
        ],
        syncingConnectionId: 'exc_1',
        syncActive: true
      })
    );

    expect(card).toMatchObject({
      status: { tone: 'warn', label: 'Reauthorization required' },
      metaLine: 'Sync paused',
      error: 'Reconnect Binance with a new read-only API key to resume syncing.',
      requiresReauthorization: true
    });
    expect(card.syncChip).toBeUndefined();
  });

  it('maps a file import to a CSV imported card titled by brand, sublined by file name', () => {
    const [card] = buildCards(input({ csvImports: [csvRow()] }));
    expect(card).toMatchObject({
      id: 'file:csv_1',
      kind: 'file',
      lane: 'exchanges',
      iconId: 'coindcx',
      title: 'CoinDCX',
      subtitle: 'coindcx-trades-fy25.csv',
      status: { tone: 'primary', label: 'CSV imported' },
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

  it('says "Not synced yet" (never an epoch date) for a wallet that has never synced', () => {
    const [card] = buildCards(
      input({ wallets: [walletRow({ id: 'ethereum:0xAAA', chain: 'ethereum', address: '0xAAA', lastSyncedAt: 0 })] })
    );
    expect(card.metaLine).toBe('Not synced yet');
    expect(card.syncChip).toBeUndefined();
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

/**
 * Item 8 — "% Synced" chips. Honest sync-completeness derived from ACTUAL
 * state only: exchange per-kind cursors (written only after a successful
 * save) and per-chain wallet sync timestamps. 100% → no chip (the green
 * Synced/Watching state already says it).
 */
describe('exchangeCoverageChip', () => {
  it('is undefined at full coverage (keeps the green Synced state)', () => {
    expect(exchangeCoverageChip(exchangeConn())).toBeUndefined();
  });

  it('names covered ✓ and uncovered — ranges from the persisted cursors', () => {
    expect(
      exchangeCoverageChip(exchangeConn({ cursors: { trades: NOW, deposits: NOW } }))
    ).toBe('Trades ✓ · Deposits ✓ · Withdrawals —');
    expect(exchangeCoverageChip(exchangeConn({ cursors: { trades: NOW } }))).toBe(
      'Trades ✓ · Deposits — · Withdrawals —'
    );
    expect(exchangeCoverageChip(exchangeConn({ cursors: {} }))).toBe(
      'Trades — · Deposits — · Withdrawals —'
    );
    // A missing cursors field (legacy view) reads as "no ranges on record".
    expect(exchangeCoverageChip(exchangeConn({ cursors: undefined }))).toBe(
      'Trades — · Deposits — · Withdrawals —'
    );
  });

  it('is undefined before the first sync (the meta line already says "Not synced yet")', () => {
    expect(exchangeCoverageChip(exchangeConn({ lastSyncAt: null, cursors: {} }))).toBeUndefined();
  });
});

describe('walletChainChip', () => {
  const group = (stamps: number[]) => {
    const chains = ['ethereum', 'polygon', 'base'];
    const rows = stamps.map((lastSyncedAt, i) =>
      walletRow({ id: `${chains[i]}:0xAAA`, chain: chains[i], lastSyncedAt })
    );
    const [g] = groupWallets(rows);
    return g;
  };

  it('is undefined when every enabled chain has a completed sync', () => {
    expect(walletChainChip(group([10, 20]))).toBeUndefined();
    expect(walletChainChip(group([10]))).toBeUndefined();
  });

  it('reports chains fully synced ÷ chains enabled with a rounded percent', () => {
    expect(walletChainChip(group([10, 20, 0]))).toBe('2/3 chains · 67%');
    expect(walletChainChip(group([0, 20]))).toBe('1/2 chains · 50%');
  });

  it('is undefined when no chain has ever synced (the meta line already says "Not synced yet")', () => {
    expect(walletChainChip(group([0]))).toBeUndefined();
    expect(walletChainChip(group([0, 0]))).toBeUndefined();
  });
});

describe('buildCards — sync chips', () => {
  it('attaches the exchange coverage chip only when coverage is partial', () => {
    const [full] = buildCards(input({ connections: [exchangeConn()] }));
    expect(full.syncChip).toBeUndefined();

    const [partial] = buildCards(
      input({ connections: [exchangeConn({ cursors: { trades: NOW, deposits: NOW } })] })
    );
    expect(partial.syncChip).toBe('Trades ✓ · Deposits ✓ · Withdrawals —');
  });

  it('attaches the wallet chain chip only when some enabled chain lacks a sync', () => {
    const [synced] = buildCards(
      input({
        wallets: [
          walletRow({ id: 'ethereum:0xAAA', chain: 'ethereum', lastSyncedAt: 10 }),
          walletRow({ id: 'polygon:0xaaa', chain: 'polygon', lastSyncedAt: 20 })
        ]
      })
    );
    expect(synced.syncChip).toBeUndefined();

    const [partial] = buildCards(
      input({
        wallets: [
          walletRow({ id: 'ethereum:0xAAA', chain: 'ethereum', lastSyncedAt: 10 }),
          walletRow({ id: 'polygon:0xaaa', chain: 'polygon', lastSyncedAt: 20 }),
          walletRow({ id: 'bsc:0xAAA', chain: 'bsc', lastSyncedAt: 0 })
        ]
      })
    );
    expect(partial.syncChip).toBe('2/3 chains · 67%');
  });

  it('file imports and the manual card never carry a sync chip', () => {
    const [file] = buildCards(input({ csvImports: [csvRow()] }));
    expect(file.syncChip).toBeUndefined();
    const [manual] = buildCards(input({ manualCount: 2 }));
    expect(manual.syncChip).toBeUndefined();
  });
});
