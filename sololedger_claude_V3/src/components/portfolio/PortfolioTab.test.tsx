import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { getAvailableFys, getCurrentFy, getFyLabel } from '@/lib/utils';

const utilityMocks = vi.hoisted(() => ({ downloadBlob: vi.fn() }));

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  downloadBlob: utilityMocks.downloadBlob
}));

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
  return {
    txs,
    emptyAddresses: [] as { chain: string; address: string }[],
    exchangeConnections: [] as Record<string, unknown>[],
    openingBalances: [] as Record<string, unknown>[],
    authoritySnapshots: [] as Record<string, unknown>[],
    authorityAssets: [] as Record<string, unknown>[],
    sourceCoverage: [] as Record<string, unknown>[]
  };
});

vi.mock('dexie-react-hooks', () => ({
  // Run the querier synchronously against the stubbed db below.
  useLiveQuery: (querier: () => unknown) => querier()
}));

vi.mock('@/lib/storage/db', () => ({
  db: {
    transactions: { toArray: () => SEED.txs },
    csvImports: { toArray: () => [] },
    exchangeConnections: { toArray: () => SEED.exchangeConnections },
    openingBalances: { toArray: () => SEED.openingBalances },
    authoritySnapshots: { toArray: () => SEED.authoritySnapshots },
    authorityAssets: { toArray: () => SEED.authorityAssets },
    sourceCoverage: { toArray: () => SEED.sourceCoverage }
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

function addApiAuthority(asset: string, quantity: number, asOf = Date.now()) {
  SEED.exchangeConnections.push({
    id: 'api-current', exchange: 'binance', createdAt: 0, cursors: {}, status: 'ok'
  });
  SEED.authoritySnapshots.push({
    snapshotId: 'api-snapshot', generation: 1, scopeId: 'exchange:api-current',
    authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
    coveredAccountClasses: ['spot'], asOf, capturedAt: asOf, sourceIdentityId: 'api-current',
    endpointProof: {
      authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot',
      requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
    },
    status: 'complete'
  });
  SEED.authorityAssets.push({
    id: 'api-asset', snapshotId: 'api-snapshot', generation: 1,
    scopeId: 'exchange:api-current', accountClass: 'spot', assetKey: `asset:${asset}`,
    asset, quantity
  });
  SEED.sourceCoverage.push({
    id: 'api-coverage', generation: 1, scopeId: 'exchange:api-current',
    sourceIdentityId: 'api-current', evidenceId: 'api-evidence', kind: 'api',
    accountClasses: ['spot'], endpoints: ['history'], authoritySnapshotId: 'api-snapshot',
    authorityAsOf: asOf, requestedHistoryStart: 0, requestedHistoryEnd: asOf,
    observedHistoryStart: 0, observedHistoryEnd: asOf, startedAt: 0, completedAt: asOf,
    status: 'complete', paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: 'history', accountClass: 'spot', required: true, status: 'complete',
      requestedStart: 0, requestedEnd: asOf, observedStart: 0, observedEnd: asOf,
      paginationRequired: true, paginationExhausted: true
    }]
  });
}

function clearProjectionEvidence() {
  SEED.exchangeConnections.length = 0;
  SEED.openingBalances.length = 0;
  SEED.authoritySnapshots.length = 0;
  SEED.authorityAssets.length = 0;
  SEED.sourceCoverage.length = 0;
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
    expect(within(panel).getByText(/Indicators describe quantity source only/)).toHaveTextContent(
      'not reconciliation or tax correctness'
    );
  });

  it('keeps the export affordances and the ledger-health repair action', async () => {
    await renderTab();
    expect(screen.getByRole('button', { name: 'CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run ledger repair' })).toBeInTheDocument();
  });

  it('selects and exports case-distinct Base58 wallets independently', async () => {
    const originalTxCount = SEED.txs.length;
    const originalAddressCount = SEED.emptyAddresses.length;
    SEED.txs.push(
      {
        id: 'sol-upper', timestamp: Date.UTC(2026, 5, 1), type: 'transfer_in', asset: 'SOL',
        amount: 1, fiatCurrency: 'INR', source: 'rpc:helius', chain: 'solana',
        walletAddress: 'Base58Case', flags: [], isInternalTransfer: false
      } as never,
      {
        id: 'sol-lower', timestamp: Date.UTC(2026, 5, 2), type: 'transfer_in', asset: 'SOL',
        amount: 2, fiatCurrency: 'INR', source: 'rpc:helius', chain: 'solana',
        walletAddress: 'base58Case', flags: [], isInternalTransfer: false
      } as never
    );
    SEED.emptyAddresses.push(
      { chain: 'solana', address: 'Base58Case' },
      { chain: 'solana', address: 'base58Case' }
    );
    try {
      await renderTab();
      const walletFilter = screen.getByRole('combobox', { name: 'Wallet filter' });
      expect(within(walletFilter).getByRole('option', { name: 'Base58Case' })).toBeInTheDocument();
      expect(within(walletFilter).getByRole('option', { name: 'base58Case' })).toBeInTheDocument();

      fireEvent.change(walletFilter, { target: { value: 'solana:solana:base58Case' } });
      fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
      expect(utilityMocks.downloadBlob).toHaveBeenCalledTimes(1);
      const exported = JSON.parse(utilityMocks.downloadBlob.mock.calls[0][0] as string);
      expect(exported.wallet).toBe('solana:solana:base58Case');
      expect(exported.holdings).toEqual([
        expect.objectContaining({ asset: 'SOL', amount: 2, chain: 'solana' })
      ]);
    } finally {
      SEED.txs.splice(originalTxCount);
      SEED.emptyAddresses.splice(originalAddressCount);
    }
  });

  it('uses a current API authority quantity instead of the transaction-derived quantity', async () => {
    const originalTxCount = SEED.txs.length;
    SEED.txs.push({
      id: 'api-current-tx', timestamp: Date.now() - 1_000, type: 'transfer_in', asset: 'APICOIN',
      amount: 2, fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'api-current',
      parserAccountClass: 'spot', flags: [], isInternalTransfer: false
    } as never);
    addApiAuthority('APICOIN', 7);
    try {
      await renderTab();
      expect(screen.getAllByText('7.00000000').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('holding-quantity-source').some((row) =>
        row.textContent?.includes('Verified current authority · quantity source only')
      )).toBe(true);
    } finally {
      SEED.txs.splice(originalTxCount);
      clearProjectionEvidence();
    }
  });

  it('falls back to posting quantity when API authority is stale', async () => {
    const originalTxCount = SEED.txs.length;
    SEED.txs.push({
      id: 'api-stale-tx', timestamp: Date.now() - 1_000, type: 'transfer_in', asset: 'STALECOIN',
      amount: 2, fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'api-current',
      parserAccountClass: 'spot', flags: [], isInternalTransfer: false
    } as never);
    addApiAuthority('STALECOIN', 7, Date.now() - 86_400_001);
    try {
      await renderTab();
      expect(screen.getAllByText('2.00000000').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('7.00000000')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('holding-quantity-source').some((row) =>
        row.textContent?.includes('Unverified posting-derived · quantity source only · stale authority')
      )).toBe(true);
    } finally {
      SEED.txs.splice(originalTxCount);
      clearProjectionEvidence();
    }
  });

  it('labels posting fallback caused by incomplete authority coverage', async () => {
    const originalTxCount = SEED.txs.length;
    SEED.txs.push({
      id: 'api-incomplete-tx', timestamp: Date.now() - 1_000, type: 'transfer_in',
      asset: 'PARTIALCOIN', amount: 2, fiatCurrency: 'INR', source: 'binance_api',
      importBatchId: 'api-current', parserAccountClass: 'spot', flags: [],
      isInternalTransfer: false
    } as never);
    addApiAuthority('PARTIALCOIN', 7);
    SEED.sourceCoverage[0].status = 'partial';
    (SEED.sourceCoverage[0].endpointOutcomes as Record<string, unknown>[])[0].status = 'partial';
    try {
      await renderTab();
      expect(screen.getAllByText('2.00000000').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('7.00000000')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('holding-quantity-source').some((row) =>
        row.textContent?.includes(
          'Unverified posting-derived · quantity source only · incomplete source coverage'
        )
      )).toBe(true);
    } finally {
      SEED.txs.splice(originalTxCount);
      clearProjectionEvidence();
    }
  });

  it('falls back to postings after current authority becomes stale while mounted', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 2, 12);
    vi.setSystemTime(now);
    const originalTxCount = SEED.txs.length;
    SEED.txs.push({
      id: 'api-aging-tx', timestamp: now - 1_000, type: 'transfer_in', asset: 'AGINGCOIN',
      amount: 2, fiatCurrency: 'INR', source: 'binance_api', importBatchId: 'api-current',
      parserAccountClass: 'spot', flags: [], isInternalTransfer: false
    } as never);
    addApiAuthority('AGINGCOIN', 7, now);
    let view: Awaited<ReturnType<typeof renderTab>> | undefined;
    try {
      view = await renderTab();
      expect(screen.getAllByText('7.00000000').length).toBeGreaterThanOrEqual(1);

      act(() => vi.advanceTimersByTime(24 * 60 * 60_000 + 5 * 60_000));

      expect(screen.getAllByText('2.00000000').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('7.00000000')).not.toBeInTheDocument();
    } finally {
      view?.unmount();
      SEED.txs.splice(originalTxCount);
      clearProjectionEvidence();
      vi.useRealTimers();
    }
  });

  it('keeps same-symbol Solana contracts as separate projected holdings', async () => {
    const originalTxCount = SEED.txs.length;
    SEED.txs.push(
      {
        id: 'mint-a', timestamp: Date.now() - 2_000, type: 'transfer_in', asset: 'SAME', amount: 1,
        fiatCurrency: 'INR', source: 'rpc:helius', chain: 'solana', walletAddress: 'WalletA',
        contractAddress: 'MintCaseA', flags: [], isInternalTransfer: false
      } as never,
      {
        id: 'mint-b', timestamp: Date.now() - 1_000, type: 'transfer_in', asset: 'SAME', amount: 3,
        fiatCurrency: 'INR', source: 'rpc:helius', chain: 'solana', walletAddress: 'WalletA',
        contractAddress: 'MintCaseB', flags: [], isInternalTransfer: false
      } as never
    );
    try {
      utilityMocks.downloadBlob.mockClear();
      await renderTab();
      fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
      const exported = JSON.parse(utilityMocks.downloadBlob.mock.calls[0][0] as string);
      expect(exported.holdings).toEqual(expect.arrayContaining([
        expect.objectContaining({ asset: 'SAME', contractAddress: 'MintCaseA', amount: 1 }),
        expect.objectContaining({ asset: 'SAME', contractAddress: 'MintCaseB', amount: 3 })
      ]));
    } finally {
      SEED.txs.splice(originalTxCount);
    }
  });

  it('applies opening balances and transactions after the opening instant', async () => {
    const originalTxCount = SEED.txs.length;
    const now = Date.now();
    SEED.txs.push({
      id: 'opening-after', timestamp: now - 1_000, type: 'transfer_in', asset: 'OPEN', amount: 2,
      fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false
    } as never);
    SEED.openingBalances.push({
      id: 'opening', logicalKey: 'manual-open', scopeId: 'manual', accountClass: 'manual',
      assetKey: 'asset:OPEN', asset: 'OPEN', absoluteQuantity: 10, effectiveAt: now - 2_000,
      provenance: 'user_confirmed', createdAt: now, updatedAt: now
    });
    try {
      await renderTab();
      expect(screen.getAllByText('12.00000000').length).toBeGreaterThanOrEqual(1);
    } finally {
      SEED.txs.splice(originalTxCount);
      clearProjectionEvidence();
    }
  });

  it('projects selected FY quantities at the exact FY cutoff', async () => {
    const originalTxCount = SEED.txs.length;
    SEED.txs.push({
      id: 'btc-after-cutoff', timestamp: Date.UTC(2026, 4, 20), type: 'transfer_in', asset: 'BTC',
      amount: 4, fiatCurrency: 'INR', source: 'manual', flags: [], isInternalTransfer: false
    } as never);
    try {
      await renderTab();
      const fyPill = within(screen.getByRole('radiogroup', { name: 'Period' }))
        .getByRole('radio', { name: PREV_FY_LABEL });
      fireEvent.click(fyPill);
      expect(screen.getAllByText('0.50000000').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('4.50000000')).not.toBeInTheDocument();
    } finally {
      SEED.txs.splice(originalTxCount);
    }
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
