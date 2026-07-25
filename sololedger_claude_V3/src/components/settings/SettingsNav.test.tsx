import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { db, DEFAULT_SETTINGS } from '@/lib/storage/db';
import { invalidateServerConfigCache } from '@/lib/saas/effectiveSettings';
import { setMode } from '@/lib/saas/mode';
import type { PublicUser } from '@/lib/saas/api';

/**
 * Ember & Slate Settings layout (flows-reports mockup §05): left sub-nav of
 * section anchors, section cards, loss-toned danger zone, and save feedback
 * via the toast stack. Auth + hosted config are mocked exactly like
 * SettingsTab.test.tsx; mode is flipped through the real runtime singleton.
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

beforeEach(async () => {
  setMode('local');
  mocks.user.current = null;
  invalidateServerConfigCache();
  await db.settings.clear();
  await db.settings.put({ id: 'singleton', ...DEFAULT_SETTINGS });
});

describe('SettingsTab — Ember & Slate sub-nav', () => {
  it('lists every local-mode section as an anchor link', async () => {
    render(<SettingsTab />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Tax defaults',
      'Network features',
      'AI advisor',
      'Your data',
      'Address registries',
      'Appearance'
    ]);
    for (const link of links) {
      const id = link.getAttribute('href')?.slice(1);
      expect(id).toBeTruthy();
      expect(document.getElementById(id as string)).not.toBeNull();
    }
  });

  it('marks the clicked section link as current', async () => {
    render(<SettingsTab />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const data = within(nav).getByRole('link', { name: 'Your data' });
    expect(data).not.toHaveAttribute('aria-current');
    fireEvent.click(data);
    expect(data).toHaveAttribute('aria-current', 'location');
  });
});

describe('SettingsTab — section styling hooks', () => {
  it('renders the danger zone in a loss-toned panel inside Your data', async () => {
    render(<SettingsTab />);
    const zone = await screen.findByTestId('danger-zone');
    expect(zone.className).toContain('border-loss/30');
    expect(zone.className).toContain('bg-loss/[0.06]');
    expect(within(zone).getByText('Danger zone')).toBeInTheDocument();
    expect(
      within(zone).getByRole('button', { name: 'Delete all local data' })
    ).toBeInTheDocument();
  });

  it('keeps network features as labelled checkboxes with honest captions', async () => {
    render(<SettingsTab />);
    const price = await screen.findByRole('checkbox', { name: /Live price lookup/i });
    const rpc = screen.getByRole('checkbox', { name: /Wallet address lookup/i });
    expect(price).toBeInTheDocument();
    expect(rpc).toBeInTheDocument();
    expect(screen.getAllByText(/Leaves your device:/)).toHaveLength(2);
  });

  it('confirms a settings change with a "Settings saved" toast', async () => {
    render(<SettingsTab />);
    const selects = await screen.findAllByRole('combobox', { name: /Jurisdiction/i });
    fireEvent.change(selects[0], { target: { value: 'US' } });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });
});
