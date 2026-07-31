import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { getAvailableFys, getCurrentFy, getFyLabel } from '@/lib/utils';

/**
 * Portfolio tab — Ember & Slate restyle. The Dexie layer is replaced with a
 * synchronous in-memory stub (the real `useLiveQuery` effect chains never
 * settle under jsdom's microtask model), so the tab renders deterministically
 * against a fixed three-asset ledger. Network/PDF repair plumbing is mocked
 * out; the cost-basis engine and portfolio compute run for real.
 */

const SEED = vi.hoisted(() => {
  const txs = [
    {
      id: 't-btc',
      timestamp: Date.UTC(2026, 0, 15), // FY 2025-26 (IN)
      type: 'buy',
      asset: 'BTC',
      amount: 0.5,
      fiatCurrency: 'INR',
      fiatValue: 25000,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-eth',
      timestamp: Date.UTC(2026, 4, 10), // FY 2026-27 (IN)
      type: 'buy',
      asset: 'ETH',
      amount: 2,
      fiatCurrency: 'INR',
      fiatValue: 10000,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    },
    {
      id: 't-doge',
      timestamp: Date.UTC(2026, 4, 11),
      type: 'buy',
      asset: 'ZZZNOLOGO',
      amount: 500,
      fiatCurrency: 'INR',
      fiatValue: 500,
      source: 'manual',
      flags: [],
      isInternalTransfer: false
    }
  ];
  return { txs, emptyAddresses: [] as { chain: string; address: string }[] };
});

vi.mock('dexie-react-hooks', () => ({
  // Run the querier synchronously against the stubbed db below.
  useLiveQuery: (querier: () => unknown) => querier()
}));

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: { toArray: () => SEED.txs },
    csvImports: { toArray: () => [] }
  },
  getSettings: () => Promise.resolve({ reportingCurrency: 'INR', jurisdiction: 'IN' }),
  // Stable reference: the sync useLiveQuery stub re-invokes the querier on
  // every render, so returning a fresh [] here would re-fire the balance
  // effect (it deps on the array identity) and loop forever.
  getLookupAddresses: () => SEED.emptyAddresses,
  transactionSourceKey: (t: { sourceRef?: string; walletAddress?: string }) =>
    t.sourceRef && t.walletAddress ? `${t.walletAddress}|${t.sourceRef}` : null
}));

vi.mock('@/lib/rpc/walletBalances', () => ({ fetchLiveWalletBalances: vi.fn(async () => []) }));
vi.mock('@/lib/portfolio/repairSolSwapLegs', () => ({
  repairMissingSolSwapLegs: vi.fn(),
  repairUsdcOvercount: vi.fn()
}));
vi.mock('@/lib/portfolio/reconcileWalletChain', () => ({
  reconcileSolanaWalletsFromChain: vi.fn(async () => ({ message: 'Ledger checked' }))
}));
vi.mock('@/lib/portfolio/collapseDuplicateLegs', () => ({
  collapseDuplicateTradeTransferLegs: vi.fn()
}));
vi.mock('@/lib/rpc/reprocessSwaps', () => ({ reprocessSwapDetectionInDb: vi.fn() }));
vi.mock('@/lib/rpc/dcaDetection', () => ({
  applyDcaClassification: vi.fn(),
  detectDcaGroups: () => []
}));
vi.mock('@/lib/portfolio/solBalance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/portfolio/solBalance')>()),
  normalizeSolLedgerRows: vi.fn()
}));
vi.mock('@/lib/export/pdfTheme', () => ({
  createBrandedPdf: vi.fn(),
  pdfTableStyles: () => ({})
}));
vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

import { PortfolioTab } from './PortfolioTab';

const JURISDICTION = 'IN' as const;
const CURRENT_FY_LABEL = getFyLabel(getCurrentFy(JURISDICTION), JURISDICTION);
const PREV_FY_LABEL = getFyLabel(2025, JURISDICTION); // t-btc lands in FY 2025-26
const EXPECTED_PILL_COUNT =
  getAvailableFys(SEED.txs.map((t) => t.timestamp), JURISDICTION).length + 1; // + "All time"

async function renderTab() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<PortfolioTab />);
    // Flush the mocked getSettings().then state update inside act().
    await Promise.resolve();
  });
  return utils;
}

describe('PortfolioTab (Ember & Slate)', () => {
  it('renders the summary hero with total cost basis and the stat rail', async () => {
    await renderTab();
    const hero = screen.getByTestId('portfolio-hero');
    expect(within(hero).getByText('Total holdings value')).toBeInTheDocument();
    // 25,000 + 10,000 + 500 = ₹35,500.00 (big number + compact subline).
    expect(within(hero).getAllByText(/35,500/).length).toBeGreaterThanOrEqual(1);
    expect(within(hero).getByText('Unrealized gain')).toBeInTheDocument();
    expect(within(hero).getByText('—')).toBeInTheDocument();
    expect(
      within(hero).getByText(`Realized gain — ${CURRENT_FY_LABEL}`)
    ).toBeInTheDocument();
    expect(within(hero).getByText(`Est. tax — ${CURRENT_FY_LABEL}`)).toBeInTheDocument();
    expect(within(hero).getByText(/not tax advice/)).toBeInTheDocument();
  });

  it('renders period as a radiogroup of pills with "All time" selected by default', async () => {
    await renderTab();
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(EXPECTED_PILL_COUNT);
    expect(radios[0]).toHaveTextContent('All time');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    // Roving tabindex: only the checked pill is tabbable.
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
    // 44px touch target on every pill.
    for (const radio of radios) expect(radio.className).toContain('min-h-[44px]');
  });

  it('selecting an FY pill filters the holdings to that period', async () => {
    await renderTab();
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    const fyPill = within(group)
      .getAllByRole('radio')
      .find((r) => r.textContent === PREV_FY_LABEL);
    expect(fyPill).toBeDefined();
    fireEvent.click(fyPill!);

    expect(
      within(screen.getByRole('radiogroup', { name: 'Period' })).getByRole('radio', {
        name: PREV_FY_LABEL
      })
    ).toHaveAttribute('aria-checked', 'true');

    // FY 2025-26 keeps only the January BTC buy — ETH/ZZZNOLOGO (May 2026) drop out.
    // (Rows render in both the desktop table and the mobile card list.)
    expect(screen.getAllByText('BTC').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('ZZZNOLOGO')).not.toBeInTheDocument();
    expect(screen.getByText('1 asset')).toBeInTheDocument();
  });

  it('moves period selection with arrow keys (roving radio group)', async () => {
    await renderTab();
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    const radios = within(screen.getByRole('radiogroup', { name: 'Period' })).getAllByRole(
      'radio'
    );
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Period' }), { key: 'Home' });
    expect(
      within(screen.getByRole('radiogroup', { name: 'Period' })).getAllByRole('radio')[0]
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('renders holdings with real brand icons, letter-chip fallback and share of portfolio', async () => {
    const { container } = await renderTab();
    const panel = screen.getByTestId('portfolio-holdings');

    const imgs = Array.from(panel.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    // CDN-based colored logos (coin-logos) keyed by CoinGecko ID ('small' size).
    expect(imgs).toContain('https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png');
    expect(imgs).toContain('https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/ethereum/small.png');
    // Every asset gets a CDN URL (tier-3 ticker guess) — the letter-chip fallback
    // only appears after a load error (covered by AssetIcon.test.tsx via
    // fireEvent.error). Here we just assert the third asset rendered an <img>.
    expect(imgs.length).toBeGreaterThanOrEqual(3);

    // Share column: BTC is 25,000 / 35,500 ≈ 70.4% of the total cost basis.
    expect(within(panel).getAllByText('70.4%').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText('1.4%').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(4);
  });

  it('keeps the export affordances and the ledger-health repair action', async () => {
    await renderTab();
    expect(screen.getByRole('button', { name: 'CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run ledger repair' })).toBeInTheDocument();
  });

  it('shows the empty state when the ledger is empty', async () => {
    // Render with an empty ledger by swapping the stub for this test only.
    const backup = [...SEED.txs];
    SEED.txs.length = 0;
    try {
      await renderTab();
      expect(screen.getByText('Your portfolio is empty')).toBeInTheDocument();
    } finally {
      SEED.txs.push(...backup);
    }
  });
});
