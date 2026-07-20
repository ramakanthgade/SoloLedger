import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiAdvisor } from './AiAdvisor';
import { db } from '@/lib/storage/db';
import { getNetworkMode, resetNetworkActivity } from '@/lib/networkActivity';
import { setMode } from '@/lib/saas/mode';

// Hosted-mode tests need the server config fetch; local tests never call it.
vi.mock('@/lib/saas/api', () => ({
  fetchPublicConfig: vi.fn(async () => ({
    priceApiEnabled: true,
    rpcLookupEnabled: true,
    aiAdvisorEnabled: true
  }))
}));

// Avoid the heavy cost-basis calc — the gate/transport behaviour is what we test.
vi.mock('@/lib/ai/taxContext', () => ({
  buildTaxContextFromDb: vi.fn(async () => 'SYSTEM PROMPT (aggregated summary)')
}));

// Mock the transport: a real send records network activity at the boundary, so
// the mock simulates that to prove an AI send flips the badge to the expected mode.
vi.mock('@/lib/ai/openrouter', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/openrouter')>();
  return {
    ...actual,
    streamChatCompletion: vi.fn(async function* () {
      const { recordNetworkActivity } = await import('@/lib/networkActivity');
      recordNetworkActivity('direct'); // BYO-key build → direct
      yield 'Here is your answer.';
    })
  };
});

async function seedSettings(consent: boolean) {
  await db.settings.put({
    id: 'singleton',
    jurisdiction: 'IN',
    reportingCurrency: 'INR',
    defaultCostBasisMethod: 'FIFO',
    priceApiEnabled: false,
    rpcLookupEnabled: false,
    aiApiKey: 'sk-or-test-key',
    aiConsentGranted: consent
  });
}

describe('AiAdvisor consent gate (A2)', () => {
  beforeEach(async () => {
    resetNetworkActivity();
    await db.settings.clear();
    await db.transactions.clear();
  });

  it('BLOCKS AI use until consent is given — no chat input, only the gate', async () => {
    await seedSettings(false);
    render(<AiAdvisor />);

    // Open the panel once the (available) FAB mounts.
    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    // Consent gate is shown; the chat input is NOT present, so no send is possible.
    expect(await screen.findByText('Enable AI Advisor')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about your taxes…')).toBeNull();
    expect(getNetworkMode()).toBe('local');

    // Enable button is disabled until the explicit consent box is ticked.
    const enable = screen.getByText('Enable AI Advisor');
    expect(enable).toBeDisabled();
  });

  it('after consent, an AI send flips the badge to the expected (direct) mode', async () => {
    await seedSettings(true);
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    // Chat UI is available (consent already granted); badge starts local.
    const question = await screen.findByText('What is my total taxable gain this year?');
    expect(getNetworkMode()).toBe('local');

    fireEvent.click(question);

    // The mocked transport records a direct call — badge flips to direct.
    await waitFor(() => expect(getNetworkMode()).toBe('direct'));
  });

  it('ticking consent reveals the chat and enables sending', async () => {
    await seedSettings(false);
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    // Tick the consent checkbox and enable.
    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('Enable AI Advisor'));

    // Chat now available (persisted consent re-renders via live query).
    await waitFor(() =>
      expect(screen.getByText('What is my total taxable gain this year?')).toBeInTheDocument()
    );
  });
});

/** Seed a settings row where aiConsentGranted is ABSENT unless passed. */
async function seedRawSettings(extra: Record<string, unknown> = {}) {
  await db.settings.put({
    id: 'singleton',
    jurisdiction: 'IN',
    reportingCurrency: 'INR',
    defaultCostBasisMethod: 'FIFO',
    priceApiEnabled: false,
    rpcLookupEnabled: false,
    ...extra
  });
}

describe('AiAdvisor consent — mode-dependent defaults (item 7)', () => {
  beforeEach(async () => {
    setMode('local');
    resetNetworkActivity();
    await db.settings.clear();
    await db.transactions.clear();
  });

  afterEach(() => setMode('local'));

  it('hosted: consent defaults ON when aiConsentGranted is unset (opt-out model)', async () => {
    setMode('hosted');
    await seedRawSettings();
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    // No consent gate — the chat is available immediately.
    expect(await screen.findByText('What is my total taxable gain this year?')).toBeInTheDocument();
    expect(screen.queryByText('Enable AI Advisor')).toBeNull();
  });

  it('hosted: an explicit false opts out — the consent gate returns', async () => {
    setMode('hosted');
    await seedRawSettings({ aiConsentGranted: false });
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    expect(await screen.findByText('Enable AI Advisor')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about your taxes…')).toBeNull();
  });

  it('hosted: opting out from the panel persists false to the shared settings row', async () => {
    setMode('hosted');
    await seedRawSettings();
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);
    await screen.findByText('What is my total taxable gain this year?');

    fireEvent.click(screen.getByText(/Turn off the AI Advisor/));

    // The gate reappears and the row now holds an explicit opt-out.
    await screen.findByText('Enable AI Advisor');
    await waitFor(async () =>
      expect((await db.settings.get('singleton'))?.aiConsentGranted).toBe(false)
    );
  });

  it('local: consent defaults OFF when aiConsentGranted is unset (opt-in model)', async () => {
    await seedRawSettings({ aiApiKey: 'sk-or-test-key' });
    render(<AiAdvisor />);

    const fab = await screen.findByTitle('AI Tax Advisor — ask about your taxes');
    fireEvent.click(fab);

    expect(await screen.findByText('Enable AI Advisor')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about your taxes…')).toBeNull();
  });
});
