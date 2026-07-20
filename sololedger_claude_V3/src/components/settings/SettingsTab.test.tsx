import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db, getSettings, DEFAULT_SETTINGS } from '@/lib/storage/db';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import { invalidateServerConfigCache } from '@/lib/saas/effectiveSettings';
import { setMode } from '@/lib/saas/mode';
import type { PublicUser } from '@/lib/saas/api';

/**
 * Item 7 — Settings "AI Tax Advisor" consent checkbox.
 *
 * Renders the real SettingsTab against a real Dexie settings singleton (fake
 * IndexedDB); only auth + the hosted server-config fetch are mocked. Mode is
 * flipped through the real runtime-mode singleton so the component's own
 * `isSaasMode()` branch is what renders each section.
 */

const mocks = vi.hoisted(() => ({
  user: { current: null as PublicUser | null },
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: true,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: true
  }))
}));

vi.mock('@/lib/saas/api', () => ({
  fetchPublicConfig: mocks.fetchPublicConfig,
  startCheckout: vi.fn(async () => null)
}));

vi.mock('@/lib/saas/authContext', () => ({
  useAuth: () => ({ user: mocks.user.current })
}));

import { SettingsTab } from './SettingsTab';

const SUBSCRIBER: PublicUser = {
  id: 'u1',
  email: 'sub@example.com',
  role: 'subscriber',
  plan: 'pro',
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  includedUnits: 5000,
  subscriptionActive: true
};

/** Seed the settings row; `aiConsentGranted` stays absent unless passed. */
async function seedSettings(extra: Record<string, unknown> = {}) {
  await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS, ...extra });
}

beforeEach(async () => {
  setMode('local');
  mocks.user.current = null;
  invalidateServerConfigCache();
  await db.settings.clear();
});

afterEach(() => {
  setMode('local');
});

describe('SettingsTab — AI Advisor consent (hosted, opt-out)', () => {
  it('is ON by default when aiConsentGranted was never set', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    await seedSettings();
    render(<SettingsTab />);

    const checkbox = await screen.findByRole('checkbox', { name: /AI Tax Advisor/i });
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/On by default for subscribers — uncheck/)).toBeInTheDocument();
  });

  it('honors an explicit false (opt-out) on load', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    await seedSettings({ aiConsentGranted: false });
    render(<SettingsTab />);

    const checkbox = await screen.findByRole('checkbox', { name: /AI Tax Advisor/i });
    expect(checkbox).not.toBeChecked();
  });

  it('toggling persists through the shared settings singleton, both ways', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    await seedSettings();
    render(<SettingsTab />);

    const checkbox = await screen.findByRole('checkbox', { name: /AI Tax Advisor/i });

    // Uncheck → opt out, persisted as explicit false.
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await waitFor(async () => expect((await getSettings()).aiConsentGranted).toBe(false));

    // Re-check → opt back in, persisted as true.
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    await waitFor(async () => expect((await getSettings()).aiConsentGranted).toBe(true));
  });

  it('update() merges into the raw row — a hosted change preserves local-only fields', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    // Pre-seed a local-only field the effective view omits (a BYOK AI key) —
    // before the raw-row merge, ANY hosted settings write full-row-put the
    // effective view and silently deleted it.
    await seedSettings({ aiApiKey: 'sk-or-local-key' });
    render(<SettingsTab />);

    // Two selects mention "jurisdiction" (the tax-jurisdiction picker and the
    // derivatives-treatment helper) — the first is the settings one.
    const selects = await screen.findAllByRole('combobox', { name: /Jurisdiction/i });
    fireEvent.change(selects[0], { target: { value: 'US' } });

    await waitFor(async () => expect((await getSettings()).jurisdiction).toBe('US'));
    const row = await getSettings();
    expect(row.aiApiKey).toBe('sk-or-local-key'); // local-only field survived
    expect(row.reportingCurrency).toBe(JURISDICTIONS.US.currency); // side-patch landed
  });
});

describe('SettingsTab — AI Advisor consent (local, opt-in)', () => {
  it('is OFF by default when aiConsentGranted was never set', async () => {
    await seedSettings();
    render(<SettingsTab />);

    const checkbox = await screen.findByRole('checkbox', { name: /AI Tax Advisor/i });
    expect(checkbox).not.toBeChecked();
    // Copy aligned with the new control: revoke "from its panel or here".
    expect(screen.getByText(/from its panel or here/)).toBeInTheDocument();
  });

  it('checking the box persists the explicit opt-in', async () => {
    await seedSettings();
    render(<SettingsTab />);

    const checkbox = await screen.findByRole('checkbox', { name: /AI Tax Advisor/i });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    await waitFor(async () => expect((await getSettings()).aiConsentGranted).toBe(true));
  });
});
