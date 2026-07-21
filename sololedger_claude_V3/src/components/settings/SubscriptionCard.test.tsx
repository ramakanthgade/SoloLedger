import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { PublicUser } from '@/lib/saas/api';
import { SELECTED_PLAN_KEY } from '@/lib/saas/planCatalog';

/**
 * Feedback round 2026-07-21 — Settings → Subscription card (Items 2–4):
 *   Item 2: the header no longer duplicates the current plan — every plan
 *           appears exactly once, in the list, with the CURRENT tag.
 *   Item 3: plan rows never wrap — the Select button is always pinned to the
 *           right edge, vertically centered (structural class assertions,
 *           grep-based per the repo's ReviewTab.*.test.ts convention).
 *   Item 4: Enterprise shows a live computed total and a normal Select
 *           button that starts checkout with the chosen extra packs.
 *
 * Auth + billing are mocked exactly like SettingsTab.test.tsx so this stays a
 * focused render of the card itself.
 */

const mocks = vi.hoisted(() => ({
  user: { current: null as PublicUser | null },
  startCheckout: vi.fn(async (_plan: string, _extraPacks?: number) => null as string | null)
}));

vi.mock('@/lib/saas/api', () => ({
  startCheckout: mocks.startCheckout
}));

vi.mock('@/lib/saas/authContext', () => ({
  useAuth: () => ({ user: mocks.user.current })
}));

import { SubscriptionCard } from './SubscriptionCard';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'SubscriptionCard.tsx'),
  'utf8'
);

const LOCAL_USER: PublicUser = {
  id: 'u1',
  email: 'local@example.com',
  role: 'subscriber',
  plan: 'local',
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  includedUnits: 100,
  subscriptionActive: true
};

const PACKS_INPUT = 'Enterprise extra 1,000-event packs';

beforeEach(() => {
  mocks.user.current = LOCAL_USER;
  mocks.startCheckout.mockClear();
  sessionStorage.clear();
});

describe('SubscriptionCard — Item 2: no duplicate plan', () => {
  it('renders each plan name exactly once, CURRENT tag on the current plan only', () => {
    render(<SubscriptionCard />);
    for (const name of ['Local', 'Starter', 'Standard', 'Pro', 'Investor', 'Enterprise']) {
      expect(screen.getAllByText(name)).toHaveLength(1);
    }
    expect(screen.getAllByText('Current')).toHaveLength(1);
    // The CURRENT badge sits inside the Local plan row's name line.
    expect(within(screen.getByText('Local')).getByText('Current')).toBeInTheDocument();
  });

  it('drops the old header plan-name / unit-limit / Free-tier block', () => {
    render(<SubscriptionCard />);
    expect(
      screen.queryByText(/taxable disposals \+ income events per tax year/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Free tier')).not.toBeInTheDocument();
  });

  it('keeps the SUBSCRIPTION label and the landing-selection warning', () => {
    sessionStorage.setItem(SELECTED_PLAN_KEY, 'pro');
    render(<SubscriptionCard />);
    expect(screen.getByText('Subscription')).toBeInTheDocument();
    expect(screen.getByText(/You selected/)).toBeInTheDocument();
    expect(screen.getByText('pro')).toBeInTheDocument();
  });

  it('shows a small renewal-needed note only when the subscription is inactive', () => {
    mocks.user.current = { ...LOCAL_USER, subscriptionActive: false };
    render(<SubscriptionCard />);
    expect(screen.getByText(/renewal needed/i)).toBeInTheDocument();
  });

  it('hides the renewal-needed note for an active subscription', () => {
    render(<SubscriptionCard />);
    expect(screen.queryByText(/renewal needed/i)).not.toBeInTheDocument();
  });
});

describe('SubscriptionCard — Item 3: Select always right-aligned', () => {
  it('uses the non-wrapping row layout with a shrink-proof button cell', () => {
    expect(source).toContain('flex items-center justify-between gap-4 px-6 py-4');
    expect(source).toContain('min-w-0 flex-1');
    expect(source).toContain('shrink-0');
    expect(source).not.toContain('flex-wrap');
  });

  it('renders every Select button inside a shrink-0 wrapper', () => {
    render(<SubscriptionCard />);
    // All plans except the current one (Local) get a Select button.
    const buttons = screen.getAllByRole('button', { name: 'Select' });
    expect(buttons).toHaveLength(5);
    for (const btn of buttons) {
      expect(btn.parentElement?.className).toContain('shrink-0');
    }
  });
});

describe('SubscriptionCard — Item 4: Enterprise total + Select', () => {
  it('shows the base-only total at 0 packs', () => {
    render(<SubscriptionCard />);
    expect(screen.getByText('Total: ₹6,999/year (10,000 events included)')).toBeInTheDocument();
    expect(screen.getByText(/→ 10,000 events/)).toBeInTheDocument();
  });

  it('recomputes live for 1 pack', () => {
    render(<SubscriptionCard />);
    fireEvent.change(screen.getByLabelText(PACKS_INPUT), { target: { value: '1' } });
    expect(
      screen.getByText('Total: ₹7,598/year (₹6,999 for 10,000 events + ₹599 for 1 extra 1,000-event packs)')
    ).toBeInTheDocument();
    expect(screen.getByText(/→ 11,000 events/)).toBeInTheDocument();
  });

  it('recomputes live for 3 packs with the exact breakdown string', () => {
    render(<SubscriptionCard />);
    fireEvent.change(screen.getByLabelText(PACKS_INPUT), { target: { value: '3' } });
    expect(
      screen.getByText('Total: ₹8,796/year (₹6,999 for 10,000 events + ₹1,797 for 3 extra 1,000-event packs)')
    ).toBeInTheDocument();
    expect(screen.getByText(/→ 13,000 events/)).toBeInTheDocument();
  });

  it('settings card no longer honors contactOnly (landing keeps it)', () => {
    expect(source).not.toContain('contactOnly');
    expect(source).not.toContain("'Contact'");
    render(<SubscriptionCard />);
    expect(screen.queryByRole('button', { name: /contact/i })).not.toBeInTheDocument();
  });

  it('enterprise Select starts checkout with the chosen packs', async () => {
    render(<SubscriptionCard />);
    fireEvent.change(screen.getByLabelText(PACKS_INPUT), { target: { value: '3' } });

    const enterpriseRow = screen.getByText('Enterprise').closest('div.flex.items-center');
    expect(enterpriseRow).not.toBeNull();
    fireEvent.click(within(enterpriseRow as HTMLElement).getByRole('button', { name: 'Select' }));

    await waitFor(() => expect(mocks.startCheckout).toHaveBeenCalledWith('enterprise', 3));
  });
});
