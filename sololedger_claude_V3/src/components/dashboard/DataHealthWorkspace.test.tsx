import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataHealthModel } from './dataHealthModel';
import { DataHealthWorkspace } from './DataHealthWorkspace';

const clean: DataHealthModel = {
  summary: { sourceCount: 1, scopeCount: 1, assetCount: 1, actionSourceCount: 0, divergent: 0, stale: 0, missingAuthority: 0, nonComparableAuthority: 0, partialCoverage: 0, failedCoverage: 0, unknownCoverage: 0, openingBalanceRequired: 0, unresolvedScope: 0, deletedScope: 0, reconciled: 1 },
  sources: [{
    id: 'manual', title: 'Manual entry', target: { kind: 'manual', singletonId: 'manual' },
    axes: { divergent: 0, stale: 0, missingAuthority: 0, nonComparableAuthority: 0, partialCoverage: 0, failedCoverage: 0, unknownCoverage: 0, openingBalanceRequired: 0, unresolvedScope: 0, deletedScope: 0, reconciled: 1 },
    severity: 'clean', findings: []
  }]
};

const actionable: DataHealthModel = {
  summary: { ...clean.summary, actionSourceCount: 1, divergent: 1, reconciled: 0 },
  sources: [{ ...clean.sources[0], id: 'file:one', title: 'CSV one', target: { kind: 'csv', importId: 'one' }, severity: 'warning', axes: { ...clean.sources[0].axes, divergent: 1, reconciled: 0 }, findings: [{ key: 'f', severity: 'warning', remediation: 'inspect_evidence_history', scopeId: 'file:one:spot', accountClass: 'spot', asset: 'BTC', assetKey: 'asset:BTC', intent: { destination: 'transactions', filter: { sourceTarget: { kind: 'csv', importId: 'one' }, scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC' }, focus: 'filters' } }], primaryFinding: { key: 'f', severity: 'warning', remediation: 'inspect_evidence_history', scopeId: 'file:one:spot', accountClass: 'spot', asset: 'BTC', assetKey: 'asset:BTC', intent: { destination: 'transactions', filter: { sourceTarget: { kind: 'csv', importId: 'one' }, scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC' }, focus: 'filters' } } }]
};

const actionableManual: DataHealthModel = {
  summary: { ...clean.summary, actionSourceCount: 1, missingAuthority: 1, reconciled: 0 },
  sources: [{
    ...clean.sources[0],
    severity: 'warning',
    axes: { ...clean.sources[0].axes, missingAuthority: 1, reconciled: 0 },
    findings: [{
      key: 'manual-authority', severity: 'warning', remediation: 'add_timestamped_authority', scopeId: 'manual', accountClass: 'manual',
      intent: { destination: 'transactions', filter: { sourceTarget: { kind: 'manual', singletonId: 'manual' }, scopeId: 'manual' }, focus: 'filters' }
    }]
  }]
};

const secondaryIntent = { destination: 'connections' as const, target: { kind: 'csv' as const, importId: 'one' }, workspaceTab: 'reconciliation' as const, focus: { kind: 'asset' as const, scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC' } };
const importIntent = { destination: 'connections' as const, target: { kind: 'csv' as const, importId: 'one' }, workspaceTab: 'overview' as const, focus: { kind: 'import' as const } };
const syncIntent = { destination: 'connections' as const, target: { kind: 'csv' as const, importId: 'one' }, workspaceTab: 'overview' as const, focus: { kind: 'sync' as const } };
const withSecondary: DataHealthModel = {
  ...actionable,
  sources: [{
    ...actionable.sources[0],
    findings: [
      ...actionable.sources[0].findings,
      { key: 'secondary-a', severity: 'warning', remediation: 'add_timestamped_authority', scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC', intent: secondaryIntent },
      { key: 'secondary-b', severity: 'info', remediation: 'refresh_authority', scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC', intent: secondaryIntent }
    ]
  }]
};
const withDistinctClasses: DataHealthModel = {
  ...actionable,
  sources: [{
    ...actionable.sources[0],
    findings: [
      ...actionable.sources[0].findings,
      { key: 'spot-authority', severity: 'warning', remediation: 'add_timestamped_authority', scopeId: 'file:one:spot', accountClass: 'spot', assetKey: 'asset:BTC', intent: secondaryIntent },
      { key: 'options-authority', severity: 'warning', remediation: 'add_timestamped_authority', scopeId: 'file:one:options', accountClass: 'options', assetKey: 'asset:BTC', intent: { ...secondaryIntent, focus: { ...secondaryIntent.focus, scopeId: 'file:one:options', accountClass: 'options' } } }
    ]
  }]
};

describe('DataHealthWorkspace', () => {
  it('renders loading, empty, clean, and live-updated actionable states', () => {
    const props = { onClose: vi.fn(), onNavigate: vi.fn(), focusOnMount: false };
    const view = render(<DataHealthWorkspace {...props} model={{ ...clean, sources: [], summary: { ...clean.summary, sourceCount: 0 } }} loading />);
    expect(screen.getByText('Loading Data Health…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Data Health summary' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Filter Data Health sources' })).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
    view.rerender(<DataHealthWorkspace {...props} model={{ ...clean, sources: [], summary: { ...clean.summary, sourceCount: 0 } }} />);
    expect(screen.getByText('No source data yet')).toBeInTheDocument();
    view.rerender(<DataHealthWorkspace {...props} model={clean} />);
    fireEvent.click(screen.getByRole('radio', { name: /All/ }));
    expect(screen.getByText('Manual entry')).toBeInTheDocument();
    view.rerender(<DataHealthWorkspace {...props} model={actionable} />);
    expect(screen.getByText('CSV one')).toBeInTheDocument();
  });

  it('supports roving keyboard filters, mobile-safe controls, typed navigation, and initial focus', async () => {
    const onNavigate = vi.fn();
    render(<DataHealthWorkspace model={actionable} onClose={vi.fn()} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Data Health' })).toHaveFocus());
    const action = screen.getByRole('radio', { name: /Needs action/ });
    action.focus();
    fireEvent.keyDown(action, { key: 'End' });
    expect(screen.getByRole('radio', { name: /No balance record/ })).toHaveFocus();
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('button', { name: /Review the related transactions/ }));
    expect(onNavigate.mock.calls[0][0]).toMatchObject({ destination: 'transactions', filter: { sourceTarget: { kind: 'csv', importId: 'one' }, scopeId: 'file:one:spot', assetKey: 'asset:BTC' } });
    expect(screen.getByText('What these statuses mean')).toBeInTheDocument();
    expect(screen.getByText(/does not confirm tax treatment, labels, prices, or cost basis/i)).toBeInTheDocument();
    expect(screen.getByText(/Opens Transactions with this source, account, and asset already selected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sync all|Export health report/)).toBeNull();
  });

  it('roves only across visible Action, Stale, and All filters on mobile', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;
    try {
      render(<DataHealthWorkspace model={actionable} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
      const action = screen.getByRole('radio', { name: /Needs action/ });
      action.focus();
      fireEvent.keyDown(action, { key: 'End' });
      expect(screen.getByRole('radio', { name: /All/ })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole('radio', { name: /All/ }), { key: 'ArrowRight' });
      expect(action).toHaveFocus();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('subscribes to breakpoint changes and normalizes hidden no-authority selections', async () => {
    const originalMatchMedia = window.matchMedia;
    let mobile = false;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() { return mobile; },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
    })) as typeof window.matchMedia;
    try {
      render(<DataHealthWorkspace model={actionableManual} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} initialState={{ filter: 'no-authority', scrollTop: 0 }} />);
      expect(screen.getByRole('radio', { name: /No balance record/ })).toHaveAttribute('aria-checked', 'true');
      mobile = true;
      act(() => listeners.forEach((listener) => listener()));
      await waitFor(() => expect(screen.getByRole('radio', { name: /Needs action/ })).toHaveAttribute('aria-checked', 'true'));
      expect(screen.getByRole('radio', { name: /No balance record/ })).toHaveAttribute('aria-checked', 'false');
      const action = screen.getByRole('radio', { name: /Needs action/ });
      action.focus();
      fireEvent.keyDown(action, { key: 'End' });
      expect(screen.getByRole('radio', { name: /All/ })).toHaveFocus();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('normalizes restored no-authority directly to a visible mobile filter', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;
    try {
      render(<DataHealthWorkspace model={actionableManual} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} initialState={{ filter: 'no-authority', scrollTop: 0 }} />);
      expect(screen.getByRole('radio', { name: /Needs action/ })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: /No balance record/ })).toHaveAttribute('tabindex', '-1');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('groups equivalent secondary intents and reopens their disclosure before restoring focus and scroll', async () => {
    const originalScrollTo = window.scrollTo;
    window.scrollTo = vi.fn();
    try {
      render(<DataHealthWorkspace model={withSecondary} onClose={vi.fn()} onNavigate={vi.fn()} initialState={{ filter: 'all', scrollTop: 444, focusActionKey: 'file:one:secondary-a' }} />);
      const summary = screen.getByText('More actions (1)').closest('details');
      expect(summary).not.toBeNull();
      await waitFor(() => expect(summary).toHaveAttribute('open'));
      const action = document.querySelector<HTMLButtonElement>('[data-data-health-action="file:one:secondary-a"]');
      await waitFor(() => expect(action).toHaveFocus());
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 444 });
      expect(screen.queryByText('More actions (2)')).toBeNull();
    } finally {
      window.scrollTo = originalScrollTo;
    }
  });

  it('keeps filters, disclosures, and focus mounted while a coherent refresh is pending', () => {
    const props = { model: withSecondary, onClose: vi.fn(), onNavigate: vi.fn(), focusOnMount: false };
    const view = render(<DataHealthWorkspace {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /Needs action/ }));
    const disclosure = screen.getByText('More actions (1)').closest('details')!;
    fireEvent.click(screen.getByText('More actions (1)'));
    const secondary = document.querySelector<HTMLButtonElement>('[data-data-health-action="file:one:secondary-a"]')!;
    secondary.focus();
    expect(disclosure).toHaveAttribute('open');
    expect(secondary).toHaveFocus();

    view.rerender(<DataHealthWorkspace {...props} updating />);

    expect(screen.getByTestId('data-health-workspace')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Updating Data Health…');
    expect(screen.getByRole('radio', { name: /Needs action/ })).toHaveAttribute('aria-checked', 'true');
    expect(disclosure).toHaveAttribute('open');
    expect(secondary).toHaveFocus();
    expect(secondary).toBeDisabled();
    expect(screen.getByText('CSV one')).toBeInTheDocument();

    view.rerender(<DataHealthWorkspace {...props} />);
    expect(disclosure).toHaveAttribute('open');
    expect(secondary).toHaveFocus();
    expect(secondary).not.toBeDisabled();
  });

  it('gives the secondary disclosure summary a 44px centered target', () => {
    render(<DataHealthWorkspace model={withSecondary} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    expect(screen.getByText('More actions (1)')).toHaveClass('min-h-[44px]', 'flex', 'items-center');
  });

  it('restores nonzero scroll to the active shell scroller at 768px', async () => {
    const originalMatchMedia = window.matchMedia;
    const main = document.createElement('main');
    main.id = 'main-content';
    main.scrollTo = vi.fn();
    document.body.append(main);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1023px)', addEventListener: vi.fn(), removeEventListener: vi.fn()
    })) as typeof window.matchMedia;
    try {
      render(<DataHealthWorkspace model={actionable} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} initialState={{ filter: 'all', scrollTop: 768 }} />);
      await waitFor(() => expect(main.scrollTo).toHaveBeenCalledWith({ top: 768 }));
    } finally {
      main.remove();
      window.matchMedia = originalMatchMedia;
    }
  });

  it('distinguishes equivalent remediation labels for exact account-class scopes', () => {
    render(<DataHealthWorkspace model={withDistinctClasses} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    fireEvent.click(screen.getByText('More actions (2)'));
    expect(screen.getByRole('button', { name: /Add a dated balance record · Spot account/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a dated balance record · Options account/ })).toBeInTheDocument();
    expect(screen.queryByText(/file:one:/)).not.toBeInTheDocument();
  });

  it('renders the mobile summary as Need action then Reconciled and keeps desktop order', () => {
    render(<DataHealthWorkspace model={actionable} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    const summaries = screen.getAllByRole('region', { name: 'Data Health summary' });
    expect([...summaries[0].querySelectorAll('p:first-child')].map((node) => node.textContent)).toEqual(['Need action', 'Balances matched']);
    expect([...summaries[1].querySelectorAll('p:first-child')].map((node) => node.textContent)).toEqual(['Sources connected', 'Balances matched', 'Need action', 'Not checked yet']);
  });

  it('preserves a restored filter, nonzero scroll, and exact action focus over the mobile default', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalScrollTo = window.scrollTo;
    const scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;
    window.scrollTo = scrollTo;
    try {
      const view = render(<DataHealthWorkspace
        model={actionable}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        initialState={{ filter: 'all', scrollTop: 321, focusActionKey: 'file:one:f' }}
        loading
      />);
      expect(screen.queryByRole('radiogroup', { name: 'Filter Data Health sources' })).toBeNull();
      expect(scrollTo).not.toHaveBeenCalled();
      view.rerender(<DataHealthWorkspace
        model={actionable}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        initialState={{ filter: 'all', scrollTop: 321, focusActionKey: 'file:one:f' }}
      />);
      expect(screen.getByRole('radio', { name: /All/ })).toHaveAttribute('aria-checked', 'true');
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 321 }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Review the related transactions/ })).toHaveFocus());
    } finally {
      window.matchMedia = originalMatchMedia;
      window.scrollTo = originalScrollTo;
    }
  });

  it('labels manual remediation as a transaction review and emits the manual singleton filter', () => {
    const onNavigate = vi.fn();
    render(<DataHealthWorkspace model={actionableManual} onClose={vi.fn()} onNavigate={onNavigate} focusOnMount={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Review manual balance transactions/ }));
    expect(onNavigate.mock.calls[0][0]).toMatchObject({
      destination: 'transactions',
      filter: { sourceTarget: { kind: 'manual', singletonId: 'manual' }, scopeId: 'manual' }
    });
    expect(screen.queryByRole('button', { name: /Add a dated balance record/ })).toBeNull();
  });

  it('keeps plain-language status help visible and raw diagnostics collapsed', () => {
    render(<DataHealthWorkspace model={actionable} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    expect(screen.getByText('What these statuses mean')).toBeVisible();
    expect(screen.getAllByText('Needs attention').some((node) => node.classList.contains('mt-2'))).toBe(true);
    expect(screen.getByText(/Recorded activity does not match the source balance/)).toBeVisible();
    const rawStatus = screen.getByText(/raw severity: warning/);
    const advanced = rawStatus.closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(within(advanced!).getByText('Advanced details')).toBeInTheDocument();
  });

  it('describes retry navigation without claiming the update starts immediately', () => {
    const retryModel: DataHealthModel = {
      ...actionable,
      sources: [{
        ...actionable.sources[0],
        title: 'Binance API',
        findings: [{ ...actionable.sources[0].findings[0], remediation: 'retry_source_operation', intent: importIntent }]
      }]
    };
    render(<DataHealthWorkspace model={retryModel} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    expect(screen.getByRole('button', { name: 'Open Binance API to retry update' })).toBeInTheDocument();
    expect(screen.getByText('Opens this source and focuses Import file.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Retry Binance API/ })).toBeNull();
  });

  it('describes sync and reconciliation destinations exactly', () => {
    const model: DataHealthModel = {
      ...actionable,
      sources: [{
        ...actionable.sources[0],
        findings: [
          { ...actionable.sources[0].findings[0], key: 'sync', remediation: 'refresh_authority', intent: syncIntent },
          { ...actionable.sources[0].findings[0], key: 'reconcile', remediation: 'inspect_evidence_history', intent: secondaryIntent }
        ]
      }]
    };
    render(<DataHealthWorkspace model={model} onClose={vi.fn()} onNavigate={vi.fn()} focusOnMount={false} />);
    expect(screen.getByText('Opens this source and focuses Sync now.')).toBeVisible();
    fireEvent.click(screen.getByText('More actions (1)'));
    expect(screen.getByText(/Opens this source’s Reconciliation view/)).toBeVisible();
  });
});
