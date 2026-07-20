import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Transaction } from '@/types/transaction';

/**
 * Item 1 — "Skip setup — go straight to Import" on every guided-setup screen.
 *
 * Onboarding's intro steps already had a skip link, but it was never threaded
 * into the ConnectionWizard phase, so all four wizard steps (pick exchange →
 * export steps → upload → preview) stranded users in the guided flow. When
 * `onSkip` is provided the link must be visible and clickable on EVERY step
 * (including mid-preview); when omitted (the Import tab's embedded wizard) it
 * must not render at all.
 *
 * Persistence/parsing deps are mocked exactly as in the batch-flow tests so
 * the wizard can be driven to the preview step.
 */

const mocks = vi.hoisted(() => ({
  parseImportFile: vi.fn(),
  hashFileContent: vi.fn(async (input: unknown) => `hash:${String(input)}`),
  csvImportsGet: vi.fn(async () => undefined),
  isAiMappingAvailable: vi.fn(async () => false),
  confirmSheetOrientations: vi.fn(async (_sheets: unknown, txs: Transaction[]) => txs)
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
    transactions: { bulkPut: vi.fn(async () => undefined) }
  },
  getSettings: vi.fn(async () => ({ reportingCurrency: 'USD' })),
  hashFileContent: mocks.hashFileContent,
  upsertCsvImport: vi.fn(async () => undefined),
  countCsvImportTransactions: vi.fn(async () => 1),
  deduplicateTransactions: vi.fn(async () => 0)
}));

vi.mock('@/lib/pricing/fiatConvert', () => ({
  convertOrNormalizeForImport: vi.fn(async (txs: Transaction[]) => ({ transactions: txs }))
}));

vi.mock('@/lib/pricing/autoFetch', () => ({
  fetchMissingPricesForAllTransactions: vi.fn(async () => ({ updated: 0, failed: 0 }))
}));

vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  isAiMappingAvailable: mocks.isAiMappingAvailable
}));

vi.mock('@/lib/parsers/types', () => ({
  normalizeFiatMagnitude: (v: unknown) => v
}));

import { ConnectionWizard } from './ConnectionWizard';

const SKIP_LINK = /skip setup — go straight to import/i;

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseImportFile.mockImplementation(async (file: File) => ({
    transactions: [makeTx(`${file.name}#0`)],
    detectedParser: 'test_parser',
    warnings: [],
    sheets: [],
    rows: [],
    headers: [],
    missingFields: []
  }));
});

/** Walk the wizard forward to the upload step, then drop one file to reach preview. */
async function driveToPreview() {
  fireEvent.click(await screen.findByRole('button', { name: /binance/i }));
  fireEvent.click(await screen.findByRole('button', { name: /i've got my file/i }));
  const dropzone = (await screen.findByText(/Drag & drop your Binance file/)).closest('div')!;
  fireEvent.drop(dropzone, { dataTransfer: { files: [makeFile('a.csv', 'aaa')] } });
  await screen.findByRole('button', { name: 'Confirm & save 1 transaction' });
}

describe('ConnectionWizard — skip link (Item 1)', () => {
  it('shows the skip link on ALL four steps and calls onSkip when clicked', async () => {
    const onSkip = vi.fn();
    render(<ConnectionWizard onSkip={onSkip} />);

    // Step 1 — pick exchange.
    expect(screen.getByRole('button', { name: SKIP_LINK })).toBeInTheDocument();

    // Step 2 — export instructions.
    fireEvent.click(await screen.findByRole('button', { name: /binance/i }));
    await screen.findByText(/Export from Binance/);
    expect(screen.getByRole('button', { name: SKIP_LINK })).toBeInTheDocument();

    // Step 3 — upload.
    fireEvent.click(await screen.findByRole('button', { name: /i've got my file/i }));
    await screen.findByText(/Drag & drop your Binance file/);
    expect(screen.getByRole('button', { name: SKIP_LINK })).toBeInTheDocument();

    // Step 4 — preview: still there, and clickable mid-preview.
    const dropzone = screen.getByText(/Drag & drop your Binance file/).closest('div')!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [makeFile('a.csv', 'aaa')] } });
    await screen.findByRole('button', { name: 'Confirm & save 1 transaction' });
    fireEvent.click(screen.getByRole('button', { name: SKIP_LINK }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('calls onSkip from the FIRST step too (no need to walk forward)', async () => {
    const onSkip = vi.fn();
    render(<ConnectionWizard onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('button', { name: SKIP_LINK }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the skip link when onSkip is omitted (Import tab usage)', async () => {
    render(<ConnectionWizard />);
    expect(screen.queryByRole('button', { name: SKIP_LINK })).not.toBeInTheDocument();

    await driveToPreview();
    expect(screen.queryByRole('button', { name: SKIP_LINK })).not.toBeInTheDocument();
  });
});
