import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LandingPage } from './LandingPage';

/**
 * Landing page content contract (live-feedback round, item 1): the approved
 * foundation-landing mockup's full copy in Ember & Slate — hero + preview,
 * stats band (minus the removed rating stat), What's new / Privacy / Private
 * AI, the 7-row compare table, the grouped Pricing anchor (plans + mode
 * chooser), the aurora CTA band and the full footer. Also pins the rules that
 * must not regress: no tax-loss-harvesting copy (India §115BBH), CTAs only
 * scroll, and the mode-selection invariant stays with the path cards.
 */

const onSelectMode = vi.fn();
const onSignIn = vi.fn();

function renderLanding() {
  return render(<LandingPage onSelectMode={onSelectMode} onSignIn={onSignIn} />);
}

beforeAll(() => {
  // jsdom does not implement scrollIntoView.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  onSelectMode.mockClear();
  onSignIn.mockClear();
  vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();
});

describe('LandingPage — hero (mockup content)', () => {
  it('renders the NEW pill, gradient headline, subline, step pills, CTAs and checkmarks', () => {
    renderLanding();

    expect(
      screen.getByText('Exchange auto-sync · AI tax advisor · India Schedule VDA reports')
    ).toBeInTheDocument();

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Crypto taxes in minutes.');
    expect(h1).toHaveTextContent('Your ledger stays in your browser.');

    expect(
      screen.getByText(/imports from 200\+ exchanges, wallets and chains/)
    ).toBeInTheDocument();

    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Export')).toBeInTheDocument();

    expect(
      screen.getAllByRole('button', { name: 'Create account' })[0]
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /continue without an account/i })[0]).toBeInTheDocument();

    expect(screen.getByText('Free forever tier')).toBeInTheDocument();
    expect(screen.getByText('No credit card')).toBeInTheDocument();
    expect(screen.getByText('Nothing to install')).toBeInTheDocument();
  });

  it('renders the product-preview illustration with the India TDS AI note (no loss-harvesting)', () => {
    renderLanding();

    expect(screen.getByText('sololedger.app — this tab is the whole app')).toBeInTheDocument();
    expect(screen.getByText('Example local ledger')).toBeInTheDocument();
    expect(
      screen.getByText(/₹18,240 TDS deducted this FY — reconcile with Form 26AS/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Local calculation example/)
    ).toBeInTheDocument();

    // §115BBH: VDA losses cannot offset gains — the landing never pitches harvesting.
    expect(screen.queryByText(/harvest/i)).toBeNull();
    // The removed rating stat stays removed.
    expect(screen.queryByText(/4\.9/)).toBeNull();
  });
});

describe('LandingPage — navigation & sections', () => {
  it('top nav links to the five mockup anchors', () => {
    renderLanding();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ["What's new", '#new'],
      ['Privacy', '#privacy'],
      ['Private AI', '#private-ai'],
      ['Compare', '#compare'],
      ['Pricing', '#pricing']
    ]);
  });

  it('compare section shows all seven mockup rows against "Typical cloud tools"', () => {
    renderLanding();

    expect(
      screen.getByRole('heading', { name: 'SoloLedger vs typical cloud tax tools' })
    ).toBeInTheDocument();

    const table = screen.getByRole('table', {
      name: 'SoloLedger compared to typical cloud tax tools'
    });
    // Header row + 7 data rows.
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(within(table).getByText('Typical cloud tools')).toBeInTheDocument();

    for (const feature of [
      'Local ledger and tax calculations',
      'Optional hosted AI',
      'Free tier, no account required',
      'Exchange auto-sync (read-only, deduped)',
      'AI tax advisor',
      'Derivatives & perpetuals support',
      'India tax forms — Schedule VDA + TDS'
    ]) {
      expect(within(table).getByText(feature)).toBeInTheDocument();
    }
  });

  it('groups the mode chooser and the subscription plans under the single #pricing anchor', () => {
    const { container } = renderLanding();
    const pricing = container.querySelector('#pricing');
    expect(pricing).not.toBeNull();

    const scope = within(pricing as HTMLElement);
    expect(scope.getByText('Start your crypto tax review')).toBeInTheDocument();
    expect(scope.getByText('Pick a plan. Start free.')).toBeInTheDocument();
    // The chooser keeps its scroll target id so existing CTAs still land there.
    expect(pricing?.querySelector('#choose')).not.toBeNull();
  });
});

describe('LandingPage — CTA band & footer', () => {
  it('renders the aurora CTA band with the canonical tagline', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', { name: 'Private. Precise. Yours.' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Your taxes are your business. File them like it.')
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Create account' })[0]
    ).toBeInTheDocument();
  });

  it('renders the mockup footer: blurb, menus, legal line', () => {
    renderLanding();
    const footer = screen.getByRole('contentinfo');

    expect(
      within(footer).getByText(
        'The private tax engine for crypto today — and for your whole balance sheet tomorrow.'
      )
    ).toBeInTheDocument();

    expect(within(footer).getByRole('link', { name: "What's new" })).toHaveAttribute(
      'href',
      '#new'
    );
    expect(within(footer).getByRole('link', { name: 'Pricing' })).toHaveAttribute(
      'href',
      '#pricing'
    );
    for (const label of ['India VDA guide', 'TDS under 194S', 'Import your exchange', 'Help center']) {
      expect(within(footer).getByRole('link', { name: label })).toBeInTheDocument();
    }

    expect(
      within(footer).getByText('© 2026 SoloLedger. Private. Precise. Yours.')
    ).toBeInTheDocument();
    for (const label of ['Privacy promise', 'Terms', 'Security']) {
      expect(within(footer).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('waitlist submit is non-navigating and shows the confirmation toast', async () => {
    renderLanding();
    const footer = screen.getByRole('contentinfo');

    fireEvent.change(screen.getByLabelText('Email for waitlist'), {
      target: { value: 'trader@example.in' }
    });
    fireEvent.click(within(footer).getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      "You're on the list — we'll write when full-wealth launches"
    );
    // The form clears after joining.
    expect(screen.getByLabelText('Email for waitlist')).toHaveValue('');
  });
});

describe('LandingPage — account-first behavior', () => {
  it('primary account CTAs select hosted directly, with no architecture chooser', () => {
    renderLanding();
    for (const button of screen.getAllByRole('button', { name: 'Create account' })) fireEvent.click(button);
    expect(onSelectMode).toHaveBeenCalledWith('hosted');
    expect(screen.queryByText('BYOK')).toBeNull();
    expect(screen.queryByText(/three ways/)).toBeNull();
  });
  it('secondary no-account actions select local and disclose account is not backup', () => {
    renderLanding();
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue without an account' })[0]);
    expect(onSelectMode).toHaveBeenCalledWith('local');
    expect(screen.getByText(/An account is not a backup/)).toBeInTheDocument();
  });
  it('Sign in keeps the existing auth entrypoint', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
