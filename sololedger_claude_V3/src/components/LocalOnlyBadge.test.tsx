import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { LocalOnlyBadge } from '@/components/LocalOnlyBadge';
import {
  recordNetworkActivity,
  resetNetworkActivity,
  type NetworkMode
} from '@/lib/networkActivity';

/** Drive the store into a given mode before rendering. */
function seedMode(mode: NetworkMode): void {
  resetNetworkActivity();
  if (mode !== 'local') recordNetworkActivity(mode);
}

describe('LocalOnlyBadge', () => {
  beforeEach(() => {
    resetNetworkActivity();
  });

  it('renders the local state with a mint/teal (gain) dot and label', () => {
    seedMode('local');
    render(<LocalOnlyBadge />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('100% Local');
    // The status dot carries the gain token fill.
    expect(pill.querySelector('.bg-gain')).not.toBeNull();
  });

  it('renders the direct state with a BLUE dot and "your keys, direct" label', () => {
    seedMode('direct');
    render(<LocalOnlyBadge />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('Local + network on');
    expect(pill).toHaveTextContent('· your keys, direct');
    expect(pill.querySelector('.bg-blue')).not.toBeNull();
  });

  it('renders the relay state with a VIOLET dot and "via SoloLedger" label', () => {
    seedMode('relay');
    render(<LocalOnlyBadge />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('Local + relay');
    expect(pill).toHaveTextContent('· via SoloLedger');
    expect(pill.querySelector('.bg-violet')).not.toBeNull();
  });

  it('reacts to store escalation without re-rendering manually', () => {
    seedMode('local');
    render(<LocalOnlyBadge />);
    expect(screen.getByRole('button')).toHaveTextContent('100% Local');
    act(() => {
      recordNetworkActivity('relay');
    });
    expect(screen.getByRole('button')).toHaveTextContent('Local + relay');
  });

  it('opens the disclosure popover on click with the state sentence', () => {
    seedMode('local');
    render(<LocalOnlyBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Nothing has left this device/i)).not.toBeNull();
  });

  it('is keyboard-accessible: the pill is a focusable button and toggles aria-expanded', () => {
    seedMode('direct');
    render(<LocalOnlyBadge />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveAttribute('aria-haspopup', 'dialog');
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    pill.focus();
    expect(pill).toHaveFocus();
    // Enter/Space activate a native button (click), opening the popover.
    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('dismisses the popover with Escape', () => {
    seedMode('relay');
    render(<LocalOnlyBadge />);
    fireEvent.click(screen.getByRole('button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
