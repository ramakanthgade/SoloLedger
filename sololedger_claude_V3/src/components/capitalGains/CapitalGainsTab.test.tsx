import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { formatHoldingPeriod } from './formatHoldingPeriod';

/**
 * Capital Gains tab — Ember & Slate restyle. The Dexie layer is replaced with
 * a synchronous in-memory stub (mirroring PortfolioTab.test.tsx: the real
 * `useLiveQuery` effect chains never settle under jsdom), so the tab renders
 * deterministically against a fixed FY 2026-27 ledger: one gain disposal
 * (BTC), one loss disposal (ETH — disallowed under Sec 115BBH), one spot
 * income event and a derivative profit + trading fee. The cost-basis engine,
 * matched-gains builders and jurisdiction summary all run for real; PDF and
 * auth plumbing is mocked out.
 */

const SEED = vi.hoisted(() => {
  const txs = [
    {
      id: 't-btc-buy',
      timestamp: Date.UTC(2026, 3, 10, 10), // FY 2026-27 (IN)
      type: 'buy',
      asset: 'BTC',
      amount: 1,
      fiatCurrency: 'INR',
      fiatValue: 5_000_000,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-eth-buy',
      timestamp: Date.UTC(2026, 3, 12, 10),
      type: 'buy',
      asset: 'ETH',
      amount: 10,
      fiatCurrency: 'INR',
      fiatValue: 2_000_000,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-eth-sell',
      timestamp: Date.UTC(2026, 4, 20, 10),
      type: 'sell',
      asset: 'ETH',
      amount: 10,
      fiatCurrency: 'INR',
      fiatValue: 1_500_000, // loss −₹5,00,000 — not offsettable (IN)
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-btc-sell',
      timestamp: Date.UTC(2026, 5, 15, 10),
      type: 'sell',
      asset: 'BTC',
      amount: 0.5,
      fiatCurrency: 'INR',
      fiatValue: 3_000_000, // gain +₹5,00,000
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-income',
      timestamp: Date.UTC(2026, 4, 1, 10),
      type: 'income',
      asset: 'ETH',
      amount: 0.1,
      fiatCurrency: 'INR',
      fiatValue: 15_000,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-perp-profit',
      timestamp: Date.UTC(2026, 5, 1, 10),
      type: 'income',
      asset: 'BTC-PERP',
      amount: 0.5,
      fiatCurrency: 'INR',
      fiatValue: 120_000,
      instrumentClass: 'derivative',
      category: 'perp_profit',
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-perp-fee',
      timestamp: Date.UTC(2026, 5, 2, 10),
      type: 'fee',
      asset: 'USDT',
      amount: 400,
      fiatCurrency: 'INR',
      fiatValue: 33_000,
      instrumentClass: 'derivative',
      category: 'futures_fee',
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    }
  ];
  return { txs, hints: {} as Record<string, never> };
});

vi.mock('dexie-react-hooks', () => ({
  // Run the querier synchronously against the stubbed db below.
  useLiveQuery: (querier: () => unknown) => querier()
}));

vi.mock('@/lib/storage/db', () => ({
  db: { transactions: { toArray: () => SEED.txs } },
  getSettings: () =>
    Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN', defaultCostBasisMethod: 'FIFO' }),
  // Stable reference: the sync useLiveQuery stub re-invokes the querier on
  // every render.
  getSpecIdHints: () => SEED.hints
}));

vi.mock('@/lib/rpc/dcaDetection', () => ({ detectDcaGroups: () => [] }));
vi.mock('@/lib/saas/authContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/export/pdfTheme', () => ({
  createBrandedPdf: vi.fn(),
  pdfTableStyles: () => ({})
}));
vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

import { CapitalGainsTab } from './CapitalGainsTab';

async function renderTab() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<CapitalGainsTab />);
    // Flush the mocked getSettings().then state update inside act().
    await Promise.resolve();
  });
  return utils;
}

describe('formatHoldingPeriod', () => {
  it('formats days, months and years in the mockup style', () => {
    expect(formatHoldingPeriod(0)).toBe('0 days');
    expect(formatHoldingPeriod(1)).toBe('1 day');
    expect(formatHoldingPeriod(26)).toBe('26 days');
    expect(formatHoldingPeriod(45)).toBe('1m 15d');
    expect(formatHoldingPeriod(60)).toBe('2m');
    expect(formatHoldingPeriod(365)).toBe('1y');
    expect(formatHoldingPeriod(426)).toBe('1y 2m');
  });
});

describe('CapitalGainsTab (Ember & Slate)', () => {
  it('renders the FY summary hero with gains, losses, taxable base and India tax estimate', async () => {
    await renderTab();

    const gains = screen.getByTestId('cg-card-gains');
    expect(within(gains).getByText('Realized gains')).toBeInTheDocument();
    expect(within(gains).getByText('+₹5,00,000.00')).toBeInTheDocument();
    expect(within(gains).getByText('1 gain disposal')).toBeInTheDocument();

    const losses = screen.getByTestId('cg-card-losses');
    // 115BBH: the loss is shown separately and marked as not offsettable.
    expect(within(losses).getByText('−₹5,00,000.00')).toBeInTheDocument();
    expect(within(losses).getByText('not offsettable')).toBeInTheDocument();

    const taxable = screen.getByTestId('cg-card-taxable');
    expect(within(taxable).getByText('Taxable VDA income')).toBeInTheDocument();
    expect(within(taxable).getByText('₹5,00,000.00')).toBeInTheDocument();
    expect(within(taxable).getByText(/flat 30%/)).toBeInTheDocument();

    const estTax = screen.getByTestId('cg-card-est-tax');
    // 30% of ₹5,00,000 = ₹1,50,000; 4% cess = ₹6,000; total ₹1,56,000.
    expect(within(estTax).getByText('₹1,56,000.00')).toBeInTheDocument();
    expect(within(estTax).getByText(/30% = ₹1,50,000\.00/)).toBeInTheDocument();
    expect(within(estTax).getByText(/cess 4% = ₹6,000\.00/)).toBeInTheDocument();
    expect(within(estTax).getByText(/not tax advice/)).toBeInTheDocument();
  });

  it('shows the Sec 115BBH explainer with the disallowed loss and gross-gains base', async () => {
    await renderTab();
    const note = screen.getByTestId('cg-115bbh-note');
    expect(note).toHaveTextContent('Sec 115BBH');
    expect(note).toHaveTextContent('₹5.00L'); // compact disallowed losses
    expect(note).toHaveTextContent('gross gains of ₹5,00,000.00');
  });

  it('renders matched disposals with brand icons, caption/scope semantics and tonal P&L pills', async () => {
    const { container } = await renderTab();
    const panel = screen.getByTestId('capital-gains-disposals');

    // Real brand icons for BTC and ETH (CDN-based colored logos, 'small' size).
    const imgs = Array.from(panel.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    expect(imgs).toContain('https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png');
    expect(imgs).toContain('https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/ethereum/small.png');

    // Table a11y: one caption + seven scoped column headers (desktop table).
    expect(panel.querySelectorAll('caption')).toHaveLength(1);
    expect(panel.querySelectorAll('th[scope="col"]')).toHaveLength(7);
    expect(within(panel).getByText('Held for')).toBeInTheDocument();

    // Gain and loss rows render as tonal pills (desktop row + mobile card).
    expect(within(panel).getAllByText('+₹5,00,000.00').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText('−₹5,00,000.00').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText('2m 6d').length).toBeGreaterThanOrEqual(1); // BTC: Apr 10 → Jun 15

    // Method pill + per-lot footer note.
    expect(within(panel).getAllByText('FIFO').length).toBeGreaterThanOrEqual(1);
    expect(panel).toHaveTextContent('2 matched lot rows');
    void container;
  });

  it('renders income & rewards with slab-rate badge and the FY total', async () => {
    await renderTab();
    const panel = screen.getByTestId('capital-gains-income');
    expect(within(panel).getByText('Slab rate')).toBeInTheDocument();
    expect(within(panel).getByText('Total income')).toBeInTheDocument();
    expect(within(panel).getAllByText('₹15,000.00').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText('Income').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getByText(/receipt FMV/)).toBeInTheDocument();
  });

  it('renders derivatives with the Settings treatment indicator and business income/expense tables', async () => {
    await renderTab();
    const panel = screen.getByTestId('capital-gains-derivatives');

    // Static treatment indicator: Business income is the IN default.
    const seg = within(panel).getByRole('group', { name: /Derivatives tax treatment/ });
    expect(within(seg).getByText('Business income')).toHaveAttribute('aria-current', 'true');
    expect(within(seg).getByText('Capital gains')).not.toHaveAttribute('aria-current');

    // Summary strip: income − expenses = net.
    expect(within(panel).getByText('+₹1,20,000.00')).toBeInTheDocument();
    expect(within(panel).getByText('−₹33,000.00')).toBeInTheDocument();
    expect(within(panel).getByText('₹87,000.00')).toBeInTheDocument();

    // Expense kind badge + judgement-call note.
    expect(within(panel).getByText('Trading fee')).toBeInTheDocument();
    expect(within(panel).getByText(/judgement call/)).toBeInTheDocument();
  });

  it('keeps the export affordances in the filing card; PDF asks for confirmation', async () => {
    await renderTab();
    const cta = screen.getByTestId('capital-gains-export');
    expect(within(cta).getByRole('button', { name: /Export CSV/ })).toBeInTheDocument();
    expect(within(cta).getByRole('button', { name: /Export JSON/ })).toBeInTheDocument();

    fireEvent.click(within(cta).getByRole('button', { name: /Export PDF/ }));
    expect(await screen.findByText('Export as PDF?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('surfaces a fully matched unpriced disposal without adding it to totals and blocks exports', async () => {
    SEED.txs.push({
      id: 't-btc-unpriced',
      timestamp: Date.UTC(2026, 6, 1, 10),
      type: 'sell',
      asset: 'BTC',
      amount: 0.5,
      fiatCurrency: 'INR',
      fiatValue: undefined,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    } as never);
    try {
      await renderTab();
      const warning = screen.getByRole('alert');
      expect(warning).toHaveTextContent('Taxable disposals are missing proceeds');
      expect(warning).toHaveTextContent('1 are fully matched to acquisition lots');
      expect(screen.getByTestId('cg-card-gains')).toHaveTextContent('+₹5,00,000.00');

      const exportButtons = screen.getAllByRole('button').filter((button) =>
        /^(Download CSV|Export CSV|Export JSON|Export PDF →)$/.test(button.textContent?.trim() ?? '')
      );
      expect(exportButtons).toHaveLength(4);
      for (const button of exportButtons) expect(button).toBeDisabled();
    } finally {
      SEED.txs.pop();
    }
  });

  it('surfaces unpriced non-mining receipts, prevents ready-to-file copy, and blocks exports', async () => {
    SEED.txs.push({
      id: 't-unpriced-gift', timestamp: Date.UTC(2026, 7, 1, 10), type: 'gift_received',
      asset: 'SOL', amount: 2, fiatCurrency: 'INR', fiatValue: undefined,
      source: 'manual', flags: [], isInternalTransfer: false
    } as never);
    try {
      await renderTab();
      expect(screen.getByText('Taxable receipts are missing market value')).toBeInTheDocument();
      expect(screen.queryByText(/Ready to file/)).not.toBeInTheDocument();
      expect(screen.getByText(/Complete missing tax values/)).toBeInTheDocument();
      expect(screen.getByTestId('capital-gains-income')).toHaveTextContent('₹15,000.00');
      const exportButtons = screen.getAllByRole('button').filter((button) =>
        /^(Download CSV|Export CSV|Export JSON|Export PDF →)$/.test(button.textContent?.trim() ?? '')
      );
      expect(exportButtons).toHaveLength(4);
      for (const button of exportButtons) expect(button).toBeDisabled();
    } finally {
      SEED.txs.pop();
    }
  });

  it('preserves intentional unpriced mining semantics without blocking filing', async () => {
    SEED.txs.push({
      id: 't-unpriced-mining', timestamp: Date.UTC(2026, 7, 2, 10), type: 'income',
      category: 'mining', asset: 'BTC', amount: 0.01, fiatCurrency: 'INR', fiatValue: undefined,
      source: 'manual', flags: [], isInternalTransfer: false
    } as never);
    try {
      await renderTab();
      expect(screen.queryByText('Taxable receipts are missing market value')).not.toBeInTheDocument();
      expect(screen.getByText(/Ready to file/)).toBeInTheDocument();
      expect(within(screen.getByTestId('capital-gains-export')).getByRole('button', { name: /Export CSV/ })).toBeEnabled();
    } finally {
      SEED.txs.pop();
    }
  });

  it('keeps the per-FY selector and shows the empty state when the ledger is empty', async () => {
    await renderTab();
    expect(screen.getByLabelText('Financial year')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost basis method')).toBeInTheDocument();

    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    try {
      const { unmount } = await renderTab();
      expect(screen.getByText('No gains to calculate yet')).toBeInTheDocument();
      unmount();
    } finally {
      SEED.txs.push(...backup);
    }
  });
});
