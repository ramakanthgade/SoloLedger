import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Transaction } from '@/types/transaction';

/**
 * F1/F2 — multi-file batch flow through the guided wizard.
 *
 * The wizard reads queued files SEQUENTIALLY, chaining file N into file N+1
 * after each confirm. The queue must be threaded through the async chain as
 * an explicit parameter: reading it from a stale render closure re-dequeues
 * the file already being processed (infinite recursion) or strands the queue
 * when the FIRST file is a duplicate. And `onComplete` may only fire once the
 * batch is done — onboarding unmounts the wizard on the first call.
 *
 * All persistence/parsing deps are mocked; files carry distinct transaction
 * counts so the preview identifies WHICH file is being shown.
 */

const mocks = vi.hoisted(() => ({
  parseImportFile: vi.fn(),
  hashFileContent: vi.fn(),
  csvImportsGet: vi.fn(),
  bulkPut: vi.fn(async () => undefined),
  upsertCsvImport: vi.fn(async () => undefined),
  countCsvImportTransactions: vi.fn(async () => 1),
  deduplicateTransactions: vi.fn(async () => 0),
  getSettings: vi.fn(async () => ({ reportingCurrency: 'USD' })),
  convertOrNormalizeForImport: vi.fn(async (txs: Transaction[]) => ({ transactions: txs })),
  fetchMissingPrices: vi.fn(async () => ({ updated: 0, failed: 0 })),
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  isAiMappingAvailable: vi.fn(async () => false),
  confirmSheetOrientations: vi.fn(async (_sheets: unknown, txs: Transaction[]) => txs),
  onComplete: vi.fn()
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
  getSettings: mocks.getSettings,
  hashFileContent: mocks.hashFileContent,
  upsertCsvImport: mocks.upsertCsvImport,
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

import { ConnectionWizard } from './ConnectionWizard';

/** Transactions each file (by name) yields when parsed. */
let txCounts: Record<string, number> = {};
/** Content hashes already present in csvImports (i.e. duplicate files). */
let duplicateHashes: Set<string> = new Set();

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

/** Drive the wizard to the upload step and drop the given files. */
async function dropFiles(files: File[]) {
  render(<ConnectionWizard onComplete={mocks.onComplete} />);
  fireEvent.click(await screen.findByRole('button', { name: /binance/i }));
  fireEvent.click(await screen.findByRole('button', { name: /i've got my file/i }));
  const dropzone = (await screen.findByText(/Drag & drop your Binance file/)).closest('div')!;
  fireEvent.drop(dropzone, { dataTransfer: { files } });
}

beforeEach(() => {
  vi.clearAllMocks();
  txCounts = {};
  duplicateHashes = new Set();
  mocks.hashFileContent.mockImplementation(async (input: unknown) => `hash:${String(input)}`);
  mocks.csvImportsGet.mockImplementation(async (hash: string) =>
    duplicateHashes.has(hash) ? { hash, fileName: 'older import' } : undefined
  );
  mocks.parseImportFile.mockImplementation(async (file: File) => {
    const count = txCounts[file.name] ?? 1;
    return {
      transactions: Array.from({ length: count }, (_, i) => makeTx(`${file.name}#${i}`)),
      detectedParser: 'test_parser',
      warnings: [],
      sheets: [],
      rows: [],
      headers: [],
      missingFields: []
    };
  });
});

describe('ConnectionWizard — multi-file batch flow', () => {
  it('skips a duplicate in the MIDDLE of a batch and finishes with the aggregated banner', async () => {
    // a.csv: 1 tx · b.csv: already imported · c.csv: 2 txs
    txCounts = { 'a.csv': 1, 'c.csv': 2 };
    duplicateHashes = new Set(['hash:bbb']);
    await dropFiles([makeFile('a.csv', 'aaa'), makeFile('b.csv', 'bbb'), makeFile('c.csv', 'ccc')]);

    // File 1 preview → confirm. (The old stale-closure bug spun forever here.)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 1 transaction' }));

    // File 2 is skipped pre-parse and file 3 is previewed; onComplete must NOT
    // have fired yet — the batch is still open (onboarding would unmount).
    const secondConfirm = await screen.findByRole('button', { name: 'Confirm & save 2 transactions' });
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(2); // a + c, never b
    expect(mocks.onComplete).not.toHaveBeenCalled();

    fireEvent.click(secondConfirm);

    // Aggregated outcome: 1 + 2 transactions, one onComplete with the total.
    await screen.findByText(/Saved 3 transactions to your local ledger/);
    expect(mocks.onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.onComplete).toHaveBeenCalledWith(3);
    expect(screen.getByText(/Skipped already-imported file: b\.csv/)).toBeInTheDocument();
    expect(screen.queryByText(/was already imported\. Remove/)).not.toBeInTheDocument();
  });

  it('keeps the batch running when the FIRST file is a duplicate', async () => {
    // a.csv: already imported · b.csv: 1 tx · c.csv: 2 txs
    txCounts = { 'b.csv': 1, 'c.csv': 2 };
    duplicateHashes = new Set(['hash:aaa']);
    await dropFiles([makeFile('a.csv', 'aaa'), makeFile('b.csv', 'bbb'), makeFile('c.csv', 'ccc')]);

    // The duplicate first file chains into file 2 instead of aborting.
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 1 transaction' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 2 transactions' }));

    await screen.findByText(/Saved 3 transactions to your local ledger/);
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(2); // b + c, never a
    expect(mocks.onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.onComplete).toHaveBeenCalledWith(3);
    expect(screen.getByText(/Skipped already-imported file: a\.csv/)).toBeInTheDocument();
    expect(screen.queryByText(/was already imported\. Remove/)).not.toBeInTheDocument();
  });

  it('ends with the batch banner when the LAST file is a duplicate', async () => {
    // a.csv: 1 tx · b.csv: already imported
    txCounts = { 'a.csv': 1 };
    duplicateHashes = new Set(['hash:bbb']);
    await dropFiles([makeFile('a.csv', 'aaa'), makeFile('b.csv', 'bbb')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 1 transaction' }));

    // The duplicate tail still produces the aggregated batch outcome — no
    // single-file "already imported" error.
    await screen.findByText(/Saved 1 transaction to your local ledger/);
    expect(mocks.onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.onComplete).toHaveBeenCalledWith(1);
    expect(screen.getByText(/Skipped already-imported file: b\.csv/)).toBeInTheDocument();
    expect(screen.queryByText(/was already imported\. Remove/)).not.toBeInTheDocument();
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(1); // only a
  });

  it('single duplicate file still shows the blocking error (non-batch path unchanged)', async () => {
    duplicateHashes = new Set(['hash:aaa']);
    await dropFiles([makeFile('a.csv', 'aaa')]);

    await screen.findByText(/"a\.csv" was already imported\. Remove it from the Import tab/);
    expect(mocks.parseImportFile).not.toHaveBeenCalled();
    expect(mocks.onComplete).not.toHaveBeenCalled();
    expect(screen.queryByText(/Saved \d+ transaction/)).not.toBeInTheDocument();
  });

  it('single file: confirms and fires onComplete once with the saved count', async () => {
    txCounts = { 'a.csv': 2 };
    await dropFiles([makeFile('a.csv', 'aaa')]);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & save 2 transactions' }));

    await screen.findByText(/Saved 2 transactions to your local ledger/);
    expect(mocks.onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.onComplete).toHaveBeenCalledWith(2);
  });
});
