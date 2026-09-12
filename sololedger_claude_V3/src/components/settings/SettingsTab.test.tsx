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
    expect(row.aiApiKey).toBeUndefined(); // retired provider keys stay disabled
    expect(row.reportingCurrency).toBe(JURISDICTIONS.US.currency); // side-patch landed
  });
});

describe('SettingsTab — account-free network controls', () => {
  it('does not offer provider keys or a local AI toggle', async () => {
    await seedSettings({ aiApiKey: 'legacy', priceApiEnabled: true });
    render(<SettingsTab />);
    await screen.findByText(/Legacy provider keys are disabled/);
    expect(screen.queryByRole('checkbox', { name: /AI Tax Advisor/i })).toBeNull();
    expect(screen.queryByText(/OpenRouter API key/)).toBeNull();
    const lookup = screen.getByRole('checkbox', { name: /Live price lookup/i });
    expect(lookup).not.toBeChecked();
    fireEvent.click(lookup);
    expect(lookup).not.toBeChecked();
  });
});

describe('SettingsTab — Network features (hosted first-run defaults)', () => {
  it('shows both lookup toggles ON after the hosted first-run seed', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    // Exactly the row applyHostedLookupDefaults writes on first hosted run.
    await seedSettings({ priceApiEnabled: true, rpcLookupEnabled: true });
    render(<SettingsTab />);

    const price = await screen.findByRole('checkbox', { name: /Live price lookup/i });
    const rpc = screen.getByRole('checkbox', { name: /Wallet address lookup/i });
    expect(price).toBeChecked();
    expect(rpc).toBeChecked();
    // Hosted badge copy flips to "On by default"; BYOK key panels stay hidden
    // (hosted lookups run through the server proxy, which injects the keys).
    expect(screen.getByText('On by default')).toBeInTheDocument();
    expect(screen.queryByText(/CoinGecko Pro API key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Helius API key/i)).not.toBeInTheDocument();
  });

  it('turning a lookup off persists the explicit opt-out and never snaps back on', async () => {
    setMode('hosted');
    mocks.user.current = SUBSCRIBER;
    await seedSettings({ priceApiEnabled: true, rpcLookupEnabled: true });
    render(<SettingsTab />);

    const price = await screen.findByRole('checkbox', { name: /Live price lookup/i });
    fireEvent.click(price);

    // The raw row records both the new value and the explicit-choice marker.
    await waitFor(async () => {
      const row = await getSettings();
      expect(row.priceApiEnabled).toBe(false);
      expect(row.lookupPrefsExplicit).toBe(true);
    });
    // After the effective-view reload ("Settings saved" toast), the toggle
    // must still be OFF — the hosted merge honors the explicit choice.
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    expect(price).not.toBeChecked();
    // The untouched flag stays ON.
    expect(screen.getByRole('checkbox', { name: /Wallet address lookup/i })).toBeChecked();
  });
});
