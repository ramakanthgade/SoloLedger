import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Transaction } from '@/types/transaction';

/**
 * F4/F6/F8 — FileImportFlow multi-file batch handling (ported from the old
 * ImportTab.batch.test; the engine moved verbatim into the Connections v2
 * drawer file flow).
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
  bulkPut: vi.fn(async (..._args: unknown[]) => undefined),
  upsertCsvImport: vi.fn(async (..._args: unknown[]) => undefined),
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
  confirmSheetOrientations: vi.fn(async (_sheets: unknown, txs: Transaction[]) => txs),
  persistCsvImportEvidence: vi.fn(async (..._args: unknown[]) => undefined),
  buildCsvImportEvidenceGeneration: vi.fn((input: unknown) => input),
  commitCsvImportGeneration: vi.fn(),
  accountIdentitiesToArray: vi.fn()
}));

vi.mock('@/lib/parsers', () => ({
  parseImportFile: mocks.parseImportFile,
  isSpreadsheetFile: () => false,
  buildCsvImportEvidenceGeneration: mocks.buildCsvImportEvidenceGeneration,
  hasSourceDeclaredHistory: (evidence: { declaredHistory?: { completeHistory?: boolean; start?: number; end?: number } } | undefined) =>
    evidence?.declaredHistory?.completeHistory === true ||
    (evidence?.declaredHistory?.start != null && evidence.declaredHistory.end != null),
  declaredLegacyBalanceSnapshot: (evidence: { declaredSnapshots?: { balances: Record<string, number> }[] } | undefined) =>
    evidence?.declaredSnapshots?.length === 1 ? evidence.declaredSnapshots[0].balances : undefined
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
    transactions: { bulkPut: mocks.bulkPut },
    accountIdentities: {
      where: () => ({ equals: () => ({ toArray: mocks.accountIdentitiesToArray }) })
    }
  },
  commitCsvImportGeneration: mocks.commitCsvImportGeneration,
  getCsvImports: mocks.getCsvImports,
  getSettings: mocks.getSettings,
  hashFileContent: mocks.hashFileContent,
  upsertCsvImport: mocks.upsertCsvImport,
  deleteCsvImportAndTransactions: vi.fn(async () => undefined),
  countCsvImportTransactions: mocks.countCsvImportTransactions,
  deduplicateTransactions: mocks.deduplicateTransactions,
  claimAccountOwnershipPrompt: vi.fn(async () => ({ claimed: false })),
  createCsvAccountIdentity: vi.fn(),
  updateAccountOwnership: vi.fn()
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

// Mapping form stubbed — this is a focused batch-flow test.
vi.mock('@/components/import/ColumnMappingForm', () => ({
  ColumnMappingForm: () => <div data-testid="panel-mapping">Mapping</div>
}));

import { FileImportFlow } from './FileImportFlow';

function renderFlow() {
  const view = render(<FileImportFlow />);
  const observer = new MutationObserver(() => {
    const account = screen.queryAllByRole('button', { name: /Test account/ })[0];
    if (account) fireEvent.click(account);
  });
  observer.observe(view.container, { childList: true, subtree: true });
  return view;
}

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
  return screen.getByText(/Drop your export here/).closest('div')!;
}

/** Post-dedup rows surviving per import hash — mirrors countCsvImportTransactions. */
let savedCounts: Record<string, number> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedCounts = {};
  mocks.accountIdentitiesToArray.mockResolvedValue([
    ['test', 'test_parser'], ['options', 'binance_options'], ['unknown', undefined],
    ['manual', 'manual_mapping'], ['ai', 'ai_mapping']
  ].map(([suffix, parserId]) => ({
    id: `csv-account:${suffix}`, canonicalKey: `csv-account:${suffix}`, kind: 'csv',
    parserId, label: 'Test account', ownershipStatus: 'owned', ownershipOrigin: 'user',
    ownershipConfirmedAt: 1, createdAt: 1, updatedAt: 1, lifecycleRevision: 1
  })));
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
  mocks.commitCsvImportGeneration.mockImplementation(async (input: {
    id: string; fileName: string; parserId: string | null; transactions: Transaction[];
    metadata?: Record<string, unknown>;
    buildGeneration: (context: { generation: number; savedAfterDedup: number; completedAt: number }) => unknown;
  }) => {
    await mocks.bulkPut(input.transactions);
    const saved = savedCounts[input.id] ?? 1;
    const generation = input.buildGeneration({ generation: 1, savedAfterDedup: saved, completedAt: 100 });
    await mocks.persistCsvImportEvidence(generation);
    await mocks.upsertCsvImport(input.id, input.fileName, input.parserId, saved, {
      ...input.metadata,
      balanceSnapshot: saved === input.transactions.length ? input.metadata?.balanceSnapshot : undefined,
      optionsBalanceIncluded: saved === input.transactions.length ? input.metadata?.optionsBalanceIncluded : undefined
    });
    return saved;
  });
});

describe('FileImportFlow — multi-file batch handling', () => {
  it('rejects a second drop while account selection is pending without replacing the first resolver', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(1, file.name));
    render(<FileImportFlow />);
    const dropzone = getDropzone();
    fireEvent.drop(dropzone, { dataTransfer: { files: [makeFile('first.csv', 'first')] } });

    expect(await screen.findByText('Which account is this file for?')).toBeInTheDocument();
    fireEvent.drop(dropzone, { dataTransfer: { files: [makeFile('second.csv', 'second')] } });
    expect(mocks.parseImportFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('button', { name: /Test account/ })[0]);
    await waitFor(() => expect(mocks.commitCsvImportGeneration).toHaveBeenCalledTimes(1));
    expect(mocks.commitCsvImportGeneration).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'first.csv', accountIdentityId: 'csv-account:test'
    }));
    expect(mocks.commitCsvImportGeneration).not.toHaveBeenCalledWith(expect.objectContaining({ fileName: 'second.csv' }));
  });

  it('requires an explicit recurring account choice and carries it separately from the file hash', async () => {
    mocks.accountIdentitiesToArray.mockResolvedValue([
      { id: 'csv-account:main', canonicalKey: 'csv-account:main', kind: 'csv', parserId: 'test_parser', label: 'Main account', ownershipStatus: 'owned', ownershipOrigin: 'user', ownershipConfirmedAt: 1, createdAt: 1, updatedAt: 1, lifecycleRevision: 1 },
      { id: 'csv-account:family', canonicalKey: 'csv-account:family', kind: 'csv', parserId: 'test_parser', label: 'Family account', ownershipStatus: 'not_owned', ownershipOrigin: 'user', ownershipConfirmedAt: 1, createdAt: 1, updatedAt: 1, lifecycleRevision: 1 }
    ]);
    mocks.parseImportFile.mockResolvedValue(recognized(1, 'recurring.csv'));
    const { container } = render(<FileImportFlow />);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [makeFile('recurring.csv', 'same parser, new generation')] }
    });

    expect(await screen.findByText('Which account is this file for?')).toBeInTheDocument();
    expect(mocks.commitCsvImportGeneration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Family account/ }));
    await waitFor(() => expect(mocks.commitCsvImportGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'hash:same parser, new generation',
        accountIdentityId: 'csv-account:family'
      })
    ));
  });

  it('shows reading feedback before a deferred large-file parser begins producing results', async () => {
    let resolveParse!: (value: ReturnType<typeof recognized>) => void;
    mocks.parseImportFile.mockImplementation(() => new Promise((resolve) => { resolveParse = resolve; }));
    const { container } = renderFlow();

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [makeFile('large-binance.csv', 'many rows')] }
    });

    expect(await screen.findByText('Reading and checking your file…')).toBeInTheDocument();
    await waitFor(() => expect(mocks.parseImportFile).toHaveBeenCalledTimes(1));
    await act(async () => resolveParse(recognized(1, 'large-binance.csv')));
    await screen.findByText(/Saved 1 transaction to your local database/);
  });

  it('F4: the browse input accepts multiple files and imports them all', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      recognized(file.name === 'one.csv' ? 1 : 2, file.name)
    );
    savedCounts = { 'hash:aaa': 1, 'hash:bbb': 2 };
    const { container } = renderFlow();

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
    renderFlow();

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
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('corrupt.csv', 'xxx')] } });

    await screen.findByText(/"corrupt\.csv" could not be read — the file may be corrupt/);
    expect(mocks.bulkPut).not.toHaveBeenCalled();
  });

  it('F8: mapping note points at the form only when the manual file is LAST in the batch', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) =>
      file.name === 'mystery.csv' ? unrecognized() : recognized(1, file.name)
    );
    renderFlow();

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
    renderFlow();

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
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('reexport.csv', 'aaa')] } });

    await screen.findByText(/No new transactions — everything in that file was already in your ledger/);
    expect(screen.queryByText(/Saved \d+ transaction/)).not.toBeInTheDocument();
  });

  it('dedup: a fully-deduped file in a batch is bucketed as no-new-rows, not imported', async () => {
    mocks.parseImportFile.mockImplementation(async (file: File) => recognized(2, file.name));
    savedCounts = { 'hash:aaa': 2, 'hash:bbb': 0 };
    renderFlow();

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
    renderFlow();

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
    renderFlow();

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
    renderFlow();

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
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('a.csv', 'aaa')] } });

    await screen.findByText(/Fetched prices for 29 transactions\./);
    expect(screen.getAllByText(/Fetched prices for \d+ transactions?\./)).toHaveLength(1);
    // Single file: no batch summary line.
    expect(screen.queryByText(/of 1 files imported/)).not.toBeInTheDocument();
  });

  it('pricing continues after unmount because transactions and import metadata are already saved', async () => {
    mocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: true });
    let resolvePricing!: (value: { updated: number; failed: number }) => void;
    let pricingFinished = false;
    mocks.fetchMissingPrices.mockImplementation(() =>
      new Promise<{ updated: number; failed: number }>((resolve) => {
        resolvePricing = (value) => {
          pricingFinished = true;
          resolve(value);
        };
      })
    );
    mocks.parseImportFile.mockResolvedValue(recognized(1, 'options.csv'));
    savedCounts = { 'hash:aaa': 1 };
    const view = renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('options.csv', 'aaa')] } });
    await screen.findByText(/Transactions saved.*you can close this panel/i);
    expect(mocks.bulkPut).toHaveBeenCalledTimes(1);
    expect(mocks.upsertCsvImport).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => resolvePricing({ updated: 1, failed: 0 }));
    await waitFor(() => expect(pricingFinished).toBe(true));
  });

  it('reports optional pricing failure without turning a saved import into a read failure', async () => {
    mocks.getEffectiveSettings.mockResolvedValue({ priceApiEnabled: true });
    mocks.fetchMissingPrices.mockRejectedValue(new Error('pricing unavailable'));
    mocks.parseImportFile.mockResolvedValue(recognized(1, 'options.csv'));
    savedCounts = { 'hash:aaa': 1 };
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('options.csv', 'aaa')] } });

    await screen.findByText(/Saved 1 transaction/i);
    expect(screen.getAllByText(/Optional market prices could not be fetched/i)).toHaveLength(1);
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
    expect(mocks.bulkPut).toHaveBeenCalledTimes(1);
    expect(mocks.upsertCsvImport).toHaveBeenCalledTimes(1);
  });

  it('persists Options coverage only when every parsed row survives dedup', async () => {
    mocks.parseImportFile.mockResolvedValue({
      ...recognized(2, 'options.csv'),
      detectedParser: 'binance_options',
      optionsBalanceIncluded: true
    });
    savedCounts = { 'hash:aaa': 1 };
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('options.csv', 'aaa')] } });
    await waitFor(() => expect(mocks.upsertCsvImport).toHaveBeenCalled());
    expect(mocks.upsertCsvImport).toHaveBeenCalledWith(
      'hash:aaa',
      'options.csv',
      'binance_options',
      1,
      expect.objectContaining({ optionsBalanceIncluded: undefined })
    );
  });

  it('persists one post-dedup CSV evidence generation and does not promote an undeclared snapshot', async () => {
    const evidence = {
      coveredAccountClasses: ['spot'],
      requiredOutcomes: [{ id: 'history', accountClass: 'spot', required: true, status: 'complete' }],
      recognizedCount: 2, parsedCount: 2, excludedCount: 0, skippedCount: 0, failedCount: 0,
      exclusionReasons: [], skippedReasons: [], failureReasons: []
    };
    mocks.parseImportFile.mockResolvedValue({
      ...recognized(2, 'history.csv'), balanceSnapshot: { BTC: 1 }, evidence
    });
    savedCounts = { 'hash:aaa': 1 };
    renderFlow();

    fireEvent.drop(getDropzone(), { dataTransfer: { files: [makeFile('history.csv', 'aaa')] } });
    await waitFor(() => expect(mocks.persistCsvImportEvidence).toHaveBeenCalledTimes(1));
    expect(mocks.persistCsvImportEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sourceIdentityId: 'hash:aaa', parsedBeforeDedup: 2, savedAfterDedup: 1, evidence
    }));
    expect(mocks.upsertCsvImport).toHaveBeenCalledWith(
      'hash:aaa', 'history.csv', 'test_parser', 1,
      expect.objectContaining({ balanceSnapshot: undefined })
    );
  });
});
