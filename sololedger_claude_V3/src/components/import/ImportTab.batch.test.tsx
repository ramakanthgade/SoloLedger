import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Transaction } from '@/types/transaction';

/**
 * F4/F6/F8 — ImportTab multi-file batch handling.
 *
 * F4: the browse input must accept MULTIPLE files and route them all through
 *     the sequential batch path (multi-select silently dropped all but the
 *     first before).
 * F6: a file that throws mid-batch (e.g. a corrupt workbook) must be counted
 *     and skipped, not strand the remaining files with an unhandled rejection.
 * F8: the "N need column mapping — shown below" batch note is only accurate
 *     when the LAST processed file is the one awaiting mapping; otherwise the
 *     per-file mapping UI was reset by the later file and the note must say so.
 */

const mocks = vi.hoisted(() => ({
  parseImportFile: vi.fn(),
  hashFileContent: vi.fn(),
  csvImportsGet: vi.fn(async () => undefined),
  getCsvImports: vi.fn(async () => []),
  bulkPut: vi.fn(async () => undefined),
  upsertCsvImport: vi.fn(async () => undefined),
  countCsvImportTransactions: vi.fn(async (_hash: string) => 1),
  deduplicateTransactions: vi.fn(async () => 0),
  getSettings: vi.fn(async () => ({ reportingCurrency: 'USD' })),
  convertOrNormalizeForImport: vi.fn(async (txs: Transaction[]) => ({
    transactions: txs,
    converted: 0,
    failed: 0
  })),
  fetchMissingPrices: vi.fn(async () => ({ updated: 0, failed: 0 })),
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  isAiMappingAvailable: vi.fn(async () => false),
  confirmSheetOrientations: vi.fn(async (_sheets: unknown, txs: Transaction[]) => txs)
}));

vi.mock('dexie-react-hooks', () => ({
  // transactionCount 1 (dropzone rendered — these tests drop files on it), csvImports [].
  useLiveQuery: (query: () => unknown) =>
    String(query).includes('transactions.count') ? 1 : []
}));

vi.mock('@/lib/parsers', () => ({
  parseImportFile: mocks.parseImportFile,
  isSpreadsheetFile: () => false
}));

vi.mock('@/lib/parsers/generic', () => ({ parseWithMapping: vi.fn() }));

vi.mock('@/lib/parsers/addressOrientation', () => ({
  confirmSheetOrientations: mocks.confirmSheetOrientations,
  confirmAddressOrientation: vi.fn(async (txs: Transaction[]) => txs)
}));

vi.mock('@/lib/ai/csvMapping', () => ({ suggestCsvMappingWithAi: vi.fn() }));

vi.mock('@/lib/storage/db', () => ({
  db: {
    csvImports: { get: mocks.csvImportsGet },
    transactions: { bulkPut: mocks.bulkPut }
  },
  getCsvImports: mocks.getCsvImports,
  getSettings: mocks.getSettings,
  hashFileContent: mocks.hashFileContent,
  upsertCsvImport: mocks.upsertCsvImport,
  deleteCsvImportAndTransactions: vi.fn(async () => undefined),
  countCsvImportTransactions: mocks.countCsvImportTransactions,
  deduplicateTransactions: mocks.deduplicateTransactions
}));

vi.mock('@/lib/pricing/fiatConvert', () => ({
  convertOrNormalizeForImport: mocks.convertOrNormalizeForImport
}));

vi.mock('@/lib/pricing/autoFetch', () => ({
  fetchMissingPricesForAllTransactions: mocks.fetchMissingPrices
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: mocks.getEffectiveSettings,
  isAiMappingAvailable: mocks.isAiMappingAvailable
}));

vi.mock('@/lib/parsers/types', () => ({
  normalizeFiatMagnitude: (v: unknown) => v
}));

// Heavy sub-panels stubbed — this is a focused batch-flow test.
vi.mock('./ConnectionWizard', () => ({ ConnectionWizard: () => null }));
vi.mock('./ManualEntryForm', () => ({ ManualEntryForm: () => null }));
vi.mock('./WalletLookupPanel', () => ({ WalletLookupPanel: () => null }));
vi.mock('./ColumnMappingForm', () => ({
  ColumnMappingForm: () => <div data-testid="panel-mapping">Mapping</div>
}));

import { ImportTab } from './ImportTab';

function makeTx(id: string): Transaction {
  return {
    id,
    timestamp: Date.UTC(2026, 0, 15, 10, 0, 0),
    type: 'buy',
    asset: 'BTC',
    amount: 1,
    fiatValue: 100,
    fiatCurrency: 'USD',
    source: 'test_parser'
  } as Transaction;
}

/** A File whose .text() works regardless of jsdom Blob support. */
function makeFile(name: string, content: string): File {
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => content });
  return file;
}

/** Parse outcome for a recognized file yielding `count` transactions. */
function recognized(count: number, name: string) {
  return {
    transactions: Array.from({ length: count }, (_, i) => makeTx(`${name}#${i}`)),
    detectedParser: 'test_parser',
    warnings: [],
    skippedRows: 0,
    sheets: [],
    rows: [],
    headers: [],
    missingFields: []
  };
}

/** Parse outcome for an unrecognized file → manual column mapping. */
function unrecognized() {
  return {
    transactions: [],
    detectedParser: null,
    warnings: [],
    skippedRows: 0,
    sheets: [],
    rows: [{ A: '1' }],
    headers: ['A'],
    missingFields: ['timestamp']
  };
}

function getDropzone() {
  return screen.getByText(/Drop a CSV or Excel/).closest('div')!;
}

/** Post-dedup rows surviving per import hash — mirrors countCsvImportTransactions. */
let savedCounts: Record<string, number> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedCounts = {};
  mocks.hashFileContent.mockImplementation(async (input: unknown) => `hash:${String(input)}`);
  mocks.countCsvImportTransactions.mockImplementation(
    async (hash: string) => savedCounts[hash] ?? 1
  );
  // Pricing defaults: disabled, and a no-op when enabled — individual tests
  // opt in explicitly. clearAllMocks keeps implementations, so reset here.
  mocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: false });
  mocks.fetchMissingPrices.mockResolvedValue({ updated: 0, failed: 0 });
  mocks.convertOrNormalizeForImport.mockImplementation(async (txs: Transaction[]) => ({
    transactions: txs,
    converted: 0,
    failed: 0
  }));
});

describe('ImportTab — multi-file batch handling', () => {
  it('F4: the browse input accepts multiple files and imports them all', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      recognized(file.name === 'one.csv' ? 1 : 2, file.name)
    );
    savedCounts = { 'hash:aaa': 1, 'hash:bbb': 2 };
    const { container } = render(<ImportTab />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);

    fireEvent.change(input, {
      target: { files: [makeFile('one.csv', 'aaa'), makeFile('two.csv', 'bbb')] }
    });

    await screen.findByText(/2 of 2 files imported \(3 transactions\)/);
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(2);
    expect(mocks.bulkPut).toHaveBeenCalledTimes(2);
    await screen.findByText(/Saved 3 transactions to your local database/);
  });

  it('F6: a file that throws mid-batch is counted and the rest still import', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) => {
      if (file.name === 'corrupt.csv') throw new Error('not a workbook');
      return recognized(2, file.name);
    });
    savedCounts = { 'hash:aaa': 2 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('corrupt.csv', 'xxx'), makeFile('good.csv', 'aaa')] }
    });

    await screen.findByText(
      /1 of 2 files imported \(2 transactions\) · 1 could not be read — skipped/
    );
    expect(mocks.bulkPut).toHaveBeenCalledTimes(1); // only the good file
    await screen.findByText(/Saved 2 transactions to your local database/);
  });

  it('F6: a single corrupt file reports the failure instead of an unhandled rejection', async () => {
    mocks.parseImportFile.mockRejectedValue(new Error('not a workbook'));
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('corrupt.csv', 'xxx')] } });

    await screen.findByText(/"corrupt\.csv" could not be read — the file may be corrupt/);
    expect(mocks.bulkPut).not.toHaveBeenCalled();
  });

  it('F8: mapping note points at the form only when the manual file is LAST in the batch', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      file.name === 'mystery.csv' ? unrecognized() : recognized(1, file.name)
    );
    render(<ImportTab />);

    // Manual file LAST → the mapping form survives; the note points below.
    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('good.csv', 'aaa'), makeFile('mystery.csv', 'mmm')] }
    });
    await screen.findByText(/1 needs column mapping — shown below/);
    expect(screen.getByTestId('panel-mapping')).toBeInTheDocument();
  });

  it('F8: mapping note says re-drop when a LATER file reset the mapping UI', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      file.name === 'mystery.csv' ? unrecognized() : recognized(1, file.name)
    );
    render(<ImportTab />);

    // Manual file FIRST → the later file's handleFile reset the outcome, so
    // "shown below" would point at nothing.
    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('mystery.csv', 'mmm'), makeFile('good.csv', 'aaa')] }
    });
    await screen.findByText(/1 needs column mapping — re-drop that file on its own to map it/);
    expect(screen.queryByTestId('panel-mapping')).not.toBeInTheDocument();
  });

  it('dedup: a single file whose rows all dedupe away must NOT claim them saved', async () => {
    // Overlapping re-export: different bytes (new hash) but every row already
    // in the ledger. The banner must tell the truth: nothing new was saved.
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(2, file.name));
    savedCounts = { 'hash:aaa': 0 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('reexport.csv', 'aaa')] } });

    await screen.findByText(/No new transactions — everything in that file was already in your ledger/);
    expect(screen.queryByText(/Saved \d+ transaction/)).not.toBeInTheDocument();
  });

  it('dedup: a fully-deduped file in a batch is bucketed as no-new-rows, not imported', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(2, file.name));
    savedCounts = { 'hash:aaa': 2, 'hash:bbb': 0 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('new.csv', 'aaa'), makeFile('reexport.csv', 'bbb')] }
    });

    await screen.findByText(
      /1 of 2 files imported \(2 transactions\) · 1 had no new rows — everything already in your ledger/
    );
    await screen.findByText(/Saved 2 transactions to your local database/);
  });

  it('Item 4: a mixed CSV + XLSX batch imports every file', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      recognized(file.name === 'trades.xlsx' ? 3 : 2, file.name)
    );
    savedCounts = { 'hash:aaa': 2, 'hash:bbb': 3 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('deposits.csv', 'aaa'), makeFile('trades.xlsx', 'bbb')] }
    });

    await screen.findByText(/2 of 2 files imported \(5 transactions\)/);
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(2);
    expect(mocks.bulkPut).toHaveBeenCalledTimes(2);
    await screen.findByText(/Saved 5 transactions to your local database/);
  });

  it('Item 5: a multi-file batch shows ONE aggregated price message with the summed count', async () => {
    // Live pricing on; each file's persist pass prices its rows. Without
    // aggregation only the LAST file's note (73) would survive.
    mocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: true });
    mocks.fetchMissingPrices
      .mockResolvedValueOnce({ updated: 50, failed: 0 })
      .mockResolvedValueOnce({ updated: 73, failed: 0 });
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(2, file.name));
    savedCounts = { 'hash:aaa': 2, 'hash:bbb': 2 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('a.csv', 'aaa'), makeFile('b.csv', 'bbb')] }
    });

    await screen.findByText(/Fetched prices for 123 transactions\./);
    // Exactly one price note — the aggregated one, never a per-file one.
    expect(screen.getAllByText(/Fetched prices for \d+ transactions?\./)).toHaveLength(1);
    expect(screen.queryByText(/Fetched prices for 73 transactions\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fetched prices for 50 transactions\./)).not.toBeInTheDocument();
  });

  it('Item 5: a multi-file batch aggregates conversion notes too', async () => {
    mocks.convertOrNormalizeForImport.mockImplementation(async (txs: Transaction[]) => ({
      transactions: txs,
      converted: 2,
      failed: 0
    }));
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(1, file.name));
    savedCounts = { 'hash:aaa': 1, 'hash:bbb': 1 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), {
      dataTransfer: { files: [makeFile('a.csv', 'aaa'), makeFile('b.csv', 'bbb')] }
    });

    await screen.findByText(/Converted 4 values to USD using historical exchange rates\./);
    expect(screen.getAllByText(/Converted \d+ values? to USD/)).toHaveLength(1);
  });

  it('Item 5: single-file price message is unchanged (no aggregation wrapper)', async () => {
    mocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: true });
    mocks.fetchMissingPrices.mockResolvedValue({ updated: 29, failed: 0 });
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(2, file.name));
    savedCounts = { 'hash:aaa': 2 };
    render(<ImportTab />);

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('a.csv', 'aaa')] } });

    await screen.findByText(/Fetched prices for 29 transactions\./);
    expect(screen.getAllByText(/Fetched prices for \d+ transactions?\./)).toHaveLength(1);
    // Single file: no batch summary line.
    expect(screen.queryByText(/of 1 files imported/)).not.toBeInTheDocument();
  });
});
