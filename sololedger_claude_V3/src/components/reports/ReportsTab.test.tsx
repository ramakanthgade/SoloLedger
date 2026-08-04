import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const SEED = vi.hoisted(() => ({
  hints: {} as Record<string, never>,
  txs: [
    {
      id: 'buy', timestamp: Date.UTC(2026, 3, 10), type: 'buy', asset: 'BTC', amount: 1,
      fiatCurrency: 'INR', fiatValue: 5_000_000, source: 'manual', flags: [], isInternalTransfer: false
    },
    {
      id: 'sell-unpriced', timestamp: Date.UTC(2026, 4, 10), type: 'sell', asset: 'BTC', amount: 1,
      fiatCurrency: 'INR', fiatValue: undefined, source: 'manual', flags: [], isInternalTransfer: false
    }
  ]
}));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (querier: () => unknown) => querier() }));
vi.mock('@/lib/storage/db', () => ({
  db: { transactions: { toArray: () => SEED.txs } },
  getSettings: () => Promise.resolve({
    reportingCurrency: 'INR', jurisdiction: 'IN', defaultCostBasisMethod: 'FIFO'
  }),
  getSpecIdHints: () => SEED.hints
}));
vi.mock('@/lib/saas/authContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/export/pdfTheme', () => ({
  createBrandedPdf: vi.fn(), pdfTableStyles: () => ({}), addPdfDisclaimer: vi.fn(),
  truncatePdfRef: (value: string) => value,
  PDF: { paperDeep: [0, 0, 0], ink: [0, 0, 0], gain: [0, 0, 0], loss: [0, 0, 0], amber: [0, 0, 0] }
}));
vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

import { ReportsTab } from './ReportsTab';

describe('ReportsTab unpriced disposal guard', () => {
  it('warns about fully matched unpriced disposals, excludes them from totals, and disables every export', async () => {
    await act(async () => {
      render(<ReportsTab />);
      await Promise.resolve();
    });

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Taxable disposals are missing proceeds');
    expect(warning).toHaveTextContent('1 are fully matched to inventory lots');
    expect(screen.getByText('Total gain / loss').parentElement).toHaveTextContent('₹0.00');
    expect(screen.getByText('Proceeds').parentElement).toHaveTextContent('₹0.00');

    const exportButtons = screen.getAllByRole('button').filter((button) =>
      /^(CSV|JSON|Schedule VDA CSV|Export PDF)$/.test(button.textContent ?? '')
    );
    expect(exportButtons.length).toBeGreaterThanOrEqual(8);
    for (const button of exportButtons) expect(button).toBeDisabled();
  });

  it('warns for an unpriced non-mining receipt and disables main, Schedule VDA, and TDS exports', async () => {
    const backup = [...SEED.txs];
    SEED.txs.splice(0, SEED.txs.length, {
      id: 'gift-unpriced', timestamp: Date.UTC(2026, 4, 10), type: 'gift_received', asset: 'ETH', amount: 1,
      fiatCurrency: 'INR', fiatValue: undefined, source: 'manual', flags: [], isInternalTransfer: false
    } as never);
    try {
      await act(async () => {
        render(<ReportsTab />);
        await Promise.resolve();
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Taxable receipts are missing market value');
      expect(screen.getByText('Spot income').parentElement).toHaveTextContent('₹0.00');
      const exportButtons = screen.getAllByRole('button').filter((button) =>
        /^(CSV|JSON|Schedule VDA CSV|Export PDF)$/.test(button.textContent ?? '')
      );
      expect(exportButtons.length).toBeGreaterThanOrEqual(8);
      for (const button of exportButtons) expect(button).toBeDisabled();
    } finally {
      SEED.txs.splice(0, SEED.txs.length, ...backup);
    }
  });
});
