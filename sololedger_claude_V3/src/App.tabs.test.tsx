import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '@/App';
import { AuthProvider } from '@/lib/saas/authContext';

/**
 * Tab a11y (Task T2): the primary nav is a WAI-ARIA tablist with roving
 * tabindex and Left/Right/Home/End arrow-key navigation. In default local mode
 * `dbReady` is immediately true and no network call fires, so we can render the
 * whole app and drive the real tablist.
 */
describe('App tab navigation (a11y)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  async function renderApp() {
    render(
      <AuthProvider>
        <App />
      </AuthProvider>
    );
    // Wait for the tablist to mount (dbReady resolves on a microtask).
    return waitFor(() => screen.getByRole('tablist'));
  }

  it('renders a tablist with tabs and the first tab selected', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Roving tabindex: only the active tab is tabbable.
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves aria-selected to the next tab', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveFocus();
  });

  it('ArrowLeft from the first tab wraps to the last', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to first and last tab', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('the tabpanel is wired to the selected tab', async () => {
    await renderApp();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-import');
  });
});
