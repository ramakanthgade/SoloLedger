import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { evaluateExportGate, suggestPlanForUnits } from './gate';
import { LOCAL_INCLUDED_UNITS } from '@/lib/saas/plans';
import { useExportGuard } from '@/components/billing/ExportGateDialog';
import { db, saveSettings, DEFAULT_SETTINGS } from '@/lib/storage/db';
import type { AuthSnapshot } from '@/lib/features';
import type { Disposal } from '@/types/transaction';

describe('free-tier export cap (100 events)', () => {
  it('allows export at exactly 100 units', () => {
    const r = evaluateExportGate(100, LOCAL_INCLUDED_UNITS, 'local');
    expect(r.allowed).toBe(true);
    expect(r.overageUnits).toBe(0);
    expect(r.upgradeCta).toBeUndefined();
  });

  it('blocks export at 101 units with an upgrade CTA and no truncation', () => {
    const r = evaluateExportGate(101, LOCAL_INCLUDED_UNITS, 'local');
    expect(r.allowed).toBe(false);
    expect(r.overageUnits).toBe(1);
    expect(r.units).toBe(101); // full count preserved — nothing truncated
    expect(r.upgradeCta?.action).toBe('upgrade_plan');
    expect(r.upgradeCta?.suggestedPlan).toBe('starter');
  });
});

describe('suggestPlanForUnits', () => {
  it('suggests the smallest tier that covers the unit count', () => {
    expect(suggestPlanForUnits(100)).toBe('local');
    expect(suggestPlanForUnits(101)).toBe('starter');
    expect(suggestPlanForUnits(501)).toBe('standard');
    expect(suggestPlanForUnits(2001)).toBe('pro');
    expect(suggestPlanForUnits(5001)).toBe('investor');
    expect(suggestPlanForUnits(10001)).toBe('enterprise');
  });
});

describe('Enterprise allowance enforcement (prepaid packs)', () => {
  it('blocks base Enterprise (10,000) at 10,001 with a buy-pack CTA', () => {
    const r = evaluateExportGate(10_001, 10_000, 'enterprise');
    expect(r.allowed).toBe(false);
    expect(r.overageUnits).toBe(1);
    expect(r.upgradeCta?.action).toBe('buy_pack');
  });

  it('allows a larger pack (13,000) up to 13,000 and blocks at 13,001', () => {
    expect(evaluateExportGate(13_000, 13_000, 'enterprise').allowed).toBe(true);
    const over = evaluateExportGate(13_001, 13_000, 'enterprise');
    expect(over.allowed).toBe(false);
    expect(over.upgradeCta?.action).toBe('buy_pack');
  });
});

/* ------------------------------------------------------------------ *
 * FIX 1 integration: the export guard blocks real export paths.
 * ------------------------------------------------------------------ */

const IN_FY_2025 = Date.UTC(2025, 5, 15); // 15 Jun 2025 — inside IN FY 2025-26.

function makeDisposals(n: number): Disposal[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    asset: 'BTC',
    disposedAt: IN_FY_2025,
    amount: 1,
    proceeds: 100,
    costBasis: 50,
    gain: 50,
    holdingPeriodDays: 10,
    lotConsumption: [],
    sourceTxId: `tx${i}`,
    method: 'FIFO' as const
  }));
}

/** Test harness: renders a single guarded export button + the gate dialog. */
function GuardHarness({
  disposals,
  auth,
  onExport
}: {
  disposals: Disposal[];
  auth?: AuthSnapshot | null;
  onExport: () => void;
}) {
  const { runGuarded, gateDialog } = useExportGuard({
    disposals,
    transactions: [],
    fy: 2025,
    jurisdiction: 'IN',
    auth
  });
  return (
    <div>
      <button onClick={() => void runGuarded(onExport)}>Export</button>
      {gateDialog}
    </div>
  );
}

describe('useExportGuard — blocks real export paths over the cap (D6 FIX 1)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await saveSettings({ ...DEFAULT_SETTINGS, jurisdiction: 'IN' });
  });

  it('blocks a free-tier (Local 100) export at 101 units — no export runs', async () => {
    let exported = 0;
    render(<GuardHarness disposals={makeDisposals(101)} onExport={() => { exported += 1; }} />);
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(screen.getByTestId('export-gate-dialog')).toBeInTheDocument());
    expect(exported).toBe(0);
    expect(screen.getByText(/Upgrade to export this report/)).toBeInTheDocument();
  });

  it('allows a free-tier export at exactly 100 units', async () => {
    let exported = 0;
    render(<GuardHarness disposals={makeDisposals(100)} onExport={() => { exported += 1; }} />);
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(exported).toBe(1));
    expect(screen.queryByTestId('export-gate-dialog')).toBeNull();
  });

  it('blocks base Enterprise (10,000) at 10,001 with a buy-pack CTA', async () => {
    let exported = 0;
    render(
      <GuardHarness
        disposals={makeDisposals(10_001)}
        auth={{ plan: 'enterprise', includedUnits: 10_000 }}
        onExport={() => { exported += 1; }}
      />
    );
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(screen.getByTestId('export-gate-dialog')).toBeInTheDocument());
    expect(exported).toBe(0);
    expect(screen.getByText(/Buy a larger allowance pack/)).toBeInTheDocument();
  });

  it('allows an Enterprise pack (13,000) to export up to 13,000 units', async () => {
    let exported = 0;
    render(
      <GuardHarness
        disposals={makeDisposals(13_000)}
        auth={{ plan: 'enterprise', includedUnits: 13_000 }}
        onExport={() => { exported += 1; }}
      />
    );
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(exported).toBe(1));
    expect(screen.queryByTestId('export-gate-dialog')).toBeNull();
  });

  it('blocks the same 13,000-pack user at 13,001 units', async () => {
    let exported = 0;
    render(
      <GuardHarness
        disposals={makeDisposals(13_001)}
        auth={{ plan: 'enterprise', includedUnits: 13_000 }}
        onExport={() => { exported += 1; }}
      />
    );
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(screen.getByTestId('export-gate-dialog')).toBeInTheDocument());
    expect(exported).toBe(0);
  });
});
